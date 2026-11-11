# constructor-args-unavailable

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The creation code shows that `creationBytecode` is not the deployed build.

## How to fix

Fix: check that `creationBytecode` and the compiler input come from the build that was deployed.
Or pass `constructorArgs`: the ABI-encoded arguments without a selector, such as the output of
`cast abi-encode`.

From the CLI: Pass --constructor-args with the ABI-encoded arguments, or check the --input files
against the deployed build.

## Facts

Retryable: no.

Exit code: 2

Sent to an explorer: no.

Default hint: Pass constructorArgs, the ABI-encoded arguments, or check creationBytecode against the
deployed build.

For end users: The build does not match the creation code of the deployed contract, so its
constructor arguments cannot be read. Use the build output of the deployed contract, or enter the
constructor arguments.

## Why

Cause: `verify()` derived the constructor arguments from the creation code and found that
`creationBytecode` is not the deployed build. The explorer would refuse that build anyway.
`details.reason` says what it found:

- `prefix-mismatch`: the creation code does not start with `creationBytecode`. The compiler input
  or settings usually differ from the deployed build. A changed source comment is enough: it
  changes the metadata hash in the bytecode.
- `bad-length`: what follows `creationBytecode` in the creation code is not a whole number of
  32-byte words, so it is not ABI-encoded arguments.

`verify()` derives the arguments only when all of these hold:

- you passed no `constructorArgs`;
- the route's backend sends arguments: Etherscan v2, Routescan, Etherscan-compatible or
  Blockscout;
- the input has `creationBytecode`.

It throws this code on Etherscan v2, Routescan or a standalone Etherscan-compatible explorer. When
no source gives the creation code, or the contract came from a factory, or the route is Blockscout,
`verify()` does not throw: it logs the reason and submits without arguments.

See [Constructor arguments](../verify.md#constructor-arguments) for how the arguments are derived.

## In code

Check the code, then read what the creation code showed:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "constructor-args-unavailable")) {
    console.error(`Not the deployed build: ${error.details.reason}.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
