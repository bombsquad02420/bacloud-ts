/**
 * Runs bacloud commands (port of `bacommontools.bacloud.App`).
 *
 * bacloud is a thin client: the user's argv goes to the server as an
 * `_interactive` command, and every response says what to do next —
 * print, prompt, transfer files, or call `endCommand` — until a
 * response carries no follow-up.
 */

import type { BacloudHost } from "./host.ts";
import {
  decodeFinalizeResponse,
  decodePrepareResponse,
  encodeDirectoryManifest,
  encodeFinalizeRequest,
  encodePrepareRequest,
  encodeUploadPlanCommit,
  type OneshotUploadEntry,
  type SignedDownloadEntry,
  type SignedDownloadsProgress,
  type SignedUploadEntry,
  type StandardResponse,
  type UploadPlan,
  type UploadPlanFileInfo,
  BACLOUD_VERSION,
} from "./protocol/bacloud.ts";
import { BacloudSession } from "./session.ts";
import {
  readWorkspaceState,
  updateWorkspaceState,
  WorkspaceStateError,
  type WorkspaceState,
} from "./workspaceState.ts";
import type { Dialer } from "./transport/transport.ts";

/** A failure the server or protocol reported; message is user-facing. */
export class BacloudError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacloudError";
  }
}

export type Fleet = "prod" | "test" | "dev";

const FLEET_HOSTS: Record<Fleet, string> = {
  prod: "regional.ballistica.net",
  test: "test.ballistica.net",
  dev: "dev.ballistica.net",
};

/**
 * argv prefixes safe to retry after a post-send failure (read-only or
 * content-idempotent). Everything else is treated as mutating.
 */
const IDEMPOTENT_PREFIXES: readonly (readonly string[])[] = [
  ["assetpackage", "_assemble"],
  ["assetpackage", "version"],
  ["assetpackage", "_listing"],
  ["assetpackage", "wrapper"],
  ["account", "info"],
  ["workspace", "list"],
  ["workspace", "get"],
];

export function isIdempotentCommand(args: readonly string[]): boolean {
  return IDEMPOTENT_PREFIXES.some((prefix) => prefix.every((part, i) => args[i] === part));
}

/**
 * The host to open a session with. `prod` dials the regional load
 * balancer; other fleets ask their master for a healthy node.
 */
export async function resolveServer(fleet: Fleet = "prod"): Promise<string> {
  if (fleet === "prod") return FLEET_HOSTS.prod;
  const res = await fetch(`https://${FLEET_HOSTS[fleet]}/bacloud_node`);
  if (!res.ok) throw new BacloudError(`bacloud_node (${fleet}): HTTP ${res.status}`);
  const data = (await res.json()) as { error?: string; hostname?: string };
  if (data.error) throw new BacloudError(`bacloud_node (${fleet}): ${data.error}`);
  if (!data.hostname) throw new BacloudError(`bacloud_node (${fleet}): missing hostname`);
  return data.hostname;
}

export interface ClientOptions {
  host: BacloudHost;
  /** Explicit server host; otherwise resolved from `fleet`. */
  server?: string;
  fleet?: Fleet;
  /** API key (`bsac-…`) or login token. */
  bearer?: string;
  /** Called when the server signs the user in (token) or out (undefined). */
  onLoginChange?: (token: string | undefined) => void;
  /** Engine build number to report (asset commands gate on it). */
  buildNumber?: number;
  /** Whether output goes to a terminal. */
  isatty?: boolean;
  dialer?: Dialer;
  /** Concurrent signed downloads. */
  downloadWorkers?: number;
  log?: (message: string) => void;
}

export interface RunOptions {
  /** Client working directory the server resolves paths against. */
  cwd: string;
  /** Project root reported to the server; defaults to `cwd`. */
  projectRoot?: string;
}

export interface RunResult {
  returnCode: number;
  /** Workspace snapshot id after a `workspace get`/`put`. */
  workspaceSnapshotId?: string;
  /** Raw results from responses, in order (for programmatic callers). */
  rawResults: Record<string, unknown>[];
}

type Call = [string, Record<string, unknown>];

interface WorkspaceGuard {
  /** Args to actually send. */
  args: string[];
  /** Absolute local workspace dir. */
  dir: string;
  /** Explicit `--workspace` name, if given. */
  name: string | undefined;
}

export class BacloudClient {
  private readonly options: ClientOptions;
  private readonly server: string;
  private session: BacloudSession;
  private bearer: string | undefined;

  private constructor(options: ClientOptions, server: string, session: BacloudSession) {
    this.options = options;
    this.server = server;
    this.session = session;
    this.bearer = options.bearer;
  }

  /** Resolve the server and open a session. */
  static async connect(options: ClientOptions): Promise<BacloudClient> {
    const server = options.server ?? (await resolveServer(options.fleet));
    const session = await BacloudSession.open({
      server,
      bearer: options.bearer,
      dialer: options.dialer,
      log: options.log,
    });
    return new BacloudClient(options, server, session);
  }

  /** Session channel id, for bug reports. */
  get channelId(): string | undefined {
    return this.session.channelId;
  }

  async close(): Promise<void> {
    await this.session.end();
  }

  /** Run one user command (argv, without the `bacloud` itself). */
  async run(argv: string[], options: RunOptions): Promise<RunResult> {
    const guard = await this.prepareWorkspaceGuard(argv, options.cwd);
    const args = guard?.args ?? argv;
    const idempotent = isIdempotentCommand(args);
    const result: RunResult = { returnCode: 0, rawResults: [] };
    let next: Call | undefined = [
      "_interactive",
      { c: options.cwd, p: options.projectRoot ?? options.cwd, a: args },
    ];
    let retryWindow = 0;

    while (next) {
      const response = await this.callChained(next, idempotent, retryWindow);
      next = undefined;
      retryWindow = 0;
      const extraArgs: Record<string, unknown> = {};

      if (response.rawResult) result.rawResults.push(response.rawResult);
      if (response.login !== undefined) this.setLogin(response.login);
      if (response.logout) this.setLogin(undefined);
      if (response.dirManifest !== undefined) {
        const manifest = await this.options.host.fs.manifest(response.dirManifest);
        extraArgs["manifest"] = encodeDirectoryManifest(manifest);
      }
      if (response.uploadsSigned) {
        extraArgs["uploads_signed"] = await this.uploadSigned(response.uploadsSigned);
      }
      if (response.uploadsOneshot) {
        extraArgs["uploads_oneshot"] = await this.uploadOneshot(response.uploadsOneshot);
      }
      if (response.uploadPlan) {
        if (response.endCommand) {
          throw new BacloudError("Response has both upload_plan and end_command.");
        }
        next = await this.runUploadPlan(response.uploadPlan, idempotent);
        continue;
      }

      await this.applyFileOps(response);
      if (response.workspaceSnapshotId !== undefined) {
        result.workspaceSnapshotId = response.workspaceSnapshotId;
      }

      const io = this.options.host;
      if (response.openUrl !== undefined) io.openUrl(response.openUrl);
      if (response.inputPrompt) {
        const [message, password] = response.inputPrompt;
        extraArgs["input"] = await io.prompt(message, { password });
      }
      if (response.endMessage !== undefined) {
        io.stdout(response.endMessage + (response.endMessageEnd ?? "\n"));
      }
      if (response.endMessageStderr !== undefined) {
        io.stderr(response.endMessageStderr + (response.endMessageStderrEnd ?? "\n"));
      }
      if (response.endCommand) {
        const [command, commandArgs] = response.endCommand;
        next = [command, { ...commandArgs, ...extraArgs }];
        retryWindow = response.retryWindowSeconds ?? 0;
      }
      if (response.returnCode !== undefined) result.returnCode = response.returnCode;
    }
    if (guard && result.workspaceSnapshotId !== undefined) {
      await this.saveWorkspaceState(guard, result.workspaceSnapshotId);
    }
    return result;
  }

  /**
   * Optimistic-concurrency setup for `workspace get`/`put`.
   *
   * A get records the workspace's snapshot id in the target dir's
   * `.bacloudstate.json`; a put sends it back as
   * `--expected-snapshotid` so the server refuses to overwrite a
   * workspace that changed since. The client-only `--force` flag skips
   * that check.
   */
  private async prepareWorkspaceGuard(
    args: string[],
    cwd: string,
  ): Promise<WorkspaceGuard | undefined> {
    if (args[0] !== "workspace" || (args[1] !== "get" && args[1] !== "put")) return undefined;

    // The target dir is the lone positional after the subcommand
    // (default '.'); --workspace takes a value, other --flags don't.
    let name: string | undefined;
    const positionals: string[] = [];
    const rest = args.slice(2);
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i]!;
      if (token === "--workspace") name = rest[++i];
      else if (!token.startsWith("--")) positionals.push(token);
    }
    const dir = resolvePath(cwd, positionals[0] ?? ".");
    const isPut = args[1] === "put";
    const force = isPut && args.includes("--force");
    let sent = force ? args.filter((a) => a !== "--force") : args;

    let state: WorkspaceState | undefined;
    try {
      state = await readWorkspaceState(this.options.host.fs, dir);
    } catch (err) {
      if (!(err instanceof WorkspaceStateError)) throw err;
      // Fail closed: a put without the guard could overwrite newer
      // work. A get rewrites the file anyway.
      if (isPut && !force) {
        throw new BacloudError(`${err.message} (Or pass --force to put without the check.)`);
      }
    }

    // The recorded name wins over the folder's name, so a renamed or
    // moved checkout still targets the workspace it came from.
    if (name === undefined && state?.name !== undefined) {
      name = state.name;
      sent = [...sent, "--workspace", name];
    }

    if (force) {
      this.options.host.stderr(
        "WARNING: --force skips the changed-since-last-get check.\n" +
          "Your local copy wins outright; nothing is merged. A stale local workspace.json " +
          "will overwrite server-maintained state in it (translation up-to-date stamps, " +
          "wrap params, caches), which can silently restale every string in the package.\n",
      );
    } else if (isPut && state?.snapshotid !== undefined) {
      sent = [...sent, "--expected-snapshotid", state.snapshotid];
    }
    return { args: sent, dir, name };
  }

  private async saveWorkspaceState(guard: WorkspaceGuard, snapshotId: string): Promise<void> {
    const patch: WorkspaceState = { snapshotid: snapshotId };
    if (guard.name !== undefined) patch.name = guard.name;
    try {
      await updateWorkspaceState(this.options.host.fs, guard.dir, patch);
    } catch (err) {
      // Non-fatal: the sync succeeded; a later put just skips the check.
      this.options.log?.(`could not save workspace state: ${String(err)}`);
    }
  }

  // ---------------------------------------------------------------- //

  private setLogin(token: string | undefined): void {
    this.bearer = token;
    this.options.onLoginChange?.(token);
  }

  /** Send one command and apply the handling every response gets. */
  private async call(call: Call, idempotent: boolean): Promise<StandardResponse> {
    if (!this.session.alive) {
      throw new BacloudError(
        "Connection to the bacloud server was lost. Please re-run the command.",
      );
    }
    const io = this.options.host;
    const response = await this.session.request(
      {
        type: "s",
        command: call[0],
        payload: call[1],
        tzoffset: -new Date().getTimezoneOffset() * 60,
        isatty: this.options.isatty ?? false,
        idempotent,
        buildNumber: this.options.buildNumber ?? 0,
      },
      (text) => io.stdout(text),
    );
    if (response.message !== undefined) io.stdout(response.message + (response.messageEnd ?? "\n"));
    if (response.messageStderr !== undefined) {
      io.stderr(response.messageStderr + (response.messageStderrEnd ?? "\n"));
    }
    if (response.error !== undefined) throw new BacloudError(response.error);
    if (response.delaySeconds) await sleep(response.delaySeconds * 1000);
    return response;
  }

  /** A chained call the server declared retryable for `retryWindow` seconds. */
  private async callChained(call: Call, idempotent: boolean, retryWindow: number) {
    const deadline = Date.now() + retryWindow * 1000;
    for (;;) {
      try {
        return await this.call(call, idempotent);
      } catch (err) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw err;
        this.options.host.stderr("Server hiccup; retrying...\n");
        await sleep(Math.min(3000, remaining));
      }
    }
  }

  private async applyFileOps(response: StandardResponse): Promise<void> {
    const fs = this.options.host.fs;
    // Deletes first so downloads only ever have to replace empty dirs.
    for (const path of response.deletes ?? []) await fs.deleteFile(path);
    if (response.casDelivery) {
      throw new BacloudError("CAS asset delivery is not supported by this client yet.");
    }
    for (const [path, zipped] of Object.entries(response.downloadsInline ?? {})) {
      await fs.writeFile(path, await inflate(zipped));
    }
    if (response.downloadsSigned?.length) {
      await this.downloadSigned(response.downloadsSigned, response.downloadsSignedProgress);
    }
    if (response.dirPruneEmpty !== undefined) await fs.pruneEmptyDirs(response.dirPruneEmpty);
  }

  private async uploadSigned(entries: SignedUploadEntry[]): Promise<Record<string, string>> {
    const sessions: Record<string, string> = {};
    for (const entry of entries) {
      await this.put(entry.uploadUrl, entry.uploadHeaders, entry.path, entry.path);
      sessions[entry.path] = entry.sessionId;
    }
    return sessions;
  }

  private async uploadOneshot(entries: OneshotUploadEntry[]): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    for (const entry of entries) {
      const body = await this.options.host.fs.readFile(entry.path);
      const headers: Record<string, string> = {
        "User-Agent": `bacloud/${BACLOUD_VERSION}`,
        "Content-Type": "application/octet-stream",
      };
      if (this.bearer) headers["Authorization"] = `Bearer ${this.bearer}`;
      const url = `https://${this.server}/bacloud_oneshot_upload?f=${encodeURIComponent(entry.cloudFileId)}`;
      const res = await fetch(url, { method: "POST", headers, body });
      if (!res.ok) {
        throw new BacloudError(
          `One-shot upload of ${entry.path} failed: status=${res.status} body=${await res.text()}`,
        );
      }
      let id: string | undefined;
      try {
        id = ((await res.json()) as { cloud_file_id?: string }).cloud_file_id;
      } catch {
        id = undefined;
      }
      results[entry.path] = id ?? entry.cloudFileId;
    }
    return results;
  }

  private async put(url: string, headers: Record<string, string>, path: string, label: string) {
    const body = await this.options.host.fs.readFile(path);
    const res = await fetch(url, { method: "PUT", headers, body });
    if (!res.ok) {
      throw new BacloudError(
        `Upload of ${label} failed: status=${res.status} body=${await res.text()}`,
      );
    }
  }

  /** Manifest → dedup → upload → finalize, then call the plan's command. */
  private async runUploadPlan(plan: UploadPlan, idempotent: boolean): Promise<Call> {
    const manifest = await this.options.host.fs.manifest(plan.sourceDir);
    const files: UploadPlanFileInfo[] = Object.entries(manifest.files).map(([name, info]) => ({
      name,
      ...info,
    }));
    if (files.length === 0) {
      throw new BacloudError(`upload_plan source dir ${plan.sourceDir} is empty.`);
    }
    if (plan.description) this.options.host.stdout(`${plan.description}\n`);

    const prepared = await this.call(
      [
        uploadPlanSibling(plan.finalizeCommand, "_upload_plan_prepare"),
        encodePrepareRequest(files, plan.cloudFileCategory),
      ],
      idempotent,
    );
    if (!prepared.rawResult) throw new BacloudError("Prepare response missing raw_result.");

    const resolved: Record<string, string> = {};
    const sessions: Record<string, string> = {};
    for (const item of decodePrepareResponse(prepared.rawResult)) {
      if (item.cloudFileId !== undefined) {
        resolved[item.name] = item.cloudFileId;
        continue;
      }
      if (!item.uploadUrl || !item.sessionId) {
        throw new BacloudError(`Prepare item ${item.name} has neither id nor upload url.`);
      }
      await this.put(
        item.uploadUrl,
        item.uploadHeaders ?? {},
        joinPath(plan.sourceDir, item.name),
        item.name,
      );
      sessions[item.name] = item.sessionId;
    }

    if (Object.keys(sessions).length) {
      const finalized = await this.call(
        [
          uploadPlanSibling(plan.finalizeCommand, "_upload_plan_finalize"),
          encodeFinalizeRequest(sessions),
        ],
        idempotent,
      );
      if (!finalized.rawResult) throw new BacloudError("Finalize response missing raw_result.");
      Object.assign(resolved, decodeFinalizeResponse(finalized.rawResult));
    }
    return [plan.finalizeCommand, encodeUploadPlanCommit(resolved, plan.finalizeState)];
  }

  private async downloadSigned(
    entries: SignedDownloadEntry[],
    progress: SignedDownloadsProgress | undefined,
  ): Promise<void> {
    const totalCount = progress?.totalCount ?? entries.length;
    let doneCount = progress?.priorCount ?? 0;
    let lastReport = Date.now();
    const fetchOne = async (entry: SignedDownloadEntry) => {
      const res = await fetch(entry.downloadUrl);
      if (!res.ok) {
        throw new BacloudError(`Download of ${entry.path} failed: status=${res.status}`);
      }
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.length !== entry.size) {
        throw new BacloudError(
          `Download of ${entry.path} returned ${data.length} bytes; expected ${entry.size}.`,
        );
      }
      const digest = await sha256Hex(data);
      if (digest !== entry.sha256) {
        throw new BacloudError(
          `Download of ${entry.path} sha256 mismatch: got ${digest}, expected ${entry.sha256}.`,
        );
      }
      await this.options.host.fs.writeFile(entry.path, data);
      doneCount++;
      if (Date.now() - lastReport >= 2000 && doneCount < totalCount) {
        lastReport = Date.now();
        this.options.host.stdout(`Downloaded ${doneCount}/${totalCount} files...\n`);
      }
    };
    await pool(entries, this.options.downloadWorkers ?? 16, fetchOne);
  }
}

/**
 * Upload-plan prepare/finalize live directly under the `admin` segment
 * of the finalize command's path.
 */
export function uploadPlanSibling(finalizeCommand: string, sibling: string): string {
  const parts = finalizeCommand.split(".");
  const index = parts.indexOf("admin");
  if (index < 0) {
    throw new BacloudError(`Could not locate admin segment in command path '${finalizeCommand}'.`);
  }
  return [...parts.slice(0, index + 1), sibling].join(".");
}

function resolvePath(cwd: string, target: string): string {
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)) return target;
  const parts = joinPath(cwd, target).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || (part === "" && out.length > 0)) continue;
    if (part === ".." && out.length > 1) out.pop();
    else out.push(part);
  }
  return out.join("/") || "/";
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Undo Python's `zlib.compress`. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function pool<T>(
  items: T[],
  workers: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, run));
}
