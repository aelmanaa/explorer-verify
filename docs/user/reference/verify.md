# verify()

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who call `verify()` and act on what it returns or throws.

`verify()` checks a contract's source on an explorer and submits it when the explorer does not
have it yet. In this release every chain goes to Sourcify, which needs no API key. Nothing is
published to npm yet.

```ts
function verify(input: VerifyInput, options?: VerifyOptions): Promise<VerifyResult>;
```

The submit is outward and permanent: the explorer publishes the source. Read
[Using explorer-verify from an agent](../guides/using-from-an-agent.md) before you call `verify()`
on someone's behalf.

## Example

```ts
import { ExplorerVerifyError, verify } from "explorer-verify";

try {
  const result = await verify(input, { timeoutMs: 60_000 });
  if (result.status === "failed") {
    console.error(`Rejected: ${result.reason}`);
  } else {
    console.log(`${result.status} (${result.match}) ${result.explorerUrl ?? ""}`);
  }
} catch (error) {
  if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
    localStorage.setItem("pending-verification", JSON.stringify(error.details.handle));
  } else {
    throw error;
  }
}
```

Build `input` with `buildVerifyInput` from build files, or write it by hand. See
[Verify a contract shipped in an npm package](../guides/verify-a-contract-from-an-npm-package.md).

## What it does

1. Validates the input with `validateInput`, checks the options and resolves the route. A problem
   throws `invalid-input`, and nothing is sent.
2. Looks the contract up. When the explorer already has an `exact` or `partial` match, it returns
   `already-verified` with that match and submits nothing.
3. Submits the source. When the explorer answers that the contract is already verified, it returns
   `already-verified`.
4. Waits `pollIntervalMs`, then asks for the job's state, until the job ends or `timeoutMs` is
   spent. A poll that fails with `network`, `rate-limited` or `unexpected-response`, after the
   request's own retries, is logged at `warn`, and polling goes on at the next interval.
5. Maps the job's end to a result or an error (see below).
6. When `timeoutMs` runs out while the job is still pending, or after 3 failed polls in a row, it
   looks the contract up once more. Some explorers finish a job before their status endpoint says
   so. A match returns `verified`; otherwise the call throws `not-confirmed` with the handle.

`verify()` uses the address in lower case, as `validateInput` returns it: in the handle, the events
and `explorerUrl`.

A partial match found by the lookup is returned as `already-verified`, without a submit. To turn it
into an exact match, submit the exact sources another way; an option for this is planned.

## Options

Every field is optional.

| Option           | Default              | What it does                                                                                                       |
| ---------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `fetch`          | `globalThis.fetch`   | Every request goes through it. Point it at your own server to proxy the calls. It must not follow redirects        |
| `signal`         | none                 | Cancels the call. The call rejects with `signal.reason`, unchanged                                                 |
| `timeoutMs`      | `120000`             | Time budget for the whole call, every request and retry included                                                   |
| `pollIntervalMs` | `3000`               | Wait before each status poll                                                                                       |
| `logger`         | none, writes nothing | Receives log lines, keys removed. See [Logging and events](logging-and-events.md)                                  |
| `onEvent`        | none                 | Receives the stage events, keys removed. See [Logging and events](logging-and-events.md#events)                    |
| `route`          | the routing table    | `{ backend?, apiUrl? }`: another Sourcify server, such as a self-hosted one. Results from it have no `explorerUrl` |

`timeoutMs` and `pollIntervalMs` must be positive numbers of milliseconds; anything else throws
`invalid-input`. A value above 2147483647, the largest delay `setTimeout` takes, is lowered to it.
A `pollIntervalMs` below 1000 is raised to 1000.

`signal` must be an `AbortSignal`, `fetch` and `onEvent` functions, and `logger` an object. Only the
options object's own properties are read, each once. A value of the wrong kind, or a property that
cannot be read, throws `invalid-input` before any request.

The library sends every request with `redirect: "manual"` and never follows a redirect, because a
redirect could carry a key to another host. A `fetch` you pass must keep that behaviour: it must not
follow redirects itself.

The call ends within `timeoutMs` plus `min(pollIntervalMs, 30000)`. The lookups after polling,
described below, get that much more time, so a server that never answers cannot hold the call
longer.

The values of `route.apiUrl`'s query string count as keys: they are removed from every error, log
line, event and result, even when an explorer repeats them in an answer. Only values count, not
parameter names. A value counts only when it is at least 8 characters long, holds a character that
is not a digit, and does not appear in the handle's `ev1:<backend>:<chainId>:<address>` part.
Other values, such as a short token, are not removed from free text. Put a key in a parameter named
like a key, such as `apikey` or `token`: those values are removed whatever their length.

## Results

| `status`           | When                                                                                    | Fields                                       | Exit code |
| ------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------- | --------- |
| `already-verified` | The lookup found the contract verified, or the explorer said so on submit or in the job | `backend`, `match`, `explorerUrl` when known | 0         |
| `verified`         | The job verified the contract, or the lookup after the budget found it verified         | `backend`, `match`, `explorerUrl` when known | 0         |
| `failed`           | The explorer definitively rejected the source, for example because the bytecode differs | `backend`, `reason`                          | 1         |

- `match` is `exact` when the metadata hash matches too, and `partial` when everything else does.
- `explorerUrl` is the public page of the contract, such as
  `https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc`. It is absent
  when `route` points at another server.
- `reason` is the explorer's code and message, such as
  `no_match: The deployed and recompiled bytecode don't match.`, with keys removed and cut to 300
  characters.
- When a job reports the contract already verified without the grade, `verify()` looks the grade
  up. If that lookup fails, or says the contract is not verified, it throws `unknown-state`.

`already-verified` can describe a verification this same call caused. A submit can reach the
explorer without the library learning the job id, for example when the connection drops. The
library then looks the contract up before it submits again. If the first submit was accepted and
its job has finished, that lookup finds the contract verified.

## Errors

Every failure throws an `ExplorerVerifyError`. An unknown or ambiguous state is never returned as
a result. [Errors](errors.md) has the fix for each code.

| Code                        | When `verify()` throws it                                                                         | Exit code |
| --------------------------- | ------------------------------------------------------------------------------------------------- | --------- |
| `invalid-input`             | The input, an option or the route is invalid. Nothing was sent                                    | 2         |
| `unsupported-chain`         | The explorer does not serve the chain                                                             | 2         |
| `timeout`                   | The budget ran out before the explorer accepted the submission. No handle                         | 5         |
| `not-confirmed`             | The budget ran out, or 3 polls in a row failed, before the job ended. `details.handle` resumes it | 4         |
| `verification-inconclusive` | The job ended without a verdict. No handle: call `verify()` again later                           | 4         |
| `unknown-state`             | The explorer reported a final state the library cannot classify. Has a handle                     | 6         |
| `job-not-found`             | The explorer no longer knows the job                                                              | 6         |
| `in-progress`               | The explorer is already verifying this contract from another submission                           | 5         |
| `network`                   | No request got an answer, retries included                                                        | 5         |
| `rate-limited`              | The explorer answered 429 on every try                                                            | 5         |
| `unexpected-response`       | The explorer answered something the library does not recognise                                    | 5         |

A budget that runs out after the explorer accepted the submission always ends in `not-confirmed`,
never `timeout`, so the handle is not lost. The same holds when status polls keep failing.

The `cause` of a `not-confirmed` error is the last poll error, or the last lookup's error. Like
every cause, it is a redacted copy: a plain `Error` with the original `name`
(`ExplorerVerifyError`), message and `code`, not an `ExplorerVerifyError` instance. Read
`cause.code` for the error code.

## Abort and resume

An aborted call rejects with `signal.reason`, unchanged, at the next wait or request. It carries no
handle. To resume after an abort, keep the handle from the `verify.submitted` event: `verify()`
emits it, and logs it at `info`, as soon as the explorer accepts the submission.

```ts
const controller = new AbortController();
let handle: string | undefined;
const pending = verify(input, {
  signal: controller.signal,
  onEvent: (event) => {
    if (event.type === "verify.submitted") {
      handle = event.handle; // ev1:sourcify:<chainId>:<address>:<jobId>
    }
  },
});
```

`checkStatus(handle)`, which continues polling from a handle, is planned
([#18](https://github.com/aelmanaa/explorer-verify/issues/18)).

## Events

`verify()` emits the stage events in this order: `verify.validated`, `verify.routed`,
`verify.lookup`, then `verify.submitted` and one `verify.poll` per pending poll when it submits,
and `verify.result` last. `verify.retry` comes before each retry wait, wherever a request is
retried. A call that throws emits no `verify.result`. `verify.poll` reports only polls that found
the job still pending; the poll that ends the job is reported by `verify.result`. See
[Logging and events](logging-and-events.md#events).

## Tested live

On 2026-11-03, with Node.js and the public Sourcify server, no key:

- Base Sepolia (chain id 84532), contract `0x616dc0f820416e46841d2e1122ff7ca615a740fe`, deployed in
  transaction `0x916e36a160b0b1cce018905f9cf3634c63c7b339d07d130a123badc5aed181ef`. The first
  `verify()` submitted, got job `c2ecf68c-2f91-436f-8670-3210387bb3ea`, and returned `verified`
  with `exact` after 2.5 s. A second `verify()` returned `already-verified` with `exact` after one
  lookup request, in 65 ms, with no submit.
- Sepolia (chain id 11155111), contract `0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc`, already
  verified: `verify()` returned `already-verified` with `exact` after one GET request.
