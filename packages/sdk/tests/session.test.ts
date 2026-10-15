import { describe, expect, test } from "vite-plus/test";
import { BacloudSession } from "../src/session.ts";
import { fakeRelay, msg } from "./fakerelay.ts";

const request = {
  type: "s" as const,
  command: "_interactive",
  payload: { a: ["version"] },
  tzoffset: 0,
  isatty: false,
};

async function openSession() {
  const relay = fakeRelay();
  const opening = BacloudSession.open({
    server: "node.test",
    bearer: "bsac-key",
    dialer: relay.dialer,
  });
  const leg = await relay.leg(0);
  expect(await leg.nextFrame("h")).toEqual({ type: "h", lastRecv: 0 });
  leg.push({ type: "h", lastRecv: 0 });
  leg.push(
    msg(1, {
      _t: "sh",
      t: "resume-token",
      c: "chan-1",
      u: "wss://node-7.test/bacloudsession",
      e: 0,
    }),
  );
  const session = await opening;
  return { relay, leg, session };
}

describe("BacloudSession", () => {
  test("dials with auth and version headers", async () => {
    const { leg, session } = await openSession();
    expect(leg.url).toBe("wss://node.test/bacloudsession");
    expect(leg.options.protocols).toEqual(["basmartsocket"]);
    expect(leg.options.headers["Authorization"]).toBe("Bearer bsac-key");
    expect(leg.options.headers["X-Bacloud-Version"]).toBe("29");
    expect(leg.options.headers["X-WS-Token"]).toBeUndefined();
    expect(leg.options.headers["User-Agent"]).toBe("bacloud/29");
    leg.push({ type: "h" });
    await session.end();
  });

  test("request gets its standard response; stream output is forwarded", async () => {
    const { leg, session } = await openSession();
    const output: string[] = [];
    const answer = session.request(request, (t) => output.push(t));
    const sent = await leg.nextFrame("m");
    expect(sent).toMatchObject({ seq: 1 });
    expect(JSON.parse((sent as { payload: string }).payload)).toMatchObject({ c: "_interactive" });
    leg.push(msg(2, { _t: "so", t: "working..." }));
    leg.push(msg(3, { em: "done" }));
    expect(await answer).toEqual({ type: "s", endMessage: "done" });
    expect(output).toEqual(["working..."]);
    expect(session.channelId).toBe("chan-1");
    await session.end();
  });

  test("a client name is prepended to the User-Agent", async () => {
    const relay = fakeRelay();
    const opening = BacloudSession.open({
      server: "node.test",
      client: "bacloud-ts-cli/1.2.3",
      dialer: relay.dialer,
    });
    const leg = await relay.leg(0);
    expect(leg.options.headers["User-Agent"]).toBe("bacloud-ts-cli/1.2.3 bacloud/29");
    await leg.nextFrame("h");
    leg.push({ type: "h" });
    const session = await opening;
    await session.end();
  });

  test("chunked responses are rejoined", async () => {
    const { leg, session } = await openSession();
    const answer = session.request(request);
    await leg.nextFrame("m");
    const body = JSON.stringify({ m: "x".repeat(50) });
    const half = Math.floor(body.length / 2);
    leg.push(msg(2, { _t: "ch", i: 0, n: 2, d: body.slice(0, half) }));
    leg.push(msg(3, { _t: "ch", i: 1, n: 2, d: body.slice(half) }));
    expect(await answer).toEqual({ type: "s", message: "x".repeat(50) });
    await session.end();
  });

  test("resumes on the node from the session handle, replaying unacked sends", async () => {
    const { relay, leg, session } = await openSession();
    const answer = session.request(request);
    await leg.nextFrame("m");
    leg.drop(1006); // abnormal loss before any ack

    const leg2 = await relay.leg(1);
    expect(leg2.url).toBe("wss://node-7.test/bacloudsession");
    expect(leg2.options.headers["X-WS-Token"]).toBe("resume-token");
    // Client has seen server seq 1 (the session handle).
    expect(await leg2.nextFrame("h")).toEqual({ type: "h", lastRecv: 1 });
    leg2.push({ type: "h", lastRecv: 0 });
    expect(await leg2.nextFrame("m")).toMatchObject({ seq: 1 });
    leg2.push(msg(2, { em: "ok" }));
    expect(await answer).toEqual({ type: "s", endMessage: "ok" });
    await session.end();
  });

  test("dead close fails the in-flight request", async () => {
    const { leg, session } = await openSession();
    const answer = session.request(request);
    await leg.nextFrame("m");
    leg.drop(4105, "killed");
    await expect(answer).rejects.toThrow(/4105 killed.*chan-1/);
    expect(session.alive).toBe(false);
  });

  test("open fails fast when nothing answers", async () => {
    await expect(
      BacloudSession.open({
        server: "nowhere.test",
        dialer: () => Promise.reject(new Error("ECONNREFUSED")),
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
