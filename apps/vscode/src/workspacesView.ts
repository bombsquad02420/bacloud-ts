/**
 * The Cloud Workspaces view: the signed-in account's workspaces.
 */

import * as vscode from "vscode";
import { parseWorkspaceList, stripAnsi, type WorkspaceListing } from "@bacloud/sdk";
import type { Auth } from "./auth.ts";
import type { Cloud } from "./cloud.ts";

type Node =
  | { kind: "workspace"; listing: WorkspaceListing }
  | { kind: "message"; text: string; error: boolean };

export class WorkspacesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly cloud: Cloud;
  private readonly auth: Auth;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  /** Cached result; `undefined` means fetch on next render. */
  private nodes: Promise<Node[]> | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(cloud: Cloud, auth: Auth) {
    this.cloud = cloud;
    this.auth = auth;
    this.subscription = auth.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.nodes = undefined;
    this.changed.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "message") {
      const item = new vscode.TreeItem(node.text);
      item.iconPath = new vscode.ThemeIcon(node.error ? "error" : "info");
      item.tooltip = node.text;
      return item;
    }
    const { name, type, size, modified } = node.listing;
    const item = new vscode.TreeItem(name);
    item.description = `${type} · ${size} · ${modified}`;
    item.tooltip = new vscode.MarkdownString(
      `**${name}**\n\n${type} · ${size} · modified ${modified}`,
    );
    item.iconPath = new vscode.ThemeIcon("cloud");
    item.contextValue = "workspace";
    return item;
  }

  getChildren(node?: Node): Thenable<Node[]> | Node[] {
    if (node) return [];
    this.nodes ??= this.load();
    return this.nodes;
  }

  private async load(): Promise<Node[]> {
    const bearer = await this.auth.token();
    // Signed out: the welcome view takes over.
    if (bearer === undefined) return [];
    try {
      const { stdout } = await this.cloud.run(["workspace", "list"], { bearer });
      const listings = parseWorkspaceList(stdout);
      if (listings.length === 0)
        return [{ kind: "message", text: "No cloud workspaces yet.", error: false }];
      return listings.map((listing) => ({ kind: "workspace", listing }));
    } catch (err) {
      const text =
        stripAnsi(err instanceof Error ? err.message : String(err)).trim() ||
        "Could not list workspaces.";
      return [{ kind: "message", text, error: true }];
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
