# unsupported-chain

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: the chain in `details.chainId` has no route, or the backend answered that it does not serve
it. `details.backend` names the backend. Before any request, the routing table throws it when:

- the chain has no row and `allowSourcifyFallback` is not set; `details.backend` is `sourcify`;
- `route.backend` names a backend that the chain's row does not list;
- the table chose a backend this version has no client for.

The error's own hint says which options fix the case. [Routing](../routing.md) explains how a
chain resolves.

Fix: check the chain ID. If it is right, set `allowSourcifyFallback: true` to verify on Sourcify,
or pick a backend that serves the chain with the `route` option.

Default hint: Check the chain ID, or pick a backend that serves this chain with the route option.

Retryable: no.

Exit code: 2

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
