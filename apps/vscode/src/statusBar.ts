/**
 * `☁ Workspace1 · synced 5m ago` for the checkout holding the active
 * editor (or the window's only checkout).
 */

import * as vscode from "vscode";
import { currentFleet } from "./cloud.ts";
import type { Checkout, CheckoutTracker } from "./folders.ts";
import type { PullManager } from "./pull.ts";

export function timeAgo(date: Date, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export class CheckoutStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    "bacloud.checkout",
    vscode.StatusBarAlignment.Left,
    50,
  );
  private readonly tracker: CheckoutTracker;
  private readonly pulls: PullManager;
  private readonly subscriptions: vscode.Disposable[];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(tracker: CheckoutTracker, pulls: PullManager) {
    this.tracker = tracker;
    this.pulls = pulls;
    this.item.name = "Ballistica Cloud";
    this.subscriptions = [
      tracker.onDidChange(() => this.update()),
      pulls.onDidChange(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("bacloud.fleet")) this.update();
      }),
    ];
    // Keep "synced 5m ago" honest.
    this.timer = setInterval(() => this.update(), 60_000);
    this.update();
  }

  /** The checkout the status bar is about; also the default pull target. */
  current(): Checkout | undefined {
    const active = this.tracker.find(vscode.window.activeTextEditor?.document.uri);
    if (active) return active;
    return this.tracker.all.length === 1 ? this.tracker.all[0] : undefined;
  }

  update(): void {
    const checkout = this.current();
    if (!checkout) {
      this.item.hide();
      return;
    }
    const { name, error, record, stateModified } = checkout;
    const tooltip = new vscode.MarkdownString(`**${name}** · Ballistica cloud workspace\n\n`);
    this.item.backgroundColor = undefined;
    this.item.command = {
      command: "bacloud.pull",
      title: "Pull",
      arguments: [checkout.folder.uri],
    };

    const staged = this.pulls.staged;
    if (staged && staged.checkout.folder === checkout.folder) {
      const pending = this.pulls.pending(staged);
      const conflicts = pending.filter((c) => c.kind === "conflict").length;
      const incoming = pending.length - conflicts;
      const parts = [
        incoming && `${incoming} incoming`,
        conflicts && `${conflicts} conflict${conflicts === 1 ? "" : "s"}`,
      ];
      this.item.text = `$(cloud-download) ${name} · ${parts.filter(Boolean).join(", ")}`;
      if (conflicts)
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.command = "bacloud.changes.focus";
      this.item.tooltip = tooltip.appendText(
        "A pull is waiting for review. Click to open Incoming Changes.",
      );
      this.item.show();
      return;
    }

    if (error) {
      this.item.text = `$(warning) ${name}`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      tooltip.appendText(error);
    } else if (record && record.fleet !== currentFleet()) {
      this.item.text = `$(warning) ${name} · ${record.fleet}`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      tooltip.appendText(
        `Cloned from the ${record.fleet} fleet, but the bacloud.fleet setting is ${currentFleet()}. ` +
          "Pulls are refused until they match.",
      );
    } else {
      const synced = record ? new Date(record.syncedAt) : stateModified;
      this.item.text = `$(cloud) ${name}${synced ? ` · synced ${timeAgo(synced)}` : ""}`;
      tooltip.appendMarkdown(
        [
          `Fleet: ${record?.fleet ?? `${currentFleet()} (assumed)`}`,
          `Snapshot: \`${checkout.state?.snapshotid ?? "unknown"}\``,
          synced ? `Last sync: ${synced.toLocaleString()}` : undefined,
          record ? undefined : "_Synced by another tool; the next pull rebuilds its base copy._",
          "Click to pull.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
    this.item.tooltip = tooltip;
    this.item.show();
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const s of this.subscriptions) s.dispose();
    this.item.dispose();
  }
}
