import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { classifyChanges, workspaceManifest, type Manifest } from "../src/changes.ts";
import { nodeFileHost } from "../src/node.ts";

const f = (sha256: string): { sha256: string; size: number } => ({ sha256, size: sha256.length });

describe("classifyChanges", () => {
  // Every row of the design doc's table.
  const base: Manifest = {
    "unchanged.txt": f("u"),
    "cloud-mod.txt": f("a"),
    "cloud-del.txt": f("a"),
    "local-mod.txt": f("a"),
    "local-del.txt": f("a"),
    "same-change.txt": f("a"),
    "both-mod.txt": f("a"),
    "del-local-mod-cloud.txt": f("a"),
    "mod-local-del-cloud.txt": f("a"),
    "both-del.txt": f("a"),
  };
  const cloud: Manifest = {
    "unchanged.txt": f("u"),
    "cloud-mod.txt": f("b"),
    "local-mod.txt": f("a"),
    "local-del.txt": f("a"),
    "same-change.txt": f("x"),
    "both-mod.txt": f("b"),
    "del-local-mod-cloud.txt": f("b"),
    "cloud-add.txt": f("n"),
    "both-add-same.txt": f("s"),
    "both-add-diff.txt": f("c"),
  };
  const local: Manifest = {
    "unchanged.txt": f("u"),
    "cloud-mod.txt": f("a"),
    "cloud-del.txt": f("a"),
    "local-mod.txt": f("l"),
    "same-change.txt": f("x"),
    "both-mod.txt": f("l"),
    "mod-local-del-cloud.txt": f("l"),
    "local-add.txt": f("n"),
    "both-add-same.txt": f("s"),
    "both-add-diff.txt": f("l"),
  };

  test("covers every case", () => {
    expect(classifyChanges(base, cloud, local)).toEqual([
      { path: "both-add-diff.txt", kind: "conflict", reason: "both-added" },
      { path: "both-mod.txt", kind: "conflict", reason: "both-modified" },
      { path: "cloud-add.txt", kind: "incoming", edit: "added" },
      { path: "cloud-del.txt", kind: "incoming", edit: "deleted" },
      { path: "cloud-mod.txt", kind: "incoming", edit: "modified" },
      { path: "del-local-mod-cloud.txt", kind: "conflict", reason: "deleted-locally" },
      { path: "local-add.txt", kind: "local", edit: "added" },
      { path: "local-del.txt", kind: "local", edit: "deleted" },
      { path: "local-mod.txt", kind: "local", edit: "modified" },
      { path: "mod-local-del-cloud.txt", kind: "conflict", reason: "deleted-in-cloud" },
    ]);
  });

  test("a fresh clone (empty base and local) is all incoming", () => {
    expect(classifyChanges({}, { "a.txt": f("a") }, {})).toEqual([
      { path: "a.txt", kind: "incoming", edit: "added" },
    ]);
  });
});

test("workspaceManifest skips the state file and uses forward slashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bacloud-man-"));
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", "a.txt"), "hi");
  await writeFile(join(dir, ".bacloudstate.json"), "{}");
  expect(Object.keys(await workspaceManifest(nodeFileHost, dir))).toEqual(["sub/a.txt"]);
});

test("local-only means a dot-named file, not a file in a dot-folder", async () => {
  const { isLocalOnly, unsupportedFiles } = await import("../src/changes.ts");
  expect(isLocalOnly(".bacloudstate.json")).toBe(true);
  expect(isLocalOnly("sub/.DS_Store")).toBe(true);
  expect(isLocalOnly(".vscode/settings.json")).toBe(false);
  expect(isLocalOnly("test.py")).toBe(false);
  expect(unsupportedFiles(["a.py", "B.PNG", ".git/HEAD", "notes.md"])).toEqual([
    ".git/HEAD",
    "notes.md",
  ]);
});
