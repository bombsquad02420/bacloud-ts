/**
 * Local Changes: files changed since the last sync, in the Ballistica
 * container. Same data as the Source Control provider (scm.ts), shown
 * next to Current Workspace instead of in the shared Source Control
 * view.
 */

import { posix } from "node:path";
import * as vscode from "vscode";
import type { Change, Edit } from "@bacloud/sdk";
import type { CheckoutScm, ScmProviders } from "./scm.ts";

type Node =
  | { type: "checkout"; scm: CheckoutScm }
  | { type: "change"; scm: CheckoutScm; change: Change };

const ICONS: Record<Edit, [string, string]> = {
  added: ["diff-added", "gitDecoration.addedResourceForeground"],
  modified: ["diff-modified", "gitDecoration.modifiedResourceForeground"],
  deleted: ["diff-removed", "gitDecoration.deletedResourceForeground"],
};

export class LocalChangesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly providers: ScmProviders;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(providers: ScmProviders) {
    this.providers = providers;
    this.subscription = providers.onDidChange(() => {
      const count = providers.all.reduce((n, scm) => n + scm.changes.length, 0);
      void vscode.commands.executeCommand("setContext", "bacloud.hasLocalChanges", count > 0);
      this.changed.fire();
    });
  }

  getChildren(node?: Node): Node[] {
    const withChanges = this.providers.all.filter((scm) => scm.changes.length > 0);
    if (!node) {
      // One checkout: list its files directly; several: group by checkout.
      if (withChanges.length === 1) return this.changesOf(withChanges[0]!);
      return withChanges.map((scm) => ({ type: "checkout", scm }));
    }
    return node.type === "checkout" ? this.changesOf(node.scm) : [];
  }

  private changesOf(scm: CheckoutScm): Node[] {
    return scm.changes.map((change) => ({ type: "change", scm, change }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === "checkout") {
      const item = new vscode.TreeItem(
        node.scm.checkout.name,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon("cloud");
      item.description = `${node.scm.changes.length}`;
      return item;
    }
    const { change, scm } = node;
    const edit: Edit = change.kind === "conflict" ? "modified" : change.edit;
    const [icon, color] = ICONS[edit];
    const item = new vscode.TreeItem(posix.basename(change.path));
    const dir = posix.dirname(change.path);
    item.description = dir === "." ? edit : `${dir} · ${edit}`;
    item.tooltip = `${change.path}: ${edit} since the last sync`;
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.contextValue = `local-${edit}`;
    item.command = {
      command: "bacloud.openLocalChange",
      title: "Compare with Last Sync",
      arguments: [scm.staging, scm.folder, change],
    };
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
