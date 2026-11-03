# 0011: A finished job without a verdict is verification-inconclusive

Status: Accepted (2026-11-03). Amends the error code list of
[decision 0009](0009-options-handle-and-errors.md).

Research: [2026-11-02-sourcify-v2.md](../research/2026-11-02-sourcify-v2.md#error-codes), the
live Sourcify behaviour. The choice of a new code is the maintainer's.

## Context

A Sourcify verification job can finish with an error that may clear up on a later submit:
`internal_error`, `job_abandoned`, `contract_not_deployed` right after a deployment, and others
listed in the research note. The job is finished, so polling it again returns the same body every
time.

The first draft of the Sourcify client threw `not-confirmed` with a handle for these jobs.
`not-confirmed` tells the caller to pass the handle to `checkStatus()` later. For a finished job,
`checkStatus()` reads the same answer again and throws the same error, so the call never resolves.
The fix the caller needs is a new `verify()`, which looks the contract up first and submits only
when the contract is not verified.

## Decision

- Add the error code `verification-inconclusive`: the explorer finished the job without a verdict.
  Call `verify()` again.
- `retryable` is `true`, and trying again means a new `verify()`, not `checkStatus()`.
- Exit code 4, the code for "no verdict yet", shared with `not-confirmed`.
- `details` holds `backend` and `reason`, the explorer's code and message, redacted and cut to 300
  characters. It holds no handle: the job cannot give another answer.
- `not-confirmed` keeps one meaning: the job is still running, so poll this handle again.

## Alternatives considered

- Keep `not-confirmed` for both cases. Rejected: the same code would ask for `checkStatus()` in one
  case and `verify()` in the other, and an agent following the hint would loop.
- Map these jobs to `failed`. Rejected: `failed` is only for a definitive rejection of the source
  (R-FLOW-4), and these errors may clear up.
- Map them to `unknown-state`. Rejected: the state is known and a retry may succeed, while
  `unknown-state` asks a person to check and is not retryable.

## Consequences

- `ERROR_CODES`, `ERROR_EXIT_CODES`, the error reference, the JSON reference and the envelope
  schema's code list gain `verification-inconclusive`.
- R-AX-7's exit code 4 covers both codes; only `not-confirmed` carries a handle.
- `checkStatus()` (#17) never sees a loop on a finished job: the client throws
  `verification-inconclusive`, and the hint says to call `verify()`.
- Other backends map their own "finished without a verdict" states to this code.
