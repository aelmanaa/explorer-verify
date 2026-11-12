# not-confirmed

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The explorer accepted the submission and was still verifying when the time budget ran out.

## How to fix

Store `details.handle` and pass it to `checkStatus()` later to continue polling. Raise
`timeoutMs` if this happens often.

> [!WARNING]
> Do not call `verify()` again: it would submit the contract again.

From the CLI: The explorer is still verifying. Run explorer-verify status
`ev1:sourcify:11155111:0x<address>:<job>` later to continue polling, or raise --timeout. Running
verify again would submit again.

## Facts

Retryable: yes, with `checkStatus(details.handle)`.

Exit code: 4

Sent to an explorer: yes. The explorer accepted the submission; `details.handle` identifies it.

Default hint: Call checkStatus later with the error's handle (details.handle) to continue polling.

For end users: The explorer is still verifying the contract. Check the contract's page on the
explorer in a few minutes; there is no need to submit it again.

## Why

Cause: the time budget (`timeoutMs`) ran out after the explorer accepted the submission, while it
was still verifying the contract.

## In code

Check the code, then store the handle in its one-line form:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";
import { formatHandle } from "explorer-verify/handle";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "not-confirmed")) {
    const line = formatHandle(error.details.handle);
    localStorage.setItem("pending-verification", line);
  }
}
```

[Check status](../check-status.md) resumes from the stored handle.

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
