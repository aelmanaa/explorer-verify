# Where `verify` submits without `--backend` (2026-11-05)

Question: should the CLI's `verify` submit to the routing table's pick when the command line names
no backend, or ask the caller to name one?

Sources were read on 2026-11-05.

## The case

`explorer-verify verify` without `--backend` submits to the first backend of the chain's row that
works with the keys set. On Sepolia that is Sourcify without `ETHERSCAN_API_KEY` and Etherscan v2
with it. A submit publishes source on the explorer and cannot be undone.

- In the [agent evaluation pilot](2026-11-05-agent-evaluation-pilot.md), task `no-key`, an agent
  asked to verify on Etherscan read `--help`, ran `verify` without `--backend` and submitted to
  Sourcify.
- [Decision 0027](../decisions/0027-etherscan-rows-and-paid-plan-chains.md) names the same risk
  for the key-present case: a key in the environment sends a call to Etherscan without the caller
  asking for it.

## What other tools do

| Tool                                                                                   | Behaviour                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| forge 1.9.0, `crates/verify/src/provider.rs`                                           | The provider depends on the key: "An explicit flag always takes precedence over the `ETHERSCAN_API_KEY` environment variable"; without `--verifier`, a set key selects Etherscan and no key selects Sourcify. A chain with a Sourcify-compatible API falls back to Sourcify with a warning ("ETHERSCAN_API_KEY is set but chain ... uses a Sourcify-compatible API. Falling back to Sourcify"). |
| hardhat-verify 3.1.4                                                                   | `verify` runs every configured explorer in turn; which ones run is set in the project's config, not guessed per run.                                                                                                                                                                                                                                                                            |
| npm 11.19.0, `lib/commands/publish.js`                                                 | Refuses to guess the tag where a guess is risky: "You must specify a tag using --tag when publishing a prerelease version." and "Cannot implicitly apply the "latest" tag because previously published version ... is higher than the new version".                                                                                                                                             |
| gh 2.92.0, `pkg/cmd/repo/create/create.go`                                             | Without a terminal, the visibility of a new repository has no default: "`--public`, `--private`, or `--internal` required when not running interactively".                                                                                                                                                                                                                                      |
| [Terraform `apply` docs](https://developer.hashicorp.com/terraform/cli/commands/apply) | `-input=false` turns off prompts; a run that needs a value it was not given fails instead of guessing.                                                                                                                                                                                                                                                                                          |
| [clig.dev](https://clig.dev/#arguments-and-flags)                                      | Asks for confirmation, or an explicit flag when there is no terminal, before a dangerous or irreversible action.                                                                                                                                                                                                                                                                                |
| MCP tools specification 2025-11-25                                                     | Marks a tool that changes state outside the client with `destructiveHint`, so the client asks before it runs.                                                                                                                                                                                                                                                                                   |

The shared pattern: an action that publishes or cannot be undone either asks, or, without a
terminal, refuses until the caller names the choice. The CLI never prompts (R-AX-6), so it refuses.

## Options

- A. Keep the routing table's pick. Rejected: the pilot shows the wrong explorer gets the source.
- B. Prompt on a terminal, pick on a pipe. Rejected: R-AX-6 forbids prompts, and the risk is
  largest without a terminal, where agents and CI run.
- C. Refuse only when a key changes the pick. Rejected: a caller cannot tell from the command line
  which case applies, and the no-key case is the one the pilot hit.
- D. Require a target on every submitting run: `--backend <name>` or `--backend auto` for the
  routing table's pick, with a hint that names the row's backends and what `auto` would pick.
  Chosen. `--dry-run` and `status` stay as they are; the dry run shows the pick and `routedBy`.

Agent-facing tool guidance points the same way: an error that says what to pass next is the cheapest
way for an agent to recover, so the hint lists the backends and the pick.

## Sources

- foundry-rs/foundry v1.9.0, `crates/verify/src/provider.rs` and `crates/verify/src/verify.rs`.
- NomicFoundation/hardhat, `@nomicfoundation/hardhat-verify` 3.1.4.
- npm/cli v11.19.0, `lib/commands/publish.js`.
- cli/cli v2.92.0, `pkg/cmd/repo/create/create.go`.
- HashiCorp, [Terraform `apply` command](https://developer.hashicorp.com/terraform/cli/commands/apply), read 2026-11-05.
- [Command Line Interface Guidelines](https://clig.dev/).
- [Model Context Protocol, tools, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
