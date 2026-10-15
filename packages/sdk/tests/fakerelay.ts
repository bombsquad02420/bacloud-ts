import { decodeFrame, encodeFrame, type Frame } from "../src/protocol/smartsocket.ts";
import { SmartSocketClosed, type DialOptions, type Transport } from "../src/transport/transport.ts";

/** Server side of one fake leg. */
export class FakeLeg {
  readonly url: string;
  readonly options: DialOptions;
  readonly received: Frame[] = [];
  private readonly toClient: string[] = [];
  private clientWaiter: ((data: string) => void) | undefined;
  private closeClient: ((err: SmartSocketClosed) => void) | undefined;
  closed: SmartSocketClosed | undefined;
  private frameWaiters: Array<() => void> = [];

  constructor(url: string, options: DialOptions) {
    this.url = url;
    this.options = options;
  }

  push(frame: Frame): void {
    const data = encodeFrame(frame);
    if (this.clientWaiter) {
      const w = this.clientWaiter;
      this.clientWaiter = undefined;
      w(data);
    } else this.toClient.push(data);
  }

  /** Server closes the leg. */
  drop(code: number, reason = ""): void {
    const err = new SmartSocketClosed(code, reason);
    this.closed = err;
    this.closeClient?.(err);
  }

  async nextFrame(type: Frame["type"]): Promise<Frame> {
    for (;;) {
      const found = this.received.find((f) => f.type === type);
      if (found) {
        this.received.splice(this.received.indexOf(found), 1);
        return found;
      }
      await new Promise<void>((resolve) => this.frameWaiters.push(resolve));
    }
  }

  transport(): Transport {
    return {
      send: (data) => {
        if (this.closed) return Promise.reject(this.closed);
        this.received.push(decodeFrame(data));
        const waiters = this.frameWaiters;
        this.frameWaiters = [];
        for (const w of waiters) w();
        return Promise.resolve();
      },
      recv: () => {
        const next = this.toClient.shift();
        if (next !== undefined) return Promise.resolve(next);
        if (this.closed) return Promise.reject(this.closed);
        return new Promise((resolve, reject) => {
          this.clientWaiter = resolve;
          this.closeClient = reject;
        });
      },
      close: (code = 1000, reason = "") => {
        this.drop(code, reason);
        return Promise.resolve();
      },
    };
  }
}

/** A dialer that records every leg and lets the test play relay. */
export function fakeRelay() {
  const legs: FakeLeg[] = [];
  let legWaiters: Array<() => void> = [];
  return {
    legs,
    dialer: (url: string, options: DialOptions) => {
      const leg = new FakeLeg(url, options);
      legs.push(leg);
      const waiters = legWaiters;
      legWaiters = [];
      for (const w of waiters) w();
      return Promise.resolve(leg.transport());
    },
    async leg(index: number): Promise<FakeLeg> {
      while (legs.length <= index) await new Promise<void>((r) => legWaiters.push(r));
      return legs[index]!;
    },
  };
}

/** Wrap a bacloud response object as a server message payload. */
export const msg = (seq: number, body: unknown): Frame => ({
  type: "m",
  seq,
  payload: JSON.stringify(body),
});
