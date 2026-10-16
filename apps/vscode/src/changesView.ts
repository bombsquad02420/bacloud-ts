/**
 * Incoming Changes: a staged pull, grouped into conflicts, incoming and
 * local-only changes. Clicking a file opens a cloud ↔ local diff.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import type { Change, ConflictReason, Edit } from "@bacloud/sdk";
import type { PullManager } from "./pull.ts";

/**
 * Read-only documents for the cloud side of a diff. The query holds the
 * staging folder to read from; an empty query stands in for a side
 * where the file doesn't exist.
 */
export const CLOUD_SCHEME = "bacloud-cloud";

export class CloudContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (!uri.query) return "";
    try {
      return await readFile(join(uri.query, uri.path), "utf8");
    } catch {
      return "";
    }
  }
}

/** Open a diff of `change`: the cloud copy in `staging` against the folder. */
export async function openChangeDiff(
  staging: string,
  folder: string,
  change: Change,
): Promise<void> {
  const local = vscode.Uri.file(join(folder, change.path));
  const cloud = vscode.Uri.from({ scheme: CLOUD_SCHEME, path: `/${change.path}`, query: staging });
  const missing = vscode.Uri.from({ scheme: CLOUD_SCHEME, path: `/${change.path}` });
  const { cloud: cloudExists, local: localExists } = sides(change);
  await vscode.commands.executeCommand(
    "vscode.diff",
    cloudExists ? cloud : missing,
    localExists ? local : missing,
    `${change.path} (Cloud ↔ Local)`,
    { preview: true },
  );
}

type Group = "conflict" | "incoming" | "local";
export type ChangeNode = { type: "group"; group: Group } | { type: "change"; change: Change };

const GROUP_LABELS: Record<Group, string> = {
  conflict: "Conflicts",
  incoming: "Incoming",
  local: "Local only (kept)",
};

const EDIT_ICONS: Record<Edit, string> = {
  added: "diff-added",
  modified: "diff-modified",
  deleted: "diff-removed",
};

const REASONS: Record<ConflictReason, string> = {
  "both-modified": "changed in both",
  "both-added": "added in both",
  "deleted-locally": "deleted locally, changed in cloud",
  "deleted-in-cloud": "changed locally, deleted in cloud",
};

/** Conflicts where both sides have the file, so a 3-way merge applies. */
export function mergeable(change: Change): boolean {
  return (
    change.kind === "conflict" &&
    (change.reason === "both-modified" || change.reason === "both-added")
  );
}

/** Which sides of a change have the file. */
export function sides(change: Change): { cloud: boolean; local: boolean } {
  switch (change.kind) {
    case "incoming":
      return { cloud: change.edit !== "deleted", local: change.edit !== "added" };
    case "local":
      return { cloud: change.edit !== "added", local: change.edit !== "deleted" };
    case "conflict":
      return {
        cloud: change.reason !== "deleted-in-cloud",
        local: change.reason !== "deleted-locally",
      };
  }
}

export class ChangesView implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable {
  private readonly pulls: PullManager;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(pulls: PullManager) {
    this.pulls = pulls;
    this.subscription = pulls.onDidChange(() => {
      void vscode.commands.executeCommand(
        "setContext",
        "bacloud.pullStaged",
        pulls.staged !== undefined,
      );
      this.changed.fire();
    });
  }

  private visible(group: Group): Change[] {
    const pull = this.pulls.staged;
    if (!pull) return [];
    return pull.changes.filter(
      (c) => c.kind === group && (group === "local" || !pull.resolved.has(c.path)),
    );
  }

  getChildren(node?: ChangeNode): ChangeNode[] {
    if (!node) {
      return (["conflict", "incoming", "local"] as const)
        .filter((group) => this.visible(group).length > 0)
        .map((group) => ({ type: "group", group }));
    }
    if (node.type === "group")
      return this.visible(node.group).map((change) => ({ type: "change", change }));
    return [];
  }

  getTreeItem(node: ChangeNode): vscode.TreeItem {
    if (node.type === "group") {
      const count = this.visible(node.group).length;
      const item = new vscode.TreeItem(
        `${GROUP_LABELS[node.group]} (${count})`,
        node.group === "local"
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = `group-${node.group}`;
      return item;
    }
    const { change } = node;
    const item = new vscode.TreeItem(change.path);
    if (change.kind === "conflict") {
      item.description = REASONS[change.reason];
      item.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("list.warningForeground"),
      );
      // Both sides have the file: it can be merged line by line.
      item.contextValue = mergeable(change) ? "conflict-merge" : "conflict";
    } else {
      item.description = change.edit;
      item.iconPath = new vscode.ThemeIcon(EDIT_ICONS[change.edit]);
      item.contextValue = change.kind === "incoming" ? "incoming" : "local-change";
    }
    item.tooltip = `${change.path}: ${item.description}`;
    item.command = { command: "bacloud.openChange", title: "Compare", arguments: [node] };
    return item;
  }

  /** Cloud on the left, local on the right. */
  async open(change: Change): Promise<void> {
    const pull = this.pulls.staged;
    if (pull) await openChangeDiff(pull.staging, pull.checkout.folder.uri.fsPath, change);
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
