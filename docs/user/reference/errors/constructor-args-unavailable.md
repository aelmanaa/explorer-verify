# constructor-args-unavailable

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: `verify()` derived the constructor arguments from the creation code and found that
`creationBytecode` is not the deployed build, on Etherscan v2, Routescan or a standalone Etherscan-compatible explorer, which would refuse
that build anyway. It derives them only when you passed no `constructorArgs`, the route's backend
sends arguments (Etherscan v2, Routescan, Etherscan-compatible, Blockscout) and the input has `creationBytecode`.
`details.reason` says what it found:

- `prefix-mismatch`: the creation code does not start with `creationBytecode`. The compiler input
  or settings usually differ from the deployed build. A changed source comment is enough: it
  changes the metadata hash in the bytecode.
- `bad-length`: what follows `creationBytecode` in the creation code is not a whole number of
  32-byte words, so it is not ABI-encoded arguments.

When no source gives the creation code, or the contract came from a factory, or the route is
Blockscout, `verify()` does not throw: it logs the reason and submits without arguments.

Fix: check that `creationBytecode` and the compiler input come from the build that was deployed,
or pass `constructorArgs`, the ABI-encoded arguments without a selector, such as the output of
`cast abi-encode`.

Default hint: Pass constructorArgs, the ABI-encoded arguments, or check creationBytecode against the
deployed build.

For end users: The build does not match the creation code of the deployed contract, so its
constructor arguments cannot be read. Use the build output of the deployed contract, or enter the
constructor arguments.

From the CLI: Pass --constructor-args with the ABI-encoded arguments, or check the --input files
against the deployed build.

Retryable: no. Nothing was submitted to an explorer.

Exit code: 2

See [Constructor arguments](../verify.md#constructor-arguments) for how the arguments are derived.

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
