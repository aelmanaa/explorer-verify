# timeout

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The time budget ran out before the explorer accepted the submission.

## How to fix

Fix: call again, or raise `timeoutMs`. If the explorer did receive the submission, the next call
may report the contract as verified or in progress.

From the CLI: Run the command again, or raise --timeout. The explorer had not accepted the
submission, so nothing is pending.

## Facts

Retryable: yes.

Exit code: 5

Sent to an explorer: maybe. The explorer had not accepted a submission when the budget ran out.

Default hint: Call again, or raise timeoutMs. The explorer had not accepted the submission yet.

For end users: The explorer did not accept the submission in time. Try again.

## Why

Cause: the time budget (`timeoutMs`) ran out before the explorer accepted the submission. There is
no job id yet, so the error carries no handle. `details.timeoutMs` gives the budget.

## In code

Check the code, then call again with a larger budget:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "timeout")) {
    const next = error.details.timeoutMs * 2;
    console.error(`Call again with timeoutMs: ${String(next)}.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
