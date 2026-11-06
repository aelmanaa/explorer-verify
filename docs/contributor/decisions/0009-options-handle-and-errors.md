# 0009: Verify options, the resumable handle and the error shape

Status: Accepted (2026-11-02). The brand-check point of section 3 is superseded by
[decision 0044](0044-errors-narrow-by-code-and-carry-a-brand.md).

Amended by [decision 0046](0046-handler-url-and-keyed-backend-names.md): `apiKeys` takes only the
backends of `KeyedBackendName`, as the type `ApiKeys`.

## Context

[architecture.md](../architecture.md) proposed `verify(input, options)` and
`checkStatus(handle, options)` but left three shapes open: the options object, the handle that lets
a caller resume polling, and the error type. Every M1 module from the error catalogue to
`checkStatus` depends on them, and all three are public API. Changing them after 0.1.0 breaks
callers.

Implementation B of the prior art ([prior-art.md](../prior-art.md)) takes
`{ chainId, apiKey, route, fetch, abort, timeoutMs, logger }`. `chainId` already sits in
`VerifyInput`.

A handle often comes from untrusted storage: a URL parameter, local storage or a request body. The
library must not let that data choose where it sends requests, because on keyed backends the API key
goes with them (R-SEC-2).

Research: [agent readiness](../research/2026-11-02-agent-readiness.md) for the JSON error
object, exit codes and fix hints (R-AX-5, R-AX-7, R-AX-10);
[explorer APIs](../research/2026-11-02-explorer-apis.md) for the job id formats (Sourcify
`verificationId`, Etherscan `guid`);
[Routescan](../research/2026-11-03-routescan-zksync.md#verification-guid) for the Routescan GUID.

## Decision

### 1. `VerifyOptions` declares only what M1 implements

```ts
interface VerifyOptions {
  fetch?: typeof fetch; // default globalThis.fetch (R-SRV-5)
  signal?: AbortSignal; // the web-platform name, not "abort"
  timeoutMs?: number; // budget for the whole call, polling included; default 120000
  pollIntervalMs?: number; // default 3000
  logger?: Logger; // { debug, info, warn, error }; receives redacted strings only
  route?: RouteOverride; // { backend?, apiUrl? }, from M1 item 6 (#15)
}
```

Every field is optional. Later fields are optional additions, so adding them does not break a
caller. Two are planned for M2 and not declared now:

- `apiKeys?: Partial<Record<BackendName, string>>`. The prior art takes one `apiKey` string. Fan-out
  (R-RT-4) calls Etherscan and Blockscout's hosted API in one call, and each needs its own key, so
  M2 adds keys keyed by backend name. This is the direction for M2, not implemented here.
- `rpcUrl?: string`, for deriving constructor arguments from the creation code (R-IN-3).

`RouteOverride` is only declared here; nothing reads it yet. The routing change
([#15](https://github.com/aelmanaa/explorer-verify/issues/15)) validates `apiUrl`: `https:`, or
`http:` on a loopback host, no user name or password in the URL, and the query string redacted in
logs.

`timeoutMs` covers the whole call. When it runs out before the explorer accepts the submission,
there is no job id yet, so the call throws a timeout error without a handle. #12 adds its code,
which the CLI maps to exit code 5. `not-confirmed` exists only once there is a job id.

On abort, the call rejects with `signal.reason` unchanged, as `fetch` does, and carries no handle.
To keep R-FLOW-5, `verify()` ([#17](https://github.com/aelmanaa/explorer-verify/issues/17)) logs
the handle through `logger.info` as soon as the explorer accepts the submission. The CLI owns its
controller and maps any rejection seen while its own signal is aborted to exit code 130 (R-AX-7).

### 2. `Handle` is plain JSON with a version and no URL

```ts
interface Handle {
  version: 1;
  backend: BackendName;
  chainId: number;
  address: Hex;
  jobId: string; // Sourcify verificationId, Etherscan guid
}
```

- The handle carries no URL and no host. `checkStatus` resolves the API URL again from `chainId`,
  `backend` and the caller's `route` option. This extends R-SEC-2: a handle never chooses a host.
- `parseHandle(value: unknown): Handle` reads untrusted input field by field and throws the
  catalogue's `invalid-input` error. It uses no casts and no type predicates.
  - It rejects any field it does not know, an `apiUrl` included. All unknown fields become one
    issue, `{ field: "handle", message: "has N fields that are not handle fields" }`, with a count
    and no names: the input chose those names, and one could hold a key. So `issues` holds at most
    six entries, one per known field plus this one.
  - Messages name known fields only and never repeat a value.
  - A value whose fields cannot be read, such as a Proxy whose traps throw, gives `invalid-input`,
    not the raw error.
- `jobId` matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`. Sourcify UUIDs and Etherscan and Routescan
  GUIDs fit. It has no `:`, `.`, `/`, `%`, `?`, `#` or `\`: a job id such as `http:evil.example`
  would turn into a host under `new URL(jobId, base)`, and `..` would resolve to the parent path.
- `version` lets a later release change the shape and still read version 1 handles.
- The one-line string form, `ev1:<backend>:<chainId>:<address>:<jobId>`, belongs to M1 item 9
  ([#18](https://github.com/aelmanaa/explorer-verify/issues/18)). Because a job id has no `:`, the
  string form splits on `:` into exactly five parts. This change ships only the formatter, because
  `toJSON()` needs it. Item 9 adds parsing of the string form.

### 3. One error class with a details union (option B)

```ts
class ExplorerVerifyError extends Error {
  get name(): "ExplorerVerifyError"; // a getter, so not an own field
  readonly code: ErrorCode; // stable string from the ERROR_CODES const list
  readonly hint: string; // one sentence: what to do next (R-DX-3)
  readonly retryable: boolean; // for not-confirmed: retry with checkStatus, not verify
  readonly details: ErrorDetails; // union keyed by code
  readonly docsUrl: string; // the code's entry in docs/user/reference/errors.md (R-AX-10)
  toJSON(): ErrorJson;
}

type ErrorDetails =
  | { code: "invalid-input"; issues: { field: string; message: string }[] }
  | { code: "not-confirmed"; handle: Handle };
```

- `if (error.details.code === "not-confirmed") error.details.handle` narrows without a cast.
- `cause` is the standard ES2022 option. No `Error.captureStackTrace`: it is a non-standard engine
  extension, and the core targets every runtime (R-RUN-1).
- `toJSON()` returns `{ code, message, hint, docsUrl, retryable, handle? }`, with the handle in its
  string form. This matches the `error` object of the CLI's JSON envelope in R-AX-5 field for field.
  R-AX-5 gains `retryable` in the same change, so an agent can decide whether to retry without
  mapping codes itself. `toJSON()` never includes `cause`, the stack or `details`, so
  `JSON.stringify(error)` is safe to print. ([Decision 0049](0049-error-details-in-json-and-cli-hints.md)
  adds the redacted `details`.)
- `retryable` for `not-confirmed` means trying `checkStatus(details.handle)` again. A new
  `verify()` would submit the contract again.
- Abort is not a catalogue error. The call rejects with `signal.reason` unchanged (see decision 1).
- (Superseded by [decision 0044](0044-errors-narrow-by-code-and-carry-a-brand.md), which adds
  `ExplorerVerifyError.is` with a `Symbol.for` brand.) No `isExplorerVerifyError` brand check. It
  needs a type predicate, which the type-escape check flags, and callers narrow with `instanceof`. Two copies of the package in one bundle break
  `instanceof`; a caller in that case can check `error.name === "ExplorerVerifyError"`. If that case
  turns out common, a later decision adds the brand check with an allowlist entry.
- This change adds the class and two codes, `invalid-input` and `not-confirmed`, which `parseHandle`
  and the tests need. M1 item 3 ([#12](https://github.com/aelmanaa/explorer-verify/issues/12)) adds
  the remaining codes, the exit-code mapping and key redaction of `message`, `hint` and `details`.

## Alternatives considered

| Option     | Shape                                                                                                                  | For                                                                                     | Against                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A          | One class per code (the earlier architecture.md)                                                                       | `instanceof` narrows to the code                                                        | Many classes. `instanceof` fails across two copies of the package in one bundle |
| B (chosen) | One class `ExplorerVerifyError` with `code` and `details: ErrorDetails`, where `ErrorDetails` is a union keyed by code | One class. `details.code` narrows `details` without a cast, and survives JSON transport | Callers check `details.code`, not the class                                     |
| C          | A base class plus a few subclasses that carry extra fields                                                             | Familiar                                                                                | Two ways to narrow                                                              |

For the options object, one `apiKey` string as in the prior art was considered. It cannot express
fan-out to two keyed backends in one call, so M2 uses `apiKeys` keyed by backend name.

For the handle, carrying the API URL was considered, so `checkStatus` would not need routing. It
lets whoever wrote the handle choose the host, and on keyed backends the key goes to that host.

## Consequences

- `types.ts` exports `VerifyOptions`, `Logger`, `RouteOverride` and `Handle`. The entry point also
  exports `ExplorerVerifyError`, `ERROR_CODES` and `parseHandle`.
- Every module throws `ExplorerVerifyError`. A new failure adds a code to `ERROR_CODES`, a member to
  `ErrorDetails`, a hint and a heading in the error reference.
- `checkStatus` needs the routing table or a `route` option to resume a handle. A handle alone never
  decides where a request goes.
- The CLI prints `toJSON()` as the `error` object of its envelope without adding fields.
- A caller with two copies of the package cannot rely on `instanceof`. The name check above covers
  it.
