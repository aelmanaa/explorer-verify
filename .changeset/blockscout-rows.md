---
"explorer-verify": patch
---

The routing table now lists a Blockscout instance for 111 chains, each one that answered the API without a key or a redirect on 2026-11-05. On those chains, `route: { backend: "blockscout" }` and the CLI's `--backend blockscout` reach the instance without `route.apiUrl` or `--api-url`, and the result's `explorerUrl` is `https://<instance>/address/<address>?tab=contract`. They include Ethereum Mainnet (1), OP Mainnet (10), Gnosis (100), ZKsync Era (324), Celo (42220), Base Sepolia (84532), Scroll (534352) and Ethereum Sepolia (11155111).

In a row, Blockscout comes after Sourcify and a free-tier Etherscan v2, and before a paid-plan Etherscan v2 and Routescan, so a call that names no backend goes where it went before on every chain whose row has Sourcify or Etherscan v2. `verifyEach()` with `backends: "all"` now also verifies on Blockscout on these chains, since it takes every backend the row lists.

Behaviour change: the table has 325 rows, 11 more. On those 11 chains Blockscout is the only backend, and a call goes there by default; before, it threw `unsupported-chain`. They are 484, 901, 957, 1076, 10901, 261131, 529375, 89346162, 245022926, 1666700000 and 3735928814. On Numine (8021), whose row lists Blockscout and then Routescan, a call that names no backend now goes to Blockscout instead of Routescan.

The Blockscout instances of Polygon PoS (137), Base (8453), Arbitrum One (42161), Arbitrum Sepolia (421614) and four others sent a bot-check page and have no entry; reach them with `route.apiUrl`.

[#169](https://github.com/aelmanaa/explorer-verify/issues/169)
