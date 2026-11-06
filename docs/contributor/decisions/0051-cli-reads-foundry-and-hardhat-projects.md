# 0051: The CLI reads Foundry and Hardhat projects through the helper packages

Status: Accepted (2026-11-06). Builds on the package split of
[decision 0008](0008-package-split-and-bundle-budget.md), where the CLI and the build helpers are
Node-only packages, and on the Hardhat helper of
[decision 0018](0018-hardhat-helper-reads-both-versions-without-hardhat.md).

Research: [2026-11-06-cli-project-mode.md](../research/2026-11-06-cli-project-mode.md).

## Context

Issue [#221](https://github.com/aelmanaa/explorer-verify/issues/221). In a Foundry project,
`verify` needs the build-info file, whose name is a hash, so the user lists `out/build-info` first.
A shell glob such as `--input out/build-info/*.json` expands to several files, and the second one
lands as an extra argument: `verify takes at most 1 arguments`. `--input out` exits 2 with "must
name a regular file". Hardhat 3 needs three `--input` flags. `findFoundryBuild` and
`findHardhatBuild` already find the files, but the CLI did not use them. `forge verify-contract`
and `hardhat verify` read the project themselves.

## Decision

- `verify` takes `--foundry <dir>` or `--hardhat <dir>` with `--contract path:Name`, and calls
  `buildVerifyInputFromFoundry` or `buildVerifyInputFromHardhat` with that folder as `root`.
  `--compiler-version` is passed on. `--out-dir <dir>` and `--artifact <file>` set `outDir` and
  `artifact`. The CLI has no flag for the Foundry helper's `buildInfoDir`.
- The folder is a required value, so `verify --foundry 0x…` cannot read the address as the folder.
  `.` names the current folder, not the Git root that `forge verify-contract` uses by default; the
  help says so. Each of the four options may be given once. `--contract` takes `path:Name`, or a
  bare `Name` when one contract has that name.
- `--out-dir` and `--artifact` are relative to the project folder, or absolute. The Hardhat helper
  keeps its rule from decision 0018 that the artifact is inside the output folder; the help says
  so. Both helpers name a file outside the project folder by its absolute path in an error.
- `--foundry` with `--hardhat`, a project option with `--input`, a project without `--contract`,
  and `--out-dir` or `--artifact` without a project each exit 2 before any request. With
  `--input-json`, the project options exit 2, as every request option does (R-AX-16).
- `@explorer-verify/cli` depends on `@explorer-verify/foundry` and `@explorer-verify/hardhat`. It
  loads each with a dynamic `import()` only when its option is given. The core package gains no
  dependency (R-RUN-1).
- A helper's error names the library's options, such as `outDir` or `options.contract`, and
  `details` fields. The CLI rewrites the issue fields of `invalid-input` to its own flags. The
  envelope carries the issues and the candidates in `details`, and the stderr error block lists
  them ([decision 0049](0049-error-details-in-json-and-cli-hints.md), which replaced the first
  form: the issues listed in the message and the candidates joined to it). The hint goes through
  the CLI's one hint layer, which rewrites the library's words. Its `details.field` keeps the
  library's name, because its values are a closed set. A test feeds every hint of both helpers
  through the rewrite and fails on a library name left in it. An `outDir` issue when `--out-dir` was not
  given names the project flag and the default folder, `out` or `artifacts`.
- Any envelope that carries the library's default hint gets the CLI's hint for its code
  (decision 0049).
- A helper's message may list file names under the project folder, such as the artifacts that
  match a contract name. These are names the helper found, not values the user typed, so the CLI
  rule that an issue never repeats a typed path or value still holds.
- An `--input` that names a folder gets the issue "names a folder, not a file", naming `--foundry`
  and `--hardhat`. When `--artifact` is given, an extra argument gets "`--artifact` takes one
  file"; when `--input` is given, "`--input` takes one file; repeat `--input` for each". Otherwise
  the count stays, with the singular "1 argument".

## Alternatives considered

- **Accept a folder in `--input`.** It would mix two meanings in one option, and still needs the
  build tool, which a folder does not say for certain.
- **Find the project without a flag**, from `foundry.toml` or `hardhat.config.*` in the current
  folder. The helpers do not read configs, and a guess could pick the wrong build when both exist.
  Left for a follow-up.
- **An optional `--contract` in project mode.** forge and Hardhat take it as optional, but the
  helpers search by name, not by deployed bytecode, so there is nothing to search without it.
- **An optional value, `--foundry [dir]`.** The address is a positional, so `verify --foundry 0x…`
  would be ambiguous.
- **Load the helpers statically.** Every run would read two packages it does not need.

## Consequences

- The help examples, the CLI reference, the skill, the Foundry, Hardhat and CI guides, and the
  agent-eval tasks use project mode. One help example keeps `--input` for build files outside a
  project, and the CLI's test project gains a `build/` folder for it.
- The CI guide drops its request-writing script; `--input-json` stays for jobs that write the
  request themselves.
