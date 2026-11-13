# verification-inconclusive

Version: explorer-verify 0.3.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The explorer finished the verification job without a verdict.

## How to fix

Wait a minute, then call `verify()` again. It looks the contract up first and submits only
when the contract is not verified.

> [!WARNING]
> Do not call `checkStatus()`: it would read the same finished job.

From the CLI: Wait a minute, then run verify again: it looks the contract up first and submits only
when the contract is not verified.

## Facts

Retryable: yes, with a new `verify()`.

Exit code: 4

Sent to an explorer: yes. The explorer accepted the submission, then ended the job without a
verdict.

Default hint: Wait a minute, then call verify() again: it looks the contract up first and submits
only when the contract is not verified.

For end users: The explorer ended the verification without a verdict. Wait a minute, then try again.

## Why

Cause: the job ended with an error that may clear up later, such as Sourcify's `internal_error`,
or `contract_not_deployed` right after a deployment. The finished job will not change, so the error
carries no handle.

The details hold the explorer's answer:

- `details.reason` holds the explorer's code and message, redacted, at most 300 characters.
- `details.backend` names the backend.

The [Sourcify page](../sourcify.md#how-answers-are-read) lists those errors.

## In code

Check the code, then call `verify()` again after a minute:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "verification-inconclusive")) {
    console.error(`No verdict: ${error.details.reason}`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
