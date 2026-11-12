# checkStatus()

Resume a submitted verification from its handle. It never submits, so it is
safe to call without asking.

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

The signatures:

<!-- fragment: signatures only; the examples below run. -->

```ts fragment
function checkStatus(
  handle: Handle | string, // the handle object or its one-line form
  options?: CheckStatusOptions,
): Promise<VerifyResult>;
function formatHandle(handle: Handle): HandleString;
function parseHandle(value: unknown): Handle;
function tryParseHandle(value: unknown): Handle | undefined;
function isHandleString(value: unknown): value is HandleString;
type HandleString = `ev1:${BackendName}:${number}:${Hex}:${string}`;
```

Use it after a `not-confirmed` error, an abort, a page reload or a process
restart. [Abort and resume](../advanced/abort-and-resume.md) shows the whole
flow.

## Example

Pass the handle that `verify()` gave, in its one-line form:

```ts [resume.ts]
import { checkStatus } from "explorer-verify";

// The handle of a Sourcify job, as stored after verify().
const handle =
  "ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:" +
  "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";

const result = await checkStatus(handle, { timeoutMs: 60_000 });
console.log(result.status, result.backend);
```

When the job has ended with a match, it prints:

```text
verified sourcify
```

## Options

The options of [verify()](verify.md#options) without `rpcUrl`, with the same
defaults and checks. The type is `CheckStatusOptions`.

Pass the same `route`, `apiKeys`, `allowSourcifyFallback` and `handlerUrl`
the submit used, so the route resolves to the same backend
([Routing](routing.md#resuming)). At run time it also accepts an object built
for `verify()`, `rpcUrl` included
([Options of each function](verify.md#options-of-each-function)).

## Results

The results of [verify()](verify.md#results): `verified`,
`already-verified` or `failed`, with the same fields and exit codes.

`checkStatus()` has the handle, not the input, so it compares no contract
name or compiler version. A lookup after the job can find another
contract's match and report it as `verified` or `already-verified`, without
`storedContract` ([Another contract's source](verify.md#another-contracts-source)).
To check whose source the explorer holds, call `dryRun()` with the input.

## Errors

`checkStatus()` throws the errors of [verify()](verify.md#errors), except
`timeout`, because the job id exists. These codes differ:

| Code                        | When `checkStatus()` throws it                                                      | Exit code |
| --------------------------- | ----------------------------------------------------------------------------------- | --------- |
| `invalid-input`             | The options or the handle are invalid, or the handle's backend is not the route's   | 2         |
| `not-confirmed`             | The budget ran out, or 3 polls in a row failed. `details.handle` is the same handle | 4         |
| `verification-inconclusive` | The job ended without a verdict. Call `verify()` again                              | 4         |
| `job-not-found`             | The explorer forgot the job, and a lookup did not find the contract verified        | 6         |

The `job-not-found` hint says to call `verify()` again when the lookup found
the contract not verified. When the lookup failed, it says to check the
explorer first, and its `cause` is the lookup's error.
[Errors](errors/index.md) has the fix for every code.

## The handle

A handle is plain JSON with no URL:
`{ version: 1, backend, chainId, address, jobId }`. Store it in its one-line
form, `ev1:<backend>:<chainId>:<address>:<jobId>`. That form holds no spaces
or shell characters, so a shell takes it without quotes.

| Function                | What it does                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `formatHandle(handle)`  | Writes the one-line form, typed `HandleString`                       |
| `parseHandle(value)`    | Reads either form from untrusted input, or throws `invalid-input`    |
| `tryParseHandle(value)` | Reads either form, or returns `undefined`                            |
| `isHandleString(value)` | `true` for a valid one-line form, which it narrows to `HandleString` |

`parseHandle(formatHandle(h))` and `parseHandle(h)` both equal `h`. The
`handle` of an error's `toJSON()` and of the `verify.submitted` event has the
one-line form and the `HandleString` type.

### A submit over a partial match

A job that `verify()` submitted with
[`submitOverPartial`](verify.md#submit-over-a-partial-match) over a partial
match of the input's source has a handle with `overPartial: true`. Its
one-line form ends with `:over-partial`:

```text
ev1:blockscout:11155111:0xdce2c184bfa3baecf2fbfc85248563e6b03d5360:dce2c184bfa3baecf2fbfc85248563e6b03d53606af41c8c:over-partial
```

`checkStatus()` ends such a job as `verify()` would:

- A rejected job gives `already-verified`, `partial`, with a `warn` line,
  unless a newer lookup finds no match.
- A lookup after the budget runs out, or after the explorer forgets the job,
  confirms it only with an `exact` match. A `partial` match gives
  `not-confirmed` or `job-not-found`.

A handle without the marker resumes as before.

## Handle rules

- The one-line form splits on `:` into five parts, or six when the last is
  `over-partial`.
- A job id is 1 to 128 letters, digits, `_` or `-`, starting with a letter
  or digit.
- The address keeps its case. Whitespace is not trimmed.
- JSON text is not read: store the one-line form, not
  `JSON.stringify(handle)`.

`parseHandle` throws `invalid-input` and names each bad field in
`details.issues`. The field is `handle` for a value of neither form, and
the message then names both forms, the handle object and
`ev1:<backend>:<chainId>:<address>:<jobId>`. Messages never repeat a value. When a job id equals one of your keys, the
handle in an error, event or log line ends in `:[redacted]`. It cannot
resume: `isHandleString` gives `false` and `parseHandle` throws.

## A page that only stores the handle

The four functions and the `Handle` and `HandleString` types are also
exported from `explorer-verify/handle`. That entry never reaches the
verification code, so a page that only stores or checks a handle stays
small:

```ts [stored-handle.ts]
import { formatHandle, tryParseHandle } from "explorer-verify/handle";

const stored = localStorage.getItem("pending-verification");
const handle = tryParseHandle(stored);
if (handle !== undefined) {
  console.log(formatHandle(handle));
}
```

| Function                            | Minified size |
| ----------------------------------- | ------------- |
| `formatHandle`                      | about 100 B   |
| `tryParseHandle`, `isHandleString`  | about 2 KB    |
| `parseHandle`, with the error class | about 15.7 KB |

A page that only checks a stored value uses `tryParseHandle` or
`isHandleString`.

## What it does

1. Reads the options as `verify()` does, then the handle with `parseHandle`.
   A problem throws `invalid-input`, and nothing is sent.
2. Resolves the route from the handle's chain id and the `route` option. The
   handle never chooses a host. When its backend is not the route's, the call
   throws `invalid-input` naming `backend`.
3. Polls the job at once, then every `pollIntervalMs`, until the job ends or
   `timeoutMs` is spent, as [verify()](verify.md#what-it-does) does.
4. When the explorer no longer knows the job, it looks the contract up once.
   A match returns `verified`; otherwise it throws `job-not-found`.

The call ends within `timeoutMs` plus `min(pollIntervalMs, 30000)`.

A handle from a self-hosted Sourcify server, resumed without its `route`, is
polled on the public server, which does not know the job. A Sourcify handle
from `verifyEach()`, on a chain where `handlerUrl` makes Etherscan the
choice, resumes only with `route: { backend: "sourcify" }`.

## Events

`checkStatus()` emits `verify.routed`, then one `verify.poll` per pending
poll, and `verify.result` last. `verify.retry` comes before each retry wait.
It emits no `verify.validated`, `verify.lookup` or `verify.submitted`. A
call that throws emits no `verify.result`. See
[Logging and events](logging-and-events.md#events).

## Sources

- Tested live on 2026-11-03 with Node.js and public Sourcify, no key, on
  Base Sepolia (84532). A `verify()` submit of
  `0x37e6e91f168c4aafd405444596b42de58dfc84ef` got job
  `1e5c597f-643c-4133-b088-2499daf81600`. Its stored handle, passed to
  `checkStatus()` twice, returned `verified` with `exact` after one GET
  request each time.
- The same day, the handle
  `ev1:sourcify:84532:0x616dc0f820416e46841d2e1122ff7ca615a740fe:c2ecf68c-2f91-436f-8670-3210387bb3ea`
  from the run in [verify()](verify.md#sources) returned `verified` with
  `exact` after one GET request.
