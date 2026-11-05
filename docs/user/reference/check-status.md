# checkStatus()

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who resume a verification that `verify()` submitted.

`checkStatus()` continues polling a submitted verification from its handle. Use it after a
`not-confirmed` error, an abort, a page reload or a process restart. It never submits, so it is safe
to call without asking. Nothing is published to npm yet.

<!-- fragment: signatures only; the example below runs. -->

```ts fragment
function checkStatus(handle: Handle | string, options?: VerifyOptions): Promise<VerifyResult>;
function formatHandle(handle: Handle): string;
function parseHandle(value: unknown): Handle;
```

## Example

Store the one-line form, then resume it later:

```ts
import { ExplorerVerifyError, checkStatus, formatHandle, verify } from "explorer-verify";

try {
  await verify(input);
} catch (error) {
  if (error instanceof ExplorerVerifyError && error.code === "not-confirmed") {
    localStorage.setItem("pending-verification", formatHandle(error.details.handle));
  } else {
    throw error;
  }
}

// Later, after a page reload:
const stored = localStorage.getItem("pending-verification");
if (stored !== null) {
  const result = await checkStatus(stored, { timeoutMs: 60_000 });
  localStorage.removeItem("pending-verification");
  console.log(result.status);
}
```

When the job ends with an exact match, it prints:

```text
verified
```

## The handle

A handle is plain JSON with no URL: `{ version: 1, backend, chainId, address, jobId }`. Its one-line
form is `ev1:<backend>:<chainId>:<address>:<jobId>`, for example
`ev1:sourcify:84532:0x616dc0f820416e46841d2e1122ff7ca615a740fe:c2ecf68c-2f91-436f-8670-3210387bb3ea`.
It holds no spaces or shell characters, so it can be pasted into a shell without quotes.

- `formatHandle(handle)` writes the one-line form. The `handle` field of an error's `toJSON()` and
  the `verify.submitted` event carry the same form.
- `parseHandle(value)` reads either form from untrusted input and returns a new handle. The
  one-line form must split on `:` into exactly five parts, because a job id never holds a `:`. The
  address keeps its case. Surrounding whitespace is not trimmed.
- `parseHandle(formatHandle(h))` and `parseHandle(JSON.parse(JSON.stringify(h)))` both equal `h`.

`parseHandle` throws `invalid-input` and names each bad field in `details.issues`: `version`,
`backend`, `chainId`, `address`, `jobId`, or `handle` for a value of neither form or for an object
with fields a handle does not have, such as `apiUrl`. Messages never repeat a value.

## What it does

1. Reads the options as `verify()` does, then reads the handle with `parseHandle`. A problem
   throws `invalid-input`, and nothing is sent.
2. Resolves the route from the handle's chain id and the `route` option. The handle never chooses a
   host. Its backend must be the backend that route names; otherwise the call throws
   `invalid-input` naming `backend`, and nothing is sent.
3. Polls the job at once, then every `pollIntervalMs`, until the job ends or `timeoutMs` is spent.
   Failed polls, the cap of 3 failed polls in a row, the last lookup and the result mapping are the
   same as in [verify()](verify.md#what-it-does).
4. When the explorer no longer knows the job, it looks the contract up once. A match returns
   `verified`. Otherwise it throws `job-not-found`.

Pass the same `route`, `apiKeys` and `allowSourcifyFallback` the submit used, so the route
resolves to the same backend ([Routing](routing.md#resuming)). A handle from a self-hosted Sourcify
server, resumed without its `route`, is polled on the public server, which does not know the job.

The call ends within `timeoutMs` plus `min(pollIntervalMs, 30000)`.

## Options

The same options as [verify()](verify.md#options), with the same defaults and checks.

## Results and errors

The results are those of [verify()](verify.md#results), with the same exit codes. The errors
differ in these cases:

| Code                        | When `checkStatus()` throws it                                                                                        | Exit code |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------- |
| `invalid-input`             | The options or the handle are invalid, or the handle's backend is not the route's. Nothing was sent                   | 2         |
| `not-confirmed`             | The budget ran out, or 3 polls in a row failed, before the job ended. `details.handle` is the same handle: call again | 4         |
| `verification-inconclusive` | The job ended without a verdict. No handle: call `verify()` again                                                     | 4         |
| `job-not-found`             | The explorer no longer knows the job, and a lookup found the contract not verified, or failed. The hint says which    | 6         |

When the lookup finds the contract not verified, the `job-not-found` hint says to call `verify()`
again. When the lookup fails, the hint says to check the contract on the explorer first. Its
`cause` is the lookup's error.

`checkStatus()` never throws `timeout`: the job id exists. [Errors](errors/index.md) links the
page of every code, with its fix.

## Events

`checkStatus()` emits `verify.routed`, one `verify.poll` per pending poll, `verify.retry` before
each retry wait, and `verify.result` last. It emits no `verify.validated`, `verify.lookup` or
`verify.submitted`. A call that throws emits no `verify.result`. See
[Logging and events](logging-and-events.md#events).

## Tested live

On 2026-11-03, with Node.js and the public Sourcify server, no key:

- Base Sepolia (chain id 84532), contract `0x37e6e91f168c4aafd405444596b42de58dfc84ef`, deployed in
  transaction `0xa285187bcc6a93710dc959182433cad02802c1fe0e47bfd53ee2c2b2d766c580`. A `verify()`
  submit got job `1e5c597f-643c-4133-b088-2499daf81600`. Its handle was stored, then passed to
  `checkStatus()` twice. Both calls returned `verified` with `exact` after one GET request each.
- Base Sepolia, the handle
  `ev1:sourcify:84532:0x616dc0f820416e46841d2e1122ff7ca615a740fe:c2ecf68c-2f91-436f-8670-3210387bb3ea`
  from the `verify()` run in [verify()](verify.md#tested-live): `checkStatus()` returned `verified`
  with `exact` after one GET request.
