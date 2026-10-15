/**
 * Persistent CLI config and auth state.
 *
 * Login tokens are kept per fleet (a prod token means nothing to the
 * test fleet) in a file only the user can read.
 *
 * Upstream: `StateData`, `_load_state` and `_save_state` in
 * `tools/bacommontools/bacloud.py` (one token there; one per fleet here).
 * See UPSTREAM.md.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Fleet } from "@bacloud/sdk";
import type { Paths } from "./paths.ts";

export interface Config {
  fleet?: Fleet;
  server?: string;
}

interface AuthState {
  tokens: Partial<Record<string, string>>;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${file} is not valid JSON; fix or delete it.`);
  }
}

export async function loadConfig(paths: Paths): Promise<Config> {
  return (await readJson<Config>(paths.configFile)) ?? {};
}

export class AuthStore {
  private readonly file: string;

  constructor(paths: Paths) {
    this.file = paths.authFile;
  }

  async get(fleet: string): Promise<string | undefined> {
    return (await this.read()).tokens[fleet];
  }

  async set(fleet: string, token: string | undefined): Promise<void> {
    const state = await this.read();
    if (token === undefined) delete state.tokens[fleet];
    else state.tokens[fleet] = token;
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }

  private async read(): Promise<AuthState> {
    const state = await readJson<AuthState>(this.file);
    return { tokens: { ...state?.tokens } };
  }
}
