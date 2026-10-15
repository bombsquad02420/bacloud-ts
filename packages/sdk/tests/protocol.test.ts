import { describe, expect, test } from "vite-plus/test";
import { requestCodec, responseCodec } from "../src/protocol/bacloud.ts";
import { actionForCloseCode, decodeFrame, encodeFrame } from "../src/protocol/smartsocket.ts";

// Fixtures produced by ballistica's Python `efro.dataclassio`.
const PY_REQUEST = '{"c":"_interactive","p":{"a":["x"]},"z":3600.0,"y":false,"i":true,"b":5}';
const PY_RESPONSE =
  '{"m":"hi","usgn":[{"p":"p","u":"u","h":{"H":"v"},"s":"s"}],"dinl":{"a.txt":"eHl6"},"ec":["next",{"k":1}]}';
const PY_SESSION_HANDLE = '{"t":"t","c":"c","u":"wss://x","e":9,"_t":"sh"}';
const PY_HELLO = '{"r":3,"p":{"lg":120.0,"pi":30.0,"mx":7200.0},"_t":"h"}';

describe("bacloud codec", () => {
  test("request matches python encoding", () => {
    const encoded = requestCodec.encode({
      type: "s",
      command: "_interactive",
      payload: { a: ["x"] },
      tzoffset: 3600,
      isatty: false,
      idempotent: true,
      buildNumber: 5,
    });
    expect(encoded).toEqual(JSON.parse(PY_REQUEST));
  });

  test("standard response decodes", () => {
    const res = responseCodec.decode(JSON.parse(PY_RESPONSE));
    expect(res).toEqual({
      type: "s",
      message: "hi",
      uploadsSigned: [{ path: "p", uploadUrl: "u", uploadHeaders: { H: "v" }, sessionId: "s" }],
      downloadsInline: { "a.txt": new TextEncoder().encode("xyz") },
      endCommand: ["next", { k: 1 }],
    });
  });

  test("session handle decodes by type id", () => {
    expect(responseCodec.decode(JSON.parse(PY_SESSION_HANDLE))).toEqual({
      type: "sh",
      token: "t",
      channelId: "c",
      wsUrl: "wss://x",
      expiryUnixSeconds: 9,
    });
  });

  test("standard response round-trips without a type id", () => {
    const encoded = responseCodec.encode({ type: "s", error: "nope" });
    expect(encoded).toEqual({ e: "nope" });
  });

  test("unknown type id is rejected", () => {
    expect(() => responseCodec.decode({ _t: "zz" })).toThrow(/type-id/);
  });
});

describe("smartsocket frames", () => {
  test("hello decodes with policy", () => {
    expect(decodeFrame(PY_HELLO)).toEqual({
      type: "h",
      lastRecv: 3,
      policy: { lingerSeconds: 120, pingIntervalSeconds: 30, maxDurationSeconds: 7200 },
    });
  });

  test("frames encode like python", () => {
    expect(JSON.parse(encodeFrame({ type: "m", seq: 1, payload: "{}" }))).toEqual({
      s: 1,
      p: "{}",
      _t: "m",
    });
    expect(JSON.parse(encodeFrame({ type: "i" }))).toEqual({ _t: "i" });
  });

  test("close codes map to actions", () => {
    expect(actionForCloseCode(1000)).toBe("done");
    expect(actionForCloseCode(4001)).toBe("refresh");
    expect(actionForCloseCode(4107)).toBe("dead");
    expect(actionForCloseCode(4301)).toBe("resume");
    expect(actionForCloseCode(1006)).toBe("resume");
  });
});
