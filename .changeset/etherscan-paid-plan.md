---
"explorer-verify": patch
---

Etherscan's answer `Free API access is not supported for this chain` now throws `api-key-rejected` instead of `unexpected-response`. Etherscan gives it when a free-plan key asks about a chain that needs a paid plan. The hint says to use a key on a paid Etherscan plan, or to verify on Sourcify with `route: { backend: "sourcify" }`. Issue: https://github.com/aelmanaa/explorer-verify/issues/135
