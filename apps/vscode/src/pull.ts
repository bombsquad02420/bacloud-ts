/**
 * Pull: bring cloud changes into a checkout without overwriting local
 * work.
 *
 * ```
 *   C     local folder           (the checkout)
 *   |
 * B |     cloud now              (staging, after this pull's get)
 * | /
 * A       cloud at last sync     (base: staging hard-linked before the get)
 * ```
 *
 * The folder is never the target of a `get`. Changes are classified
 * three ways and applied one by one (or all incoming at once); the
 * checkout's snapshot id moves to B only when nothing is left
 * unresolved, so a push stays guarded until then.
 */

import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import {
  classifyChanges,
  updateWorkspaceState,
  workspaceManifest,
  type Change,
  type Manifest,
} from "@bacloud/sdk";
import { nodeFileHost } from "@bacloud/sdk/node";
import type { Auth } from "./auth.ts";
import { currentFleet, type Cloud } from "./cloud.ts";
import { hasKnownBase, type Checkout, type FolderStore } from "./folders.ts";
import { exists, linkTree, replaceDir } from "./fsutil.ts";
import { CLOUD_SCHEME, mergeable, openChangeDiff } from "./changesView.ts";

/** A pull waiting for review. */
export interface StagedPull {
  checkout: Checkout;
  staging: string;
  base: string;
  /** The cloud snapshot in staging (B). */
  snapshotId: string;
  /** Whether the base was known; if not, every difference is a conflict. */
  baseKnown: boolean;
  changes: Change[];
  /** Paths the user has applied or kept. */
  resolved: Set<string>;
}

/** Snapshots of local files taken for the merge editor. */
function mergeDir(pull: StagedPull): string {
  return join(dirname(pull.staging), "merge-local");
}

export function needsAction(change: Change): boolean {
  return change.kind !== "local";
}

export class PullManager implements vscode.Disposable {
  private readonly cloud: Cloud;
  private readonly auth: Auth;
  private readonly store: FolderStore;
  private readonly log: vscode.LogOutputChannel;
  /** Re-read checkouts after a sync so views show the new state. */
  private readonly rescan: () => Promise<void>;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private current: StagedPull | undefined;
  private busy = false;

  constructor(deps: {
    cloud: Cloud;
    auth: Auth;
    store: FolderStore;
    log: vscode.LogOutputChannel;
    rescan: () => Promise<void>;
  }) {
    this.cloud = deps.cloud;
    this.auth = deps.auth;
    this.store = deps.store;
    this.log = deps.log;
    this.rescan = deps.rescan;
  }

  get staged(): StagedPull | undefined {
    return this.current;
  }

  pending(pull: StagedPull): Change[] {
    return pull.changes.filter((c) => needsAction(c) && !pull.resolved.has(c.path));
  }

  // ---------------------------------------------------------------- //
  // Starting a pull.

  async pull(checkout: Checkout): Promise<void> {
    if (this.current) {
      throw new Error("A pull is already waiting for review. Finish or discard it first.");
    }
    if (this.busy) return;
    if (!vscode.workspace.isTrusted)
      throw new Error("Pulling writes files; trust this folder first.");
    if (checkout.error) throw new Error(checkout.error);
    const bearer = await this.auth.token();
    if (bearer === undefined) throw new Error("Sign in to Ballistica first.");

    const folder = checkout.folder.uri.fsPath;
    const fleet = currentFleet();
    const record = checkout.record;
    if (record && record.fleet !== fleet) {
      throw new Error(
        `${checkout.name} was cloned from the ${record.fleet} fleet, but bacloud.fleet is ${fleet}. ` +
          `Switch the setting back to ${record.fleet} to pull.`,
      );
    }

    this.busy = true;
    try {
      const staging = this.store.stagingDir(folder);
      const base = this.store.baseDir(folder);
      await this.recoverInterrupted(staging, base);

      // Staging is a trustworthy base only if it is what this folder
      // was last synced to. Another tool syncing the folder breaks that.
      const baseKnown = await hasKnownBase(checkout, this.store);
      if (!record) {
        this.log.info(`${checkout.name}: no record yet; adopting the ${fleet} fleet.`);
      } else if (!baseKnown) {
        this.log.info(`${checkout.name}: synced elsewhere since our last pull; base unknown.`);
      }

      const pull = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pulling ${checkout.name}…`,
          cancellable: true,
        },
        async (progress, token) => {
          if (baseKnown) await linkTree(staging, base);
          else await rm(staging, { recursive: true, force: true });
          progress.report({ message: "fetching from the cloud" });
          let result;
          try {
            result = await this.cloud.run(
              ["workspace", "get", staging, "--workspace", checkout.name],
              {
                bearer,
                cwd: folder,
                token,
              },
            );
          } catch (err) {
            if (baseKnown) await replaceDir(base, staging);
            throw err;
          }
          if (result.returnCode !== 0 || !result.workspaceSnapshotId) {
            if (baseKnown) await replaceDir(base, staging);
            throw new Error(`Pulling ${checkout.name} failed; see the log.`);
          }
          progress.report({ message: "comparing" });
          const [baseManifest, cloudManifest, localManifest] = await Promise.all([
            baseKnown ? workspaceManifest(nodeFileHost, base) : Promise.resolve<Manifest>({}),
            workspaceManifest(nodeFileHost, staging),
            workspaceManifest(nodeFileHost, folder),
          ]);
          const staged: StagedPull = {
            checkout,
            staging,
            base,
            snapshotId: result.workspaceSnapshotId,
            baseKnown,
            changes: classifyChanges(baseManifest, cloudManifest, localManifest),
            resolved: new Set(),
          };
          return staged;
        },
      );

      if (this.pending(pull).length === 0) {
        await this.finish(pull);
        const local = pull.changes.filter((c) => c.kind === "local").length;
        void vscode.window.showInformationMessage(
          `${checkout.name} is up to date` +
            (local ? ` (${local} local change${local === 1 ? "" : "s"} kept).` : "."),
        );
        return;
      }
      this.current = pull;
      this.changed.fire();
      await vscode.commands.executeCommand("bacloud.changes.focus");
      if (!baseKnown) {
        void vscode.window.showWarningMessage(
          `${checkout.name} was last synced by another tool, so local and cloud changes can't be told apart. ` +
            "Every difference is listed as a conflict; review each one.",
        );
      }
    } finally {
      this.busy = false;
    }
  }

  /** A pull interrupted mid-way (e.g. window closed) leaves `base/`; roll back to it. */
  private async recoverInterrupted(staging: string, base: string): Promise<void> {
    if (await exists(base)) {
      this.log.warn("Found an unfinished pull; restoring its base.");
      await replaceDir(base, staging);
    }
  }

  // ---------------------------------------------------------------- //
  // Resolving changes.

  /** Make the local file match the cloud (copy, or delete). */
  async takeCloud(path: string): Promise<void> {
    const pull = this.require();
    const target = vscode.Uri.file(join(pull.checkout.folder.uri.fsPath, path));
    const source = vscode.Uri.file(join(pull.staging, path));
    if (await exists(source.fsPath)) {
      // Through workspace.fs so open editors refresh (or, with unsaved
      // edits, get VS Code's own "file changed on disk" prompt).
      await vscode.workspace.fs.copy(source, target, { overwrite: true });
    } else if (await exists(target.fsPath)) {
      await vscode.workspace.fs.delete(target, { useTrash: true });
    }
    await this.resolve(path);
  }

  /**
   * Open VS Code's 3-way merge editor: base (last sync), cloud and a
   * snapshot of the local file, writing the result into the local file.
   * The user marks the conflict resolved afterwards (Keep Local).
   */
  async merge(change: Change): Promise<void> {
    const pull = this.require();
    if (!mergeable(change)) throw new Error(`${change.path} can't be merged: one side deleted it.`);
    const folder = pull.checkout.folder.uri.fsPath;
    const output = vscode.Uri.file(join(folder, change.path));
    // The merge writes into the local file, so the "local" input must be
    // a snapshot taken before it starts.
    const snapshot = join(mergeDir(pull), change.path);
    await mkdir(dirname(snapshot), { recursive: true });
    await copyFile(output.fsPath, snapshot);

    // The fragment keeps cached documents from an earlier pull out.
    const side = (root: string | undefined) =>
      vscode.Uri.from({
        scheme: CLOUD_SCHEME,
        path: `/${change.path}`,
        query: root ?? "",
        fragment: pull.snapshotId,
      });
    const hasBase =
      pull.baseKnown && change.kind === "conflict" && change.reason === "both-modified";
    try {
      await vscode.commands.executeCommand("_open.mergeEditor", {
        base: side(hasBase ? pull.base : undefined),
        input1: {
          uri: side(pull.staging),
          title: "Cloud",
          description: pull.checkout.name,
          detail: "incoming",
        },
        input2: {
          uri: side(mergeDir(pull)),
          title: "Local",
          description: "your version",
          detail: "current",
        },
        output,
      });
    } catch (err) {
      // The merge editor is reached through an internal command; fall
      // back to a plain diff if this VS Code doesn't have it.
      this.log.warn(`Merge editor unavailable (${String(err)}); showing a diff instead.`);
      await openChangeDiff(pull.staging, folder, change);
      return;
    }
    void vscode.window.showInformationMessage(
      `Merge ${change.path}, save it, then click "Keep Local" in Incoming Changes to mark it resolved.`,
    );
  }

  async keepLocal(path: string): Promise<void> {
    await this.resolve(path);
  }

  async applyAllIncoming(): Promise<void> {
    const pull = this.require();
    for (const change of this.pending(pull)) {
      if (change.kind === "incoming") await this.takeCloud(change.path);
    }
  }

  /** Abandon the review. Applied files stay; the folder keeps its old snapshot id. */
  async discard(): Promise<void> {
    const pull = this.require();
    if (pull.baseKnown) await replaceDir(pull.base, pull.staging);
    else await rm(pull.staging, { recursive: true, force: true });
    await rm(mergeDir(pull), { recursive: true, force: true });
    this.current = undefined;
    this.changed.fire();
  }

  private async resolve(path: string): Promise<void> {
    const pull = this.require();
    pull.resolved.add(path);
    if (this.pending(pull).length === 0) {
      await this.finish(pull);
      void vscode.window.showInformationMessage(`${pull.checkout.name} is up to date.`);
    }
    this.changed.fire();
  }

  /** Everything resolved: the folder now corresponds to snapshot B. */
  private async finish(pull: StagedPull): Promise<void> {
    const folder = pull.checkout.folder.uri.fsPath;
    await updateWorkspaceState(nodeFileHost, folder, {
      snapshotid: pull.snapshotId,
      name: pull.checkout.name,
    });
    await this.store.write({
      path: folder,
      fleet: currentFleet(),
      workspace: pull.checkout.name,
      snapshotId: pull.snapshotId,
      syncedAt: new Date().toISOString(),
    });
    await rm(pull.base, { recursive: true, force: true });
    await rm(mergeDir(pull), { recursive: true, force: true });
    this.current = undefined;
    await this.rescan();
    this.changed.fire();
  }

  private require(): StagedPull {
    if (!this.current) throw new Error("No pull is waiting for review.");
    return this.current;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
