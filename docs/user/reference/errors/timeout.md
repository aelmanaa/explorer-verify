# timeout

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the time budget (`timeoutMs`) ran out before the explorer accepted the submission. There is
no job id yet, so the error carries no handle. `details.timeoutMs` gives the budget.

Fix: call again, or raise `timeoutMs`. If the explorer did receive the submission, the next call
may report the contract as verified or in progress.

Default hint: Call again, or raise timeoutMs. The explorer had not accepted the submission yet.

From the CLI: Run the command again, or raise --timeout. The explorer had not accepted the
submission, so nothing is pending.

Retryable: yes.

Exit code: 5

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
