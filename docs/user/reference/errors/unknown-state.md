# unknown-state

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The explorer answered for a job with a status the library cannot classify.

## How to fix

Do not retry automatically. Check the contract on the explorer, then report `details.excerpt`
in an issue.

From the CLI: Do not retry automatically. Check the contract on the explorer, and report the excerpt
that --json prints.

## Facts

Retryable: no.

Exit code: 6

Sent to an explorer: yes. The explorer accepted the submission; `details.handle` identifies it.

Default hint: Do not retry automatically. Check the contract on the explorer and report its answer
(details.excerpt).

For end users: The explorer gave a final answer that could not be read. Check the contract's page on
the explorer before you try again.

## Why

Cause: the explorer's API answered for a submission with a job id, in its format, with a status the
library cannot classify. The library does not report the contract as verified.

It is also thrown when the job reported the contract as already verified without its match, and
the one lookup that reads the match failed or found the contract not verified.

The details identify the job and the answer:

- `details.handle` identifies the verification.
- `details.excerpt` holds the first 300 characters of the answer, redacted. After a failed lookup
  that got an unexpected answer, the excerpt is that answer; otherwise it is empty.

## In code

Check the code, then report the explorer's answer:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "unknown-state")) {
    console.error(`Report this answer: ${error.details.excerpt}`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
