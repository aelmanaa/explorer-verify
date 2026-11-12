# rate-limited

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The backend answered HTTP 429 on every try.

## How to fix

Wait `details.retryAfterMs`, or a few seconds when it is not set, then call again. Lower the
request rate if this happens often.

From the CLI: The explorer limited the requests. Wait a few seconds, then run the command again.

## Facts

Retryable: yes.

Exit code: 5

Sent to an explorer: yes, and refused. A 429 refuses a request before the explorer processes it.

Default hint: Wait as long as the explorer asked (details.retryAfterMs), or a few seconds, then call
again.

For end users: The explorer is limiting requests. Wait a few seconds, then try again.

When the explorer said how long to wait, `hintFor(error, "user")` names the wait instead of "a few
seconds": in seconds below 2 minutes, in minutes up to one hour, and as "Try again later" above
that.

## Why

Cause: the backend answered HTTP 429 on every try. The details say how long to wait:

| Field                  | Contents                                                             |
| ---------------------- | -------------------------------------------------------------------- |
| `details.retryAfterMs` | The wait the backend asked for, when it sent one                     |
| `details.attempts`     | The number of requests tried, when the library gave up after retries |

The wait comes from a `Retry-After` header, or, for Routescan, an `x-ratelimit-rpm-retry-after`
header. The library stops at once when the wait asked for is more than 30 seconds. Routescan sends
such a wait when a key passes its per-minute limit ([Routescan](../routescan.md#rate-limits)).

## In code

Check the code, then wait as long as the backend asked:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "rate-limited")) {
    const waitMs = error.details.retryAfterMs ?? 5_000;
    console.error(`Wait ${String(waitMs)} ms, then call again.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
