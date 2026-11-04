# 0029: The dry run is dryRun() in the core

Status: Accepted (2026-11-04). Adds an emitter to the event list of
[decision 0010](0010-logger-fields-events-and-silent-default.md) and a result form to the envelope
of [decision 0009](0009-options-handle-and-errors.md).

Research: none (maintainer choice).

The choice came out of the review of [#101](https://github.com/aelmanaa/explorer-verify/issues/101).

## Context

R-AX-8 asks the CLI's `verify --dry-run` to validate the input, resolve the route and look the
contract up, then stop before the submit, with no API key needed. The CLI reaches the core only
through its public exports, which had no way to resolve a route or run a lookup on its own.
`verify()` always submits when the lookup finds no match. An injected `fetch` that refuses the
submit would turn the key check off (decision 0016) and depend on how each client shapes its
requests.

## Decision

- The core exports `dryRun(input, options?)`, marked `@experimental`, in `flow/dry-run.ts`. It
  takes the input and options of `verify()`, runs `validateInput`, `routeOf` and `openCall` of
  `flow/verify.ts`, looks the contract up once and returns. It never submits and never polls.
- It returns a `DryRunResult`:
  `{ status: "dry-run", backend, apiHost, lookup, explorerUrl? }`. `apiHost` is the host of the
  route's API URL, with the port when it is not the scheme's default. `lookup` is `exact`,
  `partial`, `none` or `skipped`. `explorerUrl` is present only for a match the library knows a
  page for.
- When the route's backend needs a key, none is bound to the route's host and no `fetch` is
  injected, it sends no request and returns `lookup: "skipped"`, where `verify()` throws
  `missing-api-key`. `openCall` takes a `checkKey` flag for this; `keyMissing` in
  `http/api-keys.ts` is the test `requireKey` already used.
- It emits `verify.validated`, `verify.routed` and `verify.lookup`, whose `match` is `skipped` when
  no request was sent. It emits no `verify.submitted`, `verify.poll` or `verify.result`. Every
  event already exists in `event.schema.json`.
- `toEnvelope()` and `exitCodeOf()` accept a `DryRunResult`: the envelope is
  `{ schemaVersion: 1, ok: true, result }`, the result copied field by field in a fixed order with
  every string redacted, and the exit code is 0. `envelope.schema.json` lists it as a fourth form.
  The CLI prints that envelope, so the CLI and any other caller cannot disagree on it.

## Alternatives considered

- A `dryRun` option on `verify()`. Rejected: `verify()` would return a type that is not a
  `VerifyResult`, and every caller would have to handle it.
- A dry run in the CLI only, through an injected `fetch` that stops at the submit. Rejected: an
  injected `fetch` turns the missing-key check off, and the CLI would have to know which request of
  each client is the submit.
- Build the dry-run envelope in the CLI. Rejected in review: the CLI and the server handler could
  then disagree on its shape and redaction.

## Consequences

- R-AX-5 lists four envelope forms, and the `verify()` reference documents `dryRun()`.
- The `verify` bundle grows only by the `checkKey` branch; `dryRun` is a separate export, so a page
  that does not import it does not ship it.
- A later backend that needs a key goes through the same `keyMissing` test, so its dry run skips the
  lookup the same way.
