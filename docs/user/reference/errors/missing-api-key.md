# missing-api-key

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The Etherscan v2, Routescan and [Etherscan-compatible](../etherscan-compatible.md) clients throw
this code; they read the same answers.

Cause: the route's backend needs an API key and the call has none for it. Two cases throw this
code:

- Before any request: the backend is `etherscan-v2` or `blockscout-hosted`, no key is bound to the
  route's API host, and `handlerUrl` does not send the route to your server handler. An injected `fetch` does not change
  this. A key in `apiKeys["etherscan-v2"]` is sent only to `api.etherscan.io`, and
  only for a route the routing table chose: a route with `apiUrl` set, even to `api.etherscan.io`,
  gets no key from `apiKeys`. Pass `route.apiKey` for it.
- After a request: the explorer answered that the key is missing, as Etherscan's
  `Missing/Invalid API Key`. Etherscan gives this answer for no key, and for a key sent where it
  does not read one, such as a request header. With `handlerUrl`, this answer means your server
  handler sent no key.

`details.backend` names the backend. The error never holds the key.

Fix: pass the key in `apiKeys` under the backend that `details.backend` names, or as `route.apiKey`
for an explorer on its own host. For `etherscan-v2` in a browser, set `handlerUrl` to your
[server handler](../server-handler.md), which adds the key, and check that the handler has one. For
`etherscan-v2`, the message of the error thrown before any request names `handlerUrl`.
[API keys](../api-keys.md) describes where each key goes.

Default hint: Pass the key in apiKeys under the backend named in details.backend, or as
route.apiKey for an explorer on its own host, then call again. Keep the key out of browser code.

Retryable: no.

Exit code: 3

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
