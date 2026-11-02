# Architecture

Audience: contributors and agents implementing the library. This is the target design. Sections
marked "proposed" are not decided yet; the decision that settles one updates this page.

Terminology: a _backend_ is one explorer verification API (Etherscan v2, Sourcify and the others).
Its identifier type is `BackendName`.

## Packages

Decided in [decision 0008](decisions/0008-package-split-and-bundle-budget.md): an unscoped core that
also carries the server handler, and scoped add-ons for Node-only code.

| Package                    | Entry points               | Contents                                                                                                        | Runtime                      |
| -------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `explorer-verify`          | `explorer-verify`          | Types, input validation, routing table, backend clients, flow engine, input resolvers                           | Any (browser, Node, edge)    |
| `explorer-verify`          | `explorer-verify/server`   | `createVerifyHandler`: the self-hosted handler that holds the Etherscan key. Uses only `Request` and `Response` | Node, edge runtimes and serverless platforms |
| `@explorer-verify/cli`     | The `explorer-verify` bin  | The command-line interface                                                                                      | Node                         |
| `@explorer-verify/foundry` | `@explorer-verify/foundry` | Build helper that reads Foundry build-info and emits `VerifyInput` parts                                        | Node                         |
| `@explorer-verify/hardhat` | `@explorer-verify/hardhat` | Build helper that reads Hardhat 3 build-info and emits `VerifyInput` parts                                      | Node                         |

The core has no runtime dependencies. Third-party code is vendored under `src/internal/vendor/` with
its licence notice (R-RUN-4). The `verify` entry has a size ceiling checked in CI (R-RUN-3), and
optional features stay out of it (R-RUN-5). Only `explorer-verify` exists today. The `/server`
subpath arrives in M3, the add-ons in M4.

## Core modules

Planned layout of `packages/explorer-verify/src/`:

| Module                                     | Responsibility                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `types.ts`                                 | Public types: `VerifyInput`, `VerifyResult`, `Hex`, compiler inputs (exists)  |
| `backend-names.ts`                         | `BACKEND_NAMES`, `BackendName` (exists)                                       |
| `errors.ts`                                | Error catalogue: one class per code, a fix hint, key redaction                |
| `input/validate.ts`                        | R-IN-6 checks                                                                 |
| `input/constructor-args.ts`                | Derives constructor arguments from the creation code (R-IN-3)                 |
| `input/resolvers/*.ts`                     | Input resolvers, starting with bytecode metadata to Sourcify or IPFS (R-IN-5) |
| `routing/table.json`, `routing/resolve.ts` | Chain id to backend, API URL and explorer URL (R-RT)                          |
| `backends/<name>.ts`                       | One client per backend, all with the `Backend` interface below                |
| `flow/verify.ts`                           | `verify()`: validate, route, check, submit, poll, map the result (R-FLOW)     |
| `flow/status.ts`                           | `checkStatus(handle)` for resumed polling (R-FLOW-5)                          |
| `http/fetch.ts`                            | Injected `fetch`, retries with backoff, abort, timeout, key redaction in logs |
| `server/handler.ts`                        | `createVerifyHandler`, exported as `explorer-verify/server` (R-SRV)           |
| `internal/vendor/`                         | Vendored third-party code with its licence notice (R-RUN-4)                   |

## Backend interface

Every backend client implements the same shape, so the flow engine never branches on the backend:

```ts
interface Backend {
  readonly name: BackendName;
  /** Returns the match when the contract is already verified, or undefined. */
  lookup(target: Target, ctx: Context): Promise<"exact" | "partial" | undefined>;
  /** Submits the verification and returns an opaque handle for polling. */
  submit(input: ResolvedInput, ctx: Context): Promise<Handle>;
  /** Polls once; returns "pending" or a terminal outcome. */
  poll(handle: Handle, ctx: Context): Promise<PollOutcome>;
  /** The human-facing page for the contract. */
  explorerUrl(target: Target): string;
}
```

`Context` carries `fetch`, `AbortSignal`, the API key (when the backend needs one), a logger and
the route. A `Handle` is serialisable (backend name, chain id, address, explorer job id) so
`checkStatus` can resume it in another process.

## Public entry points (proposed)

`verify(input: VerifyInput, options?: VerifyOptions): Promise<VerifyResult>` and
`checkStatus(handle: Handle, options?: VerifyOptions): Promise<VerifyResult>`. `VerifyOptions`
carries `fetch`, `signal`, `timeoutMs` (poll budget), `logger`, `apiKey`, `rpcUrl` and `route`,
following implementation B's option shape ([prior-art.md](prior-art.md)). A timeout or unknown state
throws a typed error whose `handle` property `checkStatus` accepts. Settle the exact shape in the
first M1 issue and update `types.ts`.

## Verification flow

The flow engine's path from input to one of three results or a thrown error:

```mermaid
flowchart TD
  A[VerifyInput] --> B[validate]
  B --> C{constructor args given?}
  C -- no --> D[derive from creation code]
  C -- yes --> E[route: chain id to backend]
  D --> E
  E --> F[backend.lookup]
  F -- verified --> G[already-verified]
  F -- not verified --> H[backend.submit]
  H --> I[backend.poll until terminal or budget spent]
  I -- pass --> J[verified: exact or partial]
  I -- definitive rejection --> K[failed: reason]
  I -- unknown or timeout --> L[throw typed error with the handle]
  style A fill:#0847F7,color:#fff
```

## Browser and server use

Keyless backends are called from the browser; Etherscan goes through the dapp's own handler, which
adds the key:

```mermaid
sequenceDiagram
  participant Dapp as Dapp (browser)
  participant Handler as Dapp backend (createVerifyHandler)
  participant ES as Etherscan v2
  participant SF as Sourcify / Blockscout instance
  Dapp->>SF: verify() directly, no key
  Dapp->>Handler: verify() with fetch pointed at the handler
  Handler->>ES: verifysourcecode / checkverifystatus with the operator's key
  ES-->>Handler: guid / status
  Handler-->>Dapp: same response shape
```

The client code is identical in both paths. Only the injected `fetch` differs (R-SRV-5). The handler
accepts the same request the backend client would send, checks it against its guards (R-SRV-4),
adds the key and forwards it.

## Extension points

| Extension                | How                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| New backend              | New `backends/<name>.ts` implementing `Backend`, a name in `BACKEND_NAMES`, routing rows              |
| New chain                | A row in `routing/table.json`, or a per-call route override                                           |
| New compiler or language | A new member of the `compiler` union, and its mapping in each backend that accepts it (decision 0004) |
| New input source         | A resolver that returns the `compiler` part of `VerifyInput`                                          |
