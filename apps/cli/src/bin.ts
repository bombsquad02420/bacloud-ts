#!/usr/bin/env node
import { nodeHost } from "@bacloud/sdk/node";
import { main } from "./main.ts";

// Ctrl-C / SIGTERM: exit quietly, like the Python client.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(2));
}

main({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  host: nodeHost,
  isatty: process.stdout.isTTY,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 2;
  },
);
