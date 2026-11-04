---
"explorer-verify": patch
---

The routing table now lists 94 chains, each with Sourcify: every chain of the Etherscan chainlist and every chain of the verifier table this library started from that Sourcify supports, checked on 2026-11-03. Chains such as Ethereum Mainnet, Ethereum Sepolia, Avalanche Fuji and C-Chain, Polygon Amoy, Base Sepolia and Arbitrum Sepolia now resolve without `allowSourcifyFallback`. A chain without a row still needs that option or `route.apiUrl`.

The table format is now schema 2: a row holds the chain id and its backends, and the library derives each backend's API URL and contract page. The Routing reference page shows the format and the URL rules.

[#60](https://github.com/aelmanaa/explorer-verify/issues/60)
