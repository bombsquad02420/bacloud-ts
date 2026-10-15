import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { BacloudClient, isIdempotentCommand, uploadPlanSibling } from "../src/client.ts";
import type { BacloudHost } from "../src/host.ts";
import { nodeFileHost } from "../src/node.ts";
import { fakeRelay, msg, type FakeLeg } from "./fakerelay.ts";

function testHost(answers: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const host: BacloudHost = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    prompt: () => Promise.resolve(answers.shift() ?? ""),
    openUrl: (u) => urls.push(u),
    fs: nodeFileHost,
  };
  return { host, out, err, urls };
}

/** Plays the server: answers each request with the next scripted response. */
async function serve(leg: FakeLeg, script: Array<(req: Record<string, unknown>) => unknown>) {
  const requests: Array<Record<string, unknown>> = [];
  let seq = 1; // seq 1 was the session handle
  for (const respond of script) {
    const frame = await leg.nextFrame("m");
    const req = JSON.parse((frame as { payload: string }).payload) as Record<string, unknown>;
    requests.push(req);
    leg.push(msg(++seq, respond(req)));
  }
  return requests;
}

async function connect(
  host: BacloudHost,
  extra: Partial<Parameters<typeof BacloudClient.connect>[0]> = {},
) {
  const relay = fakeRelay();
  const connecting = BacloudClient.connect({
    host,
    server: "node.test",
    dialer: relay.dialer,
    ...extra,
  });
  const leg = await relay.leg(0);
  await leg.nextFrame("h");
  leg.push({ type: "h" });
  leg.push(msg(1, { _t: "sh", t: "tok", c: "chan", u: "", e: 0 }));
  return { client: await connecting, leg };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BacloudClient.run", () => {
  test("sends argv as _interactive and follows end_command with prompt input", async () => {
    const { host, out } = testHost(["hunter2"]);
    let token: string | undefined;
    const { client, leg } = await connect(host, { onLoginChange: (t) => (token = t) });
    const serving = serve(leg, [
      () => ({ m: "Signing in", inp: ["Password: ", true], ec: ["login._finish", { step: 2 }] }),
      () => ({ l: "login-token", em: "Signed in.", r: 0 }),
    ]);
    const result = await client.run(["login"], { cwd: "/work" });
    const requests = await serving;

    expect(requests[0]).toMatchObject({
      c: "_interactive",
      p: { c: "/work", p: "/work", a: ["login"] },
      i: false,
    });
    expect(requests[1]).toMatchObject({ c: "login._finish", p: { step: 2, input: "hunter2" } });
    expect(out).toEqual(["Signing in\n", "Signed in.\n"]);
    expect(token).toBe("login-token");
    expect(result.returnCode).toBe(0);
    await client.close();
  });

  test("server error becomes a BacloudError", async () => {
    const { host } = testHost();
    const { client, leg } = await connect(host);
    const serving = serve(leg, [() => ({ e: "Unknown command 'frob'." })]);
    await expect(client.run(["frob"], { cwd: "/" })).rejects.toThrow("Unknown command 'frob'.");
    await serving;
    await client.close();
  });

  test("workspace get flow: manifest, deletes, inline + signed downloads, prune", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bacloud-"));
    await writeFile(join(dir, "stale.txt"), "old");
    await writeFile(join(dir, "keep.txt"), "same");
    await mkdir(join(dir, "empty", "nested"), { recursive: true });

    const signedBody = new TextEncoder().encode("from gcs");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("https://storage.test/blob");
        return new Response(signedBody);
      }),
    );

    const { host } = testHost();
    const { client, leg } = await connect(host);
    const serving = serve(leg, [
      () => ({ man: dir, ec: ["workspace._get", {}] }),
      () => ({
        dlt: [join(dir, "stale.txt")],
        dinl: { [join(dir, "sub", "new.txt")]: deflateSync("hello").toString("base64") },
        dsgn: [
          {
            p: join(dir, "big.bin"),
            u: "https://storage.test/blob",
            h: createHash("sha256").update(signedBody).digest("hex"),
            s: signedBody.length,
          },
        ],
        dpe: dir,
        wss: "snap-42",
        em: "Done.",
      }),
    ]);
    const result = await client.run(["workspace", "get", "."], { cwd: dir });
    const requests = await serving;

    const manifest = (requests[1]!["p"] as { manifest: { f: Record<string, unknown>; e: boolean } })
      .manifest;
    expect(manifest.e).toBe(true);
    expect(Object.keys(manifest.f).sort()).toEqual(["keep.txt", "stale.txt"]);
    expect(manifest.f["keep.txt"]).toEqual({
      h: createHash("sha256").update("same").digest("hex"),
      s: 4,
    });
    expect(requests[0]!["i"]).toBe(true); // workspace get is idempotent

    expect((await readdir(dir)).sort()).toEqual([
      ".bacloudstate.json",
      "big.bin",
      "keep.txt",
      "sub",
    ]);
    expect(await readFile(join(dir, "sub", "new.txt"), "utf8")).toBe("hello");
    expect(await readFile(join(dir, "big.bin"), "utf8")).toBe("from gcs");
    expect(result.workspaceSnapshotId).toBe("snap-42");
    await client.close();
  });

  test("signed download with a bad hash is rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bacloud-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("tampered")),
    );
    const { host } = testHost();
    const { client, leg } = await connect(host);
    const serving = serve(leg, [
      () => ({ dsgn: [{ p: join(dir, "f"), u: "https://x", h: "0".repeat(64), s: 8 }] }),
    ]);
    await expect(client.run(["workspace", "get"], { cwd: dir })).rejects.toThrow(/sha256 mismatch/);
    await serving;
    await client.close();
  });
});

test("idempotent command classification", () => {
  expect(isIdempotentCommand(["workspace", "get", "."])).toBe(true);
  expect(isIdempotentCommand(["workspace", "put"])).toBe(false);
  expect(isIdempotentCommand(["account"])).toBe(false);
});

test("upload plan sibling commands live under admin", () => {
  expect(uploadPlanSibling("admin.archive._archive_publish_finalize", "_upload_plan_prepare")).toBe(
    "admin._upload_plan_prepare",
  );
  expect(() => uploadPlanSibling("foo.bar", "x")).toThrow(/admin/);
});

describe("workspace collision guard", () => {
  test("get saves the snapshot id; put sends it back", async () => {
    const root = await mkdtemp(join(tmpdir(), "bacloud-"));
    const dir = join(root, "WS");
    await mkdir(dir);
    const { host } = testHost();
    const { client, leg } = await connect(host);
    const serving = serve(leg, [() => ({ wss: "snap-1" }), () => ({ wss: "snap-2" })]);

    await client.run(["workspace", "get", "WS", "--workspace", "Named"], { cwd: root });
    expect(JSON.parse(await readFile(join(dir, ".bacloudstate.json"), "utf8"))).toEqual({
      snapshotid: "snap-1",
      name: "Named",
    });

    await client.run(["workspace", "put", "./WS/"], { cwd: root });
    const requests = await serving;
    expect((requests[1]!["p"] as { a: string[] }).a).toEqual([
      "workspace",
      "put",
      "./WS/",
      "--expected-snapshotid",
      "snap-1",
    ]);
    expect(JSON.parse(await readFile(join(dir, ".bacloudstate.json"), "utf8"))).toEqual({
      snapshotid: "snap-2",
    });
    await client.close();
  });

  test("put without state sends no expectation; --force is stripped with a warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bacloud-"));
    await writeFile(join(dir, ".bacloudstate.json"), JSON.stringify({ snapshotid: "old" }));
    const fresh = await mkdtemp(join(tmpdir(), "bacloud-"));
    const { host, err } = testHost();
    const { client, leg } = await connect(host);
    const serving = serve(leg, [() => ({}), () => ({})]);

    await client.run(["workspace", "put"], { cwd: fresh });
    await client.run(["workspace", "put", "--force"], { cwd: dir });
    const requests = await serving;
    expect((requests[0]!["p"] as { a: string[] }).a).toEqual(["workspace", "put"]);
    expect((requests[1]!["p"] as { a: string[] }).a).toEqual(["workspace", "put"]);
    expect(err.join("")).toMatch(/--force skips/);
    await client.close();
  });

  test("other commands are untouched", async () => {
    const { host } = testHost();
    const { client, leg } = await connect(host);
    const serving = serve(leg, [() => ({ wss: "x" })]);
    await client.run(["workspace", "list", "--force"], { cwd: "/nonexistent" });
    expect(((await serving)[0]!["p"] as { a: string[] }).a).toEqual([
      "workspace",
      "list",
      "--force",
    ]);
    await client.close();
  });
});
