---
"explorer-verify": patch
---

Calls now resolve their route from a routing table shipped with the package. Each row lists a chain's backends in order of preference, with the API URL and the explorer page of each. A call goes to the first backend in the row that works with the keys you passed: one that needs a key is skipped when `apiKeys` has none for it. `route.backend` picks another backend that the row lists.

Behaviour change: a chain the table does not list now throws `unsupported-chain` before any request. Set the new option `allowSourcifyFallback: true` to send such a chain to the public Sourcify API, as earlier releases did for every chain, or set `route.apiUrl`. In this release the table lists chains 1, 43113, 84532, 421614 and 11155111, each with Sourcify only. More chains and backends come in later releases.

`route.backend` now accepts every backend name that this version has a client for; any other throws `invalid-input`. A key from `apiKeys` now goes only to the host the table lists for the backend and chain, and never to a `route.apiUrl` you set, even on the same host; use `route.apiKey` there. Etherscan v2 requests get `chainid` from the route; a `chainid` in the query of `route.apiUrl`, in any letter case, is dropped, so a request never goes to another chain. See the new Routing reference page.

[#59](https://github.com/aelmanaa/explorer-verify/issues/59)
