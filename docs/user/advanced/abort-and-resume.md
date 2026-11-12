# Abort and resume

Stop a running `verify()` call, and resume its job later without a new
submission.

Version: explorer-verify 0.2.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers whose page or process can stop while an explorer is
still checking a submission. [checkStatus()](../reference/check-status.md)
describes the handle.

## Example

This example stops the call as soon as the explorer accepts the submission,
then resumes the job from its handle:

```ts [abort-and-resume.ts]
import { readFile } from "node:fs/promises";

import { checkStatus } from "explorer-verify";
import { validateInput, verify } from "explorer-verify";

const text = await readFile("greeter-sepolia.json", "utf8");
const input = validateInput(JSON.parse(text));

const controller = new AbortController();
const handles: string[] = [];

try {
  await verify(input, {
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "verify.submitted") {
        handles.push(event.handle); // the one-line form
        controller.abort(); // here: stop right after the submit
      }
    },
  });
} catch (error) {
  if (!controller.signal.aborted) {
    throw error;
  }
  console.log("aborted");
}

for (const handle of handles) {
  const result = await checkStatus(handle, { timeoutMs: 60_000 });
  console.log(result.status);
}
```

When the explorer has ended the job with a match, it prints:

```text
aborted
verified
```

The example reads the docs' [sample request](../start/greeter-sepolia.json).
Against the live explorer, which already holds that contract, `verify()`
submits nothing and prints `already-verified` instead.

## What an abort does

An aborted call rejects with `signal.reason`, unchanged, at its next wait or
request. The rejection carries no handle, and the job keeps running on the
explorer.

To resume, keep the handle from the `verify.submitted` event. `verify()`
emits it, and logs it at `info`, as soon as the explorer accepts the
submission. [Logging and events](../reference/logging-and-events.md#events)
lists every event.

## Store the handle

The event's `handle` is the one-line form, `ev1:<backend>:<chainId>:<address>:<jobId>`.
Store that string where the next run can read it:

| Where the call runs | Where to keep the handle                                                |
| ------------------- | ----------------------------------------------------------------------- |
| A web page          | `localStorage`, so it survives a reload                                 |
| A backend service   | A queue job ([Resume from a job queue](resume-from-a-job-queue.md))     |
| A CLI or CI job     | The JSON output, passed to `status` ([CLI](../reference/cli.md#status)) |

## Keep the handle of an error

A call that runs out of time after the submit throws `not-confirmed`, with
the handle in `error.details.handle`. Write it with `formatHandle()` and
store it:

```ts [keep-handle.ts]
import { readFile } from "node:fs/promises";

import { ExplorerVerifyError, formatHandle } from "explorer-verify";
import { validateInput, verify } from "explorer-verify";

const text = await readFile("greeter-sepolia.json", "utf8");
const input = validateInput(JSON.parse(text));

try {
  const result = await verify(input, { timeoutMs: 60_000 });
  console.log(result.status);
} catch (error) {
  if (!(error instanceof ExplorerVerifyError)) throw error;
  if (error.code !== "not-confirmed") throw error;
  const handle = formatHandle(error.details.handle);
  localStorage.setItem("pending-verification", handle);
}
```

When the explorer already holds the contract, there is no handle to keep:

```text
already-verified
```

## Resume

`checkStatus(handle, options)` polls the job and never submits. Pass the same
`route`, `apiKeys` and `handlerUrl` the submit used, so the route resolves to
the handle's backend. Otherwise the call throws `invalid-input` before any
request.

When it throws `not-confirmed` again, the explorer is still checking: keep
the handle and call later. [checkStatus()](../reference/check-status.md#errors)
lists the other errors.

## Several backends

`verifyEach()` takes the same `signal`. An abort rejects the whole call.
Every submission made before it has emitted its own `verify.submitted`
event, with its `backend`, so each pending job can be resumed on its own.
See [Verify on several explorers](verify-on-several-explorers.md).

## Next steps

- [checkStatus()](../reference/check-status.md): the handle, its options and
  errors.
- [Resume from a job queue](resume-from-a-job-queue.md): finish a job in a
  backend queue.
- [Verify from a browser](../guides/verify-from-a-browser.md): keep the handle
  across a reload.
