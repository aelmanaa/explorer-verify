# unsupported-chain

Version: explorer-verify 0.3.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The chain has no route, or the backend answered that it does not serve it.

## How to fix

Check the chain ID. If it is right, set `allowSourcifyFallback: true` to verify on Sourcify,
or pick a backend that serves the chain with the `route` option.

In the CLI, pass `--allow-sourcify-fallback` for a chain without a row; the CLI's hint names that
flag ([CLI](../cli.md#chains-the-routing-table-does-not-list)).

From the CLI: Check --chain, or pass a --backend that serves the chain. --backend auto lets the
routing table pick one.

## Facts

Retryable: no.

Exit code: 2

Sent to an explorer: no, or refused. The explorer holds no submission from this call.

Default hint: Check the chain ID, or pick a backend that serves this chain with the route option.

For end users: This explorer does not support this chain. Check the chain, or pick another explorer.

## Why

Cause: the chain in `details.chainId` has no route, or the backend answered that it does not serve
it. `details.backend` names the backend.

Before any request, the routing table throws it when:

- the chain has no row and `allowSourcifyFallback` is not set; `details.backend` is `sourcify`;
- `route.backend` names a backend that the chain's row does not list;
- the table chose a backend this version has no client for.

The error's own hint says which options fix the case. [Routing](../routing.md) explains how a
chain resolves.

## In code

Check the code, then read the chain and the backend:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "unsupported-chain")) {
    const { chainId, backend } = error.details;
    console.error(`${backend} does not serve chain ${String(chainId)}.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
