# job-not-found

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The explorer no longer knows the job of this handle, and the contract is not verified.

## How to fix

Do not retry automatically. Check the contract on the explorer. If it is not verified, call
`verify()` again to submit it again.

From the CLI: Do not retry automatically. Check the contract on the explorer; if it is not verified,
run verify again.

## Facts

Retryable: no. Checking the same handle again fails the same way.

Exit code: 6

Sent to an explorer: yes, earlier. The explorer accepted the submission, then dropped the job.

Default hint: Do not retry automatically. Check the contract on the explorer; if it is not verified,
call verify() again.

For end users: The explorer no longer knows this verification. Check the contract's page on the
explorer; if the contract is not verified, start a new verification.

## Why

Cause: the explorer no longer knows the job id in `details.handle`. Explorers drop old jobs.

`checkStatus()` and `verify()` check this themselves. When a poll answers that the job is not
found, they look the contract up once and return `verified` when they find a match.

They throw this error only in two cases:

- the lookup finds the contract not verified, and the hint says to call `verify()` again;
- the lookup fails.

## In code

Check the code, then read the job id the explorer dropped:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "job-not-found")) {
    console.error(`Job ${error.details.handle.jobId} is gone.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
