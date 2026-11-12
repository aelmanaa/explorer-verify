# source-mismatch

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

A source file you passed differs from the file the Solidity metadata was built from.

## How to fix

Fix: pass the file exactly as it was compiled, byte for byte. A changed line ending, a trailing
newline or a formatter run changes the hash. Take the file from the same package version or commit
as the metadata.

From the CLI: Pass the source file `<path>` exactly as it was compiled, byte for byte, line endings
included, or pass the build-info of the same build with --input.

## Facts

Retryable: no.

Exit code: 2

Sent to an explorer: no.

Default hint: Pass the source file that the error names (details.path) exactly as it was compiled,
byte for byte, line endings included.

For end users: A source file differs from the one the contract was compiled from. Use the exact
source files of the deployed build.

## Why

Cause: `buildVerifyInput` rebuilt the input from Solidity metadata, and a source file's content
does not match the keccak-256 hash the metadata records for it. Compiled from that content, the
input would not give the deployed bytecode.

The details name the file and both hashes:

| Field              | Contents                                                 |
| ------------------ | -------------------------------------------------------- |
| `details.path`     | The source path, as the metadata lists it                |
| `details.expected` | The hash in the metadata; empty when it has another form |
| `details.actual`   | The hash of the content you passed                       |

Each hash is `0x` and 64 lowercase hex digits.

## In code

Check the code, then read the path of the file to replace:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "source-mismatch")) {
    console.error(`Pass ${error.details.path} as it was compiled.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
