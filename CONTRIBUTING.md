# Contributing

## Setup

Prerequisites:

- Node.js 22.18 or newer.
- [Vite+](https://viteplus.dev/guide/) (`vp`). The right pnpm version is downloaded automatically (see `devEngines` in `package.json`).

```bash
git clone https://github.com/bombsquad02420/bacloud-ts.git
cd bacloud-ts
vp install
vp run -r build
```

**Build before checking.** The CLI and the VS Code extension import `@bacloud/sdk` through its built `dist/`, so `vp check` reports type errors in a fresh clone until the SDK has been built once (and again after you change the SDK's public API).

## Everyday commands

| Command           | What it does                                                  |
| ----------------- | ------------------------------------------------------------- |
| `vp run -r build` | Build every package (SDK first)                               |
| `vp check`        | Format, lint and type-check (`vp check --fix` to apply fixes) |
| `vp run -r test`  | Run all tests                                                 |
| `vp run ready`    | Build, check and test: what to run before a PR                |

`vp install` also installs a pre-commit hook that runs `vp check --fix` on staged files.

## Trying it against the real cloud

You need a Ballistica account. Your tokens never go into the repo: the CLI stores them under `$XDG_STATE_HOME/bacloud-ts/` and the extension in VS Code's secret storage.

**CLI**

```bash
node apps/cli/dist/bin.mjs signin
node apps/cli/dist/bin.mjs workspace list
```

See [apps/cli/README.md](apps/cli/README.md) for environment variables (`BA_FLEET`, `BACLOUD_SERVER`, `BACLOUD_VERBOSE`, …).

**VS Code extension**

Open the repo in VS Code and press F5 (**Run Ballistica extension**). It builds the SDK and the extension, then opens an Extension Development Host. Or from a terminal:

```bash
code --new-window --extensionDevelopmentPath="$PWD/apps/vscode"
```

To build an installable `.vsix` and install it into your normal VS Code:

```bash
vp run --filter bacloud-vscode... package
code --install-extension apps/vscode/bacloud-vscode.vsix
```

The design lives in [docs/vscode-extension-design.md](docs/vscode-extension-design.md).

## Keeping up with ballistica

The SDK and CLI are ported from a specific ballistica commit. [UPSTREAM.md](UPSTREAM.md) records it, maps every file to its upstream source, lists all behaviour differences, and has the command to see what changed upstream since. Update it whenever you port upstream changes or change behaviour on purpose.
