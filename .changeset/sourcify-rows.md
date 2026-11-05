---
"explorer-verify": patch
---

The routing table now lists 288 chains: every chain that Sourcify's chain list marks as supported, read on 2026-11-05. Before, a chain also had to be in the Etherscan chainlist or in the verifier table this library started from, and the table listed 94. The 194 new rows have Sourcify only. They include Cronos (25), Rootstock (30), ZKsync Era (324), Metis (1088), Ronin (2020), Kaia (8217), Mode (34443), Scroll (534352), Zora (7777777) and Tron (728126428).

Behaviour change: on these chains, `verify()`, `checkStatus()` and the CLI go to Sourcify without `allowSourcifyFallback: true` or `--api-url`, and the result's `explorerUrl` is `https://repo.sourcify.dev/<chain id>/<address>`. Before, they threw `unsupported-chain`. `allowSourcifyFallback` now matters only for a chain Sourcify does not list.

The 55 Etherscan v2 entries and their order do not change. `routingTableDate()` still returns `2026-11-05`.

[#166](https://github.com/aelmanaa/explorer-verify/issues/166)
