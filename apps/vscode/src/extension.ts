import * as vscode from "vscode";
import { BacloudError, BacloudSessionError } from "@bacloud/sdk";
import { Auth } from "./auth.ts";
import { cloneWorkspace } from "./clone.ts";
import { Cloud } from "./cloud.ts";
import { CheckoutTracker, FolderStore } from "./folders.ts";
import { CheckoutStatusBar } from "./statusBar.ts";
import { WorkspacesView, type WorkspaceNode } from "./workspacesView.ts";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Ballistica", { log: true });
  const cloud = new Cloud(log);
  const auth = new Auth(context.secrets, cloud);
  const workspaces = new WorkspacesView(cloud, auth);
  const store = new FolderStore(context.globalStorageUri);
  const tracker = new CheckoutTracker(store);

  /** Report command failures without dumping stack traces on users. */
  const command = <A extends unknown[]>(id: string, fn: (...args: A) => Promise<void> | void) =>
    vscode.commands.registerCommand(id, async (...args: A) => {
      try {
        await fn(...args);
      } catch (err) {
        if (err instanceof vscode.CancellationError) return;
        const known = err instanceof BacloudError || err instanceof BacloudSessionError;
        const message = err instanceof Error ? err.message : String(err);
        log.error(message);
        if (!known && err instanceof Error && err.stack) log.error(err.stack);
        void vscode.window
          .showErrorMessage(`Ballistica: ${message || "command failed"}`, "Show Log")
          .then((pick) => {
            if (pick) log.show();
          });
      }
    });

  const clone = async (node?: WorkspaceNode) => {
    let name = node?.kind === "workspace" ? node.listing.name : undefined;
    name ??= await vscode.window.showQuickPick(workspaces.names(), {
      title: "Clone cloud workspace",
      placeHolder: "Workspace to clone",
    });
    if (name) await cloneWorkspace(name, { cloud, auth, store });
  };

  context.subscriptions.push(
    log,
    auth,
    workspaces,
    tracker,
    new CheckoutStatusBar(tracker),
    vscode.window.registerTreeDataProvider("bacloud.workspaces", workspaces),
    command("bacloud.signIn", () => auth.signIn()),
    command("bacloud.signOut", () => auth.signOut()),
    command("bacloud.refreshWorkspaces", () => workspaces.refresh()),
    command("bacloud.clone", clone),
    command("bacloud.showPanel", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.ballistica");
    }),
    command("bacloud.showLog", () => log.show()),
  );
  void auth.refreshContext();
  void tracker.rescan();
}

export function deactivate(): void {}
