/**
 * Locations per the XDG Base Directory Specification.
 *
 * - config (`$XDG_CONFIG_HOME`, default `~/.config`): user settings.
 * - state (`$XDG_STATE_HOME`, default `~/.local/state`): data that
 *   should survive restarts but isn't portable or worth backing up —
 *   login tokens belong here.
 *
 * Per the spec, a relative or empty value is invalid and ignored.
 *
 * Upstream: replaces the `.cache/bacloud/state` location in
 * `tools/bacommontools/bacloud.py`. See UPSTREAM.md.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const APP_DIR = "bacloud-ts";

type Env = Readonly<Record<string, string | undefined>>;

function base(env: Env, variable: string, fallback: string[]): string {
  const value = env[variable];
  if (value && isAbsolute(value)) return value;
  return join(env["HOME"] || homedir(), ...fallback);
}

export interface Paths {
  configFile: string;
  stateDir: string;
  authFile: string;
}

export function resolvePaths(env: Env = process.env): Paths {
  const configDir = join(base(env, "XDG_CONFIG_HOME", [".config"]), APP_DIR);
  const stateDir = join(base(env, "XDG_STATE_HOME", [".local", "state"]), APP_DIR);
  return {
    configFile: join(configDir, "config.json"),
    stateDir,
    authFile: join(stateDir, "auth.json"),
  };
}
