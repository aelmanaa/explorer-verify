# unsupported-compiler

<!-- docs-style: legacy -->

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the input, or the documents passed to `buildVerifyInput`, come from a compiler that this
release or the route's backend does not verify.
`details.field` names what showed it:

- `compilerType`: a Hardhat 3 build-info with a `compilerType` other than `solc`.
- `language`: a compiler input whose language is not `Solidity`, such as Vyper.
- A zksolc field: the documents come from zksolc, the compiler for ZKsync Era's EraVM, through
  foundry-zksync or hardhat-zksync. The field is one of `input.zksolc_version` (foundry-zksync
  build-info), `output.zk_version` (hardhat-zksync build-info), `output.metadata.zksolcVersion`,
  `metadata.zk_version` or `metadata.zksolcVersion` (a contract's zksolc metadata), `solcVersion`
  or `solcLongVersion` (a version that starts with `zkVM-`), or `_format` (a hardhat-zksync
  artifact, `hh-zksolc-artifact-1`).
- `compiler.kind`: `verify()`, `dryRun()` or `verifyEach()` got input of a kind that the route's
  backend does not verify, such as `kind: "zksolc"`. The message names the kind and chain, and the backend when one was selected. The routing table passes over such backends when another listed backend verifies the
  kind; Blockscout verifies zksolc on chains 324 and 300.

Fix: use `kind: "solc"` for Solidity compiled with solc, or pass zksolc compiler input directly
with `kind: "zksolc"` on Blockscout for ZKsync Era (324) or Sepolia (300). Build helpers still
refuse zksolc build documents; extract the input and versions with the compiler's tooling.
Use the compiler's own verification tooling for other compilers.

Default hint: Use Solidity compiled with solc, or zksolc through Blockscout on ZKsync Era (324) or
Sepolia (300). Verify other compilers with their own tooling.

For end users: This contract was built with a compiler or language that cannot be verified here. Use
Solidity built with solc, or with zksolc on ZKsync Era or ZKsync Sepolia through Blockscout.

From the CLI: Use Solidity compiled with solc, or zksolc through Blockscout on ZKsync Era (324) or Sepolia
(300). Verify other compilers with their own tooling.

For a zksolc field, the hint says instead that zksolc (EraVM) builds are not supported and that a
contract compiled with plain solc verifies with the solc build-info.

Retryable: no. Nothing was sent to an explorer.

Exit code: 2

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
