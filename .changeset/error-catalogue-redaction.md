---
"explorer-verify": patch
---

Add eight error codes: `unsupported-chain`, `network`, `rate-limited`, `timeout`, `unexpected-response`, `in-progress`, `unknown-state` and `job-not-found`. Each has a hint, a retry flag, typed `details` and an entry in the error reference.

Add `ERROR_EXIT_CODES`, which maps each error code to its CLI exit code, and the `ExitCode` type.

`ExplorerVerifyError` now removes API keys from its message, hint, details and cause. It replaces the key of the call, passed as the `secrets` option, and the value of any `apikey`, `key` or `token` parameter in a URL or form body with `[redacted]`. `cause` holds a redacted copy of the underlying error, so `console.log(error)` does not print a key.

`toJSON()` now includes the handle for `unknown-state` and `job-not-found` errors too.

A handle with one unknown field now reports "has 1 field that is not a handle field".

[#12](https://github.com/aelmanaa/explorer-verify/issues/12)
