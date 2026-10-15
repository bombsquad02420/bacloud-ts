/**
 * `bacloud-ts`: pass argv to the bacloud server, like ballistica's
 * `tools/bacloud`.
 *
 * Exit codes: 0 success, 1 a no/fail result, 2+ errors. Command output
 * goes to stdout and diagnostics to stderr, so stdout can be parsed.
 *
 * Environment:
 * - `BALLISTICA_API_KEY`: authenticate with an API key (stateless).
 * - `BA_FLEET`: `prod` (default), `test` or `dev`.
 * - `BACLOUD_SERVER`: explicit server host.
 * - `BACLOUD_VERBOSE=1`: session and node diagnostics on stderr.
 * - `BA_BUILD_NUMBER`: engine build reported to asset commands.
 *
 * Upstream: `run_bacloud_main`, `App.run` and `_resolve_api_key` in
 * `tools/bacommontools/bacloud.py`. Differences: runs outside a ballistica
 * project, reads the API key only from the environment, and keeps logins
 * per fleet in XDG state instead of `<project>/.cache/bacloud/state`. See
 * UPSTREAM.md.
 */

import {
  BacloudClient,
  BacloudError,
  BacloudSessionError,
  type BacloudHost,
  type Fleet,
} from "@bacloud/sdk";
import { resolvePaths } from "./paths.ts";
import { AuthStore, loadConfig } from "./store.ts";

const FLEETS: readonly Fleet[] = ["prod", "test", "dev"];

type Env = Readonly<Record<string, string | undefined>>;

export interface MainOptions {
  argv: string[];
  env: Env;
  cwd: string;
  host: BacloudHost;
  isatty?: boolean;
  /** Test seam for the SDK's connect. */
  connect?: typeof BacloudClient.connect;
}

export async function main(options: MainOptions): Promise<number> {
  const { env, host } = options;
  const verbose = env["BACLOUD_VERBOSE"] === "1";
  const log = verbose ? (message: string) => host.stderr(`bacloud: ${message}\n`) : undefined;

  try {
    const paths = resolvePaths(env);
    const config = await loadConfig(paths);
    const fleet = (env["BA_FLEET"]?.toLowerCase() ?? config.fleet ?? "prod") as Fleet;
    if (!FLEETS.includes(fleet)) {
      throw new BacloudError(
        `Invalid BA_FLEET value '${fleet}'; expected one of ${FLEETS.join(", ")}.`,
      );
    }

    // An API key makes the run stateless: never read or overwrite the
    // stored login.
    const apiKey = env["BALLISTICA_API_KEY"] || undefined;
    const auth = apiKey ? undefined : new AuthStore(paths);
    const bearer = apiKey ?? (await auth?.get(fleet));
    if (apiKey) log?.(`authenticating with API key (${apiKey.slice(0, 8)}…)`);
    const buildNumber = Number.parseInt(env["BA_BUILD_NUMBER"] ?? "", 10);

    // Saves run in order so a quick login→logout can't land reversed.
    let saving = Promise.resolve();
    const connect = options.connect ?? BacloudClient.connect.bind(BacloudClient);
    const client = await connect({
      host,
      fleet,
      server: env["BACLOUD_SERVER"] || config.server,
      bearer,
      isatty: options.isatty ?? false,
      buildNumber: Number.isNaN(buildNumber) ? 0 : buildNumber,
      onLoginChange: (token) => {
        if (!auth) return;
        saving = saving
          .then(() => auth.set(fleet, token))
          .catch((err: unknown) => {
            host.stderr(`Could not save login to ${paths.authFile}: ${String(err)}\n`);
          });
      },
      log,
    });
    try {
      const result = await client.run(options.argv, { cwd: options.cwd });
      return result.returnCode;
    } finally {
      await client.close();
      await saving;
    }
  } catch (err) {
    if (err instanceof BacloudError || err instanceof BacloudSessionError) {
      // The server already printed context; an empty error is just a
      // failing exit.
      if (err.message) host.stderr(`${err.message}\n`);
      if (err instanceof BacloudSessionError && !verbose) {
        host.stderr("Re-run with BACLOUD_VERBOSE=1 for details.\n");
      }
      return 2;
    }
    throw err;
  }
}
