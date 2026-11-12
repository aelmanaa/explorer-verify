# in-progress

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The explorer is already verifying this contract from another submission.

## How to fix

Fix: wait for the explorer to finish that verification, then call again.

From the CLI: Wait for the explorer to finish its current verification of this contract, then run
the command again.

## Facts

Retryable: yes.

Exit code: 5

Sent to an explorer: maybe. The running job may come from this call's first submit.

Default hint: Wait for the explorer to finish its current verification of this contract, then call
again.

For end users: The explorer is already verifying this contract. Wait for it to finish, then check
the contract's page on the explorer.

## Why

Cause: the backend is already verifying this contract from another submission. This call has no
job id, so the error carries no handle.

It also happens when a submit got no clear answer, the library submitted once more, and the
explorer said a job for the contract was already running. The first submit most likely reached it.

## In code

Check the code, then wait before you call again:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "in-progress")) {
    console.error(`${error.details.backend} is busy. Try again later.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
