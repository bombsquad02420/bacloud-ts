/**
 * File-tree helpers for staging copies (no editor API, so unit-testable).
 */

import { copyFile, link, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirror `src` into `dest` (which must not exist) using hard links, so
 * no file data is copied. Falls back to copying a file when linking
 * fails (e.g. a filesystem without hard links).
 */
export async function linkTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: false });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) await linkTree(from, to);
    else if (entry.isFile()) await link(from, to).catch(() => copyFile(from, to));
  }
}

/** Replace `dest` with `src` (a rename, so both must be on one volume). */
export async function replaceDir(src: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await rename(src, dest);
}
