/**
 * Which open folders are bacloud checkouts, and what we know about them.
 *
 * A folder is a checkout when its root has a `.bacloudstate.json`. That
 * file is shared with other tools and can't hold our data, so the
 * extension keeps a record per folder in its own storage (fleet, last
 * sync) next to the folder's staging copy used by pulls.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import * as vscode from "vscode";
import {
  readWorkspaceState,
  WORKSPACE_STATE_FILENAME,
  WorkspaceStateError,
  type Fleet,
  type WorkspaceState,
} from "@bacloud/sdk";
import { nodeFileHost } from "@bacloud/sdk/node";

export interface FolderRecord {
  /** Absolute folder path the record belongs to. */
  path: string;
  fleet: Fleet;
  workspace: string;
  snapshotId: string;
  /** ISO time of the last successful clone or pull. */
  syncedAt: string;
}

/** Per-folder extension storage: `record.json` and `staging/`. */
export class FolderStore {
  private readonly root: string;

  constructor(globalStorage: vscode.Uri) {
    this.root = join(globalStorage.fsPath, "folders");
  }

  dirFor(folder: string): string {
    const id = createHash("sha256").update(folder).digest("hex").slice(0, 16);
    return join(this.root, id);
  }

  stagingDir(folder: string): string {
    return join(this.dirFor(folder), "staging");
  }

  /** The previous sync, hard-linked from staging while a pull is open. */
  baseDir(folder: string): string {
    return join(this.dirFor(folder), "base");
  }

  async read(folder: string): Promise<FolderRecord | undefined> {
    try {
      const record = JSON.parse(
        await readFile(join(this.dirFor(folder), "record.json"), "utf8"),
      ) as FolderRecord;
      // Hash collisions or a stale record from a moved folder.
      return record.path === folder ? record : undefined;
    } catch {
      return undefined;
    }
  }

  async write(record: FolderRecord): Promise<void> {
    const dir = this.dirFor(record.path);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "record.json");
    await writeFile(`${file}.tmp`, JSON.stringify(record, null, 2));
    await rename(`${file}.tmp`, file);
  }
}

export interface Checkout {
  folder: vscode.WorkspaceFolder;
  /** Cloud workspace name: the state file's `name`, else the folder name. */
  name: string;
  state: WorkspaceState | undefined;
  /** Set when the state file exists but can't be used. */
  error: string | undefined;
  record: FolderRecord | undefined;
  /** When the state file last changed (fallback for "synced …"). */
  stateModified: Date | undefined;
}

/**
 * Whether the folder's staging copy is exactly what it was last synced
 * to, i.e. a trustworthy base for telling local edits from cloud ones.
 * Another tool syncing the folder breaks that.
 */
export async function hasKnownBase(checkout: Checkout, store: FolderStore): Promise<boolean> {
  // Read fresh: the tracker's copy can lag a sync that just happened.
  const folder = checkout.folder.uri.fsPath;
  const record = await store.read(folder);
  const state = await readWorkspaceState(nodeFileHost, folder).catch(() => undefined);
  if (!record || state?.snapshotid === undefined || record.snapshotId !== state.snapshotid)
    return false;
  return stat(store.stagingDir(folder)).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** Tracks checkouts among the window's workspace folders. */
export class CheckoutTracker implements vscode.Disposable {
  private readonly store: FolderStore;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private checkouts: Checkout[] = [];
  private watchers: vscode.Disposable[] = [];
  private readonly subscriptions: vscode.Disposable[];

  constructor(store: FolderStore) {
    this.store = store;
    this.subscriptions = [
      this.changed,
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rescan()),
    ];
  }

  get all(): readonly Checkout[] {
    return this.checkouts;
  }

  /** The checkout containing `uri`, if any. */
  find(uri: vscode.Uri | undefined): Checkout | undefined {
    if (!uri) return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return this.checkouts.find((c) => c.folder === folder);
  }

  async rescan(): Promise<void> {
    for (const w of this.watchers) w.dispose();
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (f) => f.uri.scheme === "file",
    );
    // Watch for the state file appearing, changing or going away (a
    // clone or pull by another tool, or the user deleting it).
    this.watchers = folders.map((folder) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, WORKSPACE_STATE_FILENAME),
      );
      const rescan = () => void this.rescan();
      watcher.onDidCreate(rescan);
      watcher.onDidChange(rescan);
      watcher.onDidDelete(rescan);
      return watcher;
    });
    const found = await Promise.all(folders.map((folder) => this.inspect(folder)));
    this.checkouts = found.filter((c): c is Checkout => c !== undefined);
    await vscode.commands.executeCommand(
      "setContext",
      "bacloud.inCheckout",
      this.checkouts.length > 0,
    );
    this.changed.fire();
  }

  private async inspect(folder: vscode.WorkspaceFolder): Promise<Checkout | undefined> {
    const path = folder.uri.fsPath;
    let state: WorkspaceState | undefined;
    let error: string | undefined;
    try {
      state = await readWorkspaceState(nodeFileHost, path);
      if (state === undefined) return undefined;
    } catch (err) {
      if (!(err instanceof WorkspaceStateError)) throw err;
      error = err.message;
    }
    const stateModified = await stat(join(path, WORKSPACE_STATE_FILENAME)).then(
      (s) => s.mtime,
      () => undefined,
    );
    return {
      folder,
      name: state?.name ?? basename(path),
      state,
      error,
      record: await this.store.read(path),
      stateModified,
    };
  }

  dispose(): void {
    for (const w of this.watchers) w.dispose();
    for (const s of this.subscriptions) s.dispose();
  }
}
