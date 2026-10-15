import * as vscode from "vscode";
import { BacloudError, BacloudSessionError } from "@bacloud/sdk";
import { Auth } from "./auth.ts";
import { ChangesView, CLOUD_SCHEME, CloudContentProvider, type ChangeNode } from "./changesView.ts";
import { cloneWorkspace } from "./clone.ts";
import { CurrentWorkspaceView } from "./currentView.ts";
import { Cloud } from "./cloud.ts";
import { CheckoutTracker, FolderStore } from "./folders.ts";
import { PullManager } from "./pull.ts";
import { PushManager } from "./push.ts";
import { CheckoutStatusBar } from "./statusBar.ts";
import { WorkspacesView, type WorkspaceNode } from "./workspacesView.ts";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Ballistica", { log: true });
  const cloud = new Cloud(log);
  const auth = new Auth(context.secrets, cloud);
  const workspaces = new WorkspacesView(cloud, auth);
  const store = new FolderStore(context.globalStorageUri);
  const tracker = new CheckoutTracker(store);
  const rescan = () => tracker.rescan();
  const pulls = new PullManager({ cloud, auth, store, log, rescan });
  const pushes = new PushManager({ cloud, auth, store, pulls, log, rescan });
  const changes = new ChangesView(pulls);
  const statusBar = new CheckoutStatusBar(tracker, pulls);

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

  const pickCheckout = async (folder: vscode.Uri | undefined, title: string) => {
    let checkout = folder ? tracker.find(folder) : statusBar.current();
    if (!checkout && tracker.all.length > 1) {
      const picked = await vscode.window.showQuickPick(
        tracker.all.map((c) => ({ label: c.name, description: c.folder.uri.fsPath, checkout: c })),
        { title },
      );
      checkout = picked?.checkout;
    }
    if (!checkout && tracker.all.length === 0) {
      throw new Error("No open folder is a Ballistica cloud workspace.");
    }
    return checkout;
  };
  const pull = async (folder?: vscode.Uri) => {
    const checkout = await pickCheckout(folder, "Pull which workspace?");
    if (checkout) await pulls.pull(checkout);
  };
  const push = async (folder?: vscode.Uri) => {
    const checkout = await pickCheckout(folder, "Push which workspace?");
    if (checkout) await pushes.push(checkout);
  };
  /** Tree inline actions pass a node; the palette passes nothing. */
  const changePath = (node?: ChangeNode) => {
    if (node?.type !== "change") throw new Error("Pick a file in Incoming Changes.");
    return node.change.path;
  };

  context.subscriptions.push(
    log,
    auth,
    workspaces,
    tracker,
    pulls,
    changes,
    statusBar,
    vscode.window.registerTreeDataProvider(
      "bacloud.current",
      new CurrentWorkspaceView(tracker, pulls),
    ),
    vscode.window.registerTreeDataProvider("bacloud.workspaces", workspaces),
    vscode.window.registerTreeDataProvider("bacloud.changes", changes),
    vscode.workspace.registerTextDocumentContentProvider(CLOUD_SCHEME, new CloudContentProvider()),
    command("bacloud.signIn", () => auth.signIn()),
    command("bacloud.signOut", () => auth.signOut()),
    command("bacloud.refreshWorkspaces", () => workspaces.refresh()),
    command("bacloud.clone", clone),
    command("bacloud.pull", pull),
    command("bacloud.push", push),
    command("bacloud.openChange", (node?: ChangeNode) =>
      node?.type === "change" ? changes.open(node.change) : undefined,
    ),
    command("bacloud.takeCloud", (node?: ChangeNode) => pulls.takeCloud(changePath(node))),
    command("bacloud.keepLocal", (node?: ChangeNode) => pulls.keepLocal(changePath(node))),
    command("bacloud.applyAllIncoming", () => pulls.applyAllIncoming()),
    command("bacloud.discardPull", () => pulls.discard()),
    command("bacloud.showPanel", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.ballistica");
    }),
    command("bacloud.showLog", () => log.show()),
  );
  void auth.refreshContext();
  void tracker.rescan();
}

export function deactivate(): void {}
