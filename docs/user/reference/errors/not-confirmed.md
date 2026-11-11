# not-confirmed

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the time budget (`timeoutMs`) ran out after the explorer accepted the submission, while it
was still verifying the contract.

Fix: store `details.handle` and pass it to `checkStatus()` later to continue polling. Raise
`timeoutMs` if this happens often.

Default hint: Call checkStatus later with the error's handle (details.handle) to continue polling.

For end users: The explorer is still verifying the contract. Check the contract's page on the
explorer in a few minutes; there is no need to submit it again.

From the CLI: The explorer is still verifying. Run explorer-verify status
`ev1:sourcify:11155111:0x<address>:<job>` later to continue polling, or raise --timeout. Running
verify again would submit again.

Retryable: yes, with `checkStatus(details.handle)`. Do not call `verify()` again: it would submit
the contract again.

Exit code: 4

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
