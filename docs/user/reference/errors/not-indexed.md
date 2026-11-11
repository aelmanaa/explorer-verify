# not-indexed

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The explorer kept answering that it finds no contract code at the address.

## How to fix

Fix: check that `chainId` and `address` name the deployed contract. If it was deployed in the last
few minutes, call again in a minute, or pass a longer `indexWaitMs` and a `timeoutMs` that holds
it. [Etherscan](../etherscan.md#how-answers-are-read) describes the wait.

A tool that shows the error to a person tells them to try again in a minute.

From the CLI: Check --chain and the address argument, or the chain and the address in the
--input-json request (chainId, address). If the contract was deployed in the last few minutes, run
the command again in a minute. To wait longer, raise --index-wait and --timeout, which caps it.

On the command line, `verify` takes the wait in seconds, such as `--index-wait 120` with
`--timeout 300`.

## Facts

Retryable: yes, with a new call.

Exit code: 4

Sent to an explorer: yes. Each submit reached the explorer, which refused it, so it holds no
submission from the call.

Default hint: Check the chain and the address (chainId, address). If the contract was just
deployed, call again in a minute, or wait longer with indexWaitMs.

For end users: The explorer has not found the contract at this address yet. Check the chain and the
address; if the contract was deployed moments ago, try again in a minute.

Through a server handler, the default hint is: Etherscan has no creation record for the address
yet, so your server handler cannot check its deployer. Check the chain and the address (chainId,
address); if the contract was just deployed, call again in a minute.

## Why

Cause: the explorer kept answering that it finds no contract code at the address, and `verify()`
stopped sending the submit again. Etherscan, Routescan and standalone Etherscan-compatible
explorers give this answer, `Unable to locate ContractCode at …`, for a contract they have not
indexed yet, and for a wrong chain ID or address. Nothing was submitted for verification, so the
error carries no handle.

`verify()` sends the submit again every `pollIntervalMs`: for `indexWaitMs` milliseconds from the
first submit when that option is set, otherwise at most 10 times, and never past `timeoutMs`.

| Field               | What it holds                                                            |
| ------------------- | ------------------------------------------------------------------------ |
| `details.backend`   | The backend that found no contract code                                  |
| `details.submits`   | The answers that found no code; a request retried after a 429 is not one |
| `details.elapsedMs` | The time from the first submit to the last answer                        |

A server handler whose `deployers` option is set refuses a request with 503 `address-not-indexed`
when Etherscan has no creation record for the address yet, so `verify()` and `linkProxy()` can both
throw this code through it. The client retries the request as `Retry-After` asks, then throws
([server handler](../server-handler.md#how-the-client-reads-a-refusal)).

On that path the details count differently. `details.submits` counts HTTP attempts, not answers:
the attempts of the refused request when it was the submit, and `0` when the handler refused the
lookup or another request. `details.elapsedMs` runs from the first attempt of the refused request
to its last answer. `indexWaitMs` has no effect there.

## In code

Check the code, then call again with a longer wait:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "not-indexed")) {
    const { backend, submits } = error.details;
    console.error(`${backend} found no code after ${String(submits)} submits.`);
    console.error("Check the chain and address, or raise indexWaitMs.");
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
