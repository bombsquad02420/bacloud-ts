/**
 * SmartSocket v1 wire protocol (mirror of ballistica `efro/smartsocket.py`).
 *
 * A reliable, reconnectable, two-peer session relayed by a server node.
 * Every message is delivered gaplessly and in order, or the session
 * closes with a code. Frames travel as JSON text messages, one frame per
 * WebSocket message; there is no in-band close frame.
 */

import { multitype } from "./codec.ts";

/** Largest WebSocket message the protocol puts on the wire. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Default floor for the silent-loss detection window. */
export const LOSS_DETECTION_FLOOR_SECONDS = 15;

/** Policy the relay reports for this endpoint in its hello. */
export interface EndpointPolicy {
  /** How long the relay holds our slot while we are away. */
  lingerSeconds?: number;
  /** App-level ping cadence. */
  pingIntervalSeconds?: number;
  /** Absolute session lifetime cap. */
  maxDurationSeconds?: number;
}

export const DEFAULT_POLICY: Required<EndpointPolicy> = {
  lingerSeconds: 120,
  pingIntervalSeconds: 30,
  maxDurationSeconds: 7200,
};

export type Frame =
  | { type: "h"; lastRecv?: number; policy?: EndpointPolicy }
  | { type: "m"; seq: number; payload?: string }
  | { type: "a"; recv?: number }
  | { type: "i" }
  | { type: "o" };

export const frameCodec = multitype<Frame["type"], Frame>({
  h: {
    lastRecv: "r",
    policy: {
      key: "p",
      kind: {
        object: { lingerSeconds: "lg", pingIntervalSeconds: "pi", maxDurationSeconds: "mx" },
      },
    },
  },
  m: { seq: "s", payload: "p" },
  a: { recv: "r" },
  i: {},
  o: {},
});

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frameCodec.encode(frame));
}

export function decodeFrame(data: string): Frame {
  return frameCodec.decode(JSON.parse(data));
}

// Close-code registry. Ranges encode the required action:
// 40xx auth, 41xx policy end, 42xx protocol error (all dead),
// 43xx relay-requested reattach (resume).
export const CloseCode = {
  NORMAL: 1000,
  TOKEN_EXPIRED: 4001,
  TOKEN_INVALID: 4002,
  SLOT_MISMATCH: 4003,
  NO_TOKEN: 4004,
  DETACH: 4100,
  MAX_DURATION: 4101,
  PEER_LOST: 4102,
  NODE_DRAINING: 4103,
  SUPERSEDED: 4104,
  KILLED: 4105,
  PEER_ENDED: 4106,
  CHANNEL_ENDED: 4107,
  BAD_FRAME: 4201,
  ROLE_VIOLATION: 4202,
  SEQ_VIOLATION: 4203,
  BAD_PAYLOAD: 4204,
  SERVE_FAILED: 4205,
  RECONNECT_EXHAUSTED: 4206,
  RELAY_BUFFER_FULL: 4301,
} as const;

export type CloseAction = "resume" | "refresh" | "done" | "dead";

/** Interpret a close code by table, then by range. */
export function actionForCloseCode(code: number): CloseAction {
  if (code === CloseCode.NORMAL) return "done";
  if (code === CloseCode.TOKEN_EXPIRED) return "refresh";
  if (code >= 4000 && code < 4300) return "dead";
  // 43xx, 1006/1011/absent and anything unknown: the connection died,
  // not (necessarily) the session.
  return "resume";
}
