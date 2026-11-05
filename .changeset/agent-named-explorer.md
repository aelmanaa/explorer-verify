---
"explorer-verify": patch
---

The agent guide and the skill now say to pass `--backend`, or `route.backend` in the library, when the person names an explorer. Without it, the routing table picks the explorer and `verify` submits there: on Sepolia with no Etherscan key set, a request to verify on Etherscan would publish the source on Sourcify. Issue: https://github.com/aelmanaa/explorer-verify/issues/7
