---
"explorer-verify": patch
---

Add `verify(input, options)`, which verifies a contract's source on Sourcify. It validates the input, looks the contract up and returns `already-verified` without a submit when Sourcify already has an exact or partial match. Otherwise it submits, polls every `pollIntervalMs` and returns `verified` with the match and the contract's public page, or `failed` with Sourcify's reason. Any other end throws a typed `ExplorerVerifyError`. A status poll that fails with `network`, `rate-limited` or `unexpected-response` is logged and polling goes on. When `timeoutMs` runs out while the job is pending, or after 3 failed polls in a row, it looks the contract up once more and throws `not-confirmed` with the handle if that finds no match. The call ends within `timeoutMs` plus `min(pollIntervalMs, 30000)`. `pollIntervalMs` is raised to at least 1000 ms. A `signal`, `fetch`, `logger` or `onEvent` of the wrong kind throws `invalid-input`. An abort rejects with `signal.reason`. The handle is emitted in a `verify.submitted` event and logged at `info` as soon as Sourcify accepts the submission. Values of 8 or more characters in `route.apiUrl`'s query string are removed from errors, logs, events and results, except values of digits only and values found in the handle.

[#17](https://github.com/aelmanaa/explorer-verify/issues/17)
