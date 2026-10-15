# @bacloud/sdk

TypeScript client for Ballistica's cloud (`bacloud`, protocol v29).

```ts
import { BacloudClient } from "@bacloud/sdk";
import { nodeHost } from "@bacloud/sdk/node";

const client = await BacloudClient.connect({
  host: nodeHost,
  bearer: process.env.BALLISTICA_API_KEY,
});
try {
  const { returnCode } = await client.run(["workspace", "list"], { cwd: process.cwd() });
} finally {
  await client.close();
}
```

## Layers

| Module                    | Mirrors (ballistica `tools/`)     | Role                                           |
| ------------------------- | --------------------------------- | ---------------------------------------------- |
| `protocol/codec.ts`       | `efro/dataclassio`                | short-key JSON + multitype (`_t`) encoding     |
| `protocol/smartsocket.ts` | `efro/smartsocket.py`             | frames, close codes                            |
| `protocol/bacloud.ts`     | `bacommon/bacloud.py`             | request / response types                       |
| `transport/endpoint.ts`   | `SmartSocketEndpoint`             | hello/resume, seq + ack, ping, reconnect       |
| `session.ts`              | `bacommontools/bacloudsession.py` | `wss://<node>/bacloudsession` session          |
| `client.ts`               | `bacommontools/bacloud.py`        | `_interactive` / `end_command` loop, transfers |
| `host.ts`, `node.ts`      | —                                 | pluggable file + terminal side effects         |

Not yet implemented: CAS asset delivery (`assetpackage _assemble`), token refresh.
