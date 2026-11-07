# 0057: The zksolc compiler kind, refused where no client maps it

Status: Accepted (2026-11-06). Extends [decision 0004](0004-solidity-first-pluggable-compilers.md)
with its second union member.

Research: [ZKsync Era, zksolc and the explorers](../research/2026-11-05-zksync-zksolc.md).

## Context

Contracts compiled with zksolc run on EraVM, on ZKsync Era (chain 324) and ZKsync Sepolia (chain
300). `VerifyInput.compiler` had only `kind: "solc"`, so such a contract could not be described.
Decision 0004 keeps the union open for another kind, and says each backend maps the kinds it
supports and rejects the others with a typed error.

The research note found that Etherscan v2 and Routescan do not serve chains 324 and 300, that
Sourcify compiles with solc only, and that Blockscout's ZKsync instances take zksolc through the
`/api` call the Blockscout client already sends, with one more field, `zksolcVersion`. Issue #206
adds the kind; issue #207 adds the Blockscout mapping.

## Decision

1. `VerifyInput.compiler` is `SolcCompiler | ZksolcCompiler`. The zksolc member is
   `{ kind: "zksolc"; version; solcVersion; solcFork?; input }`: `version` is the zksolc version,
   `x.y.z`; `solcVersion` is the full version of the solc that zksolc ran, with the rules of a solc
   `compiler.version`; `solcFork` is the revision of ZKsync's solc fork, `x.y.z`, whose long
   version reads `zkVM-<solc>-<revision>`; `input` is the Standard JSON input. Both types are
   exported.
2. `validateInput` checks each zksolc field and names it in its issue: `compiler.version`,
   `compiler.solcVersion` and `compiler.solcFork`. Each comes back without a leading `v`. A solc
   compiler does not declare `solcVersion` or `solcFork`, so setting either is refused with invalid-input.
3. Which client maps which kind on which chains is a static list, `ZKSOLC_ROUTES` in `compiler-kinds.ts`, read
   before any client loads. It is empty in this release; #207 adds `blockscout` for chains 324 and 300, together with the
   form fields of its client. Backend and chain are both required: enabling ZKsync must not
   enable unrelated Blockscout instances. Only the flows that take input import that module, so
   `checkStatus()` and `linkProxy()` do not bundle it.
4. The routing table passes over a listed backend that does not map the input's kind, as it passes
   over one without a client. When no listed backend maps it, the pick stays as before. A route
   whose backend does not map the kind, whether the table picked it or the caller named it, throws
   `unsupported-compiler` with `details.field` `compiler.kind`, before any request, in `verify()`,
   `dryRun()` and `verifyEach()` of both entries. In `verifyEach()` it is that backend's outcome,
   and `backends: "all"` leaves such backends out. When no backend maps the kind on the chain,
   the whole call throws before routing, including `verifyEach()`.
5. The clients do not check the kind themselves: the flow engine is their only caller, and it
   refuses before it loads a client that does not map the kind. A check in each client would add
   bytes to every client chunk; the Blockscout chunk would pass its ceiling.
6. `verify()` never derives constructor arguments for zksolc input. On EraVM the ContractDeployer
   system contract deploys a contract, so its arguments do not follow the creation code. When arguments would otherwise be derived, the call
   logs at `info` and submits without them; arguments the caller passes are sent as given.
7. `buildVerifyInput`, the bytecode-metadata resolver and `linkProxy()` do not change. The builder
   still refuses zksolc build documents (R-IN-7), and the resolver rebuilds solc input only, through
   the builder. `linkProxy()` takes no compiler input.

## Why

- A static list keeps the route choice before the client loads, as the default entry loads one
  client per call (decision 0031), and lets `explorer-verify/core` refuse before any request with
  the clients its caller passed.
- The refusal reuses `unsupported-compiler` and its default hint. A new code would add a row to the
  error catalogue, which every bundle ships.
- The list stays empty until a client sends the zksolc fields, so this release never sends zksolc
  input as solc.

## Consequences

- Code that reads `input.compiler.version` now gets the zksolc version for zksolc input. Code that
  needs the solc version switches on `kind`.
- `BuiltVerifyInput.compiler` takes the union type; the builder still returns solc input.
- Size measured with esbuild 0.28.2 and Node 24.21.0 on 2026-11-07, with the light-subpath change
  `b877564` as the base: `verify` is 17342 bytes gzip (ceiling 19738), `verifyEach` 19067 (22178),
  `checkStatus` 14524 (17006), and `index` 28532 (31510). The constructor-args chunk is 2005 bytes
  (2352). No ceiling changes.
- The Blockscout chunk is 3453 bytes against a 3520-byte ceiling. Issue #207 must account for its
  mapping in `common.ts` or document any ceiling increase.
