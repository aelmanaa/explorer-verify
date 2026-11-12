# api-key-rejected

Version: explorer-verify 0.2.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The explorer refused the API key, or the key's plan does not cover the chain.

## How to fix

Fix: check the key on the explorer's account page, then pass a valid key in `apiKeys` or
`route.apiKey` and call again. [API keys](../api-keys.md) describes where each key goes.

For a chain that needs a paid plan, use a key on a paid plan, or verify on Sourcify, which needs no
key, with `route: { backend: "sourcify" }`.

From the CLI: etherscan-v2 refused the key. Check the key in ETHERSCAN_API_KEY on the explorer's
account page: it may be mistyped, revoked or issued by another explorer.

## Facts

Retryable: no.

Exit code: 3

Sent to an explorer: yes, and refused. The explorer holds no submission from this call.

Default hint: Check the key on the explorer's account page: it may be mistyped, revoked or issued by
another explorer. Pass a valid key, then call again.

For end users: The explorer refused the API key. Check the key: it may be mistyped, revoked or
issued by another explorer.

## Why

Cause: the explorer refused the API key, as Etherscan's `Invalid API Key (#err2)`. The key may be
mistyped, revoked, or issued by another explorer. `details.backend` names the backend. The error
never holds the key.

The Etherscan v2, Routescan and [Etherscan-compatible](../etherscan-compatible.md) clients throw
this code; they read the same answers.

The client also throws this code for Etherscan's answer
`Free API access is not supported for this chain`: the key is on a free plan and the chain needs a
paid one. The Etherscan chainlist marks those chains "Paid Plan required"
([Routing](../routing.md#etherscan-rows-and-paid-plans)). The hint then names the two ways out.

## In code

Check the code, then read the backend that refused the key:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "api-key-rejected")) {
    console.error(`Check the ${error.details.backend} key.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
