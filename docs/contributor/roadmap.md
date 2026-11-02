# Roadmap

Audience: the maintainer and agents choosing the next piece of work. Each milestone becomes a GitHub
milestone; each bullet becomes an issue labelled as in [CONTRIBUTING.md](../../CONTRIBUTING.md).
Requirement IDs refer to [requirements.md](requirements.md). [adoption.md](adoption.md) lists the kinds
of users the library serves and the milestone where each becomes possible.

## M0: Repository and names (maintainer)

The scaffold, toolchain and plan exist. Remaining steps need the maintainer's accounts:

- Create the GitHub repository `aelmanaa/explorer-verify`, push `main`, apply the main-branch
  ruleset (pull requests only, squash merge, required checks from `ci.yml`).
  The pre-push hook refuses pushes to `main`, so the first push bypasses it once:
  `git push --no-verify -u origin main`. Every later change goes through a pull request.
- Create the labels and milestones listed in CONTRIBUTING.md, then file the M1 issues below.
- Reserve the npm name: create the npm organisation `explorer-verify` for the `@explorer-verify/*`
  scope. The unscoped `explorer-verify` name is free as of 2026-11-02; npm needs one manual first
  publish before a trusted publisher can be configured (see [releasing.md](releasing.md)).

## M1: Core flow with Sourcify (keyless)

Goal: `verify()` works end to end on one keyless backend, from Node and from a browser. In order:

1. Decide the package split and the bundle budget. They decide where every later file lives.
   Decided in [decision 0008](decisions/0008-package-split-and-bundle-budget.md).
2. Settle `VerifyOptions`, `Handle` and the error type shape (architecture.md, public entry points).
3. Error catalogue and key redaction (R-DX-3, R-SEC-1). Each error has a `code`, a `hint` that names
   the fix and a `docsUrl` (R-AX-10).
4. Input validation (R-IN-1, R-IN-6).
5. `http/fetch.ts`: injected fetch, retries, abort, timeout (R-FLOW-6).
6. Minimal routing: every chain id resolves to Sourcify (`https://sourcify.dev/server`) with a
   per-call override. The routing table (R-RT-1) replaces this in M2.
7. `Backend` interface and the Sourcify v2 client (R-BE-4). Sourcify's v1 API was switched off on
   2026-07-07: rewrite against v2, do not port a v1 client.
8. Flow engine with lookup, submit, poll, result mapping (R-FLOW-1 to R-FLOW-4).
9. Resumable handle and `checkStatus` (R-FLOW-5).
10. A browser smoke test (bundled page in a headless browser) proving R-RUN-1. It also measures
    the `verify` bundle and replaces the provisional 10 kB ceiling in `size-budget.json` with the
    measured size plus 20%, checked in CI (R-RUN-3).

Agent readiness (epic #2) runs beside that list, so later features meet R-AX from the start:

- #3: make agent readiness a requirement on every feature (R-AX). Lands first; items 1 and 2 rebase
  on it.
- #4: check agent docs in CI (`llms.txt`, page links, version stamps) and a stub of the agent page,
  after #3 (R-AX-1 to R-AX-3).
- #5: machine contract for results and errors, after #3, in parallel with #4 (R-AX-5, R-AX-7,
  R-AX-10).
- #6: ship an agent skill in the package, tested against each build. Needs items 8 and 9 (R-AX-4).

Test rules: #32 sets a per-file coverage floor and written rules for regression tests (R-QA-1).

## M2: Etherscan family and routing

- Etherscan v2 client (R-BE-1), Etherscan-compatible client (R-BE-2), Routescan (R-BE-5).
- Routing table seeded from the prior art's 67 chains, refreshed and dated (R-RT-1 to R-RT-3).
- Constructor-argument derivation (R-IN-3), library links (R-IN-4).
- Live matrix on Sepolia and one more testnet per backend (R-QA-2). Test Etherscan Similar Match on
  a factory deployment (open question).
- Format-detecting input builder (R-IN-7), in two issues: build-info and detection (#20), then
  Solidity metadata (#21).
- Scheduled live check across explorers (R-QA-4, #23).
- #29: mutation testing for result mapping and key redaction (R-QA-1, R-FLOW-3, R-SEC-1).

## M3: Blockscout, server handler and proxies

- Blockscout clients (R-BE-3), including the partial-match and empty-response cases (R-FLOW-7).
- `createVerifyHandler` in `explorer-verify/server`, with guards (R-SRV-1 to R-SRV-5); example for
  Next.js and one edge runtime.
- Proxy linking (R-FLOW-8). Fan-out to several backends (R-RT-4).
- Bytecode-metadata input resolver (R-IN-5). Reason: tools that hold only the deployed bytecode
  can verify without the compiler input, so the input resolver ships before 0.1.0.

## M4: Developer experience and 0.1.0

- CLI as `@explorer-verify/cli` (R-DX-1) meeting R-AX-5 to R-AX-12, and build helpers for Foundry
  and Hardhat 3 as `@explorer-verify/foundry` and `@explorer-verify/hardhat`. They locate the
  files and call the R-IN-7 builder (R-DX-2).
- #7: CLI contract harness and a recorded agent evaluation before 0.1.0 (R-AX-5 to R-AX-13).
- User docs: a tutorial (deploy then verify from a dapp), how-tos per runtime, reference generated
  from TSDoc, an explanation of match types and Etherscan plan rules (R-SEC-3), and the full page "Using
  explorer-verify from an agent" (R-AX-3). Every page ships in the package and is listed in
  `llms.txt` (R-AX-1, R-AX-2).
- Release pipeline copied from [hardhat-kms](https://github.com/aelmanaa/hardhat-kms) (signed tag, staged publish, provenance), first publish
  of 0.1.0.

## Later

- Vyper (R-EXT-1).
