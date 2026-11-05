# unsupported-compiler

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the documents passed to `buildVerifyInput` come from a compiler other than solc.
`details.field` names what showed it:

- `compilerType`: a Hardhat 3 build-info with a `compilerType` other than `solc`.
- `language`: a compiler input whose language is not `Solidity`, such as Vyper.
- A zksolc field: the documents come from zksolc, the compiler for ZKsync Era's EraVM, through
  foundry-zksync or hardhat-zksync. The field is one of `input.zksolc_version` (foundry-zksync
  build-info), `output.zk_version` (hardhat-zksync build-info), `output.metadata.zksolcVersion`,
  `metadata.zk_version` or `metadata.zksolcVersion` (a contract's zksolc metadata), `solcVersion`
  or `solcLongVersion` (a version that starts with `zkVM-`), or `_format` (a hardhat-zksync
  artifact, `hh-zksolc-artifact-1`).

Fix: verify the contract with its compiler's own tooling. This release supports Solidity compiled
with solc only. On ZKsync Era (chain 324) and ZKsync Sepolia (chain 300), a contract compiled with
plain solc verifies with the solc build-info, as on any other chain. A contract compiled with zksolc
needs the ZKsync verification tooling for now.

Default hint: Only Solidity compiled with solc is supported. Verify this contract with its
compiler's own tooling.

For a zksolc field, the hint says instead that zksolc (EraVM) builds are not supported and that a
contract compiled with plain solc verifies with the solc build-info.

Retryable: no. Nothing was sent to an explorer.

Exit code: 2

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
