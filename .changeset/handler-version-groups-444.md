---
"explorer-verify": patch
---

`createVerifyHandler` now bounds each part of a solc `compilerversion`, as it already did for the `vyper:` form: each part is `0` or 1 to 4 digits without a leading zero, and the suffix cannot start with a digit. A version such as `v00.8.24`, `v0.08.24` or `v10000.0.0`, or one with thousands of digits in a part, is refused with `bad-request` before any request to Etherscan. Every solc version the client sends still passes, including nightly and pre-release builds.

What should I do? Nothing, unless you pass a solc version with a leading zero in a part, such as `0.08.24+commit.e11b9ed9`. `validateInput` accepts it, but no solc release has that form, and the handler now refuses it. Pass the version as the compiler prints it.

Issue: https://github.com/aelmanaa/explorer-verify/issues/444
