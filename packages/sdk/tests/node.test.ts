import { link, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { nodeFileHost } from "../src/node.ts";

// The pull flow keeps the previous sync as hard links; the host must
// never write through them.
test("writeFile and deleteFile leave hard-linked copies untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bacloud-link-"));
  const live = join(dir, "live.txt");
  const kept = join(dir, "kept.txt");
  await writeFile(live, "version A");
  await link(live, kept);

  await nodeFileHost.writeFile(live, new TextEncoder().encode("version B"));
  expect(await readFile(live, "utf8")).toBe("version B");
  expect(await readFile(kept, "utf8")).toBe("version A");

  await nodeFileHost.deleteFile(live);
  expect(await readFile(kept, "utf8")).toBe("version A");
});
