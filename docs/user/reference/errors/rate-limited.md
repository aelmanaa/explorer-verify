# rate-limited

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the backend answered HTTP 429 on every try. `details.retryAfterMs` holds the wait the
backend asked for, when it sent a `Retry-After` header, or, for Routescan, an
`x-ratelimit-rpm-retry-after` header. `details.attempts` gives the number of requests tried, when
the library gave up after retries. The library stops at once when the wait asked for is more than
30 seconds. Routescan sends such a wait when a key passes its per-minute limit
([Routescan](../routescan.md#rate-limits)).

Fix: wait `details.retryAfterMs`, or a few seconds when it is not set, then call again. Lower the
request rate if this happens often.

Default hint: Wait details.retryAfterMs, or a few seconds when it is not set, then call again.

Retryable: yes.

Exit code: 5

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
