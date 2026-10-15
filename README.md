# bacloud-ts

TypeScript implementation of the Ballistica cloud (`bacloud`) client.

| Package                         | Description                                                    |
| ------------------------------- | -------------------------------------------------------------- |
| [`@bacloud/sdk`](packages/sdk)  | Wire protocol, session transport and command runner.           |
| [`@bacloud/cli`](apps/cli)      | `bacloud-ts` command-line client (also used for live testing). |
| [`bacloud-vscode`](apps/vscode) | VS Code extension (in progress).                               |

```bash
vp install
vp run -r build   # build first: the CLI and extension use the SDK's dist/
vp check
vp run -r test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, live testing and the VS Code extension.

The SDK and CLI are ported from [ballistica](https://github.com/efroemling/ballistica) `5cd0916442fd` (v1.8.1, bacloud protocol 29). [UPSTREAM.md](UPSTREAM.md) maps each file to its upstream counterpart and lists every behaviour difference.

## License

MIT; see [LICENSE](LICENSE). Code ported from ballistica keeps its MIT notice; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
