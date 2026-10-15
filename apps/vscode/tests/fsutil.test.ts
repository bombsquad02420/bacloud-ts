import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { nodeFileHost } from "@bacloud/sdk/node";
import { linkTree, replaceDir } from "../src/fsutil.ts";

test("a linked base keeps the old content while staging is updated", async () => {
  const root = await mkdtemp(join(tmpdir(), "bacloud-tree-"));
  const staging = join(root, "staging");
  const base = join(root, "base");
  await mkdir(join(staging, "sub"), { recursive: true });
  await writeFile(join(staging, "sub", "a.txt"), "A");
  await writeFile(join(staging, "gone.txt"), "old");

  await linkTree(staging, base);
  // What a `get` into staging does: replace, add, delete.
  await nodeFileHost.writeFile(join(staging, "sub", "a.txt"), new TextEncoder().encode("B"));
  await nodeFileHost.writeFile(join(staging, "new.txt"), new TextEncoder().encode("N"));
  await nodeFileHost.deleteFile(join(staging, "gone.txt"));

  expect(await readFile(join(base, "sub", "a.txt"), "utf8")).toBe("A");
  expect(await readFile(join(base, "gone.txt"), "utf8")).toBe("old");
  expect(await readFile(join(staging, "sub", "a.txt"), "utf8")).toBe("B");

  // Discarding a pull restores the base as staging.
  await replaceDir(base, staging);
  expect(await readFile(join(staging, "sub", "a.txt"), "utf8")).toBe("A");
  expect(await readFile(join(staging, "gone.txt"), "utf8")).toBe("old");
});
