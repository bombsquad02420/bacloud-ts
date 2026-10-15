import { expect, test, vi } from "vite-plus/test";

vi.mock("vscode", () => ({}));
const { sides } = await import("../src/changesView.ts");

test("diff sides follow the change kind", () => {
  expect(sides({ path: "a", kind: "incoming", edit: "added" })).toEqual({
    cloud: true,
    local: false,
  });
  expect(sides({ path: "a", kind: "incoming", edit: "deleted" })).toEqual({
    cloud: false,
    local: true,
  });
  expect(sides({ path: "a", kind: "local", edit: "added" })).toEqual({ cloud: false, local: true });
  expect(sides({ path: "a", kind: "local", edit: "deleted" })).toEqual({
    cloud: true,
    local: false,
  });
  expect(sides({ path: "a", kind: "conflict", reason: "deleted-locally" })).toEqual({
    cloud: true,
    local: false,
  });
  expect(sides({ path: "a", kind: "conflict", reason: "deleted-in-cloud" })).toEqual({
    cloud: false,
    local: true,
  });
  expect(sides({ path: "a", kind: "conflict", reason: "both-modified" })).toEqual({
    cloud: true,
    local: true,
  });
});
