---
"explorer-verify": patch
---

`buildVerifyInput` now refuses build files from zksolc, the compiler for ZKsync Era's EraVM, with `unsupported-compiler`. Before, it read a foundry-zksync or hardhat-zksync build as solc and returned an input that no explorer could match. `details.field` names the field that showed zksolc, such as `input.zksolc_version`, `output.zk_version` or `_format`, and the hint says that a contract compiled with plain solc still verifies. The CLI exits with code 2 before any request.

[#227](https://github.com/aelmanaa/explorer-verify/issues/NN)
