# unsupported-compiler

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the documents passed to `buildVerifyInput` come from a compiler other than solc.
`details.field` names what showed it: `compilerType` (a Hardhat 3 build-info with a `compilerType`
other than `solc`) or `language` (a compiler input whose language is not `Solidity`, such as
Vyper).

Fix: verify the contract with its compiler's own tooling. This release supports Solidity compiled
with solc only.

Default hint: Only Solidity compiled with solc is supported. Verify this contract with its
compiler's own tooling.

Retryable: no. Nothing was sent to an explorer.

Exit code: 2

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
