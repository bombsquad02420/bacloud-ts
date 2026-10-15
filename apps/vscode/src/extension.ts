import * as vscode from "vscode";
import { BacloudError, BacloudSessionError } from "@bacloud/sdk";
import { Auth } from "./auth.ts";
import { Cloud } from "./cloud.ts";
import { WorkspacesView } from "./workspacesView.ts";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Ballistica", { log: true });
  const cloud = new Cloud(log);
  const auth = new Auth(context.secrets, cloud);
  const workspaces = new WorkspacesView(cloud, auth);

  /** Report command failures without dumping stack traces on users. */
  const command = (id: string, fn: () => Promise<void> | void) =>
    vscode.commands.registerCommand(id, async () => {
      try {
        await fn();
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

  context.subscriptions.push(
    log,
    auth,
    workspaces,
    vscode.window.registerTreeDataProvider("bacloud.workspaces", workspaces),
    command("bacloud.signIn", () => auth.signIn()),
    command("bacloud.signOut", () => auth.signOut()),
    command("bacloud.refreshWorkspaces", () => workspaces.refresh()),
    command("bacloud.showLog", () => log.show()),
  );
  void auth.refreshContext();
}

export function deactivate(): void {}
