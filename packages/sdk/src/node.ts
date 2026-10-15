/**
 * Node implementations of the bacloud host interfaces.
 *
 * Upstream: `DirectoryManifest.create_from_disk` in
 * `tools/bacommon/transfer.py`, and the file handlers in
 * `tools/bacommontools/bacloud.py` (`_handle_deletes`,
 * `_handle_downloads_inline`, `_handle_dir_prune_empty`). See UPSTREAM.md.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import type { BacloudHost, FileHost, IoHost } from "./host.ts";
import type { DirectoryManifest } from "./protocol/bacloud.ts";

async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), size };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Remove a directory tree that contains only (empty) directories. */
async function removeEmptyTree(dir: string): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) throw new Error(`Refusing to replace non-empty dir ${dir}`);
    await removeEmptyTree(path.join(dir, entry.name));
  }
  await fs.rmdir(dir);
}

export const nodeFileHost: FileHost = {
  async manifest(target) {
    const files: DirectoryManifest["files"] = {};
    const stat = await fs.stat(target).catch(() => undefined);
    if (stat?.isDirectory()) {
      const entries = await fs.readdir(target, { recursive: true, withFileTypes: true });
      await Promise.all(
        entries
          .filter((e) => e.isFile())
          .map(async (e) => {
            const full = path.join(e.parentPath, e.name);
            const key = path.relative(target, full).split(path.sep).join("/");
            files[key] = await hashFile(full);
          }),
      );
    } else if (stat) {
      files[target.split(path.sep).join("/")] = await hashFile(target);
    }
    return { files, exists: stat !== undefined };
  },

  async readFile(file) {
    return new Uint8Array(await fs.readFile(file));
  },

  async writeFile(file, data) {
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat?.isDirectory()) await removeEmptyTree(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  },

  async deleteFile(file) {
    await fs.unlink(file);
  },

  async pruneEmptyDirs(dir) {
    const prune = async (current: string): Promise<boolean> => {
      let empty = true;
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const child = path.join(current, entry.name);
        if (!entry.isDirectory() || !(await prune(child))) empty = false;
      }
      if (empty && current !== dir) await fs.rmdir(current);
      return empty;
    };
    if (await exists(dir)) await prune(dir);
  },
};

export const nodeIoHost: IoHost = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  async prompt(message, { password }) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (password) {
      // Echo nothing while typing.
      const output = rl as unknown as { _writeToOutput: (s: string) => void };
      process.stdout.write(message);
      output._writeToOutput = () => {};
      try {
        return await rl.question("");
      } finally {
        process.stdout.write("\n");
        rl.close();
      }
    }
    try {
      return await rl.question(message);
    } finally {
      rl.close();
    }
  },
  openUrl(url) {
    process.stderr.write(`(url: ${url})\n`);
    void import("node:child_process").then(({ spawn }) => {
      const cmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "explorer"
            : "xdg-open";
      spawn(cmd, [url], { stdio: "ignore", detached: true })
        .on("error", () => {})
        .unref();
    });
  },
};

export const nodeHost: BacloudHost = { ...nodeIoHost, fs: nodeFileHost };
