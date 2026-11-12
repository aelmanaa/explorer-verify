# insufficient-artifact

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The build documents hold only ABI and bytecode, which is not enough to verify.

## How to fix

Fix: three routes remain.

1. Ask the publisher to ship the build-info or the Solidity metadata of the build.
2. Build the input from the deployed bytecode with
   [`buildVerifyInputFromBytecode`](../../guides/verify-from-deployed-bytecode.md), when the
   bytecode carries a metadata hash and the metadata is published.
3. Rely on the explorer's own matching, when an identical contract is already verified: Etherscan
   Similar Match or Sourcify similarity.

From the CLI: ABI and bytecode are not enough to verify. Pass the build-info or the Solidity
metadata of the same build with --input.

## Facts

Retryable: no.

Exit code: 2

Sent to an explorer: no.

Default hint: ABI and bytecode are not enough to verify. Routes left: (1) ask the publisher to ship
build-info or metadata; (2) the bytecode-metadata resolver, when the bytecode carries a metadata
hash and the metadata is published; (3) the explorer's own matching (Etherscan Similar Match,
Sourcify similarity), when an identical contract is already verified.

For end users: The build output holds only the ABI and the bytecode, which is not enough for
verification. Use the full build output of the compiler.

## Why

Cause: the documents passed to `buildVerifyInput` hold only ABI and bytecode, with no compiler
input, settings or metadata. The explorer needs the sources and the exact settings, and these
files do not have them. `details.field` is `input`.

## In code

Check the code, then ask for the build-info or the metadata:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "insufficient-artifact")) {
    console.error("Ask for the build-info or the Solidity metadata.");
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
