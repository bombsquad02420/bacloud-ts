import { expect, test } from "vite-plus/test";
import { BACLOUD_VERSION } from "../src/index.ts";

test("protocol version", () => {
  expect(BACLOUD_VERSION).toBe(29);
});
