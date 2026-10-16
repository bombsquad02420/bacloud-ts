import { expect, test, vi } from "vite-plus/test";

vi.mock("vscode", () => ({}));
const { parseAccountName } = await import("../src/auth.ts");

test("account name from signin and status output", () => {
  expect(
    parseAccountName(
      "\u001b[92mYou are now signed in as \u001b[1maryan02420\u001b[0m\u001b[92m.\u001b[0m\n",
    ),
  ).toBe("aryan02420");
  expect(parseAccountName("Signed in as \u001b[92maryan02420\u001b[0m.\n")).toBe("aryan02420");
  expect(parseAccountName("Not signed in.\n")).toBeUndefined();
});
