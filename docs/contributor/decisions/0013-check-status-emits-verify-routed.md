# 0013: checkStatus also emits verify.routed

Status: Accepted (2026-11-03). Amends the event list of
[decision 0010](0010-logger-fields-events-and-silent-default.md).

Research: none (maintainer choice).

## Context

Decision 0010 says `checkStatus` emits `verify.poll`, `verify.retry` and `verify.result` only.
`checkStatus` ([#18](https://github.com/aelmanaa/explorer-verify/issues/18)) resolves its API host
from the handle's chain id and the caller's `route` option, never from the handle (R-SEC-2). A
caller who resumes a stored handle cannot see which host the polls go to, short of reading log
lines, which are diagnostics and may change in any release.

## Decision

`checkStatus` also emits `verify.routed`, with `backend` and `apiHost`, before its first poll. It
emits the same event `verify()` emits after validation, with the same fields. It still emits no
`verify.validated`, `verify.lookup` or `verify.submitted`.

## Alternatives considered

- Keep the three events of decision 0010. Rejected: a program that resumes a handle from untrusted
  storage then has no typed way to confirm the host it polls.
- Emit `verify.validated` for the parsed handle too. Rejected: the event describes the
  verification input, which `checkStatus` does not have.

## Consequences

- R-DX-6 in [requirements.md](../requirements.md), the R-DX-6 row of
  [testing.md](../testing.md) and the user page on logging and events list `verify.routed` for
  `checkStatus`.
- No schema change: `verify.routed` is already in `event.schema.json`.
