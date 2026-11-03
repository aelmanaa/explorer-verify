# network

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: every request to the backend failed before it answered, retries included. DNS, TLS, a
closed connection or a CORS block in a browser all end here, or every request took longer than the
per-request timeout. `details.attempts` gives the number of requests tried.

Fix: check the network connection and the explorer's status page, then call again.

Default hint: Check the network connection and the explorer's status page, then call again.

Retryable: yes.

Exit code: 5

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
