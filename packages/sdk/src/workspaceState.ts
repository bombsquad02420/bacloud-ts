/**
 * The per-checkout `.bacloudstate.json` file.
 *
 * Several tools write this file (ballistica's `tools/bacloud`, this
 * SDK, the VS Code extension), so writes merge into whatever is there
 * and keep keys they don't know. A file that exists but can't be read
 * is an error, never "no state": treating it as absent would silently
 * drop the put collision guard.
 */

import type { FileHost } from "./host.ts";

/**
 * Per-checkout file recording the snapshot id we last synced to. A
 * dotfile, so workspace syncs ignore it.
 */
export const WORKSPACE_STATE_FILENAME = ".bacloudstate.json";

export interface WorkspaceState {
  /** Cloud snapshot the folder was last synced to. */
  snapshotid?: string;
  /** Cloud workspace name; when absent, the folder's name is used. */
  name?: string;
  [key: string]: unknown;
}

export class WorkspaceStateError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path} is unreadable (${reason}). Re-get the workspace, or delete the file.`);
    this.name = "WorkspaceStateError";
    this.path = path;
  }
}

export function workspaceStatePath(dir: string): string {
  return dir.endsWith("/") ? dir + WORKSPACE_STATE_FILENAME : `${dir}/${WORKSPACE_STATE_FILENAME}`;
}

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * Read a folder's state. `undefined` when there is no file; throws
 * {@link WorkspaceStateError} when there is one but it is unusable.
 */
export async function readWorkspaceState(
  fs: FileHost,
  dir: string,
): Promise<WorkspaceState | undefined> {
  const path = workspaceStatePath(dir);
  let data: Uint8Array;
  try {
    data = await fs.readFile(path);
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw new WorkspaceStateError(path, String(err));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new WorkspaceStateError(path, "not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WorkspaceStateError(path, "not a JSON object");
  }
  const state = parsed as WorkspaceState;
  for (const key of ["snapshotid", "name"] as const) {
    if (state[key] !== undefined && typeof state[key] !== "string") {
      throw new WorkspaceStateError(path, `'${key}' is not a string`);
    }
  }
  return state;
}

/**
 * Merge `patch` into a folder's state, keeping every other key. A
 * corrupt existing file is replaced (callers only write after a
 * successful sync, so the new content is authoritative).
 */
export async function updateWorkspaceState(
  fs: FileHost,
  dir: string,
  patch: WorkspaceState,
): Promise<WorkspaceState> {
  let current: WorkspaceState = {};
  try {
    current = (await readWorkspaceState(fs, dir)) ?? {};
  } catch (err) {
    if (!(err instanceof WorkspaceStateError)) throw err;
  }
  const next = { ...current, ...patch };
  await fs.writeFile(workspaceStatePath(dir), new TextEncoder().encode(JSON.stringify(next)));
  return next;
}
