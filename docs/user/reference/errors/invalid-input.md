# invalid-input

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The input, a handle or a CLI command line failed validation.

## How to fix

Correct each field listed in `details.issues` (`field` and `message`), then call again. For a
handle, pass the handle object or its one-line form, as `verify()` or a `not-confirmed` error
returned it.

From the CLI: Fix what the message names, and each issue listed under it, then run the command
again. explorer-verify --help lists every option.

## Facts

Retryable: no.

Exit code: 2

Sent to an explorer: no.

Default hint: Fix the fields that the issues list (details.issues), then call again.

For end users: The verification request is not valid. Check the contract, the chain and the address,
then try again; if it keeps failing, report the error to the tool's maintainer.

## Why

Cause: the input failed validation, or a handle did not parse. From `buildVerifyInput`, it also
means one of these:

- a document of no known shape;
- documents from different builds: their build ids or full compiler versions differ;
- a contract path that is not in the sources;
- a local path in the compiler input. The issue gives its position, never the path.

A handle with any field it does not know, a URL included, is rejected: a handle never sets the
host. All unknown fields are reported as one issue on `handle` that gives their count, not their
names.

From the CLI, it also means a command line or request the CLI refuses:

- `verify` without a target. A submit needs `--backend <name>` or `--backend auto`, or
  `route.backend` with `--input-json`. The hint lists the chain's backends and what `auto` would
  pick.
- `--api-url` without `--backend`.

Run with `--dry-run` to see the target without submitting.

## In code

Check the code, then print each issue:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "invalid-input")) {
    for (const issue of error.details.issues) {
      console.error(`${issue.field}: ${issue.message}`);
    }
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
