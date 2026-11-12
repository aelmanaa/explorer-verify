# quota-exceeded

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The API key's daily limit is spent.

## How to fix

Call again after the explorer resets the limit, or use a key on a plan with a higher limit.
[API keys](../api-keys.md) describes the Etherscan plan rules.

From the CLI: The key's daily limit is spent. Run the command again after the explorer resets the
limit, or use a key on a plan with a higher limit.

## Facts

Retryable: no.

Exit code: 3

Sent to an explorer: yes, and refused. The explorer holds no submission from this call.

Default hint: The key's daily limit is spent. Call again after the explorer resets the limit, or use
a key on a plan with a higher limit.

For end users: The API key has used up its daily limit. Try again after the explorer resets it, or
use a key with a higher limit.

## Why

Cause: the API key's daily limit is spent. Etherscan gives one of two answers:

- `Max daily rate limit reached`: the key has used its daily calls;
- `Daily limit of 500 source code submissions reached`: the key has used its daily submissions.

Another request in the same call cannot succeed, so the library does not retry. `details.backend`
names the backend. The error never holds the key.

The Etherscan v2, Routescan and [Etherscan-compatible](../etherscan-compatible.md) clients throw
this code; they read the same answers.

## In code

Check the code, then wait for the limit to reset:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "quota-exceeded")) {
    console.error(`The ${error.details.backend} key's daily limit is spent.`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
