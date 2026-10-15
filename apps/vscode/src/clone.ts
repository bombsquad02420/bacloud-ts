/**
 * Clone: a pull into an empty folder.
 *
 * `get` runs into the folder's staging copy (which becomes the base for
 * future pulls), then the files are copied into the new folder.
 */

import { cp, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { updateWorkspaceState } from "@bacloud/sdk";
import { nodeFileHost } from "@bacloud/sdk/node";
import type { Auth } from "./auth.ts";
import { currentFleet, type Cloud } from "./cloud.ts";
import type { FolderStore } from "./folders.ts";

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return true;
  }
}

export async function cloneWorkspace(
  name: string,
  deps: { cloud: Cloud; auth: Auth; store: FolderStore },
): Promise<void> {
  const bearer = await deps.auth.token();
  if (bearer === undefined) throw new Error("Sign in to Ballistica first.");

  const picked = await vscode.window.showOpenDialog({
    title: `Clone ${name} into…`,
    openLabel: "Clone here",
    canSelectFiles: false,
    canSelectFolders: true,
    defaultUri: vscode.workspace.workspaceFolders?.[0]
      ? vscode.Uri.file(dirname(vscode.workspace.workspaceFolders[0].uri.fsPath))
      : undefined,
  });
  if (!picked?.[0]) return;
  const target = join(picked[0].fsPath, name);
  if (!(await isEmptyOrMissing(target))) {
    throw new Error(`${target} already exists and is not empty.`);
  }

  const fleet = currentFleet();
  const staging = deps.store.stagingDir(target);
  const snapshotId = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Cloning ${name}…`,
      cancellable: true,
    },
    async (progress, token) => {
      await rm(staging, { recursive: true, force: true });
      progress.report({ message: "downloading" });
      const result = await deps.cloud.run(["workspace", "get", staging, "--workspace", name], {
        bearer,
        cwd: picked[0]!.fsPath,
        token,
      });
      if (result.returnCode !== 0) throw new Error(`Cloning ${name} failed; see the log.`);
      if (!result.workspaceSnapshotId) throw new Error("The server did not report a snapshot id.");
      progress.report({ message: "copying" });
      await cp(staging, target, { recursive: true, errorOnExist: true, force: false });
      await updateWorkspaceState(nodeFileHost, target, {
        snapshotid: result.workspaceSnapshotId,
        name,
      });
      return result.workspaceSnapshotId;
    },
  );
  await deps.store.write({
    path: target,
    fleet,
    workspace: name,
    snapshotId,
    syncedAt: new Date().toISOString(),
  });

  const choice = await vscode.window.showInformationMessage(
    `Cloned ${name} to ${target}.`,
    "Open",
    "Open in New Window",
    "Add to Workspace",
  );
  const uri = vscode.Uri.file(target);
  if (choice === "Open") await vscode.commands.executeCommand("vscode.openFolder", uri);
  else if (choice === "Open in New Window") {
    await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
  } else if (choice === "Add to Workspace") {
    const count = vscode.workspace.workspaceFolders?.length ?? 0;
    vscode.workspace.updateWorkspaceFolders(count, 0, { uri });
  }
}
