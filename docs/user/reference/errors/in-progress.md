# in-progress

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the backend is already verifying this contract from another submission. This call has no
job id, so the error carries no handle. It also happens when a submit got no clear answer, the
library submitted once more, and the explorer said a job for the contract was already running: the
first submit most likely reached it.

Fix: wait for the explorer to finish that verification, then call again.

Default hint: Wait for the explorer to finish its current verification of this contract, then call
again.

From the CLI: Wait for the explorer to finish its current verification of this contract, then run
the command again.

Retryable: yes.

Exit code: 5

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
