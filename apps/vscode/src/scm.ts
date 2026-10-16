/**
 * A Source Control provider per checkout: local changes since the last
 * sync, the way VS Code shows them for git.
 *
 * - **Source Control view**: a "Ballistica" repository per checkout with
 *   a *Local Changes* group (added / modified / deleted since the last
 *   pull, clone or push); click a file for a last-sync ↔ local diff.
 * - **Gutter (quick diff)**: change bars in the editor against the
 *   last-sync copy. In a folder that is also a git repo, VS Code shows
 *   both providers' bars (git's win where they overlap) and lets the
 *   user toggle each from the gutter's context menu.
 *
 * "Last sync" is the folder's staging copy, which only counts when it
 * is known to match the folder's snapshot id; otherwise (synced by
 * another tool) nothing is listed until the next pull.
 */

import { join, relative, sep } from "node:path";
import * as vscode from "vscode";
import {
  classifyChanges,
  isLocalOnly,
  workspaceManifest,
  type Change,
  type Manifest,
} from "@bacloud/sdk";
import { nodeFileHost } from "@bacloud/sdk/node";
import { CLOUD_SCHEME } from "./changesView.ts";
import { hasKnownBase, type Checkout, type CheckoutTracker, type FolderStore } from "./folders.ts";

const REFRESH_DELAY_MS = 400;

const LABELS = { added: "Added", modified: "Modified", deleted: "Deleted" } as const;
const ICONS = { added: "diff-added", modified: "diff-modified", deleted: "diff-removed" } as const;
const COLORS = {
  added: "gitDecoration.addedResourceForeground",
  modified: "gitDecoration.modifiedResourceForeground",
  deleted: "gitDecoration.deletedResourceForeground",
} as const;

class CheckoutScm implements vscode.Disposable {
  checkout: Checkout;
  private readonly store: FolderStore;
  private readonly sc: vscode.SourceControl;
  private readonly group: vscode.SourceControlResourceGroup;
  private readonly watcher: vscode.FileSystemWatcher;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Base manifest, cached until the staging copy changes (a sync). */
  private base: Manifest | undefined;
  private baseKnown = false;
  private refreshing: Promise<void> | undefined;
  private again = false;

  constructor(checkout: Checkout, store: FolderStore) {
    this.checkout = checkout;
    this.store = store;
    this.sc = vscode.scm.createSourceControl(
      "ballistica",
      `Ballistica · ${checkout.name}`,
      checkout.folder.uri,
    );
    // No commit message: syncing is Pull / Push.
    this.sc.inputBox.visible = false;
    this.group = this.sc.createResourceGroup("local", "Local Changes");
    this.sc.quickDiffProvider = { provideOriginalResource: (uri) => this.originalResource(uri) };
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(checkout.folder, "**/*"),
    );
    const changed = () => this.scheduleRefresh();
    this.watcher.onDidCreate(changed);
    this.watcher.onDidChange(changed);
    this.watcher.onDidDelete(changed);
  }

  private get folder(): string {
    return this.checkout.folder.uri.fsPath;
  }

  private get staging(): string {
    return this.store.stagingDir(this.folder);
  }

  /** After a sync the base itself may have changed. */
  syncChanged(checkout: Checkout): void {
    this.checkout = checkout;
    this.base = undefined;
    this.scheduleRefresh(0);
  }

  scheduleRefresh(delay = REFRESH_DELAY_MS): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  /** Recompute; overlapping requests coalesce into one more pass. */
  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.again = false;
        try {
          await this.compute();
        } catch {
          // Files changing mid-hash; the watcher will schedule another pass.
        }
      } while (this.again);
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  private async compute(): Promise<void> {
    if (this.base === undefined) {
      this.baseKnown = await hasKnownBase(this.checkout, this.store);
      this.base = this.baseKnown ? await workspaceManifest(nodeFileHost, this.staging) : {};
    }
    if (!this.baseKnown) {
      this.group.resourceStates = [];
      this.sc.count = 0;
      return;
    }
    const local = await workspaceManifest(nodeFileHost, this.folder);
    // With the base on both sides, every difference is a local change.
    const changes = classifyChanges(this.base, this.base, local);
    this.group.resourceStates = changes.map((change) => this.resourceState(change));
    this.sc.count = changes.length;
  }

  private resourceState(change: Change): vscode.SourceControlResourceState {
    const edit = change.kind === "conflict" ? "modified" : change.edit;
    return {
      resourceUri: vscode.Uri.file(join(this.folder, change.path)),
      command: {
        command: "bacloud.openLocalChange",
        title: "Compare with Last Sync",
        arguments: [this.staging, this.folder, change],
      },
      decorations: {
        tooltip: `${LABELS[edit]} since the last sync`,
        strikeThrough: edit === "deleted",
        faded: edit === "deleted",
        iconPath: new vscode.ThemeIcon(ICONS[edit], new vscode.ThemeColor(COLORS[edit])),
      },
      contextValue: edit,
    };
  }

  /** The last-sync copy of a file, for gutter change bars. */
  private originalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== "file" || !this.baseKnown || !this.base) return undefined;
    const rel = relative(this.folder, uri.fsPath).split(sep).join("/");
    if (rel.startsWith("..") || isLocalOnly(rel) || !(rel in this.base)) return undefined;
    return vscode.Uri.from({
      scheme: CLOUD_SCHEME,
      path: `/${rel}`,
      query: this.staging,
      // Changes per sync, so a cached document never outlives its base.
      fragment: this.checkout.state?.snapshotid ?? "",
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher.dispose();
    this.sc.dispose();
  }
}

/** Keeps one provider per tracked checkout. */
export class ScmProviders implements vscode.Disposable {
  private readonly providers = new Map<string, CheckoutScm>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(tracker: CheckoutTracker, store: FolderStore) {
    const sync = () => {
      const seen = new Set<string>();
      for (const checkout of tracker.all) {
        const key = checkout.folder.uri.toString();
        seen.add(key);
        const existing = this.providers.get(key);
        if (existing) existing.syncChanged(checkout);
        else {
          const scm = new CheckoutScm(checkout, store);
          this.providers.set(key, scm);
          scm.scheduleRefresh(0);
        }
      }
      for (const [key, scm] of this.providers) {
        if (!seen.has(key)) {
          scm.dispose();
          this.providers.delete(key);
        }
      }
    };
    // The tracker rescans after every clone, pull and push.
    this.subscriptions = [tracker.onDidChange(sync)];
    sync();
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    for (const scm of this.providers.values()) scm.dispose();
    this.providers.clear();
  }
}
