# job-not-found

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the explorer no longer knows the job id in `details.handle`. Explorers drop old jobs.

Fix: do not retry automatically. Check the contract on the explorer. If it is not verified, call
`verify()` again to submit it again. `checkStatus()` and `verify()` do this check themselves:
when a poll answers that the job is not found, they look the contract up once and return
`verified` when they find a match. They throw this error only when the lookup finds the contract
not verified, and then the hint says to call `verify()` again, or when the lookup fails.

Default hint: Do not retry automatically. Check the contract on the explorer; if it is not verified,
call verify() again.

From the CLI: Do not retry automatically. Check the contract on the explorer; if it is not verified,
run verify again.

Retryable: no. Checking the same handle again fails the same way.

Exit code: 6

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
