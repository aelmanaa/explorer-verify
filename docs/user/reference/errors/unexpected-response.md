# unexpected-response

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The answer did not come from the explorer's API, or not in its format, after retries.

## How to fix

Call again later. If the error persists, check the explorer's status page and report
`details.status` and `details.excerpt` in an issue.

From the CLI: Run the command again later. If it persists, check the explorer's status page and
report the status and excerpt that --json prints.

## Facts

Retryable: yes, except a 4xx answer of your server handler other than 408 and 429, with or without
a code. Such an answer holds until something changes, so its hint says to check `handlerUrl` and
the `createVerifyHandler` options.

Exit code: 5

Sent to an explorer: maybe. A submit answered with a 500, 502 or 504 may have reached the explorer.

Default hint: Call again later. If the error persists, check the explorer's status page and report
the status and the answer (details.status, details.excerpt).

For end users: The explorer gave an answer that could not be read. Try again later; if it keeps
failing, check the explorer's status page.

When an explorer with an Etherscan-style API (Etherscan, Routescan or an Etherscan-compatible
explorer) found no contract code at the address after its tries, `hintFor(error, "user")` says
instead that the explorer has not found the contract yet, and asks the user to check the chain and
the address, or to try again in a minute.

The Blockscout client, on `blockscout` or `blockscout-hosted`, can stop submitting because each
submit got `status` `"1"` and no job id, as it can right after a deployment. For that error,
`hintFor(error, "user")` says that the explorer did not start the verification.

The hint asks the user to check the contract's page on the explorer, then to try again in a
minute. `hintFor` reads this case only from an error with `details.attempts`: a job status or
proxy-link answer of the same shape gets the general hint.

## Why

Cause: the answer did not come from the explorer's API, or not in its format, after retries: a 5xx
status, an HTML page, a wrong content type, a redirect or a body that is too large or cannot be
read.

A status or body that the backend's client does not recognise ends here too, such as Sourcify's
`400 invalid_parameter`, or an answer about another contract.

The details hold what the backend answered:

| Field                  | Contents                                                        |
| ---------------------- | --------------------------------------------------------------- |
| `details.status`       | The HTTP status                                                 |
| `details.excerpt`      | The first 300 characters of the body, redacted                  |
| `details.retryAfterMs` | The wait the backend asked for, when its last answer had one    |
| `details.attempts`     | The number of requests tried, when the error came after retries |

When a client stopped sending a submit again, `details.attempts` is the number of submits.

## Through your server handler

With `handlerUrl`, a refusal with a known code and its status throws its own error, such as
[`handler-refused`](handler-refused.md) for a 403 `chain-not-allowed`. A 503
`address-not-indexed` throws [`not-indexed`](not-indexed.md). This code remains for:

- an answer with no code, an unknown code or another status; the message does not repeat it;
- the handler's `internal-error`;
- a redirect or an unreadable body.

See [how the client reads a refusal](../server-handler.md#how-the-client-reads-a-refusal).

## In code

Check the code, then report the status and the excerpt:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "unexpected-response")) {
    const { status, excerpt } = error.details;
    console.error(`HTTP ${String(status)}: ${excerpt}`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
