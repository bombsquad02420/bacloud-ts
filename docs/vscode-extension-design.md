# VS Code extension: design (v1, pull only)

Status: agreed · 2026-10-16

## Goal

Use Ballistica cloud workspaces from VS Code the way git checkouts are
used: any folder with a `.bacloudstate.json` is a cloud workspace. v1
can **sign in**, **clone** a cloud workspace into a folder, and **pull**
cloud changes into it safely, showing incoming changes and conflicts
before anything is overwritten.

Out of scope for v1: push (and "initialize this folder as a workspace",
which is a push), vscode.dev / browser VS Code, asset-package commands.
The design leaves room for push.

## Constraints that shape the design

| Fact                                                                                                                                                                   | Source                        | Consequence                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bacloud only syncs **whole folders**. `get` makes the target match the cloud, **silently overwriting local edits** and deleting local-only files.                      | `@bacloud/sdk`, verified live | Never run `get` against the user's folder. Pull into a staging copy and apply changes ourselves.                                                           |
| A read-only custom-scheme `FileSystemProvider` gets no Quick Open, no Find in Files and no Python language features (`findFiles` waits forever for a search provider). | Spike, VS Code 1.138          | Work on real `file://` folders. No virtual file system on desktop.                                                                                         |
| `.bacloudstate.json` holds `snapshotid`, plus `name` only when `--workspace` was passed. The Python client rewrites it with just those keys.                           | `bacommontools/bacloud.py`    | Workspace name = `name ?? basename(folder)`. Extra data (fleet, base) can't go in this file yet; see [bacloudstate-proposal.md](bacloudstate-proposal.md). |
| Same workspace names can exist on several fleets. A `get` against the wrong fleet succeeds if the name exists there.                                                   | Analysis                      | Record each folder's fleet in extension storage and refuse mismatches.                                                                                     |
| The cloud snapshot id is queryable (`GET /api/v1/admin/workspace-size/<name>`) **only with an API key**; login tokens get `401 Invalid API key`.                       | pcommand source, live test    | Don't depend on it. Staleness is detected by the staging pull itself.                                                                                      |
| bacloud sign-in is server-driven: `openUrl`, then the server polls until the browser finishes.                                                                         | Live `signin`                 | No `vscode://` callback. Map `host.openUrl` → `env.openExternal`.                                                                                          |
| `workspace list` returns only a formatted, coloured table (no JSON).                                                                                                   | Live test                     | Parse text in one tested function.                                                                                                                         |
| VS Code's "file modified on disk" prompt (Overwrite / Compare) fires automatically when a file with unsaved edits changes on disk.                                     | VS Code behaviour             | Applying a pull gets that safety for dirty editors for free. Saved local edits are protected by the 3-way classification below.                            |
| GitHub Repositories (RemoteHub) gets search only through proposed APIs; CodeSandbox uses Remote-SSH.                                                                   | Package / source surveys      | No prior art for our case. Borrow UI patterns only.                                                                                                        |

## Detection

- On activation and on `onDidChangeWorkspaceFolders`, check each workspace folder root for `.bacloudstate.json`. Watch it with a `FileSystemWatcher` so clone or delete outside VS Code is picked up.
- A folder is a **bacloud workspace** when the file exists and parses. A file that exists but doesn't parse is shown as broken (error in the status bar), never treated as absent.
- Identity: `name ?? basename(folder)`, plus the fleet from the folder record (below), falling back to the `bacloud.fleet` setting.
- Multi-root windows: each folder is tracked separately. The status bar shows the one containing the active editor.
- Context key `bacloud.inWorkspace` gates commands.

## Per-folder record (extension storage)

`.bacloudstate.json` can't hold our data (the Python client drops unknown keys), so the extension keeps a record per folder in `globalStorageUri/folders/<hash of absolute path>/`:

```
record.json   { path, fleet, workspace, snapshotId, syncedAt }
staging/      cloud content at the last pull (= base for the next pull)
base/         transient hard-link snapshot during a pull
```

- **Fleet guard:** if `record.fleet` differs from the current fleet, pull refuses: "This folder was cloned from _prod_; you are signed in to _test_." A folder seen for the first time adopts the current fleet on its first pull and says so.
- If the folder is moved, the record is orphaned; the next pull rebuilds staging (one full download) and re-adopts the fleet with a notice.
- `snapshotId` mismatch between the record and `.bacloudstate.json` means another tool (Python CLI, our CLI) synced the folder. The extension then treats staging as unknown and rebuilds it.

## Pull: staging copy and 3-way classification

```
  C     // local edits      (user's folder)
  |
B |     // cloud changed    (staging after this pull's get)
| /
A       // last sync        (staging before the pull → hard-linked to base/)
```

1. **Snapshot base:** hard-link `staging/` → `base/`. No file data is copied.
2. **Fetch:** `workspace get staging/ --workspace <name>`. This is safe for `base/` because `nodeFileHost` replaces files by write-to-temp + rename and deletes by unlink, so linked inodes keep A's bytes. A unit test pins this behaviour; `FileHost` documents it as a requirement.
   - If nothing was downloaded or deleted, the folder is up to date (this is the staleness check). Done.
3. **Classify** every path by sha256 of base (A), staging (B) and local (C):

   | Local vs A                | Cloud vs A                | Result                                                |
   | ------------------------- | ------------------------- | ----------------------------------------------------- |
   | same                      | changed / added / deleted | **incoming**: apply cloud                             |
   | changed / added / deleted | same                      | **local only**: keep, listed for info                 |
   | changed                   | changed, local = cloud    | same on both sides: nothing to do                     |
   | changed                   | changed, differ           | **conflict**                                          |
   | deleted                   | changed                   | **conflict** (deleted locally, modified in the cloud) |
   | changed                   | deleted                   | **conflict** (modified locally, deleted in the cloud) |
   | added                     | added, differ             | **conflict** (added on both sides)                    |

   Local-only files (`.bacloudstate.json`, and dotfiles in general if the server's dotfile rule is confirmed) are never touched.

4. **Review** in the **Incoming Changes** view. Each incoming or conflicted file opens a diff (`vscode.diff`, staging vs local). For conflicts, try VS Code's 3-way merge editor (base/A, cloud/B, local/C); it is only reachable through an internal command (`_open.mergeEditor`), so fall back to the two-way diff with **Take cloud** / **Keep mine** if it's unavailable.
5. **Apply:** **Apply all incoming** (one click, no conflicts touched) or per file. Copy chosen files from staging into the folder via `workspace.fs` (so open, unmodified editors refresh, and dirty ones get VS Code's own conflict prompt). Once nothing remains unresolved, write B's snapshot id into `.bacloudstate.json` (preserving its existing keys), update `record.json`, and delete `base/`.
   - If the user stops with unresolved conflicts, the folder keeps the old snapshot id, so a future push is still refused by the server's collision guard.

Clone is a pull into an empty folder: `get` into staging, copy everything, write `.bacloudstate.json` (with `name`, so renaming the folder doesn't change the workspace), create the record, then offer to open the folder.

Disk cost: one extra copy of each workspace (staging), plus only the files that changed between A and B during a pull.

## UI

A **Ballistica** container in the **activity bar** with three sections:

- **Current Workspace**: each cloud checkout open in the window, expanded, with a one-line status as its description and inline **Pull** and **Push** icons (the only place they appear in this view). Under it, info rows: a status row only when something needs attention (**Review incoming changes**, a broken state file or a fleet mismatch), then **Last sync**, **Fleet**, **Snapshot** and **Folder** (click to reveal). With no checkout open, a welcome link offers **Clone a Workspace**.
- **Incoming Changes** (only while a pull is staged): groups _Conflicts_, _Incoming_, _Local only_. Click to diff. Inline **Take Cloud** / **Keep Local**. Title actions **Apply All Incoming**, **Discard Pull**.
- **Cloud Workspaces**: signed out, a **Sign in** welcome link; signed in, one item per cloud workspace (name; type, size and age as description) with an inline **Clone**. Title actions: **Refresh**, **Sign out**.

Status bar (only in a bacloud workspace): `☁ Workspace1 · synced 5m ago`. States: syncing (spinner), _n_ incoming, conflicts, fleet mismatch, broken state file. Click → **Pull** if nothing is staged, otherwise reveal Incoming Changes.

Commands: `signIn`, `signOut`, `refreshWorkspaces`, `clone`, `pull`, `applyAllIncoming`, `discardPull`, `showLog`. Output goes to a **Ballistica** output channel; session diagnostics only with `bacloud.trace`.

Settings: `bacloud.fleet` (default `prod`), `bacloud.pullOnOpen` (default off; when on, runs steps 1–3 only and shows the count, never applies).

## Auth

- Token in `context.secrets`, keyed by fleet. No plaintext file (unlike CodeSandbox and our CLI).
- Sign-in runs `BacloudClient.run(["signin"])` with a host where `openUrl` → `env.openExternal`, `prompt` → `showInputBox` (`password: true` where asked), `onLoginChange` → secrets. A cancellable progress notification covers the server's polling.
- Later: an `AuthenticationProvider` so the account shows in VS Code's Accounts menu.

## SDK and CLI changes this needs

1. `run()` takes an `AbortSignal` (cancel sign-in and long pulls).
2. `parseWorkspaceList(text)` (strip ANSI, parse columns), with fixtures from live output.
3. A three-way classifier over manifests (pure, well tested), and a manifest helper that hashes a folder while skipping local-only files.
4. `FileHost` contract: writes replace by rename, deletes unlink (hard-linked base depends on it). Add a test.
5. `.bacloudstate.json` writes must preserve unknown keys and be atomic. The SDK currently writes only `{snapshotid, name}`; fix it.
6. ~~Fix the CLI's EPIPE crash when stdout closes early.~~ Done.

## Server sync rules (verified 2026-10-16)

- Files whose **name** starts with `.` are never synced (`.bacloudstate.json`, `.DS_Store`). Files inside dot-**folders** (`.vscode/settings.json`) are synced like any other.
- Every synced file must end in `.py .txt .json .png .jpg .obj .toml .bstr .apref .wav .bchar`. One other file makes the **whole put** fail ("Invalid file name …"). A folder containing `.git/` can't be pushed.
- Push previews flag unsupported files before uploading; the server stays the authority.

## Push

Local changes = the folder against its staging copy (the cloud at the last sync). Push requires a known base (otherwise: pull first), no pull under review, and a matching fleet. It saves dirty editors, shows the changes in a quick pick (select a file to diff, or **Push N changes**), then runs `workspace put` with the collision guard. If the cloud moved on, it offers to pull. On success the staging copy is updated from the folder, so the next sync starts from the right base.

## Open questions to verify

- Is `_open.mergeEditor` usable from an extension in current VS Code?
- Hard links need `base/` and `staging/` on one volume. They are siblings, so they always are; if `link()` still fails (e.g. a filesystem without hard links), fall back to a full copy.

## Package layout

`apps/vscode` (`@bacloud/vscode`), bundled with `vp pack` into one CJS `dist/extension.js` with `vscode` external. `extensionKind: ["workspace"]` (it must run where the folders are). `capabilities.virtualWorkspaces: false` (nothing to do without real folders), `untrustedWorkspaces: { supported: "limited" }` (pull writes files; only allowed in trusted folders). Packaged with `@vscode/vsce`.

## Plan

1. Scaffold `apps/vscode`, build, and an Extension Development Host launch config.
2. Auth (SecretStorage sign-in/out) and the Cloud Workspaces view.
3. SDK: classifier, manifest helper, `.bacloudstate.json` fixes, `AbortSignal`.
4. Detection, folder records, status bar.
5. Clone.
6. Pull: staging, base snapshot, Incoming Changes view, diffs, apply.
7. Later: Push (`workspace put` of the folder, previewing local changes against the same base), and "initialize this folder".

## Appendix: rejected presentation options

- **A. `bacloud://` read-only virtual folder.** Spike (VS Code 1.138, Pylance installed): browsing and read-only enforcement work; Quick Open hangs ("No search provider registered for scheme"), Find in Files finds nothing, no Python hover or Go to Definition. Kept as the starting point for a browser build, which is also blocked by WebSocket auth headers and CORS on storage hosts.
- **B. Hidden mirror opened as a read-only `file://` folder.** Search works, but it hides files in app storage and fights the user's own folders. Superseded by `.bacloudstate.json` detection.
