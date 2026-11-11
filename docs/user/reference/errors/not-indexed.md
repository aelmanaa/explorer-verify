# not-indexed

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the explorer kept answering that it finds no contract code at the address, and `verify()`
stopped sending the submit again. Etherscan, Routescan and standalone Etherscan-compatible
explorers give this answer, `Unable to locate ContractCode at …`, for a contract they have not
indexed yet, and for a wrong chain ID or address. Nothing was submitted for verification, so the
error carries no handle.

`verify()` sends the submit again every `pollIntervalMs`: for `indexWaitMs` milliseconds from the
first submit when that option is set, otherwise at most 10 times, and never past `timeoutMs`.
`details.backend` names the backend. `details.submits` counts the answers that found no contract
code, not HTTP requests: a request retried after a rate limit is not counted. `details.elapsedMs` is
the time from the first submit to the last answer.

A server handler whose `deployers` option is set refuses the lookup with 503 before any submit.
That call ends with [`unexpected-response`](unexpected-response.md), and `indexWaitMs` has no effect
there.

Fix: check that `chainId` and `address` name the deployed contract. If it was deployed in the last
few minutes, call `verify()` again in a minute, or pass a longer `indexWaitMs` and a `timeoutMs`
that holds it. A tool that shows the error to a person tells them to try again in a minute.
[Etherscan](../etherscan.md#how-answers-are-read) describes the wait.

Default hint: Check the chain and the address (chainId, address). If the contract was just
deployed, call again in a minute, or wait longer with indexWaitMs.

For end users: The explorer has not found the contract at this address yet. Check the chain and the address; if the contract was deployed moments ago, try again in a minute.

From the CLI: Check the chain and the address (--chain and --address, or chainId and address in the
request). If the contract was deployed in the last few minutes, run the command again in a minute.

Retryable: yes, with a new `verify()`.

Exit code: 4

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
