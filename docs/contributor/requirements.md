# Requirements

Audience: contributors and agents planning or reviewing work. Each requirement has a stable ID. Cite
it in issues, pull requests and test names (`R-FLOW-3`). Change a requirement in the same pull
request that changes the behaviour, and record a reversal as a decision.

Status of the whole set: drafted 2026-11-02 from two working implementations
([prior-art.md](prior-art.md)) and the research in [research/](research/README.md). Nothing is
implemented yet.

## Problem

A team that deploys contracts from a dapp, a backend service or a script wants the source verified on
the chain's block explorer right after the deployment. This library takes a contract's compiler
input and verifies it on every explorer listed in [Scope](#scope) from any JavaScript runtime, with
one result format. See [research/2026-11-02-landscape.md](research/2026-11-02-landscape.md).

Explorers already verify repeat deployments of identical bytecode on their own (Etherscan Similar
Match, Blockscout's bytecode database, Sourcify similarity). This library targets what that does not
cover: exact or full matches with constructor arguments, the first deployment of a contract or a new
version on each chain, explorers without automatic matching, and one result format across explorers.

## Users

| User                                      | Runtime                                  | Example                                                                       |
| ----------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| Dapp that deploys contracts for its users | Browser, with or without its own backend | Token launcher, pool factory UI                                               |
| Backend service that deploys contracts    | Node or an edge runtime                  | Deployment pipeline, custody platform                                         |
| Developer or CI job                       | CLI                                      | Verify after `forge create` or a script deploy                                |
| SDK that ships contract artifacts         | Any                                      | A protocol SDK that deploys its own contracts and wants one-call verification |

## Scope

In scope for 1.0: Solidity contracts on EVM chains, verified on Etherscan v2, Etherscan-compatible
standalone explorers, Blockscout, Sourcify and Routescan.

Out of scope for 1.0, with the design kept open for them (R-EXT): Vyper and other compilers,
non-EVM chains, zkSync's zksolc for EraVM contracts, compiling sources inside the library.

On ZKsync Era (324) and ZKsync Sepolia (300), a contract compiled with plain solc verifies with
`kind: "solc"`, as on any other chain. `buildVerifyInput` refuses zksolc build documents with
`unsupported-compiler` and names the field that showed them (R-IN-7)
([ZKsync and zksolc](research/2026-11-05-zksync-zksolc.md)).

## Functional requirements

### Inputs (R-IN)

- **R-IN-1** The caller passes the chain id, the contract address, the fully qualified contract name
  (`path:Name`), the compiler version (full form, `0.8.24+commit.e11b9ed9`) and the compiler's
  Standard JSON input. Optional fields: the constructor arguments (R-IN-3), the creation
  transaction hash, the compiled creation bytecode, `creationBytecode` (R-IN-3), and the library
  link addresses, `libraries` (R-IN-4).
- **R-IN-2** The library never compiles. Where the Standard JSON comes from is the caller's concern
  (decision 0005). A build helper (R-DX-2) makes it easy to produce.
- **R-IN-3** Constructor arguments are optional. When they are absent, the route's backend sends
  arguments (the Etherscan-style backends and Blockscout) and the input holds `creationBytecode`,
  `verify()` derives them from the creation code before the submit. The creation code is the
  creation transaction input, read through the caller's `rpcUrl` when the receipt shows the
  transaction created the contract directly, or the init code after the salt in a call to the
  CREATE2 deployer; else Etherscan's `getcontractcreation` `creationBytecode` when an Etherscan
  key is bound to the route. For a factory deployment the transaction input is the factory's
  code, so only the explorer source applies
  ([live probes, D](research/2026-11-03-m2-live-probes.md#d-similar-match-and-getcontractcreation-for-a-factory-deployment);
  confirmed on Ethereum Sepolia on 2026-11-04). The creation code must start with
  `creationBytecode`, every byte compared except the 20-byte `__$...$__` library placeholders;
  the remainder, a whole number of 32-byte words, is the ABI-encoded arguments. When no
  arguments are derived, `verify()` logs why and submits without them, as Etherscan verified
  such submits in probe A: at `info` when no source is configured, at `warn` when a source gave
  no usable answer or the contract came from a factory. A creation code that does not start
  with `creationBytecode`, or a remainder that is not whole words, throws
  `constructor-args-unavailable` before any submit on a backend that refuses another build
  (the Etherscan-style backends); on Blockscout, which reports partial matches, it is logged and the
  submit goes on
  ([decision 0032](decisions/0032-derived-constructor-arguments-fail-soft-when-unavailable.md)).
  When the caller supplies the arguments, they win: nothing is derived or requested. `rpcUrl`
  follows the `route.apiUrl` rules, and its path segments and query values are redacted
  (R-SEC-1).
- **R-IN-4** Library link addresses are accepted for contracts that use external libraries, as
  `libraries`: addresses keyed by `path:Name`, where the path is a source of the input and not a
  local path. Validation rejects an address that differs from the one `settings.libraries`
  already holds for the same library. `verify()` sends the compiler input unchanged: for a
  contract linked after compiling, adding the addresses to `settings.libraries` changes the
  metadata hash, and Sourcify then gave only a partial match while Etherscan found the address
  itself
  ([live probes, E](research/2026-11-03-m2-live-probes.md#e-a-contract-linked-to-an-external-library)).
  `linkLibraries` merges the addresses into `settings.libraries` for an explorer that needs them
  there ([decision 0025](decisions/0025-library-addresses-not-merged-by-default.md)).
- **R-IN-5** A resolver can produce the input instead of the caller: the first one reads the
  metadata hash in the deployed bytecode (passed, or read with `eth_getCode` from a
  caller-supplied JSON-RPC URL), fetches the metadata and sources from a verified copy on Sourcify
  at the same address on any chain, or from a caller-configured IPFS gateway (R-SEC-2), never from
  a built-in gateway host, and rebuilds the Standard JSON input with the R-IN-7 builder. Metadata
  is used only when its IPFS hash, computed as solc computes it, equals the bytecode's; for a Swarm
  hash, only an exact Sourcify match on the same chain is used. Bytecode without a hash throws
  `no-metadata-hash`; metadata that no source returns throws `metadata-unavailable` with each
  attempt ([decision 0026](decisions/0026-bytecode-metadata-resolver.md)). A second route copies
  the Standard JSON input of a contract already verified on Sourcify, whatever its metadata hash;
  it is not built yet. Resolvers are pluggable (R-EXT-2).
- **R-IN-6** Input is validated before any request: address format, chain id, name present in the
  Standard JSON, version format. Validation errors name the field. The address check is format only:
  `0x` and 40 hex digits, in any case. The EIP-55 checksum is not checked: explorers accept any
  case. Options are validated too: a key the function does not read throws `invalid-input` naming
  the key and the closest known name, never its value, and an optional field set to `undefined`
  counts as absent (decision 0047).
- **R-IN-7** A format-detecting input builder takes one or more parsed JSON documents and
  optional source contents, and returns the `compiler` part of `VerifyInput` and the fully
  qualified contract name, or a typed error that names what is missing. It detects by shape, never
  by file name or tool name, and accepts:
  - build-info from Hardhat 2, Hardhat 3 (including its separate output file) and Foundry, and a
    bare Standard JSON input with the version and name supplied (#20);
  - Solidity metadata (an object, a string, or an artifact's `metadata` or `rawMetadata`) plus the
    sources it does not embed. It rebuilds the Standard JSON input and checks each source's
    keccak-256 against the metadata before returning (#21). A missing source fails with
    `incomplete-input` listing the missing paths, at most 1,000; a source whose hash differs fails with
    `source-mismatch` naming the file and both hashes;
  - an artifact with only ABI and bytecode. That is not enough to verify, and the error says so
    and names the remaining routes (R-IN-5, explorer similar-match).

  The builder also returns the contract's `creationBytecode` (R-IN-3) when the documents hold it,
  a build-info output's `evm.bytecode.object` or an artifact's `bytecode`, and leaves it out when
  they hold different values. It returns only `language`, `sources` and `settings` in the compiler
  input, and only
  `content` and `keccak256` of each source. It rejects a local path (absolute, home, drive, file
  URL, or climbing above the root) in a source path, either side of a remapping, or a key of
  `settings.libraries` or `settings.outputSelection`, so no local path is published. It rejects
  documents whose build ids or full compiler versions differ. It runs in any runtime (R-RUN-1): it
  takes parsed objects, not paths, so it lives in the core.

### Backends (R-BE)

- **R-BE-1** Etherscan API v2: one endpoint for every chain it covers, `chainid` per request, API key
  required.
- **R-BE-2** Etherscan-compatible standalone explorers (their own host, Etherscan request format).
  A lookup or a status request without a key is a GET, as Bitlayer's API requires; with a key it
  is a form POST, so the key stays out of the URL (decision 0039).
- **R-BE-3** Blockscout: per-instance, with no key. The submit and the job status go to the
  instance's Etherscan-compatible `/api`; the lookup goes to its REST
  `/api/v2/smart-contracts/{address}`, which tells a full match from a partial one. The REST
  standard-input submit is not used: it returns no job id and no failure verdict
  ([research](research/2026-11-04-blockscout-client.md)). The backend `blockscout-hosted` sends the
  same requests to the hosted multichain API, `https://api.blockscout.com/<chainId>/api`, with
  `apiKeys["blockscout-hosted"]` in the `authorization` header. No row lists it; a call names it
  (decision 0041, [research](research/2026-11-05-blockscout-hosted-api.md)).
- **R-BE-4** Sourcify API v2 (`/v2/verify/{chainId}/{address}`, job polling, `/v2/contract/...`
  lookup). No key.
- **R-BE-5** Routescan (Etherscan-compatible host per network).
- **R-BE-6** Each backend is a separate module with the same interface (architecture.md), so a new
  backend is one new module plus routing-table rows.

### Routing (R-RT)

- **R-RT-1** A routing table maps a chain id to its backend(s), API URL and explorer URL. It is data
  (JSON), versioned with the package, and holds only what varies per chain; the API URL and the
  explorer URL are derived from it (decision 0024). It has a row for each chain that Sourcify's
  chain list marks as supported or that the Etherscan chainlist lists (decision 0036): Sourcify
  when Sourcify supports the chain, Etherscan v2 when the chainlist lists it. It lists only backends
  with a client in the release. It carries the date its rows were checked. On 2026-11-05 that is 288 chains, each
  with Sourcify, and the 55 chains of the Etherscan chainlist also with Etherscan v2. A chain whose
  Blockscout instance answered a recorded keyless probe also gets a Blockscout entry, or a row with
  Blockscout alone (decision 0038): 111 entries and 11 more rows. A chain whose
  Routescan API answered a recorded keyless probe also gets a Routescan entry, last in its row, or
  a row with Routescan alone (decision 0037): 38 entries and 26 more rows. A chain whose standalone
  Etherscan-compatible API, from Foundry's chain list, answered a recorded keyless probe gets an
  `etherscan-compatible` entry, before Routescan (decision 0039): Bitlayer (200901), one more
  row, 326 rows in all. An API that refuses a keyless request gets an entry only after a run with
  a key. A
  row lists its backends in order of preference; on a chain that needs a paid Etherscan plan,
  Sourcify comes before Etherscan v2 (decision 0027). Blockscout comes after Sourcify and a
  free-tier Etherscan v2, and before a paid-plan Etherscan v2 (decision 0038). A call goes to the first backend in the row
  that works with the caller's keys: a backend that needs a key is skipped when the caller passed
  none for it. When no backend in the row works, the call takes the first and fails with
  `missing-api-key` before any request.
- **R-RT-2** The caller can override the route per call, add chains, or pick a backend by name.
- **R-RT-3** A chain missing from the table falls back to Sourcify when the caller allows it, and
  otherwise fails with an error naming the chain. The option is `allowSourcifyFallback`, false by
  default; the error is `unsupported-chain`, and its hint names the option and the route override.
- **R-RT-4** Optional fan-out: verify on several backends in one call (for example Etherscan and
  Sourcify), with one result per backend. `verifyEach()` is a separate export: its backends run in
  parallel with one time budget and the caller's signal, each backend gets only its own key, and
  one backend's error, a client module that fails to load included, is that backend's outcome,
  never a thrown error that discards the others (decision 0034).

### Flow (R-FLOW)

- **R-FLOW-1** Check first: if the contract is already verified on the target backend, return
  `already-verified` without submitting.
- **R-FLOW-2** Submit, then poll until a terminal state, within a time budget the caller sets.
- **R-FLOW-3** The result is a discriminated union: `verified` or `already-verified` (each with an
  `exact` or `partial` match), or `failed`, each with `backend` (a `BackendName`), and the explorer
  URL on success when the library knows a public page for the contract. A route that points at a
  self-hosted or local server has none. An Etherscan Similar Match, which Etherscan made from
  another contract's verified source rather than one submitted for this address, is `partial` ([research](research/2026-11-04-etherscan-client.md#the-lookup-and-similar-match)).
- **R-FLOW-4** `failed` only when the explorer definitively rejected the submission. An unknown,
  ambiguous or timed-out state throws a typed error. A caller never mistakes it for success.
- **R-FLOW-5** Resumable: the submission returns a handle; `checkStatus(handle)` continues polling
  later, from another process or after a page reload. The handle is plain JSON with a version field
  and no URLs. Its one-line form, `ev1:<backend>:<chainId>:<address>:<jobId>`, is the form to store;
  `checkStatus` also reads the handle object (decision 0050).
- **R-FLOW-6** Cancellation through `AbortSignal`, and retries with backoff on rate limits and
  transient errors.
- **R-FLOW-7** Known explorer behaviour is handled, not reported as failure: Blockscout's partial
  match when the bytecode carries no metadata hash; Blockscout's empty submit response right after a
  deployment (retry the whole submit); Etherscan's "already verified" answers.
- **R-FLOW-8** Proxies: after the implementation verifies, link the proxy to it where the backend
  supports that (Etherscan `verifyproxycontract`). `linkProxy(target, options?)` is a separate
  export, its explorer code loaded only when called (R-RUN-5). It returns `linked`, with the
  implementation the explorer reports and whether its source is verified; `mismatch` when the
  explorer holds another implementation than `expectedImplementation`; or `not-linked` when the
  explorer definitively refuses. An unknown link state, or an implementation that is not exactly
  one non-zero address, throws `proxy-link-unknown-state`; a link still pending at the time budget
  throws `proxy-link-pending`. Etherscan v2, standalone Etherscan-compatible explorers and
  Blockscout get a link request; Sourcify gets one lookup; Routescan throws `invalid-input`
  ([decision 0033](decisions/0033-proxy-link-as-a-separate-call.md)). The server handler forwards
  the proxy-link actions only when its operator turns them on (R-SRV-3).

### Server handler (R-SRV)

- **R-SRV-1** `createVerifyHandler(options)` returns a standard function that takes a `Request` and
  returns a `Response`, and runs in Node, edge runtimes and serverless platforms. Framework adapters stay thin.
- **R-SRV-2** The handler holds the Etherscan key. The browser calls the handler; the handler calls
  Etherscan.
- **R-SRV-3** It forwards only the verify-submit and status actions, the proxy-link actions
  (`verifyproxycontract`, `checkproxyverification`) when the operator sets `allowProxyLink`, and
  a read-only lookup of one address, never
  arbitrary explorer API calls (Etherscan terms forbid a general proxy, see
  [research/2026-11-02-etherscan-terms.md](research/2026-11-02-etherscan-terms.md)). The lookup
  answer is reduced to what the client classifies, so no source is relayed
  ([decision 0021](decisions/0021-server-handler-forwards-a-reduced-lookup.md)).
- **R-SRV-4** Guards: chain allowlist, request size limit, per-client rate limit hook, and an
  optional check that the address was created by an allowed deployer or factory.
- **R-SRV-5** The client side uses the handler by passing its URL as `VerifyOptions.handlerUrl`.
  Each Etherscan request then goes to the handler with no key, and no other code path changes
  between direct and proxied use. An injected `fetch` alone never turns off the missing-key check
  ([decision 0046](decisions/0046-handler-url-and-keyed-backend-names.md)). Each refusal code of
  the handler maps to one error code; a refusal that holds until the handler's options change is
  `handler-refused`, not retryable
  ([decision 0048](decisions/0048-handler-refusals-map-to-error-codes.md)).

### Developer experience (R-DX)

- **R-DX-1** A CLI: `explorer-verify <address> --chain <id> --input <file> --contract <path:Name>`,
  or `--foundry <dir>` or `--hardhat <dir>` with `--contract <path:Name>` in place of `--input`,
  which finds the build files with the R-DX-2 helpers (decision 0051). Its machine contract (JSON
  output, streams, exit codes, dry run, key input, progress, verbosity and JSON input) is R-AX-5
  to R-AX-12 and R-AX-14 to R-AX-16.
- **R-DX-2** Build helpers for Foundry and Hardhat (2 and 3) find the build-info, artifact and
  source files for a contract in a project directory, read them, and pass them to the R-IN-7
  builder. They hold no format logic of their own. They read files, so they are Node-only and stay
  out of the core entry point. Both take the same option names and return the same result shape,
  and the builders share one name family: `buildVerifyInput`, `buildVerifyInputFrom<Source>`.
- **R-DX-3** Typed errors from one catalogue, each with a stable code, a fix hint and a docs URL.
  The CLI and the library share the catalogue (R-AX-10).
- **R-DX-4** TSDoc on every export, with an example that compiles.
- **R-DX-5** `VerifyOptions.logger` takes four methods, `debug`, `info`, `warn` and `error`, each
  `(message: string, fields?: LogFields) => void`. `LogFields` is a flat record whose values are
  `string`, `number`, `boolean` or `null`, and `console` satisfies the type. Without a logger the
  library writes nothing, in every runtime, and never calls `console` on its own. The library never
  logs at `error` a failure it throws. Every message and field value passes the one redaction
  step of decision 0010 first (R-SEC-1). Messages and field names are diagnostics and may change
  in any release.
- **R-DX-6** `VerifyOptions.onEvent` receives typed stage events, each a flat object with a `type`
  and JSON-safe values. The types follow OpenTelemetry's event naming rules (lowercase,
  dot-separated, no dynamic values):

  | `type`             | Fields besides `type`                                       |
  | ------------------ | ----------------------------------------------------------- |
  | `verify.validated` | `chainId`, `address`                                        |
  | `verify.routed`    | `backend`, `apiHost` (host only, no path or query)          |
  | `verify.lookup`    | `backend`, `match`: `exact`, `partial`, `none` or `skipped` |
  | `verify.submitted` | `backend`, `handle` in its one-line string form             |
  | `verify.poll`      | `backend`, `attempt`, `state`                               |
  | `verify.retry`     | `backend`, `attempt`, `reason`, `delayMs`                   |
  | `verify.result`    | `backend`, `status`, and `match` when the status has one    |

  `verify()` emits them in stage order and emits `verify.submitted` as soon as the explorer accepts
  the submission, so an aborted call can still be resumed (R-FLOW-5). `checkStatus` emits
  `verify.routed`, `verify.poll`, `verify.retry` and `verify.result` (decision 0013). A call that
  throws emits no `verify.result`. `verify.poll` `state` is one of `pending`, `queued` or
  `completed`; `verify.retry` `reason` is one of `rate-limited`, `network`, `server-error`,
  `duplicate-submission`, `not-indexed` or `empty-submit`. `verify.retry` names the backend the
  request goes to: a retried request to `rpcUrl` or `ipfsGateway` emits none, and is logged at
  `warn` with a `label` field in place of `backend` (#134). An exception thrown
  by `onEvent` is caught, logged once at `warn` through the logger, and does not change the
  outcome. A promise returned by `onEvent` gets a `.catch` attached and is not awaited. Events pass
  the same redaction step. Within a schema version, releases only add event types and fields.
  `event.schema.json` ships with the package and lists `state` and `reason` as enums.

### Agent readiness (R-AX)

Coding agents call explorer-verify as often as people do: they add it to a dapp, run the CLI in CI
and read the docs to answer a question. These requirements apply to every pull request that adds or
changes a public function, error, CLI command or user page. A pull request in that scope meets
them, or names the requirement it does not meet and the reason (decision 0007). Evidence:
[research/2026-11-02-agent-readiness.md](research/2026-11-02-agent-readiness.md).

Docs:

- **R-AX-1** `llms.txt` at the repository root, per [llmstxt.org](https://llmstxt.org/): an H1, a
  one-paragraph summary, H2 sections, and absolute links to the Markdown source of every user page
  and of the reference.
- **R-AX-2** The npm package ships `docs/user/` as `docs/`, plus an `llms.txt` whose links are
  relative to the packaged docs. An agent working in `node_modules` reads the docs of the installed
  version. The repository-root `llms.txt` (R-AX-1) links GitHub. Each page states the version it
  describes. Every `ts` example in the user docs compiles and runs against the build. The CLI
  reference is generated from the CLI's own help, so it does not drift from the code. The API
  reference is generated from TSDoc into the docs site build only (R-AX-17). It is not written to
  `docs/user/` and does not ship in the package, whose `.d.ts` files carry the TSDoc.
- **R-AX-3** A page "Using explorer-verify from an agent" says which calls are outward and permanent
  (submit) and which are safe (validate, dry run, lookup, status), where keys come from, and the
  Etherscan plan rule (R-SEC-3). Every user page links `llms.txt` near the top.
- **R-AX-4** A skill (`skills/explorer-verify/SKILL.md`) ships in the npm package. CI runs its
  examples against the built package, so a release cannot ship a stale skill.
- **R-AX-17** A docs site serves the user docs of the version on npm `latest` before 1.0, and of
  each major from 1.0, built from release tags, never from `main`. It serves `/llms.txt` and a
  `.md` copy of each page (decision 0015).

CLI:

- **R-AX-5** `--json` on every command. stdout holds exactly one versioned envelope for every exit
  code, errors included, in one of five forms:
  - `{ "schemaVersion": 1, "ok": true, "result": ... }` for `verified` or `already-verified`
  - `{ "schemaVersion": 1, "ok": true, "result": ... }` for a dry run, whose `result.status` is
    `dry-run` (R-AX-8)
  - `{ "schemaVersion": 1, "ok": false, "result": ... }` for a `failed` result (no `error`)
  - `{ "schemaVersion": 1, "ok": ..., "result": { "outcomes": [...] } }` for several backends (R-RT-4),
    whose `ok` is true only when every outcome's `ok` is true
  - `{ "schemaVersion": 1, "ok": false, "error": { "code", "message", "hint", "docsUrl", "retryable", "handle"? } }`

  `ok` is true exactly when the exit code (R-AX-7) is 0, so the two never disagree. For `verify` and
  `status`, `result` is a `VerifyResult`, for `verify --dry-run` a `DryRunResult` with `routedBy`
  (R-AX-8), and for
  `verify` with `--backend` repeated a `VerifyEachResult`, one outcome per backend (R-RT-4);
  every other command documents its result type in the JSON Schema. The error `code` tells an unknown explorer state
  (R-FLOW-4, exit code 6) apart from a network failure (exit code 5). Within a schema version, a
  release may add fields, error codes and backends, and changes nothing else. A reader treats an
  unknown error code by its `retryable` value and the process exit code. A JSON Schema for the
  envelope ships with the package; it accepts any error code or backend of the form
  `^[a-z0-9]+(-[a-z0-9]+)*$` and lists the known ones in its descriptions.

  The CLI reads `--json` before it parses the other arguments, so a usage error still gives an
  envelope with the code `invalid-input` and exit code 2. A `--json` after `--`, or given as the
  value of another flag, does not count as the flag. A cancelled run (exit code 130) gives an
  envelope whose `error` is the `toJSON()` of a `cancelled` error. `cancelled` is in the shared
  catalogue with `retryable` false and its own errors-page entry, and carries a handle when the
  explorer accepted a submission before the cancel; the CLI creates it and the core never throws
  it (decision 0010). An unexpected exception inside the CLI gives an envelope with the code
  `internal-error`: exit code 6, `retryable` false, no handle, a redacted message and the hint
  "This is a bug in explorer-verify. Report it with the command you ran, without your API key."
  The CLI package issue (#98) adds `internal-error` to `ERROR_CODES` and to the errors page. stderr may
  also carry a one-line human summary.

- **R-AX-6** stdout carries only the result, and progress and logs go to stderr. The CLI decides
  colour, spinners and pagers per stream, from that stream's own terminal state:
  - `--color=always` colours both streams; `--color=never` colours neither.
  - Otherwise (`--color=auto`, the default), a non-empty `NO_COLOR` or `TERM=dumb` turns colour
    off on both streams, and each stream is coloured only when it is a terminal.
  - Spinners and line redraws appear only when stderr is a terminal, `CI` is unset or empty,
    `TERM` is not `dumb`, `--log-format` is `text` and the level shows more than errors (not `--quiet`, and not
    `error` or `off` from `EXPLORER_VERIFY_LOG`).
  - A pager runs only when stdout is a terminal and `CI` is unset or empty.

  The CLI never prompts.

- **R-AX-7** Documented exit codes separate the cases an agent acts on differently:

  | Code | Meaning                                                                                                                                                                                                                                                                                                 |
  | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 0    | `verified` or `already-verified`                                                                                                                                                                                                                                                                        |
  | 1    | `failed`: the explorer definitively rejected the submission                                                                                                                                                                                                                                             |
  | 2    | Usage or input error, including a chain the backend does not support; nothing was submitted for verification. `handler-refused`: the caller's server handler refused the request until its options change                                                                                               |
  | 3    | Missing, invalid or under-privileged API key                                                                                                                                                                                                                                                            |
  | 4    | No verdict yet. `not-confirmed`: still pending at the time budget; the output carries the handle. `verification-inconclusive`: the job ended without a verdict; no handle, call `verify()` again (decision 0011). `proxy-link-pending`: a proxy link still pending; no handle, call `linkProxy()` again |
  | 5    | Network or explorer unavailable after retries                                                                                                                                                                                                                                                           |
  | 6    | `unknown-state`: the explorer answered something the library cannot classify; the output carries the handle. `proxy-link-unknown-state`: the same for a proxy link; no handle. `internal-error`: an unexpected exception inside the CLI; no handle. Do not retry automatically; a person checks it      |
  | 130  | Cancelled                                                                                                                                                                                                                                                                                               |

  Every code in the error catalogue maps to one of these exit codes. `explorer-verify status <handle>`
  resumes a pending verification and uses the same codes (R-FLOW-5). A run on several backends
  (R-RT-4) exits 0 only when every backend's outcome is 0; otherwise it exits with the first of 6,
  4, 3, 2, 5, 1 and 130 that any outcome has, so resumable work comes before a fix (decision
  0034). That code names only the first outcome that has it: the caller reads `result.outcomes`
  for every backend.

- **R-AX-8** `--dry-run` validates the input, resolves the route, builds the request and checks
  whether the contract is already verified, then stops before the submit. It needs no API key: when
  the route's backend requires a key and none is set, it skips the already-verified lookup and says
  so in the output. It says where `verify` would submit and why: `DryRunResult.routedBy` is
  `caller`, `table`, `fallback` or `api-url`. A submitting `verify` needs an explicit target:
  `--backend <name>` or `--backend auto`, the routing table's pick (`route.backend` in the request
  of R-AX-16, `"auto"` included). Without one it exits 2 with `invalid-input` on `--backend`
  before any request, with or without a terminal, `CI` or `--json`; the hint lists the backends of
  the chain's row, says what `auto` would pick and why, and suggests `--dry-run`, and never holds a
  key. `--allow-sourcify-fallback` is not a target. `--api-url` needs `--backend` naming a backend,
  not `auto`, in a dry run too. `auto` with another `--backend` exits 2. `--dry-run` and `status`
  need no target (decision 0043).
- **R-AX-9** Keys come from environment variables, `--api-key-file` or `--api-key-stdin`, never from
  a flag value. `--api-key-stdin` reads the key from stdin and trims one trailing newline. It
  cannot be combined with `--input-json -` (exit code 2). When stdin is a terminal,
  `--api-key-stdin` and `--input-json -` exit 2 at once instead of waiting. A key given this way
  fills `VerifyOptions.apiKeys` for the route's backend: `ETHERSCAN_API_KEY` fills
  `apiKeys["etherscan-v2"]` and `ROUTESCAN_API_KEY` fills `apiKeys.routescan`. A standalone
  explorer's key fills `route.apiKey` (decision 0016). A key from `--api-key-file` or
  `--api-key-stdin` needs `--backend` naming `etherscan-v2` or `routescan`, whose `apiKeys` entry
  it fills, `--backend etherscan-compatible`, or `--api-url` with `--backend` naming one of those,
  which makes it `route.apiKey`. Without `--api-url`, a standalone explorer's key goes to the
  host the routing table lists for the chain, and only when that entry has `needsKey`
  (decision 0039). Otherwise the CLI exits 2, because the routing table picks a backend
  partly by the keys it has; `--backend auto` with `--api-key-file` or `--api-key-stdin` exits 2
  for the same reason. Tests assert that a dummy key never appears on stdout, on stderr
  or in JSON (extends R-SEC-1). The JSON-RPC URL of `verify` (`VerifyOptions.rpcUrl`, R-IN-3)
  can hold a provider key, so it comes from `--rpc-url-file` or `--rpc-url-stdin`, and from
  `--rpc-url` only when no path segment, query name or value, user name, password or fragment
  has 8 or more characters. No environment variable and no `--input-json` field holds it. The
  CLI removes those parts from stdout and stderr, and tests assert that dummy ones never appear
  there. A JSON envelope or log line keeps the envelope's property names and the CLI's own words when it
  is scrubbed.
- **R-AX-10** Errors name the cause and the fix, and carry a stable code and a docs URL. The CLI and
  the library share one catalogue (R-DX-3). The docs URL is the code's own page,
  `reference/errors/<code>`, with no fragment: unversioned before 1.0, and per major from 1.0
  (decision 0015). A code that was ever released keeps its page. When a release removes a code, its
  page stays, says "Removed in X.Y.Z" and links the replacement's page. A version is promoted to npm
  `latest` only after its docs URLs resolve. An unknown command or flag suggests the single
  closest match.
- **R-AX-11** `--help` leads with examples, lists the environment variables and exit codes, and links
  the docs and `llms.txt`. `--version --json` prints the version and the routing-table date.
- **R-AX-12** The same input gives the same stdout: stable key order, no timestamps unless
  requested. The rule covers stdout only; stderr progress and logs (R-AX-14) are not covered.
- **R-AX-14** Progress goes to stderr, never to stdout. By default it is human-readable lines.
  With `--log-format json` each stderr line is one JSON object with `schemaVersion`, `level`,
  `message` and `type`: an R-DX-6 event type with that event's fields, or `log` with the logger's
  fields. These four names and `fields` are reserved; an event or logger field with a reserved
  name goes under a nested `fields` object, so a field named `fields` appears as
  `fields.fields`. `schemaVersion` is the same as the envelope's (R-AX-5). A reader
  parses the lines that start with `{`. The `verify.submitted` line, with the handle, prints at
  level `info` or more verbose (R-AX-15).
- **R-AX-15** A log level chooses what reaches stderr. `-q`/`--quiet` sets `error`, the default is
  `info`, and `--verbose` sets `debug`:

  | Mode        | Level   | stderr                                                                                  |
  | ----------- | ------- | --------------------------------------------------------------------------------------- |
  | `--quiet`   | `error` | Errors only                                                                             |
  | Default     | `info`  | Errors, warnings, info logs, `verify.retry`, `verify.submitted` and `verify.result`     |
  | `--verbose` | `debug` | Adds `verify.validated`, `verify.routed`, `verify.lookup`, `verify.poll` and debug logs |

  Event lines take these levels: `verify.submitted` and `verify.result` are `info`,
  `verify.retry` is `warn`, and every other event is `debug`, except `verify.routed` of a `verify`
  run whose backend the routing table chose (`--backend auto`, or `--dry-run` without
  `--backend`), which is `info` and says how the backend was chosen and which were skipped. Levels `error` and `off` suppress
  everything below `error`, the `verify.submitted` line included; `off` also suppresses errors on
  stderr, while the stdout envelope is unchanged. `EXPLORER_VERIFY_LOG=debug|info|warn|error|off`
  sets the level when no flag does; `warn` shows errors, warnings and `verify.retry`, without the
  `verify.submitted` and `verify.result` lines. An empty value counts as unset. Any other value,
  compared exactly, is ignored, with one `warn` line on stderr that names the variable and never
  its value. The variable is checked even when a flag sets the level, and the warning follows the
  level like any `warn` line, so `--verbose` shows it and `--quiet` hides it. `--quiet` with
  `--verbose` exits 2
  (`invalid-input`). The CLI reads the variable; the core never reads the environment. stdout is
  byte-identical at every level. `-v` is not bound.

- **R-AX-16** `verify` and `status` accept `--input-json <file|->`: the whole request as JSON,
  validated against a JSON Schema that ships with the package. Only these flags may accompany it:
  `--json`, `--log-format`, `--quiet`, `--verbose`, `--color`, `--dry-run`, `--api-key-file`,
  `--api-key-stdin` and `--timeout`. Any other request flag with it exits 2 (`invalid-input`).
  A submitting request needs `route.backend` (R-AX-8), and `route.apiUrl` needs `route.backend`.
  Malformed JSON is `invalid-input`, exit code 2. Unknown properties are one `invalid-input`
  issue with their count, never their names or values, as `parseHandle` does (decision 0009). The
  schema has no key field, so a key never travels in the input. The package ships JSON Schemas for the input, the envelope (R-AX-5) and the
  events (R-AX-14, R-DX-6).

Measurement:

- **R-AX-13** Before 0.1.0, a small recorded agent evaluation: a fixed task set (verify from a Foundry
  build, verify from shipped artifacts, resume a pending handle, handle a rejection, refuse to submit
  without a key), run by at least two models. It records success, turns and any unsafe action
  attempted. The dated results go in `docs/contributor/research/`, and the evaluation reruns before
  each minor release.

## Non-functional requirements

### Runtime (R-RUN)

- **R-RUN-1** The core runs unchanged in current browsers, Node 22.18 and later, Deno, Bun and edge
  runtimes. It uses only web-platform globals (`fetch`, `URL`, `AbortSignal`, `TextEncoder`,
  `crypto.subtle`). Enforced by lint (`import/no-nodejs-modules`), a build without Node types and
  the browser smoke test, which runs the default entry and `explorer-verify/core`.
- **R-RUN-2** ESM only, tree-shakeable (`sideEffects: false`), types included.
- **R-RUN-3** Bundle budget for `import { verify } from "explorer-verify"` in a browser build:
  minified and gzipped size at or below the ceiling in `size-budget.json`, checked in CI.
  `size-budget.json` sets a ceiling for each public entry. Each backend client loads with a dynamic
  `import()` only when a call is routed to it, and the routing table only when a call's route needs
  it: a call whose `route.apiUrl` cannot be a URL the table lists does not load it (decisions 0031
  and 0040). The entries are measured without the clients and the table, and each client chunk and
  the `table` chunk has its own ceiling under `chunks`. Every exported name of every package has
  a row in `name-budget.json`, with a ceiling for esbuild with splitting, esbuild as one file and
  Rollup; an exported name with no row fails CI (decision 0042). `explorer-verify/core` takes the clients and the
  table from its caller and reaches no dynamic `import()`, so a bundle that does not split code
  holds only the clients it imports. `verify` from the core with the Sourcify client and no table,
  as one file, stays at or below 78,687 bytes minified and 26,224 gzipped, the measured size plus
  20% on 2026-11-06; CI checks the gzipped bound as `verify (core, Sourcify, one file)` (decision
  0052).
- **R-RUN-4** The core has no runtime dependencies. Third-party code is vendored under
  `src/internal/vendor/` with its licence notice, counted in the budget, and recorded in a decision.
- **R-RUN-5** Optional features (the server handler, input resolvers) are separate entry points or
  tree-shake away, so a caller who imports only `verify` does not bundle them.

### Security (R-SEC)

- **R-SEC-1** API keys never appear in logs, errors, results or thrown messages. Redaction is
  tested. A handle's job id is exempt from the bare-key shape rule, so a valid job id resumes; it
  is redacted only where it equals a configured key or holds a key-like parameter.
- **R-SEC-2** The library calls only hosts from the routing table or the caller's configuration.
  It never follows a redirect.
  A handle never carries a host; the library resolves hosts from the routing table or the caller's
  options when it resumes. A key from `apiKeys` goes only to its backend's routing-table host, and
  only with requests of the route's backend; `route.apiKey` goes only to its route's host
  (decision 0016): the host of `route.apiUrl`, or for `etherscan-compatible` without it, the
  standalone host the chain's row lists with `needsKey` (decision 0039).
- **R-SEC-3** Docs state the Etherscan plan requirement: a public dapp or any business, protocol,
  foundation or DAO use needs an Advanced or higher plan and its own key, and must show "Powered by
  Etherscan.io APIs" when it displays Etherscan data.
- **R-SEC-4** Published with npm provenance from CI through trusted publishing; signed release tags.
- **R-SEC-5** The server handler's docs state, with a link to Etherscan's API terms and the date
  they were read: the operator uses their own key on their own server; the handler is part of the
  operator's application and must not be offered as a relay to other applications; the terms
  forbid exposing a key in client code and operating a proxy that passes API data to third parties;
  whether a verify-only handler counts as such a proxy is the project's reading, not legal advice,
  and operators should confirm with Etherscan; and that the handler forwards only the verify-submit
  and status actions, the proxy-link actions when the operator turns them on, and a reduced read-only
  lookup (R-SRV-3).

### Quality (R-QA)

- **R-QA-1** Unit tests with recorded explorer responses for every backend and every status string
  the prior art met. Coverage at or above 95%.
- **R-QA-2** A live test matrix per backend on public testnets, run by the maintainer, with dated
  results in the docs.
- **R-QA-3** The CLI and the server handler have integration tests.
- **R-QA-4** A scheduled live check runs weekly from CI using recorded testnet contracts: lookups on
  every backend with a client, and one keyless submit on Sourcify of a recorded, already-verified
  contract, expecting `already-verified`. It reads keys only from repository secrets in an
  environment limited to `main`, never runs on forks or pull requests, never prints a key, and
  opens or updates one issue when a check fails. Its dated results update the routing table's date
  (R-RT-1, R-AX-11).

### Extensibility (R-EXT)

- **R-EXT-1** The compiler is a discriminated union (`{ kind: "solc", ... }`). Adding Vyper is a new
  member plus backend mappings, with no change for Solidity callers (decision 0004).
- **R-EXT-2** Input resolvers, backends and the routing table are extension points with documented
  interfaces.

## Open questions

| Question                                                                                                                      | Owner      | Needed by |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------- | --------- |
| Do Blockscout's hosted multichain API terms allow a server handler serving many end users?                                    | Maintainer | M3        |
| Sourcify rate limits and terms for high-volume use                                                                            | Maintainer | M2        |
| What HTTP status and body does Routescan return when rate-limited? Twenty concurrent keyless requests did not reach the limit | Maintainer | M2        |
| How long does a Routescan GUID stay queryable, and how long can its CDN serve a cached poll answer?                           | Maintainer | M2        |

The question whether Etherscan v2 verifies a solc contract on zkSync Era (324) without
`zksolcVersion` closed as "not served (2026-11-05)": Etherscan v2's chain list has neither 324 nor
300, and its API refuses `chainid=324`
([ZKsync and zksolc](research/2026-11-05-zksync-zksolc.md#etherscan-v2)).

The live probes of 2026-11-03 answered two earlier questions
([live probes](research/2026-11-03-m2-live-probes.md)):

- Routescan's keyless tier accepts `verifysourcecode`. A keyless form-encoded submit for one
  contract on Avalanche Fuji (43113) was accepted and verified
  ([B](research/2026-11-03-m2-live-probes.md#b-routescan-keyless-submit-as-a-form-encoded-post)).
  A repeated poll URL was answered from a CDN cache, which still served `Pending in queue` at an
  age of 3044 s; only a unique query parameter reached the API. The GUID answered `Pass - Verified`
  at 05:30:31 UTC and `Verification not found` at 06:13:36 UTC, while the contract stayed verified.
- Etherscan Similar Match covered a factory-deployed contract whose immutables differ, for two
  children created with CREATE in one transaction on Arbitrum Sepolia (421614), compiled with solc
  0.8.24. The second child's `SimilarMatch` named the first one 6.7 s after the first one's submit
  ([D](research/2026-11-03-m2-live-probes.md#d-similar-match-and-getcontractcreation-for-a-factory-deployment)).
