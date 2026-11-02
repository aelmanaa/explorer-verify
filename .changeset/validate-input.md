---
"explorer-verify": patch
---

Add `validateInput`, which checks a verification input before any request is sent. It checks the chain id, the address format, the compiler kind and full version, the Standard JSON shape, that the contract name's path is one of the sources, and the optional constructor arguments and creation transaction hash. It throws one `invalid-input` error that lists every problem by field, and never repeats a value. It returns a deep copy of the input, with the version's leading `v` removed and the address, constructor arguments and creation transaction hash in lower case. Settings, sources and other Standard JSON fields must be JSON data: a cycle, a BigInt, a function or nesting deeper than 64 levels is rejected. Compiler versions accept nightly builds and official pre-releases such as `0.8.31-pre.1+commit.b59566f6`.

[#13](https://github.com/aelmanaa/explorer-verify/issues/13)
