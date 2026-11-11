import { deflateSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { BacloudClient, isIdempotentCommand, uploadPlanSibling } from "../src/client.ts";
import type { BacloudHost } from "../src/host.ts";
import { nodeFileHost, nodeZstd } from "../src/node.ts";
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
    zstd: nodeZstd,
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

describe("v30/v31 compression", () => {
  test("zstd signed download is decoded and checked against decoded bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bacloud-"));
    const plain = new TextEncoder().encode("compressed content ".repeat(50));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(zstdCompressSync(plain))),
    );
    const { host } = testHost();
    const { client, leg } = await connect(host);
    const serving = serve(leg, [
      () => ({
        dsgn: [
          {
            p: join(dir, "f.txt"),
            u: "https://x",
            h: createHash("sha256").update(plain).digest("hex"),
            s: plain.length,
            c: "z",
          },
        ],
      }),
    ]);
    await client.run(["workspace", "get"], { cwd: dir });
    await serving;
    expect(await readFile(join(dir, "f.txt"))).toEqual(Buffer.from(plain));
    await client.close();
  });

  test("truncated zstd download is rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bacloud-"));
    const packed = zstdCompressSync(Buffer.alloc(10000, 1));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(packed.subarray(0, packed.length - 4))),
    );
    const { host } = testHost();
    const { client, leg } = await connect(host);
    const serving = serve(leg, [
      () => ({
        dsgn: [{ p: join(dir, "f"), u: "https://x", h: "0".repeat(64), s: 10000, c: "z" }],
      }),
    ]);
    await expect(client.run(["workspace", "get"], { cwd: dir })).rejects.toThrow(
      /compressed stream/,
    );
    await serving;
    await client.close();
  });

  test("signed upload is zstd-encoded when the server asks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bacloud-"));
    await writeFile(join(dir, "a.py"), "print('hi')\n".repeat(20));
    let sent: Uint8Array | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = init.body as Uint8Array;
        return new Response("");
      }),
    );
    const { host } = testHost();
    const { client, leg } = await connect(host);
    const serving = serve(leg, [
      () => ({
        usgn: [{ p: join(dir, "a.py"), u: "https://up", h: {}, s: "sess", e: "z", l: 3 }],
        ec: ["workspace._put", {}],
      }),
      () => ({ r: 0 }),
    ]);
    await client.run(["workspace", "put"], { cwd: dir });
    const requests = await serving;
    expect(zstdDecompressSync(sent!).toString()).toBe("print('hi')\n".repeat(20));
    expect(requests[1]!["p"]).toMatchObject({ uploads_signed: { [join(dir, "a.py")]: "sess" } });
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
      "--workspace",
      "Named",
      "--expected-snapshotid",
      "snap-1",
    ]);
    // The put had no --workspace, but the name from the get is kept.
    expect(JSON.parse(await readFile(join(dir, ".bacloudstate.json"), "utf8"))).toEqual({
      snapshotid: "snap-2",
      name: "Named",
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

test("put refuses when the state file is corrupt (fail closed)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bacloud-"));
  await writeFile(join(dir, ".bacloudstate.json"), "{not json");
  const { host } = testHost();
  const { client } = await connect(host);
  await expect(client.run(["workspace", "put"], { cwd: dir })).rejects.toThrow(
    /unreadable.*--force/s,
  );
  await client.close();
});

test("relative paths from the server resolve against the run's cwd, not the process's", async () => {
  const root = await mkdtemp(join(tmpdir(), "bacloud-rel-"));
  await mkdir(join(root, "WS"));
  await writeFile(join(root, "WS", "old.txt"), "old");
  await mkdir(join(root, "WS", "empty"));
  const { host } = testHost();
  const { client, leg } = await connect(host);
  const serving = serve(leg, [
    () => ({ man: "WS", ec: ["workspace._get_process", {}] }),
    () => ({
      dlt: ["WS/old.txt"],
      dinl: { "WS/new.txt": deflateSync("new").toString("base64") },
      dpe: "WS",
    }),
  ]);
  expect(process.cwd()).not.toBe(root);
  await client.run(["workspace", "get", "WS"], { cwd: root });
  const requests = await serving;

  const manifest = (requests[1]!["p"] as { manifest: { f: Record<string, unknown>; e: boolean } })
    .manifest;
  expect(manifest).toMatchObject({ e: true, f: { "old.txt": expect.anything() } });
  // old.txt deleted, new.txt written, empty/ pruned: all under root/WS.
  expect((await readdir(join(root, "WS"))).sort()).toEqual(["new.txt"]);
  await client.close();
});
