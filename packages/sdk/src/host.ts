/**
 * Everything a command run touches outside the session.
 *
 * The server drives side effects by naming *client paths* (built from
 * the cwd we report), so a host decides what those paths mean: the
 * Node host maps them to the real disk, while an editor host could map
 * them onto a virtual file system.
 */

import type { DirectoryManifest } from "./protocol/bacloud.ts";

export interface FileHost {
  /** sha256+size of every file under `path` (or of `path` itself). */
  manifest(path: string): Promise<DirectoryManifest>;
  readFile(path: string): Promise<Uint8Array>;
  /**
   * Atomically write `data` to `path`, creating parent dirs and
   * replacing an (empty) directory standing in the way.
   */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  deleteFile(path: string): Promise<void>;
  /** Remove empty directories under (not including) `dir`. */
  pruneEmptyDirs(dir: string): Promise<void>;
}

export interface IoHost {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Ask the user for a line of input. */
  prompt(message: string, options: { password: boolean }): Promise<string>;
  openUrl(url: string): void;
}

export interface BacloudHost extends IoHost {
  fs: FileHost;
}
