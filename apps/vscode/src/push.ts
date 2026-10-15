/**
 * Push: upload a checkout's local changes, after showing them.
 *
 * Local changes are the folder compared with its staging copy (the
 * cloud at the last sync). The upload itself is a `workspace put` of
 * the folder; the SDK sends the folder's snapshot id, so the server
 * refuses the push if the cloud moved on since. After a push the
 * staging copy is brought up to date from the folder, so the next pull
 * or push starts from the right base.
 */

import { join } from "node:path";
import * as vscode from "vscode";
import {
  BacloudError,
  classifyChanges,
  unsupportedFiles,
  workspaceManifest,
  type Change,
} from "@bacloud/sdk";
import { nodeFileHost } from "@bacloud/sdk/node";
import type { Auth } from "./auth.ts";
import { openChangeDiff } from "./changesView.ts";
import { currentFleet, type Cloud } from "./cloud.ts";
import { hasKnownBase, type Checkout, type FolderStore } from "./folders.ts";
import type { PullManager } from "./pull.ts";

const EDIT_ICONS = {
  added: "diff-added",
  modified: "diff-modified",
  deleted: "diff-removed",
} as const;

type PreviewItem = vscode.QuickPickItem & { change?: Change; action?: "push" };

export class PushManager {
  private readonly cloud: Cloud;
  private readonly auth: Auth;
  private readonly store: FolderStore;
  private readonly pulls: PullManager;
  private readonly log: vscode.LogOutputChannel;
  /** Re-read checkouts after a sync so views show the new state. */
  private readonly rescan: () => Promise<void>;
  private busy = false;

  constructor(deps: {
    cloud: Cloud;
    auth: Auth;
    store: FolderStore;
    pulls: PullManager;
    log: vscode.LogOutputChannel;
    rescan: () => Promise<void>;
  }) {
    this.cloud = deps.cloud;
    this.auth = deps.auth;
    this.store = deps.store;
    this.pulls = deps.pulls;
    this.log = deps.log;
    this.rescan = deps.rescan;
  }

  async push(checkout: Checkout): Promise<void> {
    if (this.busy) return;
    if (!vscode.workspace.isTrusted) throw new Error("Trust this folder before pushing from it.");
    if (this.pulls.staged)
      throw new Error("Finish or discard the pull under review before pushing.");
    if (checkout.error) throw new Error(checkout.error);
    const bearer = await this.auth.token();
    if (bearer === undefined) throw new Error("Sign in to Ballistica first.");
    const fleet = currentFleet();
    if (checkout.record && checkout.record.fleet !== fleet) {
      throw new Error(
        `${checkout.name} was cloned from the ${checkout.record.fleet} fleet, but bacloud.fleet is ${fleet}.`,
      );
    }
    if (!(await hasKnownBase(checkout, this.store))) {
      const choice = await vscode.window.showWarningMessage(
        `${checkout.name} was last synced by another tool, so its local changes can't be shown. Pull first.`,
        "Pull",
      );
      if (choice) await this.pulls.pull(checkout);
      return;
    }

    this.busy = true;
    try {
      const folder = checkout.folder.uri.fsPath;
      const staging = this.store.stagingDir(folder);
      await vscode.workspace.saveAll(false);
      const [base, local] = await Promise.all([
        workspaceManifest(nodeFileHost, staging),
        workspaceManifest(nodeFileHost, folder),
      ]);
      // With the base as "cloud", every difference is a local change.
      const changes = classifyChanges(base, base, local);
      if (changes.length === 0) {
        void vscode.window.showInformationMessage(`${checkout.name} has no local changes to push.`);
        return;
      }
      const invalid = unsupportedFiles(Object.keys(local));
      if (!(await this.confirm(checkout, staging, changes, invalid))) return;
      await this.upload(checkout, staging, changes, bearer);
    } finally {
      this.busy = false;
    }
  }

  /** Show the changes; resolves true when the user picks Push. */
  private confirm(
    checkout: Checkout,
    staging: string,
    changes: Change[],
    invalid: string[],
  ): Promise<boolean> {
    const folder = checkout.folder.uri.fsPath;
    const picker = vscode.window.createQuickPick<PreviewItem>();
    picker.title = `Push to ${checkout.name}`;
    picker.placeholder = "Select a file to compare with the cloud, or push";
    picker.ignoreFocusOut = true;
    picker.matchOnDescription = true;

    const head: PreviewItem = invalid.length
      ? {
          label: `$(error) Can't push: ${invalid.length} file${invalid.length === 1 ? " has" : "s have"} an unsupported type`,
          detail: `${invalid.slice(0, 5).join(", ")}${invalid.length > 5 ? ", …" : ""} · the server only accepts .py .txt .json .png .jpg .obj .toml .bstr .apref .wav .bchar`,
          alwaysShow: true,
        }
      : {
          label: `$(cloud-upload) Push ${changes.length} change${changes.length === 1 ? "" : "s"}`,
          description: `to ${checkout.name} (${checkout.record?.fleet ?? currentFleet()})`,
          action: "push",
          alwaysShow: true,
        };
    picker.items = [
      head,
      { label: "Changes", kind: vscode.QuickPickItemKind.Separator },
      ...changes.map((change) => ({
        label: `$(${EDIT_ICONS[change.kind === "conflict" ? "modified" : change.edit]}) ${change.path}`,
        description: change.kind === "conflict" ? "" : change.edit,
        change,
      })),
    ];

    return new Promise((resolve) => {
      picker.onDidAccept(() => {
        const [item] = picker.selectedItems;
        if (item?.action === "push") {
          resolve(true);
          picker.hide();
        } else if (item?.change) {
          // Keep the picker open while the user looks at diffs.
          void openChangeDiff(staging, folder, item.change);
        }
      });
      picker.onDidHide(() => {
        resolve(false);
        picker.dispose();
      });
      picker.show();
    });
  }

  private async upload(
    checkout: Checkout,
    staging: string,
    changes: Change[],
    bearer: string,
  ): Promise<void> {
    const folder = checkout.folder.uri.fsPath;
    let snapshotId: string | undefined;
    try {
      snapshotId = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Pushing ${checkout.name}…` },
        async () => {
          // The SDK adds --expected-snapshotid from the folder's state file
          // and records the new snapshot id there afterwards.
          const result = await this.cloud.run(
            ["workspace", "put", folder, "--workspace", checkout.name],
            {
              bearer,
              cwd: folder,
            },
          );
          if (result.returnCode !== 0 || !result.workspaceSnapshotId) {
            throw new Error(`Pushing ${checkout.name} failed; see the log.`);
          }
          return result.workspaceSnapshotId;
        },
      );
    } catch (err) {
      if (err instanceof BacloudError && /changed since your last get/i.test(err.message)) {
        const choice = await vscode.window.showWarningMessage(
          `${checkout.name} changed in the cloud since your last sync. Pull, review, then push again.`,
          "Pull",
        );
        if (choice) await this.pulls.pull(checkout);
        return;
      }
      throw err;
    }

    // The cloud now matches the folder; make staging match too.
    for (const change of changes) {
      const from = join(folder, change.path);
      const to = join(staging, change.path);
      if (change.kind !== "conflict" && change.edit === "deleted")
        await nodeFileHost.deleteFile(to);
      else await nodeFileHost.writeFile(to, await nodeFileHost.readFile(from));
    }
    await nodeFileHost.pruneEmptyDirs(staging);
    await this.store.write({
      path: folder,
      fleet: checkout.record?.fleet ?? currentFleet(),
      workspace: checkout.name,
      snapshotId,
      syncedAt: new Date().toISOString(),
    });
    await this.rescan();
    this.log.info(`Pushed ${changes.length} change(s) to ${checkout.name} (${snapshotId}).`);
    void vscode.window.showInformationMessage(
      `Pushed ${changes.length} change${changes.length === 1 ? "" : "s"} to ${checkout.name}.`,
    );
  }
}
