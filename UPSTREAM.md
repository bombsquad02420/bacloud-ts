# Upstream: ballistica

The SDK and CLI are a TypeScript port of the bacloud client from
[ballistica](https://github.com/efroemling/ballistica).

|                    |                                                                       |
| ------------------ | --------------------------------------------------------------------- |
| Ported from commit | `5cd0916442fd4307dae1d73da2fd0e932b4b2df6` (tag `v1.8.1`, 2026-10-14) |
| bacloud protocol   | `BACLOUD_VERSION = 29`                                                |

To see what changed upstream since this port:

```bash
git -C ../ballistica log --oneline 5cd0916442fd..origin/main -- \
  tools/bacommon/bacloud.py tools/bacommon/transfer.py \
  tools/bacommontools/bacloud.py tools/bacommontools/bacloudsession.py \
  tools/efro/smartsocket.py tools/efro/dataclassio
```

When porting, also bump `BACLOUD_VERSION` and read the version history
comment at the top of `bacommon/bacloud.py`; the server rejects clients
below its minimum version, which tracks the current one.

## File map

Paths on the right are under ballistica's `tools/`.

| This repo                                  | Upstream                                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/sdk/src/protocol/codec.ts`       | `efro/dataclassio` (only the JSON shape: short storage keys, `_t` multitype ids, omitted defaults, base64 bytes)                                                                                   |
| `packages/sdk/src/protocol/smartsocket.ts` | `efro/smartsocket.py`: frames, endpoint policy, close-code registry, `action_for_close_code`                                                                                                       |
| `packages/sdk/src/protocol/bacloud.ts`     | `bacommon/bacloud.py` (all request/response types, upload-plan types), plus `bacommon/transfer.py` `DirectoryManifest`                                                                             |
| `packages/sdk/src/transport/transport.ts`  | `efro/smartsocket.py` `SmartSocketTransport` / `SmartSocketClosed`; `bacommontools/bacloudsession.py` `_WsTransport`                                                                               |
| `packages/sdk/src/transport/endpoint.ts`   | `efro/smartsocket.py` `SmartSocketEndpoint`                                                                                                                                                        |
| `packages/sdk/src/session.ts`              | `bacommontools/bacloudsession.py` `BacloudSession`                                                                                                                                                 |
| `packages/sdk/src/client.ts`               | `bacommontools/bacloud.py` `App` (command loop, transfers, workspace guard), `_resolve_server`, `_IDEMPOTENT_COMMAND_PREFIXES`, `_upload_plan_sibling`                                             |
| `packages/sdk/src/workspaceState.ts`       | `bacommontools/bacloud.py` `_read_ws_state_snapshotid`, `_finish_workspace_command`                                                                                                                |
| `packages/sdk/src/node.ts`                 | `bacommon/transfer.py` `DirectoryManifest.create_from_disk`; the `os`-level file handlers in `bacommontools/bacloud.py` (`_handle_deletes`, `_handle_downloads_inline`, `_handle_dir_prune_empty`) |
| `packages/sdk/src/host.ts`                 | none (abstraction so non-disk hosts can plug in)                                                                                                                                                   |
| `packages/sdk/src/changes.ts`              | none (three-way classification for pull/push; server rules observed live)                                                                                                                          |
| `packages/sdk/src/workspaces.ts`           | none (parses the server's `workspace list` table)                                                                                                                                                  |
| `apps/cli/src/main.ts`, `bin.ts`           | `bacommontools/bacloud.py` `run_bacloud_main`, `App.run`, `_resolve_api_key`                                                                                                                       |
| `apps/cli/src/paths.ts`, `store.ts`        | `bacommontools/bacloud.py` `StateData`, `_load_state`, `_save_state`                                                                                                                               |

## Behaviour differences

Deliberate changes and known gaps compared with upstream.

### Changed on purpose

| Area                            | Upstream                                                                                          | Here                                                                                                   | Why                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `.bacloudstate.json` read error | Treated as "no snapshot"; the put goes out **without** `--expected-snapshotid`                    | `put` refuses (`--force` still works); `get` continues                                                 | A corrupt file must not silently drop the collision guard      |
| `.bacloudstate.json` write      | Rewrites the file with only `snapshotid` (and `name` if `--workspace` was passed), non-atomically | Merges into the existing file, keeping unknown keys; atomic (temp + rename)                            | Lets other tools add data; see `docs/bacloudstate-proposal.md` |
| Workspace name                  | Folder name unless `--workspace` is passed                                                        | If the state file records a `name` and no `--workspace` is given, the client adds `--workspace <name>` | A renamed or moved checkout keeps its target                   |
| CLI login storage               | `<project>/.cache/bacloud/state`, one token                                                       | `$XDG_STATE_HOME/bacloud-ts/auth.json`, one token per fleet, mode `0600`                               | XDG spec; a prod token is never sent to test/dev               |
| CLI config                      | API key also read from `pconfig/localconfig.json`                                                 | Only `BALLISTICA_API_KEY`; optional `$XDG_CONFIG_HOME/bacloud-ts/config.json` for `fleet`/`server`     | Not tied to a ballistica checkout                              |
| CLI project root                | Must run from a ballistica project (`pconfig/projectconfig.json`)                                 | Runs anywhere; reports `cwd` as the project root                                                       | Standalone tool                                                |
| CLI closed output pipe          | Python's default handling                                                                         | Exits quietly with the current exit code on `EPIPE`                                                    | `\| head` used to crash Node with an unhandled error           |
| Session open                    | `open()` returns `None` on failure; `App` retries the open 4 times                                | `BacloudSession.open()` rejects; **no retry**                                                          | Simpler; add retries if regional-LB refusals show up           |

### Not ported (yet)

| Upstream feature                                                                                                | Effect here                                                             |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| CAS asset delivery (`cas_delivery`, `bacommon/assetcas`, `securedata` tokens)                                   | `assetpackage _assemble` responses using it fail with a clear error     |
| SmartSocket token refresh (`REFRESH` action)                                                                    | A `4001` close ends the session                                         |
| SmartSocket in-flight byte cap and back-pressure (`SmartSocketPayloadTooLarge`, `SmartSocketSendWouldDeadlock`) | Fine for bacloud's small sequential requests                            |
| SmartSocket relay-buffer-full cursor handling, serve-failure counter, anomaly detection                         | Reconnects still follow the close-code actions                          |
| Anomaly reports to the master's `/api/v1/clientlog`                                                             | Nothing is reported home                                                |
| Streaming signed downloads and uploads                                                                          | Bodies are buffered in memory (fine for workspace-sized files)          |
| `BA_BACLOUD_DOWNLOAD_WORKERS`                                                                                   | Use `downloadWorkers` on `ClientOptions` (default 16, same as upstream) |

### Observed server behaviour (not in upstream source)

Verified against prod on 2026-10-16; the server is the authority and may change:

- Files whose name starts with `.` are never synced; files inside dot-folders are.
- A put fails as a whole if any synced file lacks one of the extensions in `ALLOWED_EXTENSIONS` (`changes.ts`).
- `workspace list` only prints a formatted table; there is no machine-readable form.
- `GET /api/v1/admin/workspace-size/<name>` returns the snapshot id but only accepts API keys.
