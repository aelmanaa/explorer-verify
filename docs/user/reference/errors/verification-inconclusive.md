# verification-inconclusive

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the explorer finished the verification job without a verdict. The job ended with an error
that may clear up later, such as Sourcify's `internal_error`, or `contract_not_deployed` right after
a deployment. `details.reason` holds the explorer's code and message, redacted, at most 300
characters, and `details.backend` names the backend. The
[Sourcify page](../sourcify.md#how-answers-are-read) lists those errors. The finished job will not
change, so the error carries no handle.

Fix: wait a minute, then call `verify()` again. It looks the contract up first and submits only
when the contract is not verified. Do not call `checkStatus()`: it would read the same finished
job.

Default hint: Wait a minute, then call verify() again: it looks the contract up first and submits
only when the contract is not verified.

From the CLI: Wait a minute, then run verify again: it looks the contract up first and submits only
when the contract is not verified.

Retryable: yes, with a new `verify()`.

Exit code: 4

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
