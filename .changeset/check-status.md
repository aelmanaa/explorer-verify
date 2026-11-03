---
"explorer-verify": patch
---

Add `checkStatus(handle, options)`, which continues polling a verification that `verify()` submitted, and never submits. It takes the handle object or its one-line form `ev1:<backend>:<chainId>:<address>:<jobId>`. It resolves the API from the handle's chain id and the `route` option, never from the handle, and throws `invalid-input` before any request when the handle's backend is not the route's. It polls at once, then every `pollIntervalMs`, and maps the end as `verify()` does: `not-confirmed` again carries the same handle, and `verification-inconclusive` means calling `verify()` again. When the explorer no longer knows the job, it looks the contract up: a match returns `verified`, otherwise it throws `job-not-found` with a hint to call `verify()` again. It emits `verify.routed`, `verify.poll`, `verify.retry` and `verify.result`.

Export `formatHandle`, which writes the one-line form. `parseHandle` now also reads the one-line form, which must split on `:` into exactly five parts.

[#18](https://github.com/aelmanaa/explorer-verify/issues/18)
