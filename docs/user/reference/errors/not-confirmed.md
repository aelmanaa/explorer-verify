# not-confirmed

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the time budget (`timeoutMs`) ran out after the explorer accepted the submission, while it
was still verifying the contract.

Fix: store `details.handle` and pass it to `checkStatus()` later to continue polling. Raise
`timeoutMs` if this happens often.

Default hint: Call checkStatus with details.handle later to continue polling.

From the CLI: The explorer is still verifying. Run explorer-verify status
`ev1:sourcify:11155111:0x<address>:<job>` later to continue polling, or raise --timeout. Running
verify again would submit again.

Retryable: yes, with `checkStatus(details.handle)`. Do not call `verify()` again: it would submit
the contract again.

Exit code: 4

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
