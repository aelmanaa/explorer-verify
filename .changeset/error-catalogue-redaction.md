---
"explorer-verify": patch
---

Add eight error codes: `unsupported-chain`, `network`, `rate-limited`, `timeout`, `unexpected-response`, `in-progress`, `unknown-state` and `job-not-found`. Each has a hint, a retry flag, typed `details` and an entry in the error reference.

Add `ERROR_EXIT_CODES`, which maps each error code to its CLI exit code, and the `ExitCode` type. `in-progress` maps to 5 and `job-not-found` to 6.

`ExplorerVerifyError` now removes API keys from its message, hint, details and cause, and shows `[redacted]` in their place. The options now require `secrets`, the key values of the call; pass `[]` when there is none. The error also redacts the value of an `apikey`, `key` or `token` parameter in a URL or form body, URL user info, bearer tokens and bare 34-character Etherscan-style keys. Redaction takes linear time, so a 1 MB explorer answer cannot stall it.

`details` is rebuilt from the fields of its code, so an extra field never reaches the error. `cause` holds a redacted copy of the underlying error, so `console.log(error)` does not print a key.

An empty or blank `hint` option keeps the code's default hint.

`toJSON()` now includes the handle for `unknown-state` and `job-not-found` errors too.

A handle with one unknown field now reports "has 1 field that is not a handle field".

[#12](https://github.com/aelmanaa/explorer-verify/issues/12)
