# Foundry fixtures

One Foundry project, `project/`, built on 2026-11-03 with Foundry 1.8.1 (commit `982849d3`) and
solc 0.8.24 (`0.8.24+commit.e11b9ed9`), optimizer on, 200 runs, for the tests of
`findFoundryBuild` and `buildVerifyInputFromFoundry` (R-DX-2).

## The contracts

| File                                 | Contracts                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `src/Greeter.sol`, `src/Base.sol`    | `Greeter is Base`: one contract that imports another file. Same files as the core's build fixtures                     |
| `src/Pair.sol`                       | `Ping` and `Pong`: two contracts in one file                                                                           |
| `src/Counter.sol`, `src/Tally.sol`   | `Counter` calls the external library `Tally`, linked at `0x5A0b54D5dc17e0AadC383d2db43B0a0D3E029c4c` in `foundry.toml` |
| `src/a/Token.sol`, `src/b/Token.sol` | Two contracts named `Token` in files with the same name                                                                |

## Builds

| Folder            | Command                                                           | What Foundry wrote                                                                        |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `out/`            | `forge build --offline`                                           | One artifact per contract and a stub build-info: `id`, `source_id_to_path` and `language` |
| `out-build-info/` | `forge build --offline --build-info --force --out out-build-info` | One artifact per contract and the full build-info, with `input` and `output`              |

Foundry wrote the artifact of `src/a/Token.sol` to `Token.sol/Token.json` and the one of
`src/b/Token.sol` to `b/Token.sol/Token.json` in both builds. The artifacts of the two builds hold
the same `rawMetadata`, and it equals the metadata string of each contract in the full build-info.

## Two compiler versions: `multi/`

A second project, built on 2026-11-03 with Foundry 1.8.1 and
`forge build --offline --build-info`. `foundry.toml` sets `extra_output_files = ["metadata"]` and
pins no compiler version. `lib/utils/Context.sol` (`^0.8.20`) is imported by `src/Old.sol`
(`=0.8.20`) and by `src/New.sol` (`=0.8.24`), so Foundry compiled it with solc 0.8.20
(`0.8.20+commit.a1b79de6`) and with solc 0.8.24. It wrote:

- `out/Context.sol/Context.0.8.20.json` and `out/Context.sol/Context.0.8.24.json`, one artifact
  per version, both targeting `lib/utils/Context.sol:Context`;
- a `Name.metadata.json` file next to each artifact, holding the Solidity metadata only;
- one build-info file per version in `out/build-info/`.

## A Vyper contract: `vyper/`

A third project, built on 2026-11-20 with Foundry 1.8.1 and `forge build --offline`, with
`build_info = true` in `foundry.toml` and Vyper 0.4.3 (`0.4.3+commit.bff19ea2`). Forge used the
default EVM version, `prague`. The sources:

| File                          | What it is                                                          |
| ----------------------------- | ------------------------------------------------------------------- |
| `src/Counter.vy`              | `Counter`: imports and initializes `ownable`, implements `ICounter` |
| `src/ownable.vy`              | A module; forge also writes an artifact for it                      |
| `src/interfaces/ICounter.vyi` | The interface `Counter` implements                                  |

Forge wrote `out/Counter.vy/Counter.json`, `out/ownable.vy/ownable.json` and one build-info,
`out/build-info/cb47506b7508bb34.json`. The artifacts hold no metadata. The build-info records
the version as `0.4.3`, without a commit.

`vyper-recompile.json` holds the input `buildVerifyInputFromFoundry` returns for
`src/Counter.vy:Counter`, and the bytecode that `vyper-json` 0.4.3 gave for it when run once in an
empty folder. Both bytecodes equal the artifact's. The tests read this file and run no compiler.

The Vyper files are as forge and Vyper wrote them: nothing was trimmed, and they held no absolute
path. `cache/` is removed, and the JSON files were formatted with the repository's formatter.

## Changes from the tool output

These changes apply to `project/` and `multi/`.

- Build-info `output`: each contract keeps only `abi` and `metadata`, and each source only `id`.
  The ASTs, `evm` and docs are removed to keep the files small.
- Build-info `input.basePath`, `input.allowPaths` and `input.includePaths` held absolute paths on
  the build machine. They hold `<project-root>` instead.
- Artifacts: `ast` is removed.
- `cache/`, which Foundry writes next to `out/`, is removed.
- Files were formatted with the repository's formatter.

A test asserts that no fixture holds an absolute path or the name of the user who runs the tests.
