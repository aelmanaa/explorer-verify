# 0071: The published packages declare Node 22.12.0; the repository keeps 22.18.0

Status: Accepted (2026-11-12). Amends [0060](0060-supported-node-versions-follow-lts.md) point 4.

Research: [research/2026-11-12-node-22-floor.md](../research/2026-11-12-node-22-floor.md).

## Context

Issue [#393](https://github.com/aelmanaa/explorer-verify/issues/393). Decision 0060 point 4 set one
floor for everything: `engines.node` `>=22.18.0` in every package, because the repository's scripts
and tests run TypeScript natively and Node does that by default from 22.18.0. The published
packages are compiled JavaScript and do not need that release. A tool whose own range starts lower
in Node 22 gets an engines warning when it depends on explorer-verify.

The research note tested the packed packages on Node 22.0.0, 22.11.0, 22.12.0 and 22.18.0. Every
feature the built code uses is in 22.0.0, but before 22.12.0 Node prints an `ExperimentalWarning`
for the JSON module imports of the routing table and the CLI's version. The CLI writes that warning
on stderr, which breaks `--log-format json`. From 22.12.0 the packages run with nothing on stderr.
Hardhat 3 asks for Node 22.13.0 or later, so this floor does not stop a Hardhat 3 adapter.

## Decision

1. The four published packages (`explorer-verify`, `@explorer-verify/cli`,
   `@explorer-verify/foundry`, `@explorer-verify/hardhat`) declare `engines.node` `>=22.12.0`.
2. The repository's development floor stays at 22.18.0: the root `package.json` `engines` and
   `devEngines`, `examples/`, the first leg of the CI test matrix, and every docs example that Node
   runs as a `.ts` file.
3. The `node-floor` job in `.github/workflows/ci.yml` tests the published floor. It builds and packs
   the packages on Node 24, installs the tarballs with npm on exactly 22.12.0, and runs
   `test/node-floor/smoke.mjs`, plain JavaScript that imports every entry and runs the library,
   the build helpers and the bin with no network. The bin must write nothing on stderr.
   `scripts/test/node-floor.test.ts` fails when the job's version and `engines.node` differ.
4. Decision 0060 point 4 now reads: the published floor is the version the `node-floor` job tests,
   and `engines.node` of the published packages names it. The rest of 0060 stands. When Node 22
   reaches end of life, the drop raises both floors in one pull request.
5. Raising the published floor within Node 22, for example because the built code starts using an
   API added after 22.12.0, is a breaking change: a `minor` changeset starting with "Breaking:"
   during 0.x. Lowering it is a `patch`.

## Alternatives considered

### Node 22.0.0

Every library check passes on 22.0.0. Rejected: the CLI prints an experimental warning on every
run, and a library call that loads the routing table prints it on the caller's stderr. Removing the
JSON imports would change core source for a release line that ends on 2027-04-30.

### Keep 22.18.0 for the packages

Rejected: the floor would describe the repository's tooling, not the published code, and tools on
earlier Node 22 releases would get an engines warning for no runtime reason.

### Run the packages' TypeScript unit tests on the floor

Node 22.12.0 does not strip types without `--experimental-strip-types`, and the tests import the
TypeScript sources, not the tarballs. A smoke test on the installed tarballs checks what a user
installs.

## Consequences

- R-RUN-1 names Node 22.12.0 and later for the published packages.
- The README, the package READMEs and the user pages that run no `.ts` file state 22.12. Pages
  whose examples Node runs as `.ts` files keep 22.18 and say why.
- `node-floor` is a new CI job. It is not one of the checks the `main` ruleset requires until the
  maintainer adds it.
- [Releasing](../releasing.md#supported-node-versions) lists both floors.
