import { expect, test, vi } from "vite-plus/test";

vi.mock("vscode", () => ({}));
const { timeAgo } = await import("../src/statusBar.ts");

test("timeAgo buckets", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000);
  expect(timeAgo(at(5), now)).toBe("just now");
  expect(timeAgo(at(5 * 60), now)).toBe("5m ago");
  expect(timeAgo(at(3 * 3600), now)).toBe("3h ago");
  expect(timeAgo(at(3 * 86400), now)).toBe("3d ago");
});
