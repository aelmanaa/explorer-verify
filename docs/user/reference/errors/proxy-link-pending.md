# proxy-link-pending

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

The explorer had not finished linking the proxy when `linkProxy()` stopped waiting.

## How to fix

Fix: call `linkProxy()` again later with the same target and route, and with `resumeJobId` set to
`details.jobId`. That call sends no new link request: it checks the same link, at once and then
every `pollIntervalMs`.

A call without `resumeJobId` sends a new request, which is also safe: it undoes nothing. Blockscout
refuses a new request within its interval for the proxy, so resuming is quicker there. If the error
keeps coming back on Blockscout, check that the address is a proxy.

From the CLI: The explorer had not finished linking the proxy. Link it again later; a new request is
safe.

## Facts

Retryable: yes. Call `linkProxy()` again, with `resumeJobId`.

Exit code: 4

Sent to an explorer: yes. The explorer received the link request.

Default hint: Call linkProxy() again later with resumeJobId set to the job id (details.jobId): it
checks the same link and sends no new request. A call without it sends a new request, which is
also safe.

For end users: The explorer has not finished linking the proxy. Try again later; repeating the
request is safe.

## Why

Cause: `linkProxy()` asked the explorer to link a proxy to its implementation. The explorer had not
finished when the time budget (`timeoutMs`) ran out, or 3 status checks in a row failed.

Each explorer can take a while:

- Etherscan can answer `Pending in queue` for more than a minute.
- A Blockscout instance can stay at `Verification in progress` for an address it does not detect
  as a proxy.

The error has no handle. `details.backend` names the backend. `details.jobId` holds the job id the
explorer gave for the link request, with API keys removed. It is absent from an error of a release
before it.

See [Verify a proxy](../../guides/verify-a-proxy.md#resume-a-pending-link) for the steps and what
each explorer does.

## In code

Check the code, then keep the job id to resume the link later:

<!-- no-run: it defines a handler and calls nothing, so a run prints nothing. -->

```ts no-run [on-error.ts]
import { ExplorerVerifyError } from "explorer-verify/errors";

export function onError(error: unknown): void {
  if (ExplorerVerifyError.is(error, "proxy-link-pending")) {
    console.error(
      `${error.details.backend} is still linking: job ${error.details.jobId ?? "unknown"}.`,
    );
  }
}
```

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
