# 0034: verifyEach() verifies on several backends in one call

Status: Accepted (2026-11-04). Adds a result form to the envelope of
[decision 0009](0009-options-handle-and-errors.md) and an exit code rule to R-AX-7.

Research: none (maintainer choice).

The choices came out of [#95](https://github.com/aelmanaa/explorer-verify/issues/95), which left
three questions open: a new function or an option on `verify()`, the exit code of several
outcomes, and whether Sourcify runs first.

## Context

R-RT-4 asks for one call that verifies on several backends, such as Etherscan and Sourcify, and
returns one result per backend. `verify()` returns one `VerifyResult` or throws one error. A
second backend's outcome does not fit either shape, and one backend's error must not hide
another's success. The CLI's `--backend` was refused when repeated, waiting for this call.

## Decision

- The core exports `verifyEach(input, options)`, marked `@experimental`, in `flow/verify-each.ts`.
  `verify()` keeps its return type. `size-budget.json` measures `verifyEach` as an entry of its
  own by the rule of decision 0014: 15,263 bytes on 2026-11-04, so a ceiling of 18,316. `verify`
  does not bundle it (R-RUN-5). The steps `verify()` and `verifyEach()` share moved into one
  function, which adds 16 bytes to `verify`, 0.1%. The issue asked for `verify` to stay the same
  size; copying the steps instead would have kept it so and doubled them in the index.
- `options` is `VerifyOptions` without `route`, plus `backends`: 1 to 16 entries, or `"all"`. An
  entry is a backend name or a route override that names its backend; other fields are ignored,
  as `resolveRoute` ignores them in `route`. A top-level `route` throws `invalid-input`.
- `"all"` is every backend the chain's routing-table row lists that this version has a client
  for, less a backend that needs a key when `apiKeys` has none for it, as the routing table
  chooses for `verify()` (R-RT-1). An injected `fetch` does not change this; a caller who reaches
  a keyed backend through a server that adds the key names it in the array.
- It validates the input and options and resolves every entry's route before any request. An
  entry's `invalid-input` is thrown, with fields and hint named after the entry, such as
  `backends[1].apiUrl`. Two entries that resolve to the same backend and normalised API base
  throw `invalid-input`; the same backend on two hosts is allowed, and the position in `backends`
  identifies an entry. Every key, from `apiKeys` or any entry, is checked against the address and
  every backend's handle prefix, and a match throws `invalid-input` (R-SEC-1). An entry's
  `unsupported-chain` becomes that backend's outcome, so the other backends still run. `"all"` on
  a chain without a row throws `unsupported-chain`, as `verify()` does, unless
  `allowSourcifyFallback` is set.
- The backends run in parallel, each through the steps of `verify()` (`verifyOnRoute` in
  `flow/verify.ts`), with one budget started once and the caller's signal. Each call's keys come
  through `keyFor` (decision 0016), so each backend gets only its own key. Every entry's
  `route.apiKey` is a secret of every call, so no backend's output shows another's key.
- It returns `{ outcomes }` in the order of `backends`: `{ backend, ok: true, result }`,
  `{ backend, ok: false, result }` for `failed`, or `{ backend, ok: false, error }` with the
  `ExplorerVerifyError` itself, so `details` and `instanceof` work. A `not-confirmed` outcome
  keeps its handle, which `checkStatus()` resumes with that entry's route.
- A client module that fails to load for one backend, such as a chunk the page cannot fetch,
  becomes that backend's `network` outcome with the load's error as its `cause` (decision 0031).
  `network` fits: the code could not be fetched, and a later call may succeed. A load that runs
  past the budget stays `timeout`.
- It throws only for input or options that fail validation, for an abort (`signal.reason`), and
  for an error that is not an `ExplorerVerifyError` outside a client load, which only a bug can
  cause. It emits `verify.validated` once, then each backend's events.
- `toEnvelope()` and `exitCodeOf()` take the result. The envelope is
  `{ schemaVersion: 1, ok, result: { outcomes } }`, each outcome copied and redacted as a result
  or an error is, an error as its `toJSON()`, and `schema/envelope.schema.json` describes it.
- The exit code is 0 only when every outcome's code is 0. Otherwise it is the first of 6, 4, 3, 2,
  5, 1 and 130 that any outcome has: a state a person must check, then a job to resume, then a key
  or an input to fix, then what a retry may settle, then a rejection. The code names only the
  first outcome that has it, so the caller reads `result.outcomes` for every backend.
- The CLI's `verify` takes `--backend` more than once and then runs `verifyEach()`. Each backend
  uses its routing-table URL and its key variable, so `--api-url`, the key flags and `--dry-run`
  exit 2 with a repeated `--backend`, and the run reaches only backends with a routing-table URL
  for the chain. `status` keeps one `--backend`.
- A cancelled CLI run on several backends keeps every job: the `cancelled` error carries
  `handles`, one `{ backend, handle }` per backend that submitted and had not ended, in
  `--backend` order. `handle` stays only when exactly one backend submitted. The envelope schema
  adds `handles` to the error object, which schema version 1 allows.

## Alternatives considered

- A `backends` option on `verify()` that changes its return type. Rejected: every caller of
  `verify()` would narrow a union it never asked for, and `verify` would bundle the fan-out code.
- Run Sourcify first, so the other explorers' lookups find the source Sourcify forwards to them.
  Not now: the backends run in parallel. An ordering option can follow if live runs show a gain.
- Exit with the code of the first outcome in `backends` order. Rejected: the code would depend on
  the order the caller wrote, and a `failed` first entry would hide an `unknown-state` that needs a
  person.
- Throw for a backend the chain's row does not list, as `verify()` does. Rejected: the other
  backends would not run, which R-RT-4 forbids. The same holds for a client that fails to load.
- Put not-confirmed (4) after the fixes (3, 2) and the transient failures (5). Rejected after
  review: a submitted job is work a caller can still finish with `checkStatus()`, and an exit
  code that hides it risks a second submit.
- Reject an unknown field in a `backends` entry. Not done: `route` ignores unknown fields, and an
  entry is a route override, so both follow the same rule.

## Consequences

- R-RT-4, R-AX-5 and R-AX-7 describe the call, the envelope form and the exit code rule.
- A caller who resumes a `not-confirmed` outcome passes that entry's route to `checkStatus()`.
- Falling back to another backend after a failure stays out of scope.
