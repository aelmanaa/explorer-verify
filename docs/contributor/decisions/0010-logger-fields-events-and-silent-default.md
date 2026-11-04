# 0010: Logger fields, typed events and a silent default

Status: Accepted (2026-11-02). Amends the logging parts of
[decision 0009](0009-options-handle-and-errors.md).

Research: [2026-11-02-cli-sdk-logging.md](../research/2026-11-02-cli-sdk-logging.md) and
[2026-11-02-agent-readiness.md](../research/2026-11-02-agent-readiness.md).

## Context

The CLI (M4) and `verify()` ([#17](https://github.com/aelmanaa/explorer-verify/issues/17)) need one
logging and output contract before either is built. Research on 2026-11-02 into current CLIs and
SDK logging, in
[research/2026-11-02-cli-sdk-logging.md](../research/2026-11-02-cli-sdk-logging.md), found five
problems with the merged design:

- Decision 0009's `Logger` methods take a message only, so structured fields such as the stage,
  the backend or the attempt number are lost or end up inside the text.
- Decision 0009 sends the resume handle through `logger.info` as a string. A handle is data a
  program needs to resume (R-FLOW-5). Log text is diagnostic and can change between releases;
  section B1 of the research note quotes an SDK that states this for its own logs.
- The `Logger.error` doc comment says a failure is "logged before the error is thrown". The CLI
  logs to stderr and also prints the thrown error, so each failure would appear twice.
- R-AX-6 decides colour and spinners from stdout's terminal state only, while progress goes to
  stderr.
- R-AX-12 (same input, same output) does not say which stream it covers.

`Logger` is marked `@experimental` and nothing calls it yet, so the change costs nothing now. After
0.1.0 it would break callers.

## Decision

This record changes three things in decision 0009 and adds two rules. Everything else in 0009
stands.

### 1. `Logger` takes a message and optional flat fields

Replaces the `Logger` shape of decision 0009, section 1:

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

- Field values are flat and JSON-safe, so they map to JSON Lines and to OpenTelemetry attributes
  without conversion.
- `console` satisfies the type. A logger that reads only the message keeps working.
- Messages and field names are diagnostics. They may change in any release. A program reads
  events (section 2), not log text.
- pino puts the fields first. The docs show a one-line adapter, tested in section B1 of the
  research note.

Requirement: R-DX-5.

### 2. A typed `onEvent` option carries the stage events

`VerifyOptions` gains `onEvent?: (event: VerifyEvent) => void`. `VerifyEvent` is a union keyed by
`type`. The names follow OpenTelemetry's event naming rules: lowercase, dot-separated, no dynamic
values.

| `type`             | Emitted when                                       | Fields besides `type`                                        |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------ |
| `verify.validated` | The input passed validation                        | `chainId`, `address`                                         |
| `verify.routed`    | The route is resolved                              | `backend`, `apiHost` (the host only, never a path or query)  |
| `verify.lookup`    | The already-verified check finished or was skipped | `backend`, `match` (`exact`, `partial`, `none` or `skipped`) |
| `verify.submitted` | The explorer accepted the submission               | `backend`, `handle` (the one-line string form)               |
| `verify.poll`      | One poll returned a non-terminal state             | `backend`, `attempt`, `state`                                |
| `verify.retry`     | A request is retried after a transient failure     | `backend`, `attempt`, `reason`, `delayMs`                    |
| `verify.result`    | The call is about to return a result               | `backend`, `status`, `match` when the status has one         |

- `verify.poll` `state` is one of `pending`, `queued` or `completed`. `verify.retry` `reason` is
  one of `rate-limited`, `network`, `server-error` or `duplicate-submission`. `event.schema.json`
  lists both as enums, so a new value is a schema change. Amended on 2026-11-04: the Etherscan v2
  client (#61) adds `not-indexed` and the Blockscout client (#92) adds `empty-submit`, each for a
  whole submit sent again ([Etherscan](../research/2026-11-04-etherscan-client.md),
  [Blockscout](../research/2026-11-04-blockscout-client.md)).
- `verify.submitted` replaces "logs the handle through `logger.info`" in decision 0009,
  section 1. A caller that aborts or crashes after the submit still has the handle (R-FLOW-5).
  The logger may also print a line, but no program depends on it.
- `checkStatus` emits `verify.poll`, `verify.retry` and `verify.result` only. Amended on
  2026-11-03 by [decision 0013](0013-check-status-emits-verify-routed.md): `checkStatus` also
  emits `verify.routed`.
- A call that throws emits no `verify.result`; the thrown error is the outcome.
- Event values are flat and JSON-safe, like log fields.
- An exception thrown by `onEvent` is caught, and the library logs it once at `warn` through the
  logger; the outcome does not change. If `onEvent` returns a promise, the library attaches a
  `.catch` to it and does not wait for it.
- The union is public API. Within a schema version, a release adds event types or fields and
  never removes or changes one. `event.schema.json` ships with the package, and the CLI writes
  the same objects as JSON Lines (R-AX-14).

Requirement: R-DX-6.

### 3. Silent by default, and a thrown error is not also logged

- Without `logger` and `onEvent`, the library writes nothing, in every runtime. It never calls
  `console` on its own. Decision 0009 already says "Nothing is logged when it is absent"; this
  record keeps that and extends it to events.
- The library never logs at `error` a failure it throws. The thrown `ExplorerVerifyError` carries
  the message; the logger may record context at `debug`. This replaces the `Logger.error` doc
  comment "logged before the error is thrown".
- `error` remains for a failure the library recovers from or does not throw. A throwing `onEvent`
  callback is logged at `warn` (section 2).

### 4. One redaction step before every exit

One redaction step runs before a value reaches the logger, `onEvent`, an `ExplorerVerifyError`
(`message`, `hint`, `details`) or a result. It follows the design of the error catalogue
([#43](https://github.com/aelmanaa/explorer-verify/pull/43)):

- Free text is redacted with a deny-list of key-like parameter names, plus every configured key
  value wherever it appears.
- A URL the library itself logs or puts in an event shows no query string, as
  `Route.redactedApiUrl` does.
- Logger messages, logger field values and event field values pass the same step.
- Request bodies are never logged.

Decision 0009 required redacted log strings; this record names one step for all four exits, so a
new path cannot skip it (R-SEC-1, R-AX-9).

### 5. CLI output follows the same contract

The CLI maps its flags to `logger` and `onEvent`, and writes both to stderr. stdout holds only the
result or one JSON envelope (R-AX-5). Verbosity, log format, colour and terminal rules are
R-AX-6, R-AX-14 and R-AX-15.

- Cancel: `cancelled` joins the shared error catalogue
  ([#43](https://github.com/aelmanaa/explorer-verify/pull/43)) with exit code 130, `retryable`
  false and its own entry in the errors page. It carries a handle when the explorer accepted a
  submission before the cancel. The core never throws it; it still rejects with `signal.reason`,
  as decision 0009 states. The CLI creates the error, and the envelope's `error` object is its
  `toJSON()`.
- Usage error: `invalid-input`, exit code 2.
- Unexpected exception inside the CLI: a new catalogue code, `internal-error`, with exit code 6,
  `retryable` false, no handle, a redacted message and the hint "This is a bug in
  explorer-verify. Report it with the command you ran, without your API key."
  `unknown-state` is not used here: it requires a handle and means an explorer answer for a
  submitted job that the library cannot classify. The CLI issue
  ([#7](https://github.com/aelmanaa/explorer-verify/issues/7)) adds `internal-error` to
  `ERROR_CODES` and to the errors page.

## Alternatives considered

| Option                                      | For                         | Against                                                                                                                        |
| ------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Keep `(message)` and put fields in the text | No type change              | Fields must be parsed back out of text that may change                                                                         |
| `(fields, message)`, pino's order           | No adapter for pino         | In a test run, winston 3.19.0 dropped the message text and `console.info` printed the object first (research note, section B1) |
| Events only through the logger, at `info`   | One option                  | A program would depend on log text, which is diagnostic                                                                        |
| Depend on `@opentelemetry/api` in the core  | Native OpenTelemetry events | Counts against the bundle budget (decision 0008) for a feature most callers do not use                                         |
| Progress as an event stream on stdout       | One ordered stream          | stdout stops being one document; `\| jq .result` breaks                                                                        |

Not adopted now: a `schema` command that prints the shipped schemas, timestamps on stderr lines,
and `FORCE_COLOR` or `CLICOLOR_FORCE`. A later issue can add any of them without breaking the
contract.

## Consequences

- `types.ts` changes `Logger` and adds `LogValue`, `LogFields`, `VerifyEvent` and
  `VerifyOptions.onEvent`. The code change follows in its own issue after
  [#12](https://github.com/aelmanaa/explorer-verify/issues/12) merges.
- #17 emits the events and keeps the library silent by default. The CLI writes events and logs to
  stderr and keeps stdout to one envelope.
  [#7](https://github.com/aelmanaa/explorer-verify/issues/7) adds the CLI tests.
- The error catalogue gains `cancelled` (exit code 130), next to the codes of
  [#43](https://github.com/aelmanaa/explorer-verify/pull/43).
- The package ships three JSON Schemas: the CLI input, the envelope and the events (R-AX-16).
- Requirements change in the same pull request: R-AX-5, R-AX-6, R-AX-9 and R-AX-12 are amended;
  R-AX-14, R-AX-15, R-AX-16, R-DX-5 and R-DX-6 are new.
- A caller who wants OpenTelemetry maps `onEvent` to its own logger provider.
