# @bacloud/cli

`bacloud-ts`: a command-line client for Ballistica cloud, built on
[`@bacloud/sdk`](../../packages/sdk). Like ballistica's `tools/bacloud`,
it sends its arguments to the server, which defines the commands.

```bash
vp run @bacloud/cli#build
node apps/cli/dist/bin.mjs status
node apps/cli/dist/bin.mjs signin
node apps/cli/dist/bin.mjs workspace get MyWorkspace
```

Exit codes: `0` success, `1` a no/fail result, `2` errors. Results go to
stdout, diagnostics to stderr.

## Files (XDG Base Directory Specification)

| Path                                                        | Contents                                                |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| `$XDG_CONFIG_HOME/bacloud-ts/config.json` (`~/.config/…`)   | Optional defaults: `{ "fleet": "prod", "server": "…" }` |
| `$XDG_STATE_HOME/bacloud-ts/auth.json` (`~/.local/state/…`) | Login tokens per fleet (mode `0600`, dir `0700`)        |

Workspace checkouts also get a `.bacloudstate.json` (snapshot id for the
put collision guard), as with the Python client.

## Environment

| Variable             | Effect                                                              |
| -------------------- | ------------------------------------------------------------------- |
| `BALLISTICA_API_KEY` | Authenticate with an API key; stored logins are not read or written |
| `BA_FLEET`           | `prod` (default), `test` or `dev`; overrides config                 |
| `BACLOUD_SERVER`     | Explicit server host; overrides config                              |
| `BACLOUD_VERBOSE=1`  | Session / node diagnostics on stderr                                |
| `BA_BUILD_NUMBER`    | Engine build reported to asset commands                             |
