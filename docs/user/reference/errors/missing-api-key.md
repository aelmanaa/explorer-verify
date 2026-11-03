# missing-api-key

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

From the Etherscan v2, Routescan and standalone clients on ([#61](https://github.com/aelmanaa/explorer-verify/issues/61), [#62](https://github.com/aelmanaa/explorer-verify/issues/62), [#63](https://github.com/aelmanaa/explorer-verify/issues/63)): in this release the routing table sends every chain it lists to Sourcify, which takes no key, so the library does not
throw this code yet.

Cause: the route's backend needs an API key and the call has none for it. Two cases throw this
code:

- Before any request: the backend is `etherscan-v2`, no key is bound to the route's API host, and
  `fetch` is not set. A key in `apiKeys["etherscan-v2"]` is sent only to `api.etherscan.io`, so a
  route whose `apiUrl` points at another host gets no key from `apiKeys`.
- After a request: the explorer answered that the key is missing, as Etherscan's
  `Missing/Invalid API Key`. Etherscan gives this answer for no key, and for a key sent where it
  does not read one, such as a request header. With an injected `fetch`, the request goes out
  without a key and this answer decides.

`details.backend` names the backend. The error never holds the key.

Fix: pass the key in `apiKeys` under the backend that `details.backend` names, or as `route.apiKey`
for an explorer on its own host. With an injected `fetch` that leads to your own server, check that
the server adds the key. [API keys](../api-keys.md) describes where each key goes.

Default hint: Pass the key in apiKeys under the backend named in details.backend, or as
route.apiKey for an explorer on its own host, then call again. Keep the key out of browser code.

Retryable: no.

Exit code: 3

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
