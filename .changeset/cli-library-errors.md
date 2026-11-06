---
"@explorer-verify/cli": patch
"explorer-verify": patch
---

`explorer-verify verify --library` now says what is wrong with a value. A library that is not in a source file of the build, or an address that is not `0x` followed by 40 hex digits, gave only "The input is invalid: libraries.1.". With `--input`, `--foundry` or `--hardhat`, the CLI now names `--library[n]`, says why the value is invalid and what to pass, and exits 2. In the library, `validateInput` gives each `libraries` issue a hint that says what to pass. Issue: https://github.com/aelmanaa/explorer-verify/issues/241
