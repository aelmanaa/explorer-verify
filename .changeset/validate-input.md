---
"explorer-verify": patch
---

Add `validateInput`, which checks a verification input before any request is sent. It checks the chain id, the address format, the compiler kind and full version, the Standard JSON shape, that the contract name's path is one of the sources, and the optional constructor arguments and creation transaction hash. It throws one `invalid-input` error that lists every problem by field, and never repeats a value. It returns the input with the version's leading `v` removed and the address in lower case.

[#13](https://github.com/aelmanaa/explorer-verify/issues/13)
