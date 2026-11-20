---
"explorer-verify": minor
---

Sourcify verifies Vyper contracts. `verify()`, `dryRun()`, `verifyEach()` and `checkStatus()` take `kind: "vyper"` input on every chain Sourcify serves, and the routing table picks Sourcify for it. Sourcify grades a build from Vyper 0.4.1 on `exact` and an older one `partial`. Sourcify refuses a top-level `interfaces` field, so each Vyper interface is sent in `sources`. Every other backend still refuses Vyper input with `unsupported-compiler` before any request, and the hint of that error now names Sourcify for Vyper.

Issue: https://github.com/aelmanaa/explorer-verify/issues/423
