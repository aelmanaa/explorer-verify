# unknown-state

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the explorer's API answered for a submission with a job id, in its format, with a status the
library cannot classify. It is also thrown when the job reported the contract as already verified
without its match, and the one lookup that reads the match failed or found the contract not
verified. The library does not report it as verified. `details.handle` identifies the verification
and `details.excerpt` holds the first 300 characters of the answer, redacted. After a failed lookup
that got an unexpected answer, the excerpt is that answer; otherwise it is empty.

Fix: do not retry automatically. Check the contract on the explorer, then report `details.excerpt`
in an issue.

Default hint: Do not retry automatically. Check the contract on the explorer and report
details.excerpt.

From the CLI: Do not retry automatically. Check the contract on the explorer, and report the excerpt
that --json prints.

Retryable: no.

Exit code: 6

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
