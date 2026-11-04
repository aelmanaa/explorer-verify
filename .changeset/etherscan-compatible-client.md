---
"explorer-verify": patch
---

Add the client for standalone Etherscan-compatible explorers: an explorer that serves Etherscan's API on its own host for one chain. `verify()` and `checkStatus()` use it for `route.backend` `etherscan-compatible`. The routing table lists no such explorer, so name its API with `route.apiUrl`, and its key, if it needs one, with `route.apiKey`:

```ts
await verify(input, {
  route: {
    backend: "etherscan-compatible",
    apiUrl: "https://explorer.example.org/api",
    apiKey: explorerKey,
  },
});
```

The client reads every answer as the Etherscan v2 client does. It differs in three ways:

- Every request is a form-encoded POST to `route.apiUrl`, with no `chainid` parameter.
- The key goes only in the `apikey` field of the form body, and only to the host of `route.apiUrl`. `apiKeys["etherscan-compatible"]` still throws `invalid-input`, and a key in `apiKeys` for another backend is never sent.
- No `missing-api-key` check runs before the call: an explorer that needs a key answers `Missing/Invalid API Key`, which throws `missing-api-key`.

A result has no `explorerUrl`. `route.backend` `etherscan-compatible` without `route.apiUrl` now throws `unsupported-chain` instead of `invalid-input`.

Etherscan's retired per-chain hosts, such as `api-sepolia.basescan.org/api`, answer `You are using a deprecated V1 endpoint` with HTTP 200. For every Etherscan-style client this still throws `unexpected-response`, now with the hint `Use the etherscan-v2 backend without route.apiUrl.`

The client loads only when a call is routed to it, so a bundler that splits code puts it in a chunk of its own, about 3.3 KB gzipped.

The new reference page `docs/user/reference/etherscan-compatible.md` lists the requests and the key rules.

[#63](https://github.com/aelmanaa/explorer-verify/issues/63)
