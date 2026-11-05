---
"explorer-verify": patch
---

Add the Routescan client. `verify()` and `checkStatus()` use it for `route.backend` `routescan`. Each chain has its own API URL, with the network and the chain id in the path, so no request sends `chainid`. The free tier needs no key; a key, when set, goes in the `apikey` request header and never in the URL or the body.

On a chain the routing table lists Routescan for, name it with `route: { backend: "routescan" }`. Elsewhere, add the chain's URL: `route: { backend: "routescan", apiUrl: "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api" }`, with `apiKey` if you have one; `route.apiKey` goes to the host of `route.apiUrl`. A key in `apiKeys.routescan` is sent only on a route the table lists.

- The submit is a form-encoded POST. A lookup and a status request are GETs with a `nocache` query parameter of random characters, new on every attempt and retry, because Routescan's CDN serves a repeated URL from its cache.
- `chain not supported` throws `unsupported-chain`, never `failed`. It also comes back when the URL names the wrong network.
- `Verification not found` throws `job-not-found` from the client. `verify()` and `checkStatus()` then look the contract up once and return `verified` when it is verified: Routescan has forgotten a job 51 minutes after its submit.
- `Missing guid` throws `unexpected-response`; `verify()` and `checkStatus()` count it as a failed poll.
- A lookup never gives `partial`: Routescan's lookup has no `SimilarMatch` field.

The new reference page `docs/user/reference/routescan.md` lists the requests and how each answer is read.

[#62](https://github.com/aelmanaa/explorer-verify/issues/62)
