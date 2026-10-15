/**
 * The seam between a SmartSocket endpoint and an actual socket.
 *
 * Kept tiny so tests can drive the endpoint with a fake, and so hosts
 * with unusual WebSocket implementations can plug their own in.
 */

import { MAX_MESSAGE_BYTES } from "../protocol/smartsocket.ts";

/** Raised by a transport when its connection has closed. */
export class SmartSocketClosed extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(code: number, reason = "") {
    super(`closed: code=${code} reason=${reason || "(none)"}`);
    this.name = "SmartSocketClosed";
    this.code = code;
    this.reason = reason;
  }
}

/** One connection (leg) of a SmartSocket session. */
export interface Transport {
  send(data: string): Promise<void>;
  /** Next text message; rejects with {@link SmartSocketClosed} on close. */
  recv(): Promise<string>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface DialOptions {
  protocols: string[];
  headers: Record<string, string>;
  /** Abort the dial after this many milliseconds. */
  timeoutMs: number;
}

/** Opens one transport to `url`. */
export type Dialer = (url: string, options: DialOptions) => Promise<Transport>;

/**
 * The subset of the WHATWG `WebSocket` API we use. Node's global
 * (undici) implementation also accepts `{ protocols, headers }` as the
 * second constructor argument, which browsers do not — custom headers
 * are required for bacloud auth, so a browser host must supply its own
 * {@link Dialer} (for instance via a proxy).
 */
interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

type WebSocketCtor = new (url: string, options: unknown) => WebSocketLike;

/** A {@link Dialer} over the global `WebSocket` (Node 22+). */
export const webSocketDialer: Dialer = (url, options) => {
  const Ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (Ctor === undefined) {
    return Promise.reject(new Error("No global WebSocket; supply a Dialer."));
  }
  const socket = new Ctor(url, { protocols: options.protocols, headers: options.headers });
  return WebSocketTransport.open(socket, options.timeoutMs);
};

class WebSocketTransport implements Transport {
  private readonly socket: WebSocketLike;
  private readonly inbox: string[] = [];
  private waiter: { resolve: (data: string) => void; reject: (err: Error) => void } | undefined;
  private closed: SmartSocketClosed | undefined;

  private constructor(socket: WebSocketLike) {
    this.socket = socket;
    socket.addEventListener("message", (event: { data: unknown }) => {
      const data =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      if (data.length > MAX_MESSAGE_BYTES * 2) {
        this.onClosed(new SmartSocketClosed(1009, "message too big"));
        return;
      }
      if (this.waiter) {
        const { resolve } = this.waiter;
        this.waiter = undefined;
        resolve(data);
      } else {
        this.inbox.push(data);
      }
    });
    socket.addEventListener("close", (event: { code: number; reason: string }) => {
      this.onClosed(new SmartSocketClosed(event.code || 1006, event.reason));
    });
  }

  static open(socket: WebSocketLike, timeoutMs: number): Promise<Transport> {
    socket.binaryType = "arraybuffer";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`WebSocket open timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const transport = new WebSocketTransport(socket);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(transport);
      });
      socket.addEventListener("error", (event: { message?: string; error?: unknown }) => {
        clearTimeout(timer);
        const cause = event.error ?? event.message;
        const detail =
          cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
        reject(new Error(`WebSocket error${detail ? `: ${detail}` : ""}`, { cause }));
      });
    });
  }

  private onClosed(err: SmartSocketClosed): void {
    if (this.closed) return;
    this.closed = err;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = undefined;
      reject(err);
    }
  }

  send(data: string): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    this.socket.send(data);
    return Promise.resolve();
  }

  recv(): Promise<string> {
    const next = this.inbox.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  close(code = 1000, reason = ""): Promise<void> {
    try {
      this.socket.close(code, reason);
    } catch {
      // Already closing.
    }
    this.onClosed(new SmartSocketClosed(code, reason));
    return Promise.resolve();
  }
}
