# cancelled

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The CLI run was cancelled, for example with Ctrl-C.

## How to fix

If the envelope has `error.handle`, the explorer accepted the submission. Resume from that
handle instead of submitting again:

- in a shell, with `explorer-verify status <handle>`;
- in code, with `checkStatus()`.

If it has `error.handles`, resume each `handle` in the list the same way. Otherwise run the command
again.

From the CLI: Resume the accepted submission with explorer-verify status
`ev1:sourcify:11155111:0x<address>:<job>` instead of submitting again.

## Facts

Retryable: no.

Exit code: 130

Sent to an explorer: maybe. When the error holds a handle, the explorer accepted the submission.

Default hint: The run was cancelled. If the error holds handles (error.handle, error.handles),
resume each one with checkStatus instead of submitting again.

For end users: The verification was cancelled before the explorer accepted it. Try again.

When the error holds a handle, `hintFor(error, "user")` says instead that the explorer accepted the
submission, and asks the user to check the contract's page before submitting again.

## Why

Cause: the run was cancelled, for example with Ctrl-C. The CLI creates this error, so that its
JSON output for exit code 130 has a typed error.

The library never throws it: when the caller's `signal` aborts, the call rejects with
`signal.reason` unchanged.

`details.handle` is present when the explorer accepted the submission before the cancel. A run on
several backends carries `details.handles` instead: the handle of each backend whose job had not
ended.

## In code

The CLI's `--json` output holds the error. Read the handles to resume from it:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [resume.ts]
import type { ErrorJson } from "explorer-verify/errors";

export function toResume(error: ErrorJson): string[] {
  if (error.code !== "cancelled") {
    return [];
  }
  if (error.handle !== undefined) {
    return [error.handle];
  }
  return error.handles?.map((each) => each.handle) ?? [];
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
