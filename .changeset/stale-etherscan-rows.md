---
"explorer-verify": patch
---

The routing table no longer lists Etherscan v2 for chains 11124 (Abstract Sepolia) and 43113 (Avalanche Fuji). The Etherscan chainlist read on 2026-11-05 does not list them. Both chains keep Sourcify. The table now lists Etherscan v2 for 55 chains: 45 free-tier and 10 that need a paid plan.

Behaviour change: on 11124, a call with `apiKeys["etherscan-v2"]` now goes to Sourcify and sends no key. Before, it went to `api.etherscan.io`. On 11124 and 43113, `route: { backend: "etherscan-v2" }` without `route.apiUrl` now throws `unsupported-chain`.

`routingTableDate()` returns `2026-11-05`.

[#165](https://github.com/aelmanaa/explorer-verify/issues/165)
