# cancelled

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the run was cancelled, for example with Ctrl-C. The CLI creates this error, so that its
JSON output for exit code 130 has a typed error. The library never throws it: when the caller's
`signal` aborts, the call rejects with `signal.reason` unchanged. `details.handle` is present when
the explorer accepted the submission before the cancel.

Fix: if the envelope has `error.handle`, the explorer accepted the submission. Resume from that
handle with `explorer-verify status <handle>` (from the `status` command on, #101), or with
`checkStatus()` in code, instead of submitting again. Otherwise run the command again.

Default hint: The run was cancelled. If error.handle is set, resume with explorer-verify status
and that handle instead of submitting again.

Retryable: no.

Exit code: 130

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
