# Build-format fixtures

Build output of one small contract from three tools, for the `buildVerifyInput` tests (R-IN-7).
Built on 2026-11-02 with solc 0.8.24 (`0.8.24+commit.e11b9ed9`), optimizer on, 200 runs.

## The contract

Two files: `Base.sol` declares an abstract `Base` with an immutable `owner` set by its constructor.
`Greeter.sol` declares `Greeter is Base`, with a `string greeting` and a constructor that takes
`(address owner_, string greeting_)`. The full sources are in each build-info's `input.sources`.

## Files

| Folder           | Tool and command                          | Files                                                                  |
| ---------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `foundry-1.8.1`  | Foundry 1.8.1, `forge build --build-info` | `build-info.json`, `Greeter.json` (artifact), `build-info-stub.json`   |
| `hardhat-2.29.1` | Hardhat 2.29.1, `hardhat compile`         | `build-info.json`, `Greeter.json` (artifact)                           |
| `hardhat-3.21.2` | Hardhat 3.21.2, `hardhat build`           | `build-info.json`, `build-info.output.json`, `Greeter.json` (artifact) |

The EVM version differs by tool default: `cancun` for Foundry, `paris` for Hardhat 2, `shanghai`
for Hardhat 3.

## Changes from the tool output

- File names: the tools name build-info files by a hash; here they are `build-info.json`.
- Build-info `output`: each contract keeps only `abi` and `metadata`. The ASTs, `evm` and docs are
  removed to keep the files small. The builder reads only the contract names and the metadata.
- Foundry `input.basePath`, `input.allowPaths` and `input.includePaths` held an absolute path on
  the build machine. They hold the placeholder `<project-root>`.
- Foundry artifact: `ast` is removed.
- `foundry-1.8.1/build-info-stub.json` keeps the three fields that Foundry 1.8.1 writes to
  `out/build-info/<id>.json` when build-info is off (`id`, `source_id_to_path`, `language`),
  taken from the full build-info of the same build.

Every other field is as the tools wrote it. A test asserts that no fixture holds an absolute path
or the name of the user who runs the tests.

## Sources

- Foundry build-info format (`ethers-rs-sol-build-info-1`): `crates/compilers/src/buildinfo.rs` at
  foundry-rs/compilers@18b51786, read 2026-11-02, and Foundry 1.8.1 output on 2026-11-02.
- Hardhat 3 build-info, output file and artifact: `packages/hardhat/src/types/solidity/solidity-artifacts.ts`
  and `packages/hardhat/src/types/artifacts.ts` at NomicFoundation/hardhat@51a2cc4f, read
  2026-11-02, and Hardhat 3.21.2 output on 2026-11-02.
- Hardhat 2 build-info and artifact: `types/artifacts.d.ts` in the `hardhat@2.29.1` npm package,
  read 2026-11-02, and Hardhat 2.29.1 output on 2026-11-02.
- Each build-info input was compiled again with solc 0.8.24, after removing every top-level key
  other than `language`, `sources` and `settings`; the creation and runtime bytecode matched the
  artifact's (2026-11-02).
