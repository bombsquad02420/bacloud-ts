/**
 * One end of a SmartSocket session (port of `SmartSocketEndpoint`).
 *
 * Owns the session state that outlives any one connection — the next
 * seq, the un-acked send buffer, the highest contiguous seq received —
 * and the reconnect loop that keeps the session alive across legs.
 *
 * Payloads are opaque strings here; typing happens one layer up.
 */

import {
  actionForCloseCode,
  CloseCode,
  DEFAULT_POLICY,
  decodeFrame,
  encodeFrame,
  LOSS_DETECTION_FLOOR_SECONDS,
  type CloseAction,
  type EndpointPolicy,
  type Frame,
} from "../protocol/smartsocket.ts";
import { SmartSocketClosed, type Transport } from "./transport.ts";

export interface EndpointOptions {
  /** Open a fresh transport for one attach. */
  connect: () => Promise<Transport>;
  /** Called once per delivered message, in order. */
  onMessage: (payload: string) => void;
  /** Fires on every successful hello. */
  onConnected?: () => void;
  attachTimeoutMs?: number;
  lossDetectionFloorMs?: number;
  ackIntervalMs?: number;
  log?: (message: string) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SmartSocketEndpoint {
  policy: Required<EndpointPolicy> = { ...DEFAULT_POLICY };
  connected = false;
  done = false;
  closeCode = 0;
  closeReason = "";

  private readonly options: Required<Omit<EndpointOptions, "onConnected" | "log">> &
    Pick<EndpointOptions, "onConnected" | "log">;
  private transport: Transport | undefined;
  /** Whether new sends may go straight onto the current leg. */
  private live = false;
  private nextSeq = 1;
  private lastRecv = 0;
  private readonly unacked = new Map<number, string>();
  private pendingAcks = 0;
  private lastInbound = 0;
  private reconnectDeadline = 0;
  private reconnectDelayMs = 500;
  private stopping = false;
  /** Set when *we* closed the leg to recover, so the code means resume. */
  private recovering = false;
  private readonly ended: Promise<void>;
  private resolveEnded!: () => void;

  constructor(options: EndpointOptions) {
    this.options = {
      attachTimeoutMs: 10_000,
      lossDetectionFloorMs: LOSS_DETECTION_FLOOR_SECONDS * 1000,
      ackIntervalMs: 300,
      ...options,
    };
    this.ended = new Promise((resolve) => {
      this.resolveEnded = resolve;
    });
  }

  /** Run the session until it ends. Never rejects. */
  async run(): Promise<void> {
    try {
      this.resetReconnectBudget();
      while (!this.stopping) {
        const action = await this.runOneConnection();
        if (action !== "resume") break; // No token refresh support yet.
        if (!(await this.awaitReconnectSlot())) break;
      }
    } finally {
      this.done = true;
      this.connected = false;
      this.resolveEnded();
    }
  }

  /** Queue a payload; it survives reconnects until acked. */
  async send(payload: string): Promise<void> {
    if (this.done) throw new SmartSocketClosed(this.closeCode, this.closeReason);
    const seq = this.nextSeq++;
    this.unacked.set(seq, payload);
    if (this.live) await this.sendFrame({ type: "m", seq, payload });
  }

  /** End the session for both peers. */
  async end(reason = "done"): Promise<void> {
    this.stopping = true;
    await this.closeTransport(CloseCode.NORMAL, reason);
    await this.ended;
  }

  /** Resolves once {@link run} has finished. */
  waitEnded(): Promise<void> {
    return this.ended;
  }

  private async runOneConnection(): Promise<CloseAction> {
    try {
      this.transport = await this.options.connect();
    } catch (err) {
      if (err instanceof SmartSocketClosed) {
        this.noteClose(err.code, err.reason);
        return actionForCloseCode(err.code);
      }
      this.options.log?.(`connect failed: ${String(err)}`);
      return "resume";
    }

    const timers: ReturnType<typeof setInterval>[] = [];
    const attachTimer = setTimeout(() => {
      if (!this.connected) {
        this.recovering = true;
        void this.closeTransport(CloseCode.DETACH, "attach timeout");
      }
    }, this.options.attachTimeoutMs);
    try {
      await this.sendFrame({ type: "h", lastRecv: this.lastRecv });
      await this.readUntilClosed(timers);
    } catch (err) {
      if (err instanceof SmartSocketClosed) {
        this.noteClose(err.code, err.reason);
      } else {
        this.options.log?.(`connection failed: ${String(err)}`);
        this.noteClose(1011, String(err));
      }
    } finally {
      clearTimeout(attachTimer);
      for (const timer of timers) clearInterval(timer);
      this.connected = false;
      this.live = false;
      this.transport = undefined;
    }
    if (this.recovering) {
      this.recovering = false;
      return "resume";
    }
    return actionForCloseCode(this.closeCode);
  }

  private async readUntilClosed(timers: ReturnType<typeof setInterval>[]): Promise<void> {
    const transport = this.transport!;
    let helloed = false;
    this.lastInbound = Date.now();
    for (;;) {
      const data = await transport.recv();
      this.lastInbound = Date.now();
      let frame: Frame;
      try {
        frame = decodeFrame(data);
      } catch {
        await this.fail(CloseCode.BAD_FRAME, "undecodable frame");
        return;
      }
      switch (frame.type) {
        case "h":
          if (helloed) {
            await this.fail(CloseCode.BAD_FRAME, "duplicate hello");
            return;
          }
          helloed = true;
          await this.onHello(frame.lastRecv ?? 0, frame.policy);
          timers.push(this.startLivenessLoop(), this.startAckLoop());
          break;
        case "m":
          if (!(await this.onMsg(frame.seq, frame.payload ?? ""))) return;
          break;
        case "a":
          this.trim(frame.recv ?? 0);
          break;
        case "i":
          await this.sendFrame({ type: "o" });
          break;
        case "o":
          break;
      }
    }
  }

  private async onHello(lastRecv: number, policy: EndpointPolicy | undefined): Promise<void> {
    if (policy) this.policy = { ...DEFAULT_POLICY, ...policy };
    this.trim(lastRecv);
    // Retransmit what the relay lacks; loop in case sends were queued
    // while we were replaying.
    let sentThrough = lastRecv;
    for (;;) {
      const pending = [...this.unacked.keys()].filter((s) => s > sentThrough).sort((a, b) => a - b);
      if (pending.length === 0) break;
      for (const seq of pending) {
        const payload = this.unacked.get(seq);
        if (payload !== undefined) await this.sendFrame({ type: "m", seq, payload });
        sentThrough = seq;
      }
    }
    this.live = true;
    this.resetReconnectBudget();
    this.reconnectDelayMs = 500;
    this.connected = true;
    this.options.onConnected?.();
  }

  private async onMsg(seq: number, payload: string): Promise<boolean> {
    if (seq <= this.lastRecv) {
      this.pendingAcks++; // Resume overlap; ack and drop.
      return true;
    }
    if (seq !== this.lastRecv + 1) {
      await this.fail(CloseCode.SEQ_VIOLATION, `expected seq ${this.lastRecv + 1}, got ${seq}`);
      return false;
    }
    this.lastRecv = seq;
    this.pendingAcks++;
    try {
      this.options.onMessage(payload);
    } catch (err) {
      this.options.log?.(`undeliverable payload: ${String(err)}`);
      await this.fail(CloseCode.BAD_PAYLOAD, "undecodable payload");
      return false;
    }
    return true;
  }

  private trim(acked: number): void {
    for (const seq of this.unacked.keys()) {
      if (seq <= acked) this.unacked.delete(seq);
    }
  }

  private startLivenessLoop(): ReturnType<typeof setInterval> {
    const intervalMs = this.policy.pingIntervalSeconds * 1000;
    const windowMs = Math.max(1.5 * intervalMs, this.options.lossDetectionFloorMs);
    return setInterval(() => {
      if (Date.now() - this.lastInbound > windowMs) {
        this.recovering = true;
        void this.closeTransport(CloseCode.DETACH, "silent loss detected");
        return;
      }
      void this.sendFrame({ type: "i" });
    }, intervalMs);
  }

  private startAckLoop(): ReturnType<typeof setInterval> {
    return setInterval(() => {
      if (this.pendingAcks) {
        this.pendingAcks = 0;
        void this.sendFrame({ type: "a", recv: this.lastRecv });
      }
    }, this.options.ackIntervalMs);
  }

  private async awaitReconnectSlot(): Promise<boolean> {
    if (Date.now() > this.reconnectDeadline) {
      this.noteClose(CloseCode.RECONNECT_EXHAUSTED, "reconnect budget exhausted");
      return false;
    }
    const delay = this.reconnectDelayMs * (1 + 0.3 * Math.random());
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 10_000);
    await sleep(delay);
    return true;
  }

  private resetReconnectBudget(): void {
    this.reconnectDeadline = Date.now() + this.policy.lingerSeconds * 1000;
  }

  private async sendFrame(frame: Frame): Promise<void> {
    const transport = this.transport;
    if (!transport) return; // Detached; un-acked buffer covers it.
    try {
      await transport.send(encodeFrame(frame));
    } catch {
      // The read loop will see the close.
    }
  }

  private async fail(code: number, reason: string): Promise<void> {
    this.stopping = true;
    await this.closeTransport(code, reason);
  }

  private async closeTransport(code: number, reason: string): Promise<void> {
    const transport = this.transport;
    this.noteClose(code, reason);
    if (!transport) return;
    try {
      await transport.close(code, reason);
    } catch {
      // Best effort.
    }
  }

  private noteClose(code: number, reason: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.connected = false;
  }
}
