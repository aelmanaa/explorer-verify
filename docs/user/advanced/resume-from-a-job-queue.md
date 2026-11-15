# Resume from a job queue

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers whose backend queues a verification that outlived its time budget, and
finishes it later in a queue job. [Verify from Node.js](../guides/verify-from-node.md) shows the
service that queues the handle.

## How the job works

When `verify()` runs out of time while the explorer is still checking, it throws `not-confirmed`
with a handle in `error.details.handle`. The service queues the handle's one-line form from
`formatHandle()`. The queue job then polls it with `checkStatus()`, which never submits, so running
the job twice is safe.

Pass the job the same `apiKeys` and `route` the submit used. The handle names the backend, and the
route must resolve to it, or the call throws `invalid-input` before any request.

## The job

The job returns `again` while the explorer is still checking, so your queue runs it later:

```ts [status-job.ts]
import { ExplorerVerifyError, checkStatus } from "explorer-verify";
import type { VerifyOptions } from "explorer-verify";

type ApiKeys = NonNullable<VerifyOptions["apiKeys"]>;

/** The same keys as the submit used. An empty variable counts as unset. */
function apiKeysFrom(
  env: Readonly<Record<string, string | undefined>>,
): ApiKeys {
  const etherscan = env["ETHERSCAN_API_KEY"] ?? "";
  return etherscan === "" ? {} : { "etherscan-v2": etherscan };
}

export async function statusJob(handle: string): Promise<"done" | "again"> {
  try {
    const result = await checkStatus(handle, {
      apiKeys: apiKeysFrom(process.env),
      timeoutMs: 60_000,
    });
    console.log(`${result.status} on ${result.backend}`);
    return "done";
  } catch (error) {
    if (
      error instanceof ExplorerVerifyError &&
      error.code === "not-confirmed"
    ) {
      return "again";
    }
    throw error;
  }
}

// A handle that a Sourcify submit returned, as the queue stores it.
const handle =
  "ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:" +
  "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
console.log(await statusJob(handle));
```

When the explorer has ended the job with a match, it prints:

```text
verified on sourcify
done
```

## When to stop retrying

Limit how often a handle is retried. A job that gives `again` for hours, or ends with an error
that is not `not-confirmed`, needs a person. Log the handle, the error code and its `hint`.

| Code                                                                            | What the job does                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`not-confirmed`](../reference/errors/not-confirmed.md)                         | Return `again`; the queue runs the job later                        |
| [`verification-inconclusive`](../reference/errors/verification-inconclusive.md) | The job ended without a verdict. Call `verify()` again later, once  |
| [`job-not-found`](../reference/errors/job-not-found.md)                         | The explorer forgot the job. Log it for a person; do not resubmit   |
| [`invalid-input`](../reference/errors/invalid-input.md)                         | The route does not resolve to the handle's backend. Fix the options |

[checkStatus()](../reference/check-status.md) describes the handle and its one-line form.
