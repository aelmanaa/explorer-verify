---
"explorer-verify": patch
---

The match types page now lists the `match` each explorer gives a build compiled with `bytecodeHash: "none"`, as recorded on Ethereum Sepolia on 2026-11-10: `exact` on Etherscan v2, `partial` on Sourcify and Blockscout. Routescan states no grade, and explorer-verify now reports every Routescan match as `partial`. The page no longer says that such a build reaches only `partial` everywhere. Issue: https://github.com/aelmanaa/explorer-verify/issues/287
