/**
 * bacloud wire contract (mirror of ballistica `bacommon/bacloud.py`).
 *
 * Upstream: `tools/bacommon/bacloud.py`, plus `DirectoryManifest` from
 * `tools/bacommon/transfer.py`. See UPSTREAM.md.
 */

import { decode, encode, multitype, type Schema } from "./codec.ts";

/**
 * Protocol version sent with every session. The server rejects
 * clients below its minimum, which tracks this value.
 */
export const BACLOUD_VERSION = 29;

// ---------------------------------------------------------------- //
// Requests.
// ---------------------------------------------------------------- //

/** The command envelope every request uses. */
export interface StandardRequest {
  type: "s";
  command: string;
  payload: Record<string, unknown>;
  /** Seconds between local time and UTC. */
  tzoffset: number;
  /** Whether output goes to a terminal (affects server formatting). */
  isatty: boolean;
  /** Safe to retry after a post-send failure. */
  idempotent?: boolean;
  /** Engine build number of the caller (asset commands gate on it). */
  buildNumber?: number;
}

export type Request = StandardRequest;

export const requestCodec = multitype<Request["type"], Request>(
  {
    s: {
      command: "c",
      payload: "p",
      tzoffset: "z",
      isatty: "y",
      idempotent: "i",
      buildNumber: "b",
    },
  },
  "s",
);

// ---------------------------------------------------------------- //
// Standard response.
// ---------------------------------------------------------------- //

export interface SignedUploadEntry {
  path: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  sessionId: string;
}

export interface OneshotUploadEntry {
  path: string;
  cloudFileId: string;
}

export interface SignedDownloadEntry {
  path: string;
  downloadUrl: string;
  sha256: string;
  size: number;
}

export interface SignedDownloadsProgress {
  priorCount: number;
  priorBytes: number;
  totalCount: number;
  totalBytes: number;
}

export interface UploadPlan {
  sourceDir: string;
  finalizeCommand: string;
  finalizeState: Record<string, unknown>;
  cloudFileCategory: string;
  description?: string;
}

export interface CasDelivery {
  apverid: string;
  textureProfile: string;
  textureTier: string;
  language: string;
  blobs: Record<string, number>;
  /** Opaque `securedata.Archive` capability token. */
  token?: unknown;
}

/** Response sent from the bacloud server to the client. */
export interface StandardResponse {
  type: "s";
  message?: string;
  messageEnd?: string;
  messageStderr?: string;
  messageStderrEnd?: string;
  error?: string;
  returnCode?: number;
  delaySeconds?: number;
  retryWindowSeconds?: number;
  login?: string;
  logout?: boolean;
  dirManifest?: string;
  uploadsSigned?: SignedUploadEntry[];
  uploadsOneshot?: OneshotUploadEntry[];
  uploadPlan?: UploadPlan;
  rawResult?: Record<string, unknown>;
  deletes?: string[];
  /** Path -> zlib-compressed file body. */
  downloadsInline?: Record<string, Uint8Array>;
  downloadsSigned?: SignedDownloadEntry[];
  downloadsSignedProgress?: SignedDownloadsProgress;
  casDelivery?: CasDelivery;
  dirPruneEmpty?: string;
  workspaceSnapshotId?: string;
  openUrl?: string;
  /** [prompt, isPassword] */
  inputPrompt?: [string, boolean];
  endMessage?: string;
  endMessageEnd?: string;
  endMessageStderr?: string;
  endMessageStderrEnd?: string;
  /** Next command to run: [command, args]. */
  endCommand?: [string, Record<string, unknown>];
  streamCallId?: string;
}

const standardResponseSchema: Schema = {
  message: "m",
  messageEnd: "m_end",
  messageStderr: "m2",
  messageStderrEnd: "m2_end",
  error: "e",
  returnCode: "r",
  delaySeconds: "d",
  retryWindowSeconds: "rw",
  login: "l",
  logout: "lo",
  dirManifest: "man",
  uploadsSigned: {
    key: "usgn",
    kind: { list: { object: { path: "p", uploadUrl: "u", uploadHeaders: "h", sessionId: "s" } } },
  },
  uploadsOneshot: { key: "uos", kind: { list: { object: { path: "p", cloudFileId: "f" } } } },
  uploadPlan: {
    key: "upl",
    kind: {
      object: {
        sourceDir: "sd",
        finalizeCommand: "fc",
        finalizeState: "fs",
        cloudFileCategory: "ct",
        description: "de",
      },
    },
  },
  rawResult: "rr",
  deletes: "dlt",
  downloadsInline: { key: "dinl", kind: { record: "bytes" } },
  downloadsSigned: {
    key: "dsgn",
    kind: { list: { object: { path: "p", downloadUrl: "u", sha256: "h", size: "s" } } },
  },
  downloadsSignedProgress: {
    key: "dsgp",
    kind: { object: { priorCount: "pc", priorBytes: "pb", totalCount: "tc", totalBytes: "tb" } },
  },
  casDelivery: {
    key: "cas",
    kind: {
      object: {
        apverid: "a",
        textureProfile: "tp",
        textureTier: "tq",
        language: "l",
        blobs: "b",
        token: "tk",
      },
    },
  },
  dirPruneEmpty: "dpe",
  workspaceSnapshotId: "wss",
  openUrl: "url",
  inputPrompt: "inp",
  endMessage: "em",
  endMessageEnd: "eme",
  endMessageStderr: "em2",
  endMessageStderrEnd: "em2e",
  endCommand: "ec",
  streamCallId: "sci",
};

// ---------------------------------------------------------------- //
// Other responses.
// ---------------------------------------------------------------- //

/** Unsolicited: the resume token for a session just created. */
export interface SessionHandleResponse {
  type: "sh";
  token: string;
  channelId: string;
  wsUrl: string;
  expiryUnixSeconds: number;
}

/** Live output from a streamed command; print verbatim. */
export interface StreamOutputResponse {
  type: "so";
  text: string;
}

/** One ordered slice of a serialized response too large for one message. */
export interface ChunkedResponse {
  type: "ch";
  index: number;
  count: number;
  data: string;
}

export type Response =
  | StandardResponse
  | SessionHandleResponse
  | StreamOutputResponse
  | ChunkedResponse;

export const responseCodec = multitype<Response["type"], Response>(
  {
    s: standardResponseSchema,
    sh: { token: "t", channelId: "c", wsUrl: "u", expiryUnixSeconds: "e" },
    so: { text: "t" },
    ch: { index: "i", count: "n", data: "d" },
  },
  "s",
);

// ---------------------------------------------------------------- //
// Upload-plan sub-protocol (payloads / raw results).
// ---------------------------------------------------------------- //

export interface UploadPlanFileInfo {
  name: string;
  sha256: string;
  size: number;
}

export interface UploadPlanPrepareItem {
  name: string;
  cloudFileId?: string;
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
  sessionId?: string;
}

const prepareItemSchema: Schema = {
  name: "n",
  cloudFileId: "c",
  uploadUrl: "u",
  uploadHeaders: "h",
  sessionId: "s",
};

export function encodePrepareRequest(
  files: UploadPlanFileInfo[],
  cloudFileCategory: string,
): Record<string, unknown> {
  return encode(
    {
      files: { key: "f", kind: { list: { object: { name: "n", sha256: "h", size: "s" } } } },
      cat: "ct",
    },
    { files, cat: cloudFileCategory },
  );
}

export function decodePrepareResponse(raw: unknown): UploadPlanPrepareItem[] {
  return decode<{ items: UploadPlanPrepareItem[] }>(
    { items: { key: "i", kind: { list: { object: prepareItemSchema } } } },
    raw,
  ).items;
}

export function encodeFinalizeRequest(sessions: Record<string, string>): Record<string, unknown> {
  return { s: sessions };
}

export function decodeFinalizeResponse(raw: unknown): Record<string, string> {
  return decode<{ ids: Record<string, string> }>({ ids: "c" }, raw).ids;
}

export function encodeUploadPlanCommit(
  files: Record<string, string>,
  state: Record<string, unknown>,
): Record<string, unknown> {
  return { f: files, s: state };
}

/** `bacommon.transfer.DirectoryManifest` in wire form. */
export interface DirectoryManifest {
  files: Record<string, { sha256: string; size: number }>;
  exists: boolean;
}

export function encodeDirectoryManifest(manifest: DirectoryManifest): Record<string, unknown> {
  return encode(
    { files: { key: "f", kind: { record: { object: { sha256: "h", size: "s" } } } }, exists: "e" },
    manifest,
  );
}
