import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { BacloudError, type BacloudHost, type ClientOptions, type RunResult } from "@bacloud/sdk";
import { nodeFileHost } from "@bacloud/sdk/node";
import { main } from "../src/main.ts";
import { resolvePaths } from "../src/paths.ts";

describe("resolvePaths", () => {
  test("defaults under HOME", () => {
    expect(resolvePaths({ HOME: "/h" })).toEqual({
      configFile: "/h/.config/bacloud-ts/config.json",
      stateDir: "/h/.local/state/bacloud-ts",
      authFile: "/h/.local/state/bacloud-ts/auth.json",
    });
  });

  test("honours absolute XDG vars and ignores relative ones", () => {
    const paths = resolvePaths({
      HOME: "/h",
      XDG_CONFIG_HOME: "/cfg",
      XDG_STATE_HOME: "rel/state",
    });
    expect(paths.configFile).toBe("/cfg/bacloud-ts/config.json");
    expect(paths.authFile).toBe("/h/.local/state/bacloud-ts/auth.json");
  });
});

/** Runs main() with a fake SDK connection. */
async function runCli(
  argv: string[],
  env: Record<string, string>,
  behave: (options: ClientOptions) => Promise<RunResult> | RunResult,
) {
  const err: string[] = [];
  const host: BacloudHost = {
    stdout: () => {},
    stderr: (t) => err.push(t),
    prompt: () => Promise.resolve(""),
    openUrl: () => {},
    fs: nodeFileHost,
  };
  const seen: ClientOptions[] = [];
  const code = await main({
    argv,
    env,
    cwd: "/",
    host,
    connect: (options) => {
      seen.push(options);
      return Promise.resolve({
        run: () => Promise.resolve(behave(options)),
        close: () => Promise.resolve(),
      } as never);
    },
  });
  return { code, err: err.join(""), options: seen[0] };
}

async function xdgEnv() {
  const root = await mkdtemp(join(tmpdir(), "bacloud-cli-"));
  return { HOME: root, XDG_CONFIG_HOME: join(root, "cfg"), XDG_STATE_HOME: join(root, "state") };
}

describe("main", () => {
  test("stores the login per fleet in XDG state with private permissions", async () => {
    const env = await xdgEnv();
    const { code } = await runCli(["signin"], env, (o) => {
      o.onLoginChange?.("tok-prod");
      return { returnCode: 0, rawResults: [] };
    });
    expect(code).toBe(0);
    const file = join(env.XDG_STATE_HOME, "bacloud-ts", "auth.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ tokens: { prod: "tok-prod" } });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(env.XDG_STATE_HOME, "bacloud-ts"))).mode & 0o777).toBe(0o700);

    // Next run presents it; a test-fleet run does not.
    expect(
      (await runCli(["status"], env, () => ({ returnCode: 0, rawResults: [] }))).options?.bearer,
    ).toBe("tok-prod");
    const testFleet = await runCli(["status"], { ...env, BA_FLEET: "test" }, () => ({
      returnCode: 0,
      rawResults: [],
    }));
    expect(testFleet.options?.bearer).toBeUndefined();
    expect(testFleet.options?.fleet).toBe("test");
  });

  test("logout clears the stored token", async () => {
    const env = await xdgEnv();
    await runCli(
      ["signin"],
      env,
      (o) => (o.onLoginChange?.("t"), { returnCode: 0, rawResults: [] }),
    );
    await runCli(
      ["signout"],
      env,
      (o) => (o.onLoginChange?.(undefined), { returnCode: 0, rawResults: [] }),
    );
    const file = join(env.XDG_STATE_HOME, "bacloud-ts", "auth.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ tokens: {} });
  });

  test("API key wins and never touches stored state", async () => {
    const env = await xdgEnv();
    const { options } = await runCli(
      ["status"],
      { ...env, BALLISTICA_API_KEY: "bsac-123" },
      (o) => {
        o.onLoginChange?.("should-not-save");
        return { returnCode: 0, rawResults: [] };
      },
    );
    expect(options?.bearer).toBe("bsac-123");
    await expect(stat(join(env.XDG_STATE_HOME, "bacloud-ts", "auth.json"))).rejects.toThrow();
  });

  test("config file supplies defaults; env overrides", async () => {
    const env = await xdgEnv();
    await mkdir(join(env.XDG_CONFIG_HOME, "bacloud-ts"), { recursive: true });
    await writeFile(
      join(env.XDG_CONFIG_HOME, "bacloud-ts", "config.json"),
      JSON.stringify({ fleet: "dev", server: "node.dev" }),
    );
    const ok = () => ({ returnCode: 0, rawResults: [] });
    expect((await runCli([], env, ok)).options).toMatchObject({ fleet: "dev", server: "node.dev" });
    expect(
      (await runCli([], { ...env, BA_FLEET: "TEST", BACLOUD_SERVER: "x" }, ok)).options,
    ).toMatchObject({
      fleet: "test",
      server: "x",
    });
  });

  test("exit codes: server result, errors and bad fleet", async () => {
    const env = await xdgEnv();
    expect((await runCli([], env, () => ({ returnCode: 1, rawResults: [] }))).code).toBe(1);
    const failed = await runCli([], env, () => {
      throw new BacloudError("No such workspace.");
    });
    expect(failed).toMatchObject({ code: 2, err: "No such workspace.\n" });
    const bad = await runCli([], { ...env, BA_FLEET: "staging" }, () => ({
      returnCode: 0,
      rawResults: [],
    }));
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/Invalid BA_FLEET/);
  });
});
