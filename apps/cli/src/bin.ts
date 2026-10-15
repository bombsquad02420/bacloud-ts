#!/usr/bin/env node
import { nodeHost } from "@bacloud/sdk/node";
import { main } from "./main.ts";

// Ctrl-C / SIGTERM: exit quietly, like the Python client.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(2));
}

// Output piped to a reader that stopped early (`| head`): there is no
// one left to tell anything, so stop quietly instead of crashing on the
// unhandled EPIPE, as standard Unix tools do.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw err;
  });
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
