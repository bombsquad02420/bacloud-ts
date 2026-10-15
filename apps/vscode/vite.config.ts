import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/extension.ts"],
    platform: "node",
    format: "cjs",
    // The SDK is bundled in; only the editor API comes from the host.
    deps: { neverBundle: ["vscode"], alwaysBundle: ["@bacloud/sdk"] },
    dts: false,
  },
});
