import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/bin.ts"],
    platform: "node",
  },
});
