import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { nodeFileHost } from "../src/node.ts";
import {
  readWorkspaceState,
  updateWorkspaceState,
  WorkspaceStateError,
} from "../src/workspaceState.ts";

const tmp = () => mkdtemp(join(tmpdir(), "bacloud-state-"));

test("missing file reads as undefined", async () => {
  expect(await readWorkspaceState(nodeFileHost, await tmp())).toBeUndefined();
});

test("updates keep keys written by other tools", async () => {
  const dir = await tmp();
  await writeFile(
    join(dir, ".bacloudstate.json"),
    JSON.stringify({ snapshotid: "a", fleet: "prod", future: { x: 1 } }),
  );
  await updateWorkspaceState(nodeFileHost, dir, { snapshotid: "b", name: "WS" });
  expect(JSON.parse(await readFile(join(dir, ".bacloudstate.json"), "utf8"))).toEqual({
    snapshotid: "b",
    fleet: "prod",
    future: { x: 1 },
    name: "WS",
  });
});

test.each([
  ["truncated JSON", '{"snapshotid": "a'],
  ["not an object", "[1, 2]"],
  ["wrong type", '{"snapshotid": 7}'],
])("%s is an error, not absent state", async (_label, body) => {
  const dir = await tmp();
  await writeFile(join(dir, ".bacloudstate.json"), body);
  await expect(readWorkspaceState(nodeFileHost, dir)).rejects.toBeInstanceOf(WorkspaceStateError);
});

test("an update replaces a corrupt file", async () => {
  const dir = await tmp();
  await writeFile(join(dir, ".bacloudstate.json"), "{oops");
  await updateWorkspaceState(nodeFileHost, dir, { snapshotid: "c" });
  expect(await readWorkspaceState(nodeFileHost, dir)).toEqual({ snapshotid: "c" });
});
