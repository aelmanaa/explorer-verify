---
"explorer-verify": patch
---

`timeoutMs: Infinity` now gives the longest time budget instead of throwing `invalid-input`: it is lowered to 2147483647 ms, about 24.8 days, as any larger finite value is. `verify()`, `dryRun()`, `checkStatus()`, `linkProxy()`, `verifyEach()` and `buildVerifyInputFromBytecode()` all take it. Error messages and `timeout` details show the lowered budget.

`pollIntervalMs` still refuses `Infinity`. `NaN`, `0`, negative numbers and `-Infinity` still throw `invalid-input`. The `invalid-input` issue for `timeoutMs` now reads "must be a positive number of milliseconds".

[#289](https://github.com/aelmanaa/explorer-verify/issues/289)
