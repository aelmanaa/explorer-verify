---
"explorer-verify": minor
---

`hintFor(error, "user")` returns a hint for the people who use your tool, such as an IDE, a dapp or a verification service. It names no function, option, field or command. It reads the error's details: it gives the wait the explorer asked for, says when an explorer with an Etherscan-style API has not indexed the contract yet, and tells a cancelled run with a handle to check the explorer before submitting again. `hintFor(error, "developer")` returns `error.hint`. Import it from `explorer-verify/errors` or `explorer-verify`. Each error page shows the end-user hint on a "For end users" line.

The default hints, and the specific hints of `buildVerifyInput`, `buildVerifyInputFromBytecode` and `validateInput`, now name each value in words, with the field path only in parentheses. For example, the `rate-limited` hint reads "Wait as long as the explorer asked (details.retryAfterMs), or a few seconds when it did not say, then call again." The hints read correctly in a tool whose error has no `details` field. The `cancelled` hint says to resume each handle with `checkStatus` instead of naming the CLI's `status` command. Hint text is not part of the API: switch on `error.code`, not on the hint.

[#286](https://github.com/aelmanaa/explorer-verify/issues/286), [#298](https://github.com/aelmanaa/explorer-verify/issues/298)
