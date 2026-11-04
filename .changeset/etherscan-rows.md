---
"explorer-verify": patch
---

The routing table lists Etherscan v2 for the 57 chains of the Etherscan chainlist, checked on 2026-11-04. Each entry names the chain's explorer host, so an Etherscan result has an `explorerUrl`, such as `https://sepolia.etherscan.io/address/<address>#code`.

Behaviour change: on the 46 free-tier chains, a call with `apiKeys["etherscan-v2"]` now goes to `api.etherscan.io`, with the key in the POST body. Before, it went to Sourcify. A call without the key still goes to Sourcify and sends no key. On the 11 chains that need a paid Etherscan plan, Sourcify stays first; set `route: { backend: "etherscan-v2" }` to use Etherscan there.

`routingTableDate()` returns `2026-11-04`.

[#122](https://github.com/aelmanaa/explorer-verify/issues/122)
