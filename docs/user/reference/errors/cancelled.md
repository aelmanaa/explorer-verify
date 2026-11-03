# cancelled

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the run was cancelled, for example with Ctrl-C. The CLI creates this error, so that its
JSON output for exit code 130 has a typed error. The library never throws it: when the caller's
`signal` aborts, the call rejects with `signal.reason` unchanged. `details.handle` is present when
the explorer accepted the submission before the cancel.

Fix: if the CLI printed `verify.submitted`, or `details.handle` is present, resume with
`checkStatus()` and that handle. Otherwise run the command again.

Default hint: The run was cancelled. If verify.submitted was printed, resume with checkStatus and
that handle.

Retryable: no.

Exit code: 130

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
