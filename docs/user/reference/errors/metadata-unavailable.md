# metadata-unavailable

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

`buildVerifyInputFromBytecode` could not get the bytecode or the metadata it names.

## How to fix

Read `details.attempts`, then act on the source and outcome it shows:

| Attempt                   | What to do                                                |
| ------------------------- | --------------------------------------------------------- |
| `rpc`                     | Check the endpoint and its key                            |
| `not-found` on `sourcify` | Pass `ipfsGateway` with a gateway that holds the metadata |
| `not-found` on `ipfs`     | Pin the metadata where the gateway can find it            |
| `hash-mismatch`           | The copy belongs to another build; find the deployed one  |
| `not-metadata`            | The same                                                  |
| `unavailable`             | Call again later                                          |
| `timeout`                 | Raise `timeoutMs`                                         |

From the CLI: Run the command again later. --json lists each source tried and what it answered.

## Facts

Retryable: yes. A gateway or endpoint that failed may answer later.

Exit code: 5

Sent to an explorer: no. A lookup of the metadata on Sourcify is not a submission.

Default hint: The error lists each source tried (details.attempts). Call again later, or pass an
ipfsGateway that holds the metadata.

For end users: The contract's published metadata could not be fetched. Try again later.

## Why

Cause: `buildVerifyInputFromBytecode` could not get what it needs:

- the JSON-RPC endpoint gave no bytecode;
- no source returned usable metadata for the hash in the bytecode;
- the IPFS gateway failed on a source file the metadata lists;
- or the time budget ran out.

`details.hash` holds the hash from the bytecode, as `ipfs:` and the CID or `bzzr0:` or `bzzr1:`
and 64 hex digits. It is empty when the bytecode was not read.

`details.attempts` lists each source tried, in order. Each attempt has these fields:

| Field     | Contents                                               |
| --------- | ------------------------------------------------------ |
| `source`  | `rpc`, `ipfs` or `sourcify`                            |
| `outcome` | What the source answered; see the outcomes below       |
| `status`  | The HTTP status of the last answer, when there was one |

The outcomes:

- `not-found`: the source does not hold it.
- `hash-mismatch`: metadata of another build.
- `not-metadata`: the file has the right hash but is not Solidity metadata.
- `unavailable`: no usable answer after retries, an answer too large, or bytecode above 65536
  bytes.
- `timeout`: the time budget ran out; the resolver stops there.

## In code

Check the code, then print each source tried:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "metadata-unavailable")) {
    for (const attempt of error.details.attempts) {
      console.error(`${attempt.source}: ${attempt.outcome}`);
    }
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
