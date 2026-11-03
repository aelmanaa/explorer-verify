# 0018: The Hardhat helper reads Hardhat 2 and 3, with no `hardhat` dependency

Status: Accepted (2026-11-03). Amends the `@explorer-verify/hardhat` row of
[decision 0008](0008-package-split-and-bundle-budget.md), which said "reads Hardhat 3 build-info".

Research: [2026-11-03-hardhat-build-layout.md](../research/2026-11-03-hardhat-build-layout.md) for
where each version writes the artifact and the build-info, and how one names the other.

## Context

R-DX-2 asks for build helpers for Foundry and for Hardhat 2 and 3. Decision 0008 described the
Hardhat helper as reading Hardhat 3 build-info, and its option A noted that a Hardhat helper would
need `hardhat` as a peer dependency. Issue #100 recommended both versions and no peer.

The research shows that the two versions differ only in how the artifact names its build-info:
Hardhat 3 writes `buildInfoId` into the artifact, Hardhat 2 writes a `.dbg.json` file next to it.
Both are plain JSON files in the artifacts folder.

## Decision

- `@explorer-verify/hardhat` reads both Hardhat 2 and Hardhat 3 projects. It detects the version
  per contract: an artifact with `buildInfoId` is Hardhat 3, one without it is read through its
  `.dbg.json` file.
- It reads files only. It does not load the Hardhat config, run a compile or call the Hardhat
  runtime, so it has no `hardhat` dependency or peer dependency.
- `explorer-verify` is a peer dependency, not a regular one, and a dev dependency for the
  repository's own tests. As a regular dependency, a project could install two copies of the core:
  the helper's errors would then come from the other copy, and the caller's
  `instanceof ExplorerVerifyError` would be false. The manifest says `workspace:^`; the release
  publishes with `pnpm publish`, which replaces it with the version range (#86).
- It treats the artifacts folder as the boundary of what it reads. Each file, with its symlinks
  resolved, must be a regular file inside that folder and at most 256 MiB long. A Hardhat 2
  `buildInfo` path must point into `build-info/`. The bare-name search never follows a symlink, so
  a symlink loop cannot hang it.
- A config that moves the artifacts folder (`paths.artifacts`) is passed as the `artifacts`
  option, since the helper does not read the config.
- It holds no format logic: it passes the parsed files to `buildVerifyInput` (R-IN-7) and reads
  only `buildInfoId` and `buildInfo`. A test checks the fields it reads and the modules it
  imports.
- It runs on Node only, like the other add-ons of decision 0008. Its source may import Node
  built-ins; a lint override allows them in `packages/hardhat/src` only.

## Alternatives considered

| Option                                                  | For                                                                    | Against                                                                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardhat 3 only                                          | Smaller                                                                | R-DX-2 names Hardhat 2, and the cost of reading it is one more file                                                                                                       |
| Use Hardhat's runtime (`hre.artifacts`), `hardhat` peer | Reads `paths.artifacts` from the config; follows Hardhat's own lookups | A peer dependency on two major versions with different APIs; loading the config runs the user's config code; the helper could no longer run without the project's install |
| A Hardhat plugin or task                                | Runs inside `npx hardhat`                                              | A non-goal of issue #100; a plugin can wrap this helper later                                                                                                             |

## Consequences

- A Hardhat 2 or 3 project needs only `explorer-verify` and `@explorer-verify/hardhat` installed to
  build its verification input. The caller installs both: the package manager does not add the
  peer by itself in every setup.
- An artifacts folder that links files from outside itself, for example a build-info symlinked
  from a shared cache, is refused.
- A project that sets `paths.artifacts` must pass the same path as `artifacts`.
- A change in either version's file layout breaks the helper without a dependency update to warn
  of it. The fixtures pin Hardhat 2.29.1 and 3.21.2; a new layout needs new fixtures.
