# no-metadata-hash

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The deployed bytecode holds no metadata hash, so the resolver cannot find the metadata.

## How to fix

Build the input from the contract's build files instead, with `buildVerifyInput`, or with the
Foundry or Hardhat helper. For `no-code`, check the chain ID, the address and the `rpcUrl`.

From the CLI: Pass the build files with --input instead.

## Facts

Retryable: no.

Exit code: 2

Sent to an explorer: no.

Default hint: Build the input from the build files with buildVerifyInput instead.

For end users: The deployed bytecode does not say where its source is published, so the source
cannot be found from the address alone. Use the build output instead.

## Why

Cause: `buildVerifyInputFromBytecode` read the deployed bytecode, and its end holds no metadata
hash. `details.found` says what it found:

| `details.found` | Meaning                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `no-code`       | Nothing is deployed at the address                                       |
| `no-metadata`   | No CBOR block: solc's `appendCBOR: false`, or a compiler other than solc |
| `version-only`  | The block holds only the compiler version: solc's `bytecodeHash: "none"` |

## In code

Check the code, then read what the bytecode holds:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "no-metadata-hash")) {
    console.error(`No metadata hash: ${error.details.found}.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
