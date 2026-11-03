# unsupported-chain

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the backend answered that it does not serve the chain in `details.chainId`.
`details.backend` names the backend.

Fix: check the chain ID. If it is right, pick a backend that serves the chain with the `route`
option.

Default hint: Check the chain ID, or pick a backend that serves this chain with the route option.

Retryable: no.

Exit code: 2

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
