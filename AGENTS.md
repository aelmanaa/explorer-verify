# AGENTS.md

explorer-verify will verify the source of deployed smart contracts on block explorers: Etherscan
(API v2), Blockscout, Sourcify and Routescan. The planned API runs in a browser, on a backend or in
a CLI, and a self-hosted server handler keeps Etherscan keys off the client.

Status: in design; nothing is published to npm yet. The repository has the toolchain, a typed public
contract (`packages/explorer-verify/src/types.ts`), the plan, the first explorer client
(Sourcify, `packages/explorer-verify/src/backends/sourcify.ts`), `verify()`
(`packages/explorer-verify/src/flow/verify.ts`) and `checkStatus()`
(`packages/explorer-verify/src/flow/status.ts`).

## Start here

A new session reads these in order, then takes the lowest-numbered open issue in the current
milestone. If no issues are filed yet, start at the first M1 item in the roadmap; M0 is the
maintainer's.

1. [docs/contributor/requirements.md](docs/contributor/requirements.md): what the library must do,
   with stable IDs (`R-…`) that issues and tests cite.
2. [docs/contributor/architecture.md](docs/contributor/architecture.md): packages, modules, the
   verification flow and the extension points.
3. [docs/contributor/decisions/README.md](docs/contributor/decisions/README.md): the decisions taken
   so far and why.
4. [docs/contributor/roadmap.md](docs/contributor/roadmap.md): milestones and the first issues.
5. [docs/contributor/adoption.md](docs/contributor/adoption.md): the adoption goal, the kinds of
   users, what each needs, and the milestone where that becomes possible.
6. [docs/contributor/prior-art.md](docs/contributor/prior-art.md): the two working implementations
   this library starts from, and what to port from each.
7. [docs/contributor/research/](docs/contributor/research/): dated evidence behind the decisions
   (explorer APIs, Etherscan terms, existing packages, agent readiness, CLI output and logging).
8. [docs/contributor/testing.md](docs/contributor/testing.md): test layers and fixture rules.
9. [docs/contributor/tooling.md](docs/contributor/tooling.md): toolchain and the type-checking layout.
10. [docs/contributor/releasing.md](docs/contributor/releasing.md): release plan and first publish.

User docs live in [docs/user/](docs/user/README.md); the index for people is
[docs/README.md](docs/README.md).
[docs/user/reference/routing.md](docs/user/reference/routing.md) describes the routing table in
`packages/explorer-verify/src/routing/table.json` and its checks. The index for agents is
[llms.txt](llms.txt), and
[docs/user/guides/using-from-an-agent.md](docs/user/guides/using-from-an-agent.md) says which calls
are safe and which one submits. The CLI's output contract is in
[docs/user/reference/cli.md](docs/user/reference/cli.md). The error reference is
[docs/user/reference/errors/index.md](docs/user/reference/errors/index.md), with one page per
error code next to it, and the JSON envelope and exit codes are in
[docs/user/reference/json-output.md](docs/user/reference/json-output.md). Building the input from
compiler JSON of unknown origin is in
[docs/user/guides/verify-a-contract-from-an-npm-package.md](docs/user/guides/verify-a-contract-from-an-npm-package.md),
from a Foundry project in
[docs/user/guides/verify-from-a-foundry-project.md](docs/user/guides/verify-from-a-foundry-project.md),
and from a Hardhat project in
[docs/user/guides/verify-from-a-hardhat-project.md](docs/user/guides/verify-from-a-hardhat-project.md).
[docs/user/reference/sourcify.md](docs/user/reference/sourcify.md) says what the Sourcify client
sends and how it reads each answer. The logger and the stage events are in
[docs/user/reference/logging-and-events.md](docs/user/reference/logging-and-events.md).
[docs/user/explanation/match-types.md](docs/user/explanation/match-types.md) explains exact and
partial matches, and
[docs/user/explanation/etherscan-plans-and-attribution.md](docs/user/explanation/etherscan-plans-and-attribution.md)
the Etherscan plan and attribution rules. The agent
skill that ships in the package is
[skills/explorer-verify/SKILL.md](skills/explorer-verify/SKILL.md); the build copies it into the
package, and `packages/explorer-verify/test/unit/skill.test.ts` runs its examples against the
build.

## Commands

| Command                         | What it does                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm install`                  | Installs dependencies and the git hooks                                        |
| `pnpm run check`                | Format check, lint (type-aware), typecheck, type-escape, host and docs checks  |
| `pnpm test`                     | Builds, then runs the unit tests and the script tests with `node --test`       |
| `pnpm run coverage`             | Unit tests under c8; fails when any file is below 95% on any metric            |
| `pnpm run test:randomize`       | Unit tests and script tests in a random order; prints the seed                 |
| `pnpm run pkg:check`            | publint, are-the-types-wrong, packed docs and knip on the built package        |
| `pnpm run size`                 | Bundles each public entry for the browser; fails above `size-budget.json`      |
| `pnpm run test:browser`         | Runs `verify()` and `checkStatus()` in headless Chromium on recorded answers   |
| `pnpm run test:browser:harness` | Checks that broken page scripts and missing CORS headers fail the browser test |
| `pnpm run site:build`           | Builds the docs site from `docs/user/` into `site/dist`; never deploys         |
| `pnpm changeset`                | Adds a changeset for a user-facing change under `packages/`                    |

Node 24 for development (`.nvmrc`); the floor is 22.18.0, because scripts and tests run TypeScript
natively. pnpm 12.16.1 (`packageManager`).

## Where things are

| Path                                  | Contents                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/explorer-verify/src/`       | The core package. Runtime-neutral: no Node built-ins (lint rule and a build without Node types enforce it)                                                       |
| `packages/explorer-verify/src/server` | `explorer-verify/server`: `createVerifyHandler` ([docs](docs/user/reference/server-handler.md))                                                                  |
| `packages/explorer-verify/test/unit/` | Unit tests, `*.test.ts`                                                                                                                                          |
| `packages/foundry/`                   | `@explorer-verify/foundry`: finds a contract's build files in a Foundry project. Node only (decision 0008)                                                       |
| `packages/hardhat/`                   | `@explorer-verify/hardhat`: finds a Hardhat 2 or 3 contract's build files (Node only, decision 0018); [guide](docs/user/guides/verify-from-a-hardhat-project.md) |
| `packages/cli/`                       | `@explorer-verify/cli`, the `explorer-verify` bin (Node only, decision 0008); integration tests spawn the built bin                                              |
| `scripts/`                            | Repository scripts run with plain `node`: hooks, type-escape, host and docs checks, test runner; tests in `scripts/test/`                                        |
| `docs/user/`                          | User documentation (Diátaxis layout, written as features land); the package ships it as `docs/`                                                                  |
| `llms.txt`                            | Index of the docs for agents (llmstxt.org); lists every user page                                                                                                |
| `skills/`                             | The agent skill; the build copies it into the package, and the tests run its examples against the build                                                          |
| `docs/contributor/`                   | Requirements, architecture, roadmap, decisions, research, prior art, testing, releasing                                                                          |
| `.github/`                            | CI, issue and pull request templates, Dependabot, CODEOWNERS                                                                                                     |
| `.changeset/`                         | Pending release notes                                                                                                                                            |

## Rules for every change

- Work from a GitHub issue. The pull request says `Closes #n`. See [CONTRIBUTING.md](CONTRIBUTING.md).
- `main` changes only through squash-merged pull requests with a Conventional Commits title. The
  pre-push hook refuses a direct push to `main`.
- Every user-facing change under `packages/` adds a changeset. Versions change only through
  `pnpm run version-packages`.
- Agents never tag, publish, approve environments or move npm dist-tags.
- Tests ship with the change. Coverage stays at or above 95%.
- Docs ship with the code. A new page is linked from this file and from
  [docs/README.md](docs/README.md).
- No `any`, no `@ts-` directives, no casts. `scripts/type-escapes.json` lists the only exceptions,
  each with a reason. Prefer a typed alternative over adding one.
- `packages/*/src` never imports a Node built-in and never reads `process.env`. Every network call
  goes through the `fetch` the caller injects or the default `globalThis.fetch`. The exceptions
  are the Node-only packages. `packages/foundry/src` and `packages/hardhat/src`, the build helpers
  (decisions 0008 and 0018), read files with `node:fs` and never read `process.env`.
  `packages/cli/src` (decision 0008) may import Node built-ins, and only its bin reads
  `process.env`. A lint override names each package.
- Never print, log or commit an API key, including in tests and fixtures. Errors redact keys.
- A change that adds or changes a public function, error, CLI command or user page meets
  [agent readiness (R-AX)](docs/contributor/requirements.md#agent-readiness-r-ax), or the pull
  request says which requirement it does not meet and why (decision 0007).
- A requirement change edits [requirements.md](docs/contributor/requirements.md) in the same pull
  request. A design change that reverses a decision adds a new decision record.
- Prose (docs, changesets, issues, pull requests, comments) is plain and factual: short sentences,
  active voice, no filler, no marketing words.
