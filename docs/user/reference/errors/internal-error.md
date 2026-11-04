# internal-error

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: an unexpected exception reached the top level of the CLI. This is a bug in explorer-verify,
not a problem with the input or the explorer. The CLI creates this error so that its JSON output
still has one envelope with a typed error. The library never throws it. The message is redacted
and the error carries no handle.

Fix: do not retry automatically. Report the bug in an issue with the command you ran and the
message. Leave out your API key.

Default hint: This is a bug in explorer-verify. Report it with the command you ran, without your
API key.

Retryable: no.

Exit code: 6

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
