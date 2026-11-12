# missing-api-key

Version: explorer-verify 0.2.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The route's backend needs an API key, and the call has none for it.

## How to fix

Fix: pass the key in `apiKeys` under the backend that `details.backend` names. For an explorer on
its own host, pass it as `route.apiKey`. [API keys](../api-keys.md) describes where each key goes.

For `etherscan-v2` in a browser, set `handlerUrl` to your [server handler](../server-handler.md),
which adds the key, and check that the handler has one. The message of the error thrown before any
request names `handlerUrl`.

From the CLI: etherscan-v2 needs an API key: set ETHERSCAN_API_KEY, or pass --api-key-file `<path>`
or --api-key-stdin with --backend etherscan-v2. --backend sourcify needs no key.

## Facts

Retryable: no.

Exit code: 3

Sent to an explorer: no, or refused. The explorer holds no submission from this call.

Default hint: Pass the key in apiKeys under the backend that the error names (details.backend), or
as route.apiKey for an explorer on its own host, then call again. Keep the key out of browser code.

For end users: The explorer needs an API key and none is set. Add a key for this explorer in the
tool's settings, or ask the tool's maintainer to set one.

## Why

Cause: the route's backend needs an API key and the call has none for it. `details.backend` names
the backend. The error never holds the key. Two cases throw this code.

Before any request, when all of these hold:

- the backend is `etherscan-v2` or `blockscout-hosted`;
- no key is bound to the route's API host;
- `handlerUrl` does not send the route to your server handler.

An injected `fetch` does not change this. A key in `apiKeys["etherscan-v2"]` is sent only to
`api.etherscan.io`: for a route the routing table chose, or for a route whose `apiUrl` is on
`https://api.etherscan.io`. A route with `apiUrl` on another host gets no key from `apiKeys`. Pass
`route.apiKey` for it.

After a request, when the explorer answered that the key is missing, as Etherscan's
`Missing/Invalid API Key`. Etherscan gives this answer for no key, and for a key sent where it does
not read one, such as a request header. With `handlerUrl`, this answer means your server handler
sent no key.

The Etherscan v2, Routescan and [Etherscan-compatible](../etherscan-compatible.md) clients throw
this code; they read the same answers.

## In code

Check the code, then read the backend that needs a key:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "missing-api-key")) {
    console.error(`Pass a key for ${error.details.backend}.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
