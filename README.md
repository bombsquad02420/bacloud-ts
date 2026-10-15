# bacloud-ts

TypeScript implementation of the Ballistica cloud (`bacloud`) client.

| Package                         | Description                                                    |
| ------------------------------- | -------------------------------------------------------------- |
| [`@bacloud/sdk`](packages/sdk)  | Wire protocol, session transport and command runner.           |
| [`@bacloud/cli`](apps/cli)      | `bacloud-ts` command-line client (also used for live testing). |
| [`bacloud-vscode`](apps/vscode) | VS Code extension (in progress).                               |

```bash
vp install
vp run -r test
vp run -r build
```
