# proxy-link-unknown-state

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The explorer answered about a proxy link with a state the library cannot classify.

## How to fix

Do not retry automatically. Open the proxy's page on the explorer, check which implementation
it shows, then report `details.excerpt` in an issue.

From the CLI: Do not retry automatically. Check the proxy's page on the explorer, and report the
excerpt that --json prints.

After a call with `resumeJobId`, `Error!` or `Unknown UID` means the explorer no longer knows the
job. Call `linkProxy()` again without `resumeJobId` to send a new link request.

## Facts

Retryable: no.

Exit code: 6

Sent to an explorer: yes. The explorer may have changed the proxy's page.

Default hint: Do not retry automatically. Check the proxy's page on the explorer and report its
answer (details.excerpt).

For end users: The explorer gave an answer about the proxy that could not be read. Check the proxy's
page on the explorer before you try again.

## Why

Cause: `linkProxy()` asked about a proxy link and the explorer answered, in its format, with a
state the library cannot classify. The library does not report the proxy as linked. Examples:

- Etherscan's `Error!` for a link it had just accepted;
- Blockscout's `Unknown UID`;
- an answer that names another proxy;
- an implementation that is not exactly one address of `0x` and 40 hex digits, such as a longer
  run of digits, several addresses or the zero address.

`details.backend` names the explorer, and `details.excerpt` holds the first 300 characters of its
answer, redacted. The error has no handle: a link has none.

A link request answered in a form the library does not know throws
[`unexpected-response`](unexpected-response.md) instead: nothing started.

See [Verify a proxy](../../guides/verify-a-proxy.md) for the steps and what each explorer does.

## In code

Check the code, then report the explorer's answer:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "proxy-link-unknown-state")) {
    console.error(`Report this answer: ${error.details.excerpt}`);
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
