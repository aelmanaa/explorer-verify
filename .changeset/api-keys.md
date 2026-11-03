---
"explorer-verify": patch
---

`VerifyOptions` takes `apiKeys`, API keys by backend name, and `RouteOverride` takes `apiKey`. A key in `apiKeys` is sent only to its backend's host, `api.etherscan.io` for `etherscan-v2` and `api.routescan.io` for `routescan`, and only when the call's route resolves to that backend. A `route.apiUrl` on another host gets no key from `apiKeys`. A standalone explorer's key goes in `route.apiKey`, next to `route.apiUrl`, and is bound to that route's host; `apiKeys["etherscan-compatible"]` throws `invalid-input`. Etherscan keys go in the form body of a POST and Routescan keys in the `apikey` header, never in a URL.

Each key must be 8 to 1024 characters, each a letter, a digit, `.`, `_`, `~` or `-`, and not all digits. A key found in the contract address or the handle is refused too. A bad value throws `invalid-input` naming `apiKeys.<backend>` or `route.apiKey`, never the value. Every key, valid or not, is removed from log lines, events, errors and results.

Three error codes, each with exit code 3 and not retryable: `missing-api-key`, `api-key-rejected` and `quota-exceeded`. In this release every chain still goes to Sourcify, so the keys and these codes take effect with the Etherscan v2, Routescan and standalone clients.

[#58](https://github.com/aelmanaa/explorer-verify/issues/58)
