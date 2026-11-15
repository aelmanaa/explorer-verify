# internal-error

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The CLI hit a bug in explorer-verify, not a problem with the input or the explorer.

## How to fix

Do not retry automatically. Report the bug in an issue with the command you ran and the
message. Leave out your API key.

From the CLI: This is a bug in explorer-verify. Report it with the command you ran, without your API
key.

## Facts

Retryable: no.

Exit code: 6

Sent to an explorer: unknown. Check the contract on the explorer before you run the command again.

Default hint: This is a bug in explorer-verify. Report it with the command you ran, without your API
key.

For end users: Something went wrong inside the tool. Report it to the tool's maintainer, without
your API key.

## Why

Cause: an unexpected exception reached the top level of the CLI. The CLI creates this error so that
its JSON output still has one envelope with a typed error. The library never throws it. The message
is redacted and the error carries no handle.

## In code

The CLI's `--json` output holds the error. Check its code before you retry:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [report.ts]
import type { ErrorJson } from "explorer-verify/errors";

export function onCliError(error: ErrorJson): void {
  if (error.code === "internal-error") {
    console.error(`Report this bug: ${error.message}`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
