# Logging and events

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who want progress lines from explorer-verify, or who want a program to react
to each stage of a verification.

explorer-verify has two optional outputs, set in `VerifyOptions`:

- `logger` receives log lines: a message and flat fields. Log text is for people and may change in
  any release.
- `onEvent` receives typed stage events. A program reads events, not log text.

Both are off by default. Without them the library writes nothing, in every runtime, and never calls
`console` on its own. API keys are removed from every message, field and event before your code
sees it.

`verify()` logs and emits events as described here. `checkStatus()` lands in
[#18](https://github.com/aelmanaa/explorer-verify/issues/18).

## Logger

```ts
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

| Level   | What the library logs there                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `debug` | The first line, `Verifying <address> on chain <id>`, with `backend`, `chainId` and `api` (the API URL, query replaced by `?REDACTED`); each request: method, URL and attempt number; each pending poll |
| `info`  | The handle once the explorer accepts the submission, and the result                                                                                                                                    |
| `warn`  | A retry, with the reason and the wait; a status poll that failed; an `onEvent` callback that threw                                                                                                     |
| `error` | A failure the library recovers from. Never a failure it throws to you                                                                                                                                  |

A failure that ends the call is thrown as an `ExplorerVerifyError`, which carries the message. It
is not also logged at `error`, so a program that logs the thrown error shows each failure once.

The fields of a request line are `backend`, `method`, `url` and `attempt`. A retry line adds
`reason`, `status` (`null` when no response arrived) and `delayMs`. A URL shows its origin and path
only; a query string becomes `?REDACTED`. Field names are diagnostics, like messages, and may change
in any release.

pino takes the fields first. Wrap it in one line per method:

```ts
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

| `type`             | Emitted when                                       | Fields besides `type`                                           |
| ------------------ | -------------------------------------------------- | --------------------------------------------------------------- |
| `verify.validated` | The input passed validation                        | `chainId`, `address`                                            |
| `verify.routed`    | The route is resolved                              | `backend`, `apiHost` (the host only, never a path or query)     |
| `verify.lookup`    | The already-verified check finished or was skipped | `backend`, `match`: `exact`, `partial`, `none` or `skipped`     |
| `verify.submitted` | The explorer accepted the submission               | `backend`, `handle` in its one-line form                        |
| `verify.poll`      | One poll returned a state that is not final        | `backend`, `attempt`, `state`: `pending`, `queued`, `completed` |
| `verify.retry`     | A request is retried after a transient failure     | `backend`, `attempt`, `reason`, `delayMs`                       |
| `verify.result`    | The call is about to return a result               | `backend`, `status`, and `match` unless `status` is `failed`    |

- `verify.retry` `reason` is `rate-limited`, `network`, `server-error` or `duplicate-submission`.
  `attempt` is the number of the attempt after the wait, so the first retry is attempt 2.
- `verify()` emits events in stage order. `checkStatus()` emits only `verify.poll`, `verify.retry`
  and `verify.result`.
- A call that throws emits no `verify.result`. The thrown error is the outcome.
- `verify.submitted` arrives as soon as the explorer accepts the submission. Store its `handle`:
  if the call is aborted or the process stops, the handle resumes the verification. `verify()` also
  logs the handle at `info`.
- `verify.validated` arrives once the input, the options and the route have all passed their
  checks, so a call that fails any of them emits no event.
- `verify.lookup` reports the check before the submit. The lookup after the time budget, described
  in [verify()](verify.md#what-it-does), emits no event.

```ts
import type { VerifyEvent } from "explorer-verify";

// Your code: keep the handle, print retries, and fail to compile when a release adds a type.
function onEvent(event: VerifyEvent): void {
  switch (event.type) {
    case "verify.submitted":
      localStorage.setItem("pending-verification", event.handle);
      break;
    case "verify.retry":
      console.warn(`retry ${event.attempt} in ${event.delayMs} ms: ${event.reason}`);
      break;
    case "verify.validated":
    case "verify.routed":
    case "verify.lookup":
    case "verify.poll":
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

### Schema

The package ships a JSON Schema (draft 2020-12) for the events as
`explorer-verify/event.schema.json`. It lists `state` and `reason` as enums, so a new value is a
schema change. Within a schema version, a release adds event types and fields and never removes or
changes one, so a reader ignores fields it does not know.

```ts
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
when it equals a key the call knows. See [Errors](errors.md) for the same rules on thrown errors.

Event fields with a fixed set of values, `type`, `backend`, `match`, `state`, `reason` and
`status`, are copied as they are. They hold words the library chose, such as `sourcify` or
`rate-limited`, never your input. A key equal to one of these words is not redacted there; a key
is long and random, so this does not happen with a real one.
