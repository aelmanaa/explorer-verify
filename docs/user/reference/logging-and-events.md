# Logging and events

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who want progress lines from explorer-verify, or who want a program to react
to each stage of a verification.

explorer-verify has two optional outputs, set in `VerifyOptions`. Both are off by default.

| Option    | Receives                          | Read by  | Stable                       |
| --------- | --------------------------------- | -------- | ---------------------------- |
| `logger`  | Log lines: a message, flat fields | People   | No: text may change any time |
| `onEvent` | Typed stage events                | Programs | Yes, within a schema version |

Without them the library writes nothing, in every runtime, and never calls `console` on its own.
`verify()`, [checkStatus()](check-status.md) and `linkProxy()` log and emit events as described
here.

> [!IMPORTANT]
> API keys are removed from every message, field and event before your code sees it
> ([API keys](#api-keys)).

## A minimal call

This script prints the library's log lines and each event type for the sample request,
[greeter-sepolia.json](../start/greeter-sepolia.json):

<!-- no-run: it calls Sourcify; the examples below type-check the same options. -->

```ts no-run [log.ts]
import { readFile } from "node:fs/promises";

import { validateInput, verify } from "explorer-verify";

const text = await readFile("greeter-sepolia.json", "utf8");
const input = validateInput(JSON.parse(text));
await verify(input, {
  logger: console,
  onEvent: (event) => console.log("event", event.type),
});
```

## Logger

A logger has one method per level. Its type:

```ts [logger.d.ts]
type LogValue = string | number | boolean | null;
type LogFields = Readonly<Record<string, LogValue>>;

interface Logger {
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
}
```

`console` fits this type, so `{ logger: console }` works in a browser, Node, Deno and Bun. A logger
that reads only the message also fits. When a line has no fields, the method gets one argument, so
`console` prints no `undefined`.

| Level   | What the library logs there                                                                        |
| ------- | -------------------------------------------------------------------------------------------------- |
| `debug` | The first line, each request, and each pending poll                                                |
| `info`  | The handle once the explorer accepts the submission, and the result                                |
| `warn`  | A retry, with the reason and the wait; a status poll that failed; an `onEvent` callback that threw |
| `error` | A failure the library recovers from. Never a failure it throws to you                              |

The first line is `Verifying <address> on chain <id>`, with `backend`, `chainId` and `api`. `api`
is the API URL with its query replaced by `?REDACTED`.

A failure that ends the call is thrown as an `ExplorerVerifyError`, which carries the message. It
is not also logged at `error`, so a program that logs the thrown error shows each failure once.

### Log fields

| Line      | Fields                                                    |
| --------- | --------------------------------------------------------- |
| A request | `backend`, `method`, `url`, `attempt`                     |
| A retry   | The request fields, plus `reason`, `status` and `delayMs` |

- `status` is `null` when no response arrived.
- A URL shows its origin and path only; a query string becomes `?REDACTED`.
- A request to your `rpcUrl` or `ipfsGateway` is not a request to a backend. Its lines carry
  `label`, `rpc` or `ipfs`, in place of `backend`.

Field names are diagnostics, like messages, and may change in any release.

### pino

pino takes the fields first. Wrap it in one line per method:

```ts [pino-logger.ts]
import type { Logger } from "explorer-verify";
import pino from "pino";

const log = pino();
const logger: Logger = {
  debug: (message, fields) => log.debug(fields ?? {}, message),
  info: (message, fields) => log.info(fields ?? {}, message),
  warn: (message, fields) => log.warn(fields ?? {}, message),
  error: (message, fields) => log.error(fields ?? {}, message),
};
```

A logger method that throws, or returns a promise that rejects, is ignored: the line is dropped and
the verification goes on.

## Events

`onEvent` receives one object per stage. Each has a `type` and flat, JSON-safe values.

| `type`             | Emitted when                                       | Fields besides `type`                                                    |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------ |
| `verify.validated` | The input passed validation                        | `chainId`, `address`                                                     |
| `verify.routed`    | The route is resolved                              | `backend`, `apiHost` (the host only), `routedBy`, `skipped`              |
| `verify.lookup`    | The already-verified check finished or was skipped | `backend`, `lookup`: `exact`, `partial`, `none` or `skipped`             |
| `verify.submitted` | The explorer accepted the submission               | `backend`, `handle` in its one-line form                                 |
| `verify.poll`      | One poll returned a state that is not final        | `backend`, `attempt`, `state`: `pending`, `queued`, `completed`          |
| `verify.retry`     | A request is retried after a transient failure     | `backend`, `attempt`, `reason`, `delayMs`                                |
| `verify.result`    | The call is about to return a result               | `backend`, `status`, `match` unless failed, and `explorerUrl` when known |

### Field values

| Field                      | Values                                                                            |
| -------------------------- | --------------------------------------------------------------------------------- |
| `verify.routed` `routedBy` | `caller`, `table`, `fallback` or `api-url`, as for a [dry run](verify.md#dry-run) |
| `verify.routed` `skipped`  | The backends the table passed over for want of a key, joined with `,`             |
| `verify.retry` `attempt`   | The attempt after the wait, so the first retry is attempt 2                       |

`skipped` is present only when the routing table passed over backends listed before `backend`,
because each needs an API key and none is set. An example value is `etherscan-v2`.

The values of `verify.retry` `reason`:

| `reason`               | Meaning                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `rate-limited`         | A 429, or an answer the client reads as a rate limit                                                                            |
| `network`              | A network error or a request timeout                                                                                            |
| `server-error`         | A 502, 503 or 504; for a submit, a 503 only                                                                                     |
| `duplicate-submission` | Reserved: no client emits it                                                                                                    |
| `not-indexed`          | Etherscan found no contract code yet; sent again within `indexWaitMs` when set ([Etherscan](etherscan.md#how-answers-are-read)) |
| `empty-submit`         | Blockscout answered the submit with nothing ([Blockscout](blockscout.md#the-empty-answer-right-after-a-deployment))             |

`duplicate-submission` is reserved: no client emits it. Sourcify's answer to a duplicate request
ends the call with [`in-progress`](errors/in-progress.md), not a retry.

`verify.retry` names the backend the request goes to, so a retried request to `rpcUrl` emits none.
Its retries are logged at `warn`, with `label` set to `rpc`.

### Which calls emit which events

| Call            | Events                                                                          |
| --------------- | ------------------------------------------------------------------------------- |
| `verify()`      | All the `verify.*` types, in stage order                                        |
| `checkStatus()` | `verify.routed`, `verify.poll`, `verify.retry`, `verify.result`                 |
| `linkProxy()`   | `proxy.routed`, `proxy.poll`, `proxy.retry`, `proxy.result`                     |
| `verifyEach()`  | The `verify.*` types, each with `entry` ([Several backends](#several-backends)) |

- `linkProxy()` emits one `proxy.poll` per pending check, and `proxy.retry` when a request
  retries. `proxy.result` arrives before it returns, with the fields of the `LinkProxyResult`.
  Proxy calls emit no `verify.*` events.
- In `verifyEach()`, `entry` is the zero-based index into `backends`. Each entry emits its own
  `verify.validated`. Events within an entry keep stage order while entries run concurrently.

### When each event arrives

- `verify.validated` arrives once the input, the options and the route have all passed their
  checks, so a call that fails any of them emits no event.
- `verify.lookup` reports the check before the submit. The lookup after the time budget, described
  in [verify()](verify.md#what-it-does), emits no event. The event gives the grade the explorer
  states and compares no names: it can say `exact` for another contract's match. The final
  result compares them and carries `storedContract`
  ([Another contract's source](verify.md#another-contracts-source)).
- `verify.submitted` arrives as soon as the explorer accepts the submission. Store its `handle`:
  if the call is aborted or the process stops, the handle resumes the verification. `verify()`
  also logs the handle at `info`.
- A call that throws emits no `verify.result`. The thrown error is the outcome.

### Handle each event type

This callback keeps the handle and prints retries. Its `never` check fails to compile when a
release adds a type:

```ts [on-event.ts]
import type { VerifyEvent } from "explorer-verify";

// Your code: keep the handle, print retries, and fail to compile when a release
// adds a type.
function onEvent(event: VerifyEvent): void {
  switch (event.type) {
    case "verify.submitted":
      localStorage.setItem("pending-verification", event.handle);
      break;
    case "verify.retry":
      console.warn(
        `retry ${event.attempt} in ${event.delayMs} ms: ${event.reason}`,
      );
      break;
    case "verify.validated":
    case "verify.routed":
    case "verify.lookup":
    case "verify.poll":
    case "proxy.routed":
    case "proxy.poll":
    case "proxy.retry":
    case "proxy.result":
    case "verify.result":
      break;
    default: {
      const unknown: never = event;
      throw new Error(`Unknown event ${JSON.stringify(unknown)}`);
    }
  }
}
```

Each event is a new, frozen object, so a callback cannot change it or the next one.

### When the callback fails

An exception thrown by `onEvent` is caught. The library logs the first one at `warn`, with the
event type and the error message, and ignores later ones in the same call. The outcome does not
change. Each `verify()` call creates its own guard, so a callback that throws on every event gives
one warning per call.

`onEvent` may be `async`: its type is `(event: VerifyEvent) => void | Promise<void>`. If it returns
a promise, the library attaches a `.catch` and does not wait for it. A slow
callback does not slow the verification, and a rejection is handled like a thrown exception.

### Several backends

`verifyEach()` ([verify()](verify.md#several-backends-in-one-call)) takes the same `logger` and
`onEvent` and runs each backend as `verify()` does:

- `verify.validated` arrives once for the whole call. It means the input and the options passed,
  and every entry of `backends` resolved to a route or to an `unsupported-chain` outcome, with no
  duplicate and no key in the address. No backend has sent a request yet.
- Every later event carries its `backend`. The backends run at once, so their events interleave
  in the order things happen; within one backend they keep stage order. Group them by `backend`.
  Two entries on the same backend, on two hosts, share that name; `apiHost` in `verify.routed`
  tells them apart.
- A backend with an `unsupported-chain` outcome emits nothing after `verify.validated`. A backend
  that throws emits no `verify.result`; its outcome holds the error.
- A callback that throws gives one warning for `verify.validated` and one per backend, as each
  backend has its own guard.
- Log lines from all the backends go to the same `logger`, each with a `backend` field.

### Schema

The package ships a JSON Schema (draft 2020-12) for the events as
`explorer-verify/event.schema.json`. It lists `state` and `reason` as enums, so a new value is a
schema change. Within a schema version, a release adds event types and fields and never removes or
changes one, so a reader ignores fields it does not know.

Import it as JSON:

```ts [schema.ts]
import schema from "explorer-verify/event.schema.json" with { type: "json" };
```

To send events to OpenTelemetry, emit each one as an event named `event.type` with the other fields
as attributes. The names follow OpenTelemetry's event naming rules: lowercase, dot-separated, with
no dynamic values.

## API keys

The library removes API keys before a value reaches the logger or `onEvent`, the same way it does
for errors and results:

- every key the call knows, in any case and in its URL-encoded forms;
- the value of a key-like parameter such as `apikey=`, even when the key is not known. A log field
  whose name is a key name, such as `apikey` or `token`, has its string value replaced whole;
- a bare Etherscan-style key: 34 characters of upper-case letters and digits, with at least one of
  each, between characters that are not letters or digits.

A handle's job id keeps the shape of a key, so a valid handle still resumes. It is redacted only
when it equals a key the call knows. See [Errors](errors/index.md#api-keys-in-errors) for the same
rules on thrown errors.

These event fields have a fixed set of values and are copied as they are:

- `type` and `backend`;
- `match`, `state` and `reason`;
- `status`.

They hold words the library chose, such as `sourcify` or `rate-limited`, never your input. A key
equal to one of these words is not redacted there; a key is long and random, so this does not
happen with a real one.
