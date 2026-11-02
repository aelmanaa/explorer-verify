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
non-EVM chains, zkSync's zksolc, compiling sources inside the library.

## Functional requirements

### Inputs (R-IN)

- **R-IN-1** The caller passes the chain id, the contract address, the fully qualified contract name
  (`path:Name`), the compiler version (full form, `0.8.24+commit.e11b9ed9`) and the compiler's
  Standard JSON input.
- **R-IN-2** The library never compiles. Where the Standard JSON comes from is the caller's concern
  (decision 0005). A build helper (R-DX-2) makes it easy to produce.
- **R-IN-3** Constructor arguments are optional. When absent, the library derives them from the
  creation code: it fetches the creation transaction input through a JSON-RPC URL or the explorer, and removes the
  compiled creation bytecode from its start; the remainder is the ABI-encoded arguments. When the caller supplies them, they win.
- **R-IN-4** Library link addresses are accepted for contracts that use external libraries.
- **R-IN-5** A resolver can produce the input instead of the caller: the first one reads the
  metadata hash in the deployed bytecode, fetches the metadata and sources from a caller-configured
  IPFS gateway or fetch function (R-SEC-2) or from Sourcify, never from a built-in gateway host, and
  rebuilds the Standard JSON input with the R-IN-7 builder (added by #20). A second route
  copies the Standard JSON input of a contract already verified on Sourcify. Resolvers are
  pluggable (R-EXT-2).
- **R-IN-6** Input is validated before any request: address format, chain id, name present in the
  Standard JSON, version format. Validation errors name the field. The address check is format only:
  `0x` and 40 hex digits, in any case. The EIP-55 checksum is not checked: it needs a Keccak-256
  implementation, which the core does not ship, and explorers accept any case.

### Backends (R-BE)

- **R-BE-1** Etherscan API v2: one endpoint for every chain it covers, `chainid` per request, API key
  required.
- **R-BE-2** Etherscan-compatible standalone explorers (their own host, Etherscan request format).
- **R-BE-3** Blockscout: per-instance `/api` (Etherscan-compatible) and the v2 REST standard-input
  endpoint; the hosted multichain API with a key.
- **R-BE-4** Sourcify API v2 (`/v2/verify/{chainId}/{address}`, job polling, `/v2/contract/...`
  lookup). No key.
- **R-BE-5** Routescan (Etherscan-compatible host per network).
- **R-BE-6** Each backend is a separate module with the same interface (architecture.md), so a new
  backend is one new module plus routing-table rows.

### Routing (R-RT)

- **R-RT-1** A routing table maps a chain id to its backend(s), API URL and explorer URL. It is data
  (JSON), versioned with the package, and covers at least the 60 chains the prior art routes to a
  known backend (67 rows, 7 with no backend).
- **R-RT-2** The caller can override the route per call, add chains, or pick a backend by name.
- **R-RT-3** A chain missing from the table falls back to Sourcify when the caller allows it, and
  otherwise fails with an error naming the chain.
- **R-RT-4** Optional fan-out: verify on several backends in one call (for example Etherscan and
  Sourcify), with one result per backend.

### Flow (R-FLOW)

- **R-FLOW-1** Check first: if the contract is already verified on the target backend, return
  `already-verified` without submitting.
- **R-FLOW-2** Submit, then poll until a terminal state, within a time budget the caller sets.
- **R-FLOW-3** The result is a discriminated union: `verified` or `already-verified` (each with an
  `exact` or `partial` match), or `failed`, each with `backend` (a `BackendName`), and the explorer
  URL on success when the library knows a public page for the contract. A route that points at a
  self-hosted or local server has none.
- **R-FLOW-4** `failed` only when the explorer definitively rejected the submission. An unknown,
  ambiguous or timed-out state throws a typed error. A caller never mistakes it for success.
- **R-FLOW-5** Resumable: the submission returns a handle; `checkStatus(handle)` continues polling
  later, from another process or after a page reload. The handle is plain JSON with a version field
  and no URLs.
- **R-FLOW-6** Cancellation through `AbortSignal`, and retries with backoff on rate limits and
  transient errors.
- **R-FLOW-7** Known explorer behaviour is handled, not reported as failure: Blockscout's partial
  match when the bytecode carries no metadata hash; Blockscout's empty submit response right after a
  deployment (retry the whole submit); Etherscan's "already verified" answers.
- **R-FLOW-8** Proxies: after the implementation verifies, link the proxy to it where the backend
  supports that (Etherscan `verifyproxycontract`).

### Server handler (R-SRV)

- **R-SRV-1** `createVerifyHandler(options)` returns a standard function that takes a `Request` and
  returns a `Response`, and runs in Node, edge runtimes and serverless platforms. Framework adapters stay thin.
- **R-SRV-2** The handler holds the Etherscan key. The browser calls the handler; the handler calls
  Etherscan.
- **R-SRV-3** It forwards only the verify-submit and status actions, never arbitrary explorer API
  calls (Etherscan terms forbid a general proxy, see
  [research/2026-11-02-etherscan-terms.md](research/2026-11-02-etherscan-terms.md)).
- **R-SRV-4** Guards: chain allowlist, request size limit, per-client rate limit hook, and an
  optional check that the address was created by an allowed deployer or factory.
- **R-SRV-5** The client side uses the handler by injecting a `fetch` that targets it. No other
  code path changes between direct and proxied use.

### Developer experience (R-DX)

- **R-DX-1** A CLI: `explorer-verify <address> --chain <id> --input <file> --contract <path:Name>`.
  Its machine contract (JSON output, streams, exit codes, dry run, key input) is R-AX-5 to R-AX-12.
- **R-DX-2** Build helpers that emit the Standard JSON input and full compiler version from Foundry
  (`out/` build-info) and Hardhat 3 (artifacts build-info).
- **R-DX-3** Typed errors from one catalogue, each with a stable code, a fix hint and a docs URL.
  The CLI and the library share the catalogue (R-AX-10).
- **R-DX-4** TSDoc on every export, with an example that compiles.

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
  describes. The API reference is generated from
  TSDoc and the CLI reference from the CLI's own help, so neither drifts from the code.
- **R-AX-3** A page "Using explorer-verify from an agent" says which calls are outward and permanent
  (submit) and which are safe (validate, dry run, lookup, status), where keys come from, and the
  Etherscan plan rule (R-SEC-3). Every user page links `llms.txt` near the top.
- **R-AX-4** A skill (`skills/explorer-verify/SKILL.md`) ships in the npm package. CI runs its
  examples against the built package, so a release cannot ship a stale skill.

CLI:

- **R-AX-5** `--json` on every command. The output is one versioned envelope, in one of three forms:
  - `{ "schemaVersion": 1, "ok": true, "result": ... }`
  - `{ "schemaVersion": 1, "ok": false, "result": ... }` for a `failed` result (no `error`)
  - `{ "schemaVersion": 1, "ok": false, "error": { "code", "message", "hint", "docsUrl", "retryable", "handle"? } }`

  `ok` is true exactly when the exit code (R-AX-7) is 0, so the two never disagree. For `verify` and
  `status`, `result` is a `VerifyResult`; every other command documents its result type in the JSON
  Schema. The error `code` tells an unknown explorer state
  (R-FLOW-4, exit code 6) apart from a network failure (exit code 5). Within a schema version, changes
  only add fields. A JSON Schema for the envelope ships with the package.

- **R-AX-6** stdout carries only the result, and progress and logs go to stderr. When stdout is not a
  terminal, the CLI prints no colour, spinner or pager; it honours `NO_COLOR` always. The CLI never
  prompts.
- **R-AX-7** Documented exit codes separate the cases an agent acts on differently:

  | Code | Meaning                                                                                                                                                   |
  | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 0    | `verified` or `already-verified`                                                                                                                          |
  | 1    | `failed`: the explorer definitively rejected the submission                                                                                               |
  | 2    | Usage or input error (bad flag, invalid input); nothing was sent                                                                                          |
  | 3    | Missing, invalid or under-privileged API key                                                                                                              |
  | 4    | Still pending at the time budget; the output carries the handle                                                                                           |
  | 5    | Network or explorer unavailable after retries                                                                                                             |
  | 6    | Unknown state: the explorer answered something the library cannot classify; the output carries the handle. Do not retry automatically; a person checks it |
  | 130  | Cancelled                                                                                                                                                 |

  Every code in the error catalogue maps to one of these exit codes. `explorer-verify status <handle>`
  resumes a pending verification and uses the same codes (R-FLOW-5).

- **R-AX-8** `--dry-run` validates the input, resolves the route, builds the request and checks
  whether the contract is already verified, then stops before the submit. It needs no API key: when
  the route's backend requires a key and none is set, it skips the already-verified lookup and says
  so in the output.
- **R-AX-9** Keys come from environment variables or `--api-key-file`, never from a flag value. Tests
  assert that a dummy key never appears on stdout, on stderr or in JSON (extends R-SEC-1).
- **R-AX-10** Errors name the cause and the fix, and carry a stable code and a docs URL. The CLI and
  the library share one catalogue (R-DX-3). An unknown command or flag suggests the single closest
  match.
- **R-AX-11** `--help` leads with examples, lists the environment variables and exit codes, and links
  the docs and `llms.txt`. `--version --json` prints the version and the routing-table date.
- **R-AX-12** The same input gives the same output: stable key order, no timestamps unless requested.

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
  `crypto.subtle`). Enforced by lint (`import/no-nodejs-modules`) and a build without Node types.
- **R-RUN-2** ESM only, tree-shakeable (`sideEffects: false`), types included.
- **R-RUN-3** Bundle budget for `import { verify } from "explorer-verify"` in a browser build:
  minified and gzipped size at or below the ceiling in `size-budget.json`, checked in CI. The
  routing table loads as data; its size is reported separately and has no limit until M2 sets one.
- **R-RUN-4** The core has no runtime dependencies. Third-party code is vendored under
  `src/internal/vendor/` with its licence notice, counted in the budget, and recorded in a decision.
- **R-RUN-5** Optional features (the server handler, input resolvers) are separate entry points or
  tree-shake away, so a caller who imports only `verify` does not bundle them.

### Security (R-SEC)

- **R-SEC-1** API keys never appear in logs, errors, results or thrown messages. Redaction is
  tested.
- **R-SEC-2** The library calls only hosts from the routing table or the caller's configuration.
  A handle never carries a host; the library resolves hosts from the routing table or the caller's
  options when it resumes.
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
  and status actions (R-SRV-3).

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

| Question                                                                                         | Owner      | Needed by |
| ------------------------------------------------------------------------------------------------ | ---------- | --------- |
| Do Blockscout's hosted multichain API terms allow a server handler serving many end users?       | Maintainer | M3        |
| Sourcify rate limits and terms for high-volume use                                               | Maintainer | M2        |
| Does Etherscan Similar Match cover factory-deployed contracts whose immutables differ? Test live | Maintainer | M2        |
| Routescan API host per network, key policy and CORS (not researched yet)                         | Maintainer | M2        |
