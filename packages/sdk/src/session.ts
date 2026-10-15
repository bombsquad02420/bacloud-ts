/**
 * A live bacloud conversation with one basn node.
 *
 * The client dials `wss://<server>/bacloudsession`; the handshake
 * creates the channel. The node's first message is a
 * {@link SessionHandleResponse} carrying a resume token and the exact
 * node URL to reconnect to (prod dials a regional load balancer, but
 * a session lives on a single node).
 *
 * Sequential by contract: send a request, read until its standard
 * response, repeat. Stream output and chunked responses are handled
 * here so callers only ever see complete answers.
 *
 * Upstream: `BacloudSession` in `tools/bacommontools/bacloudsession.py`.
 * Differences: an async API instead of a session thread; `open()`
 * rejects instead of returning `None`, and nothing retries it (upstream's
 * `App` retries four times); no anomaly reports to the master. See
 * UPSTREAM.md.
 */

import {
  BACLOUD_VERSION,
  bacloudUserAgent,
  requestCodec,
  responseCodec,
  type Request,
  type Response,
  type StandardResponse,
} from "./protocol/bacloud.ts";
import { SmartSocketEndpoint } from "./transport/endpoint.ts";
import { SmartSocketClosed, webSocketDialer, type Dialer } from "./transport/transport.ts";

/** WS subprotocol the relay selects; must be offered. */
const WS_SUBPROTOCOL = "basmartsocket";
const VERSION_HEADER = "X-Bacloud-Version";
const OPEN_TIMEOUT_MS = 15_000;
const END_TIMEOUT_MS = 2_000;

export class BacloudSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacloudSessionError";
  }
}

export interface SessionOptions {
  /** Host to dial (e.g. `regional.ballistica.net`). */
  server: string;
  /** API key or login token, sent as `Authorization: Bearer`. */
  bearer?: string;
  dialer?: Dialer;
  /** Product token prepended to the User-Agent, e.g. `bacloud-ts-cli/1.0`. */
  client?: string;
  /** Override the `wss://<server>/bacloudsession` URL (tests). */
  url?: string;
  log?: (message: string) => void;
}

export type StreamOutputHandler = (text: string) => void;

interface Pending {
  resolve: (response: StandardResponse) => void;
  reject: (err: Error) => void;
  onOutput: StreamOutputHandler | undefined;
}

export class BacloudSession {
  /** The node's id for this session; quote it in bug reports. */
  channelId: string | undefined;

  private readonly options: SessionOptions;
  private readonly endpoint: SmartSocketEndpoint;
  private readonly running: Promise<void>;
  private token: string | undefined;
  private reconnectUrl: string | undefined;
  private everConnected = false;
  private dialError: string | undefined;
  private chunks: string[] = [];
  private pending: Pending | undefined;
  /** Answers that arrived with nobody waiting (shouldn't happen). */
  private readonly orphans: StandardResponse[] = [];

  private constructor(options: SessionOptions, onConnected: () => void) {
    this.options = options;
    this.endpoint = new SmartSocketEndpoint({
      connect: () => this.connect(),
      onMessage: (payload) => this.onMessage(payload),
      onConnected: () => {
        this.everConnected = true;
        onConnected();
      },
      log: options.log,
    });
    this.running = this.endpoint.run().then(() => this.onEnded());
  }

  /** Open a session, resolving once the first hello completes. */
  static async open(options: SessionOptions): Promise<BacloudSession> {
    let markConnected!: () => void;
    const connected = new Promise<void>((resolve) => {
      markConnected = resolve;
    });
    const session = new BacloudSession(options, () => markConnected());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      connected.then(() => "ok" as const),
      session.running.then(() => "ended" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), OPEN_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (outcome !== "ok") {
      const why =
        session.dialError ?? (outcome === "timeout" ? "attach timed out" : session.describeClose());
      await session.end();
      throw new BacloudSessionError(
        `Unable to open a bacloud session to ${options.server} (${why}). ` +
          "bacloud needs a working WebSocket connection.",
      );
    }
    return session;
  }

  get alive(): boolean {
    return !this.endpoint.done;
  }

  /** Send one request and wait for its standard response. */
  async request(request: Request, onOutput?: StreamOutputHandler): Promise<StandardResponse> {
    if (this.pending) throw new Error("bacloud sessions are sequential; a request is in flight.");
    if (!this.alive) throw new BacloudSessionError(this.deathMessage("is closed"));
    const orphan = this.orphans.shift();
    if (orphan) return orphan;
    const answer = new Promise<StandardResponse>((resolve, reject) => {
      this.pending = { resolve, reject, onOutput };
    });
    try {
      await this.endpoint.send(JSON.stringify(requestCodec.encode(request)));
    } catch {
      this.pending = undefined;
      throw new BacloudSessionError(this.deathMessage("closed"));
    }
    return answer;
  }

  /** Tell the far end we're done (best effort, bounded). */
  async end(): Promise<void> {
    if (this.endpoint.done) return;
    await Promise.race([
      this.endpoint.end("client exiting"),
      new Promise((resolve) => setTimeout(resolve, END_TIMEOUT_MS)),
    ]);
  }

  private async connect() {
    const headers: Record<string, string> = {
      "User-Agent": bacloudUserAgent(this.options.client),
      [VERSION_HEADER]: String(BACLOUD_VERSION),
    };
    if (this.options.bearer) headers["Authorization"] = `Bearer ${this.options.bearer}`;
    // Present only on reconnect: its absence tells the node to create
    // a channel rather than find one.
    if (this.token) headers["X-WS-Token"] = this.token;
    const url =
      this.reconnectUrl ?? this.options.url ?? `wss://${this.options.server}/bacloudsession`;
    const dial = this.options.dialer ?? webSocketDialer;
    try {
      return await dial(url, {
        protocols: [WS_SUBPROTOCOL],
        headers,
        timeoutMs: OPEN_TIMEOUT_MS,
      });
    } catch (err) {
      if (this.everConnected) throw err;
      // Nothing ever answered: fail now instead of burning the whole
      // reconnect budget.
      this.dialError = err instanceof Error ? err.message : String(err);
      throw new SmartSocketClosed(1000, "no session endpoint");
    }
  }

  private onMessage(payload: string): void {
    const response = responseCodec.decode(JSON.parse(payload));
    this.dispatch(response);
  }

  private dispatch(response: Response): void {
    switch (response.type) {
      case "ch": {
        this.chunks.push(response.data);
        if (response.index + 1 < response.count) return;
        const joined = this.chunks.join("");
        this.chunks = [];
        this.dispatch(responseCodec.decode(JSON.parse(joined)));
        return;
      }
      case "sh":
        this.token = response.token;
        this.channelId = response.channelId;
        if (response.wsUrl) this.reconnectUrl = response.wsUrl;
        this.options.log?.(`session ${response.channelId} (resume via ${response.wsUrl})`);
        return;
      case "so":
        this.pending?.onOutput?.(response.text);
        return;
      case "s": {
        const pending = this.pending;
        this.pending = undefined;
        if (pending) pending.resolve(response);
        else this.orphans.push(response);
        return;
      }
    }
  }

  private onEnded(): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(new BacloudSessionError(this.deathMessage("closed mid-command")));
  }

  private describeClose(): string {
    const { closeCode, closeReason } = this.endpoint;
    return closeCode ? `${closeCode} ${closeReason}`.trim() : "closed";
  }

  private deathMessage(what: string): string {
    const code = this.endpoint.closeCode;
    const detail =
      code && code !== 1000 && code !== 1001
        ? `bacloud session closed (${this.describeClose()}).`
        : `bacloud session ${what}.`;
    return this.channelId ? `${detail} (session ${this.channelId})` : detail;
  }
}
