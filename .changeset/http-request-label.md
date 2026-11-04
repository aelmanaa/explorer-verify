---
"explorer-verify": patch
---

The logger now gets the request and retry lines for requests to `rpcUrl` (in `verify()` and `resolveInputFromBytecode`) and to `ipfsGateway` (in `resolveInputFromBytecode`). These lines carry a `label` field, `rpc` or `ipfs`, in place of `backend`, because these endpoints are not backends. A logged URL shows its origin and path, with the whole query string as `?REDACTED`, and each path segment of 8 or more characters removed as a possible key. Retries of these requests emit no `verify.retry` event, which names the backend a request goes to; the event schema does not change.

[#134](https://github.com/aelmanaa/explorer-verify/issues/134)
