# 0005: The caller supplies the compiler input

Status: Accepted (2026-11-02)

## Context

Compiling in the library would mean shipping or downloading solc, which is heavy in a browser and
risks a build that differs from the deployed one. Teams that deploy already have their build output.

## Decision

The library takes the Standard JSON input and the full compiler version as given. Where that input
comes from (a build directory, an SDK's bundled artifacts, a published package) is the caller's
concern. Build helpers for Foundry and Hardhat (R-DX-2) and input resolvers (R-IN-5) make it easy.

## Consequences

- No compiler in any package.
- A protocol SDK that ships its own Standard JSON can depend on the core and keep only its artifacts
  and glue.
