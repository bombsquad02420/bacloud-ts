# VS Code extension: design (v1, read-only)

Status: draft for review · 2026-10-15

## Goal

Browse Ballistica cloud workspaces in VS Code, read-only. Sign in, see
your workspaces, open one as a folder, read files, refresh to pick up
cloud changes. Editing comes later through an explicit **Push** command,
which this design leaves room for but doesn't build.

Out of scope for v1: editing or push, vscode.dev / browser VS Code,
asset-package commands.

## Constraints that shape the design

| Fact                                                                                                                                      | Source                        | Consequence                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| bacloud only syncs **whole folders** (manifest → server diff → deletes and downloads). There is no per-file read.                         | `@bacloud/sdk`, verified live | We can't fetch a file on demand. Keep a **local mirror** per workspace and serve from it.            |
| `registerFileSystemProvider(scheme, p, { isReadonly: boolean \| MarkdownString })`; read-only stats are forced `FilePermission.Readonly`. | `vscode.d.ts` 1.140           | Read-only is enforced by VS Code, and the MarkdownString is the reason shown to users.               |
| `FileSearchProvider` / `TextSearchProvider` are **proposed** API, not stable.                                                             | `vscode.d.ts` 1.140           | Quick Open and Find in Files may not work in a custom-scheme workspace. **Must test early (spike).** |
| Language servers generally need `file:` paths.                                                                                            | Virtual-workspaces guide      | Python IntelliSense etc. will be limited in a custom-scheme workspace.                               |
| CodeSandbox has **no** FileSystemProvider; it opens sandboxes through Remote-SSH, where the files are real.                               | Decompiled extension survey   | No prior art to copy for the file system part. Copy its UI patterns instead (below).                 |
| bacloud sign-in is server-driven: `openUrl`, then the server polls until the browser completes.                                           | Live `signin`                 | No `vscode://` URI callback needed. Map `host.openUrl` → `env.openExternal`.                         |
| `workspace list` returns only a formatted, coloured table (no JSON, extra args ignored).                                                  | Live test                     | The tree view must parse text. Isolate this in one tested function.                                  |

## Architecture

```
extension (Node, desktop only)
├─ auth        BacloudAuthProvider: token in SecretStorage, sign in/out commands
├─ cloud       one BacloudClient per operation (connect → run → close)
├─ mirror      MirrorStore: globalStorageUri/mirrors/<fleet>/<workspace>/
│                runs `workspace get <dir> --workspace <name>` into it
├─ fs          BacloudFileSystem: scheme `bacloud`, isReadonly, serves the mirror
└─ ui          Workspaces tree, status bar item, commands
```

### Local mirror (the core)

- Location: `context.globalStorageUri/mirrors/<fleet>/<workspace>/`. Per-user, outside any project, cleaned up when the extension is uninstalled.
- Sync = `client.run(["workspace", "get", dir, "--workspace", name])` with the stock `nodeFileHost`. The server addresses real paths, so no path translation is needed, and `.bacloudstate.json` lands in the mirror, ready for a later Push.
- After a sync, diff the mirror's manifest before and after, and fire `onDidChangeFile` for changed, created and deleted paths. Open editors then refresh.
- Read-only means the mirror never has local edits, so a re-sync is always safe.
- Sync triggers: on open, on the **Refresh** command, and optionally on window focus with a cooldown (setting, default off).

### File system provider

- URI: `bacloud://<fleet>/<workspace>/<path>`. The authority carries the fleet (CodeSandbox does the same, parsing identity back from the URI on activation).
- `stat` / `readDirectory` / `readFile` read straight from the mirror, mapping ENOENT to `FileSystemError.FileNotFound`.
- If no mirror exists yet, the first `stat` of the root triggers a sync with a progress notification.
- Hide `.bacloudstate.json` from listings.
- Registered with `isReadonly: new MarkdownString("Ballistica cloud workspaces are read-only in this version.")`.
- The write methods throw `FileSystemError.NoPermissions`. VS Code shouldn't call them anyway.

### Opening a workspace

The `bacloud.openWorkspace` command (from the tree or the palette) does `vscode.openFolder(bacloud://prod/<name>/)`, with a choice of current or new window.

## Decision needed: what the opened folder _is_

|                                 | A. `bacloud://` virtual folder (above)          | B. Open the mirror as a normal `file://` folder                                       |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Read-only                       | Enforced by the provider, with a reason shown   | Workspace setting `files.readonlyInclude: {"**": true}` (users can override per file) |
| Search / Quick Open             | **Unknown**: proposed API only; needs the spike | Works                                                                                 |
| Language features (Python etc.) | Limited                                         | Full                                                                                  |
| Feels like a cloud workspace    | Yes (remote indicator, scheme)                  | No: it's a folder in app storage                                                      |
| Future Push                     | Same mirror; add a command                      | Same mirror; add a command                                                            |

**Recommendation:** build A, because it's what this project set out to do. First run a one-hour **spike**: register a read-only provider over a fixed folder and check whether Quick Open, Find in Files and Python IntelliSense work. If search is dead, switch to B. Everything except the provider is shared, so switching costs about a day.

## UI (patterns borrowed from CodeSandbox)

- Activity-bar container **Ballistica Cloud** with:
  - a **Sign In** view (`when: !bacloud.signedIn`) using `viewsWelcome` and a `command:bacloud.signIn` link;
  - a **Workspaces** tree (`when: bacloud.signedIn`) with one item per workspace (name; type and size as description), `contextValue = workspace`, inline actions **Open** and **Open in New Window** filtered by `viewItem == workspace`, and a title-bar **Refresh**.
- Status bar item, only inside a `bacloud` window: `☁ <workspace>` with last-sync time; click to Refresh, spinner while syncing.
- Commands: `signIn`, `signOut`, `refreshWorkspaces`, `openWorkspace`, `syncWorkspace`, `showLog`.
- Server output (messages, progress) goes to a **Ballistica Cloud** output channel. `BACLOUD_VERBOSE`-style session logs only when the `bacloud.trace` setting is on.

## Auth

- Store the token in `context.secrets`, keyed by fleet. This avoids a plaintext file, unlike CodeSandbox and our CLI.
- Sign-in: `BacloudClient.run(["signin"])` with a host where `openUrl` → `env.openExternal`, `prompt` → `showInputBox` (`password` → `password: true`), and `onLoginChange` → secrets. Show a cancellable progress notification while the server polls.
- Optional later: also register an `AuthenticationProvider` so the account shows in VS Code's Accounts menu.

## SDK and CLI changes this needs

1. Expose a cancellation `AbortSignal` on `run()` so sign-in and long syncs can be cancelled.
2. A `parseWorkspaceList(text)` helper (strip ANSI, parse columns), in the SDK, with fixture tests from live output.
3. A manifest diff helper for change events (`nodeFileHost.manifest` already provides hashes).
4. Settings: `bacloud.fleet` (default `prod`) and `bacloud.syncOnFocus`.
5. Fix: the CLI crashes with EPIPE when stdout closes early (seen with `| head`).

## Package layout

`apps/vscode` (`@bacloud/vscode`), bundled with `vp pack` into a single CJS `dist/extension.js` with `vscode` as an external. `engines.vscode` will be set to a recent stable version. `extensionKind: ["ui", "workspace"]`, `capabilities.virtualWorkspaces: true`. Packaging uses `@vscode/vsce`.

## Plan

1. Spike: read-only provider over a fixed folder; test search, Quick Open and Python. Decide A or B.
2. Scaffold `apps/vscode`, plus the build and launch config (Extension Development Host).
3. Auth: SecretStorage sign-in and sign-out.
4. Workspaces tree with the list parser.
5. Mirror and sync, plus the provider (or B), plus Open.
6. Status bar, Refresh, output channel.
7. Later: the Push command, which is `workspace put` on the mirror with the existing collision guard and a diff view of local and cloud changes.
