/**
 * Current Workspace: the cloud checkouts open in this window, with
 * their sync status, details and actions.
 */

import * as vscode from "vscode";
import { currentFleet } from "./cloud.ts";
import type { Checkout, CheckoutTracker } from "./folders.ts";
import type { PullManager } from "./pull.ts";
import { timeAgo } from "./statusBar.ts";

type Node = { type: "checkout"; checkout: Checkout } | { type: "row"; item: vscode.TreeItem };

function row(
  label: string,
  icon: string,
  options: {
    description?: string;
    tooltip?: string;
    command?: vscode.Command;
    color?: string;
  } = {},
): Node {
  const item = new vscode.TreeItem(label);
  item.iconPath = new vscode.ThemeIcon(
    icon,
    options.color ? new vscode.ThemeColor(options.color) : undefined,
  );
  item.description = options.description;
  item.tooltip = options.tooltip;
  item.command = options.command;
  return { type: "row", item };
}

export class CurrentWorkspaceView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly tracker: CheckoutTracker;
  private readonly pulls: PullManager;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(tracker: CheckoutTracker, pulls: PullManager) {
    this.tracker = tracker;
    this.pulls = pulls;
    const refresh = () => this.changed.fire();
    this.subscriptions = [
      this.changed,
      tracker.onDidChange(refresh),
      pulls.onDidChange(refresh),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("bacloud.fleet")) refresh();
      }),
    ];
    // Keep "synced 5m ago" honest.
    this.timer = setInterval(refresh, 60_000);
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.tracker.all.map((checkout) => ({ type: "checkout", checkout }));
    if (node.type === "checkout") return this.details(node.checkout);
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === "row") return node.item;
    const { checkout } = node;
    const item = new vscode.TreeItem(checkout.name, vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = new vscode.ThemeIcon("cloud");
    item.description = this.summary(checkout);
    item.tooltip = checkout.folder.uri.fsPath;
    item.contextValue = "checkout";
    return item;
  }

  /** One-line status, also used as the checkout's description. */
  private summary(checkout: Checkout): string {
    if (checkout.error) return "state file unreadable";
    if (checkout.record && checkout.record.fleet !== currentFleet())
      return `cloned from ${checkout.record.fleet}`;
    const staged = this.pulls.staged;
    if (staged?.checkout.folder === checkout.folder) {
      const pending = this.pulls.pending(staged).length;
      return `${pending} change${pending === 1 ? "" : "s"} to review`;
    }
    const synced = this.syncedAt(checkout);
    return synced ? `synced ${timeAgo(synced)}` : "";
  }

  private syncedAt(checkout: Checkout): Date | undefined {
    return checkout.record ? new Date(checkout.record.syncedAt) : checkout.stateModified;
  }

  private details(checkout: Checkout): Node[] {
    const rows: Node[] = [];
    const folder = checkout.folder.uri;
    const fleet = currentFleet();
    const staged = this.pulls.staged;
    const isStaged = staged?.checkout.folder === checkout.folder;

    // Status first, with the action it calls for.
    if (checkout.error) {
      rows.push(
        row("State file unreadable", "error", {
          tooltip: checkout.error,
          color: "errorForeground",
        }),
      );
    } else if (checkout.record && checkout.record.fleet !== fleet) {
      rows.push(
        row(`Cloned from ${checkout.record.fleet}`, "warning", {
          description: `fleet setting is ${fleet}`,
          tooltip: "Pulls are refused until the bacloud.fleet setting matches.",
          color: "list.warningForeground",
          command: {
            command: "workbench.action.openSettings",
            title: "Settings",
            arguments: ["bacloud.fleet"],
          },
        }),
      );
    } else if (isStaged) {
      const pending = this.pulls.pending(staged);
      const conflicts = pending.filter((c) => c.kind === "conflict").length;
      rows.push(
        row("Review incoming changes", "git-pull-request", {
          description: [
            pending.length - conflicts && `${pending.length - conflicts} incoming`,
            conflicts && `${conflicts} conflict${conflicts === 1 ? "" : "s"}`,
          ]
            .filter(Boolean)
            .join(", "),
          command: { command: "bacloud.changes.focus", title: "Review" },
          color: conflicts ? "list.warningForeground" : undefined,
        }),
      );
    } else {
      rows.push(
        row("Pull", "cloud-download", {
          description: "get cloud changes",
          command: { command: "bacloud.pull", title: "Pull", arguments: [folder] },
        }),
      );
    }

    const synced = this.syncedAt(checkout);
    rows.push(
      row("Last sync", "history", {
        description: synced ? `${timeAgo(synced)} · ${synced.toLocaleString()}` : "unknown",
        tooltip: checkout.record
          ? undefined
          : "Synced by another tool; the next pull rebuilds the base copy.",
      }),
      row("Fleet", "server", {
        description: checkout.record?.fleet ?? `${fleet} (assumed)`,
      }),
      row("Snapshot", "tag", { description: checkout.state?.snapshotid ?? "unknown" }),
      row("Folder", "folder", {
        description: folder.fsPath,
        command: { command: "revealFileInOS", title: "Reveal", arguments: [folder] },
      }),
    );
    return rows;
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const s of this.subscriptions) s.dispose();
  }
}
