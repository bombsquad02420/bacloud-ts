# Proposal: a richer `.bacloudstate.json`

Status: draft · 2026-10-16 · applies to ballistica's `tools/bacloud` and to
`bacloud-ts` (SDK, CLI, VS Code extension).

## Today

After a `workspace get` or `put`, bacloud writes the target folder's
`.bacloudstate.json`:

```json
{ "snapshotid": "FKVLHxCvm9xAH21m6lz7", "name": "Workspace1" }
```

`name` is written only when `--workspace` was passed. On the next `put`
the client sends `--expected-snapshotid`, and the server refuses the put
if the workspace has moved on (bacloud v24+). That guard is the only
protection a put has, and nothing at all protects a get.

## Problems

| #   | Problem                                                                                                                                                      | Effect                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **No fleet.** Nothing records which fleet (`prod`/`test`/`dev`) the folder came from.                                                                        | A `get` with the wrong `BA_FLEET` succeeds whenever a same-named workspace exists there, replacing the folder with another fleet's content. A put without the file is unguarded.         |
| P2  | **No account.** Nothing records which account the folder belongs to.                                                                                         | After signing in as someone else, `get` pulls _their_ same-named workspace over this folder. (A put is refused, because the snapshot ids differ.)                                        |
| P3  | **Identity is the folder name** unless `--workspace` was given.                                                                                              | Renaming or copying the folder silently retargets it: "not found" at best, another workspace at worst.                                                                                   |
| P4  | **No base manifest.** The client doesn't know what the folder looked like at the last sync.                                                                  | `get` can't tell local edits from stale files, so it **overwrites local edits silently** (verified live). No `status` command is possible, and a future push can't preview what changed. |
| P5  | **Read errors fail open.** The Python client returns "no snapshot id" if the file exists but can't be parsed, then puts **without** `--expected-snapshotid`. | A corrupt or half-written file disables the collision guard.                                                                                                                             |
| P6  | **Non-atomic write.** The file is written in place (`open(path, 'w')`).                                                                                      | A crash mid-write produces exactly the corrupt file P5 then ignores.                                                                                                                     |
| P7  | **Unknown keys are dropped.** Each write emits only `snapshotid`/`name`.                                                                                     | No tool can add data without other tools erasing it. This blocks every fix below until all writers are updated.                                                                          |
| P8  | **No version.**                                                                                                                                              | Future format changes can't be detected.                                                                                                                                                 |

## Proposed format (v2)

```json
{
  "version": 2,
  "snapshotid": "FKVLHxCvm9xAH21m6lz7",
  "name": "Workspace1",
  "fleet": "prod",
  "account": "a-8f3c…",
  "workspaceid": "w-1a2b…",
  "synced_at": "2026-10-16T09:12:44Z",
  "synced_by": "bacloud/29",
  "base_manifest": ".bacloud/base-manifest.json"
}
```

| Field                    | Fixes | Behaviour                                                                                                                                               |
| ------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                | P8    | Readers refuse a higher major version with "please update".                                                                                             |
| `snapshotid`             | —     | Unchanged.                                                                                                                                              |
| `name`                   | P3    | **Always written**, so the folder name no longer matters.                                                                                               |
| `fleet`                  | P1    | `get`/`put` refuse when the active fleet differs: "This folder belongs to _prod_; BA_FLEET is _test_." Overridable with an explicit `--fleet`.          |
| `account`                | P2    | Opaque account id from the server. `get`/`put` refuse when the signed-in account differs. Needs the server to return it (see below).                    |
| `workspaceid`            | P3    | Stable server id. Survives renames on the server; detects "same name, different workspace" (deleted and recreated). Needs server support.               |
| `synced_at`, `synced_by` | —     | Diagnostics: when and with which tool. Shown by `status`; useful in bug reports.                                                                        |
| `base_manifest`          | P4    | Path (relative to the folder) to the manifest of the last sync: `{path: {sha256, size}}`. Stored separately so the state file stays small and readable. |

### Base manifest

- Written on every successful get/put: the cloud manifest after the sync (which is the local manifest at that moment).
- Location: `.bacloud/base-manifest.json`, a dot-dir so the sync ignores it, if the server's dotfile rule holds (to verify). Long term, moving everything under `.bacloud/` (`.bacloud/state.json`, like `.git/`) would keep the folder root clean, but changes the well-known file name, so it is optional.
- Enables:
  - `bacloud workspace status`: local changes since the last sync, with no network.
  - `get` refusing to overwrite locally modified files (as git does: "your local changes would be overwritten"), with `--force` to discard them.
  - Push previews (what you're about to upload).
  - The VS Code extension's 3-way classification without keeping its own copy of the base hashes.

## Behaviour rules for every writer and reader

1. **Read-modify-write, preserving unknown keys** (fixes P7). This is the one change that has to land everywhere first.
2. **Atomic writes:** write to a temp file in the same folder, then rename (P6).
3. **Fail closed:** if the file exists but can't be parsed, `put` refuses ("state file is corrupt; re-get or pass --force") instead of dropping the guard (P5). `get` warns and continues, since it rewrites the file anyway.
4. **Missing new fields mean "unknown", not "anything goes":** a v1 file (no `fleet`) adopts the active fleet on the next successful sync and says so once.
5. Write only after a successful sync, so the file always describes a consistent state.

## Server support (optional, makes the guards authoritative)

Client-side checks protect only clients that implement them. With small server additions the guards hold for every client:

- Return `account` and `workspaceid` with get/put results (for example alongside `workspace_snapshotid` in `StandardResponseData`).
- Accept `--expected-workspaceid` and `--expected-account` on get and put, and refuse mismatches the same way `--expected-snapshotid` works today.
- A cheap status call usable with a login token, returning the current `snapshotid` for a workspace. Today `GET /api/v1/admin/workspace-size/<name>` does this but only accepts API keys (login tokens get `401 Invalid API key`).

## Rollout

1. **Preserve unknown keys + atomic write + fail closed** in `tools/bacloud` and `bacloud-ts`. Small, backwards compatible, and unblocks everything else.
2. **Client-only fields:** `version`, always-written `name`, `fleet`, `synced_at`/`synced_by`, base manifest. Each tool adopts them independently; older tools keep working (they ignore unknown keys once step 1 lands).
3. **Server-backed fields:** `account`, `workspaceid`, the expected-* flags and the status call.

Until step 1 lands upstream, the Python client will strip new keys on its next write. `bacloud-ts` must therefore treat every new field as optional, and the VS Code extension keeps its own per-folder record (see [vscode-extension-design.md](vscode-extension-design.md)).

## Also worth considering

- **An ignore file (`.bacloudignore`).** The server syncs everything except dot-named files and rejects a whole put if any file has an unsupported extension (verified 2026-10-16). So a checkout that also holds `.git/`, `.vscode/` or editor scratch files either leaks them into the cloud or can't be pushed at all. A gitignore-style file read by every client would fix both.
- **Name the client at sign-in.** Every token minted by `signin` shows as "bacloud" (location "unknown") on the account's sessions page and consent screen, whether it came from `tools/bacloud`, `bacloud-ts` or the VS Code extension; the User-Agent is ignored (tested 2026-10-16). An optional client name passed with `signin` would let users tell their sessions apart and sign out the right one.
- **Validate before uploading.** Clients could check extensions locally and list every offending file, instead of the server reporting the first one after the round trip.

- **`.gitignore` advice:** the file is per-checkout state. Committing it shares one snapshot id across clones and can make the collision guard pass for a stale copy. Recommend ignoring `.bacloudstate.json` and `.bacloud/`.
- **Status for wrappers:** `pcommand assetworkspace` already compares local and cloud snapshot ids. With the fields above it could also catch fleet and account mismatches.
