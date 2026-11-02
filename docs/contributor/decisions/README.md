# Decisions

Audience: contributors and agents. One record per decision, numbered, never rewritten: a reversal is
a new record that names the one it supersedes. Format: `NNNN-slug.md` with `# NNNN: Title`,
`Status:`, then `## Context`, `## Decision`, `## Consequences`.

| #                                                            | Decision                                                                                  | Status   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------- |
| [0001](0001-build-a-standalone-library.md)                   | Build a standalone library instead of extending thirdweb or a deploy tool                 | Accepted |
| [0002](0002-runtime-neutral-core.md)                         | The core runs in any JavaScript runtime; Node-only code stays out of the core entry point | Accepted |
| [0003](0003-etherscan-only-through-a-self-hosted-handler.md) | Etherscan keys stay on the operator's server; no hosted relay                             | Accepted |
| [0004](0004-solidity-first-pluggable-compilers.md)           | Solidity first; the compiler is a discriminated union                                     | Accepted |
| [0005](0005-caller-supplies-compiler-input.md)               | The caller supplies the compiler input; the library never compiles                        | Accepted |
| [0006](0006-personal-npm-name-and-hardhat-kms-toolchain.md)  | Personal npm name `explorer-verify`; toolchain and process copied from hardhat-kms        | Accepted |
