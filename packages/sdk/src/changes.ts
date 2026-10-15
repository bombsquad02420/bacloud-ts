/**
 * Three-way comparison of a checkout against the cloud.
 *
 * ```
 *   C     local folder now
 *   |
 * B |     cloud now
 * | /
 * A       base: the cloud at the last sync
 * ```
 *
 * Comparing both sides to the common base tells "the cloud changed
 * this" apart from "you changed this", which a plain two-way diff
 * can't.
 */

import type { FileHost } from "./host.ts";
import { WORKSPACE_STATE_FILENAME } from "./workspaceState.ts";

export interface FileInfo {
  sha256: string;
  size: number;
}

/** Relative path (forward slashes) → content. */
export type Manifest = Record<string, FileInfo>;

/** What happened to a path on one side, relative to the base. */
export type Edit = "added" | "modified" | "deleted";

export type ConflictReason =
  /** Changed differently on both sides. */
  | "both-modified"
  /** Added on both sides with different content. */
  | "both-added"
  /** Deleted locally, modified in the cloud. */
  | "deleted-locally"
  /** Modified locally, deleted in the cloud. */
  | "deleted-in-cloud";

export type Change =
  /** Only the cloud changed it: safe to apply. */
  | { path: string; kind: "incoming"; edit: Edit }
  /** Only the local folder changed it: keep it. */
  | { path: string; kind: "local"; edit: Edit }
  /** Both changed it, differently. */
  | { path: string; kind: "conflict"; reason: ConflictReason };

/** Files that belong to the checkout, never to the workspace. */
export function isLocalOnly(path: string): boolean {
  return path === WORKSPACE_STATE_FILENAME;
}

/** A folder's manifest without local-only files. */
export async function workspaceManifest(fs: FileHost, dir: string): Promise<Manifest> {
  const { files } = await fs.manifest(dir);
  const out: Manifest = {};
  for (const [path, info] of Object.entries(files)) {
    if (!isLocalOnly(path)) out[path] = info;
  }
  return out;
}

const same = (a: FileInfo | undefined, b: FileInfo | undefined) =>
  a?.sha256 === b?.sha256 && a?.size === b?.size;

function edit(base: FileInfo | undefined, now: FileInfo | undefined): Edit | undefined {
  if (same(base, now)) return undefined;
  if (base === undefined) return "added";
  if (now === undefined) return "deleted";
  return "modified";
}

/**
 * Classify every path that differs anywhere. Paths unchanged on both
 * sides, or changed identically on both, are omitted. Sorted by path.
 */
export function classifyChanges(base: Manifest, cloud: Manifest, local: Manifest): Change[] {
  const paths = new Set([...Object.keys(base), ...Object.keys(cloud), ...Object.keys(local)]);
  const out: Change[] = [];
  for (const path of [...paths].sort()) {
    const cloudEdit = edit(base[path], cloud[path]);
    const localEdit = edit(base[path], local[path]);
    if (!cloudEdit && !localEdit) continue;
    if (!localEdit) out.push({ path, kind: "incoming", edit: cloudEdit! });
    else if (!cloudEdit) out.push({ path, kind: "local", edit: localEdit });
    else if (same(cloud[path], local[path])) continue; // same change both sides
    else if (cloudEdit === "added") out.push({ path, kind: "conflict", reason: "both-added" });
    else if (localEdit === "deleted")
      out.push({ path, kind: "conflict", reason: "deleted-locally" });
    else if (cloudEdit === "deleted")
      out.push({ path, kind: "conflict", reason: "deleted-in-cloud" });
    else out.push({ path, kind: "conflict", reason: "both-modified" });
  }
  return out;
}
