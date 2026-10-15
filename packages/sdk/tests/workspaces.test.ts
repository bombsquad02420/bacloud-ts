import { expect, test } from "vite-plus/test";
import { parseWorkspaceList } from "../src/workspaces.ts";

// Captured from `workspace list` against prod (2026-10-16).
const LIVE =
  "    \u001b[37mname                    type       size       modified   \u001b[0m\n" +
  "\u001b[37m 1 \u001b[0m \u001b[34mWorkspace1              \u001b[0muntyped    197 bytes  5h ago     \n" +
  "\u001b[37m 2 \u001b[0m \u001b[34mClassicCharacterAssets  \u001b[0massets_v1  44 MB      8h ago     \n" +
  "\u001b[37m 3 \u001b[0m \u001b[34mBuiltinAssets           \u001b[0massets_v1  26 MB      8h ago     \n\n";

test("parses the live table", () => {
  expect(parseWorkspaceList(LIVE)).toEqual([
    { name: "Workspace1", type: "untyped", size: "197 bytes", modified: "5h ago" },
    { name: "ClassicCharacterAssets", type: "assets_v1", size: "44 MB", modified: "8h ago" },
    { name: "BuiltinAssets", type: "assets_v1", size: "26 MB", modified: "8h ago" },
  ]);
});

test("header only means no workspaces", () => {
  expect(parseWorkspaceList("    name    type    size    modified\n\n")).toEqual([]);
});

test("unexpected output is an error, not an empty list", () => {
  expect(() => parseWorkspaceList("Not signed in.\n")).toThrow(/Unrecognized/);
});
