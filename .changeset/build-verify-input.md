---
"explorer-verify": patch
---

Add `buildVerifyInput`, which builds the `compiler` part of `VerifyInput` and the fully qualified contract name from parsed build files of unknown origin. It accepts build-info from Hardhat 2, Hardhat 3 (with its output file) and Foundry, a bare Standard JSON input, and Hardhat or Foundry artifacts. It detects each file by its shape, in any order. The compiler input it returns holds only `language`, `sources` and `settings`, so Foundry's `basePath` and other local paths are not published. Each source keeps only `content` and `keccak256`. A local path in a source path, a remapping, or a `libraries` or `outputSelection` key is rejected. Files from different builds or compiler versions are rejected. A Hardhat 3 contract is named by its input source name, such as `project/contracts/Greeter.sol:Greeter`. Three new error codes say what is missing: `incomplete-input`, `insufficient-artifact` and `unsupported-compiler`. Each exits with code 2.

[#20](https://github.com/aelmanaa/explorer-verify/issues/20)
