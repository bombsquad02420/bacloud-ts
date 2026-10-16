# Ballistica Cloud for VS Code

Clone, pull and push [Ballistica](https://ballistica.net) cloud workspaces from VS Code.

Any folder with a `.bacloudstate.json` (made by this extension, `bacloud-ts`, or ballistica's `tools/bacloud`) is treated as a cloud workspace.

## Features

- **Sign in** with your Ballistica account through the browser. The token is kept in VS Code's secret storage.
- **Cloud Workspaces**: list your workspaces and clone one into a folder.
- **Current Workspace**: sync status, fleet, snapshot and folder, with Pull and Push.
- **Pull** without losing work: cloud changes are compared with your local edits three ways, then shown as _Incoming_, _Conflicts_ and _Local only_, with diffs. Nothing is overwritten until you apply it.
- **Push** with a preview of your local changes. The server refuses a push if the cloud changed since your last sync, and the extension offers to pull.

## Settings

| Setting         | Default | Description                                              |
| --------------- | ------- | -------------------------------------------------------- |
| `bacloud.fleet` | `prod`  | Which Ballistica cloud fleet to use                      |
| `bacloud.trace` | `false` | Log session diagnostics to the Ballistica output channel |

## Notes

- Desktop VS Code only (not vscode.dev).
- The server only syncs these file types: `.py .txt .json .png .jpg .obj .toml .bstr .apref .wav .bchar`. Files whose name starts with `.` are never synced.

Source and issues: [bombsquad02420/bacloud-ts](https://github.com/bombsquad02420/bacloud-ts).
