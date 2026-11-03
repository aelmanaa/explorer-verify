# Build-format fixtures

Build output of one small contract from three tools, for the `buildVerifyInput` tests (R-IN-7).
Built on 2026-11-02 with solc 0.8.24 (`0.8.24+commit.e11b9ed9`), optimizer on, 200 runs. A second
contract, which links an external library, was built on 2026-11-03 for the metadata rebuild (#21).

## The contracts

Two files: `Base.sol` declares an abstract `Base` with an immutable `owner` set by its constructor.
`Greeter.sol` declares `Greeter is Base`, with a `string greeting` and a constructor that takes
`(address owner_, string greeting_)`. The full sources are in each build-info's `input.sources`,
and in `sources/` as files, byte for byte. Foundry names them `src/Base.sol` and `src/Greeter.sol`;
Hardhat 2 names them `contracts/Base.sol` and `contracts/Greeter.sol`.

`solc-0.8.24-library/src/Counter.sol` declares `Counter`, which calls the external function
`Tally.add` of the library in `solc-0.8.24-library/src/Tally.sol`. The library is linked at
`0x5A0b54D5dc17e0AadC383d2db43B0a0D3E029c4c`, an address chosen for the fixture.

## Files

| Folder                        | Tool and command                                                                             | Files                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `foundry-1.8.1`               | Foundry 1.8.1, `forge build --build-info`                                                    | `build-info.json`, `Greeter.json` (artifact), `build-info-stub.json`   |
| `foundry-1.8.1-literal-viair` | Foundry 1.8.1, `forge build --build-info` with `use_literal_content = true`, `via_ir = true` | `build-info.json`, `Greeter.json` (artifact)                           |
| `hardhat-2.29.1`              | Hardhat 2.29.1, `hardhat compile`                                                            | `build-info.json`, `Greeter.json` (artifact)                           |
| `hardhat-3.21.2`              | Hardhat 3.21.2, `hardhat build`                                                              | `build-info.json`, `build-info.output.json`, `Greeter.json` (artifact) |
| `solc-0.8.24-library`         | solc-js 0.8.24, `solc.compile` on `input.json`                                               | `input.json`, `Counter.json`, `src/Counter.sol`, `src/Tally.sol`       |
| `sources`                     | The Greeter sources as files                                                                 | `Base.sol`, `Greeter.sol`                                              |
| `solc-legacy`                 | The `solc` npm package at 0.8.24, 0.8.3, 0.7.0 and 0.5.0, `solc.compile`                     | One JSON file per version                                              |

Each file in `solc-legacy/` holds the metadata string, the two source files and the creation and
runtime bytecode of `Counter`, which links the library `Tally` (same contracts as
`solc-0.8.24-library`, with `pragma solidity >=0.5.0 <0.9.0`). Its `$comment` says what that
output does that a rebuild must handle:

| File                           | Settings                           | What the metadata does                                         |
| ------------------------------ | ---------------------------------- | -------------------------------------------------------------- |
| `solc-0.8.24-no-cbor.json`     | `metadata.appendCBOR: false`       | Records `bytecodeHash: "ipfs"`, which solc rejects in an input |
| `solc-0.8.3-inliner.json`      | Optimizer on, `details.yul: false` | Records `optimizer.details.inliner`, which solc 0.8.3 rejects  |
| `solc-0.7.0-bare-library.json` | Optimizer off                      | Keys `libraries` by bare name: `Tally`                         |
| `solc-0.5.0-literal.json`      | `metadata.useLiteralContent: true` | Embeds the sources without recording `useLiteralContent`       |

The EVM version differs by tool default: `cancun` for Foundry, `paris` for Hardhat 2, `shanghai`
for Hardhat 3. The library build sets `shanghai` with the optimizer off.

`solc-0.8.24-library/Counter.json` holds what solc returned for `Counter`: `abi`, `bytecode` and
`deployedBytecode` (with `0x`), and `metadata`, the metadata string as solc wrote it.

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

## Checks

- Each build-info input was compiled again with solc 0.8.24, after removing every top-level key
  other than `language`, `sources` and `settings`; the creation and runtime bytecode matched the
  artifact's (2026-11-02).
- Metadata rebuild (#21), 2026-11-03, with solc-js 0.8.24 (`0.8.24+commit.e11b9ed9`): each input
  below was rebuilt with `buildVerifyInput` and compiled again. The creation bytecode, the runtime
  bytecode and the metadata string were equal to the original build's, in all four cases:
  - `foundry-1.8.1/Greeter.json` with the two files of `sources/`;
  - `foundry-1.8.1-literal-viair/Greeter.json` alone (the metadata embeds the sources);
  - the `metadata` string of `contracts/Greeter.sol:Greeter` in `hardhat-2.29.1/build-info.json`,
    with the two files of `sources/`, compared with `hardhat-2.29.1/Greeter.json`;
  - the `metadata` string of `solc-0.8.24-library/Counter.json` with its two source files.
- Older and edge-case solc output (#21), 2026-11-03: the metadata of each file in `solc-legacy/`
  was rebuilt with `buildVerifyInput` and compiled again with the same solc version. The creation
  bytecode, the runtime bytecode and the metadata string equaled the original's for all four.
- Live, 2026-11-03: a contract deployed on Base Sepolia (chain 84532) at
  `0xfB1Ab1b4e6292ff18F43261eFA61Dc61e12AC5Ab`, transaction
  `0x3533fb55c25502029a19a8a284b56c1e974439b54c334835577a28bb0ee10e21`, was verified on Sourcify
  from an input rebuilt from its metadata alone. Sourcify verification job
  `20aa3ede-747e-4c0d-894a-82727372531d` returned `exact_match` for both the creation and the
  runtime bytecode (R-QA-2).
- The unit tests check, on every run, that the IPFS hash at the end of each runtime bytecode is
  the hash of that metadata, and that each metadata records the keccak-256 of the source files.

## Sources

- Foundry build-info format (`ethers-rs-sol-build-info-1`): `crates/compilers/src/buildinfo.rs` at
  foundry-rs/compilers@18b51786, read 2026-11-02, and Foundry 1.8.1 output on 2026-11-02.
- Hardhat 3 build-info, output file and artifact: `packages/hardhat/src/types/solidity/solidity-artifacts.ts`
  and `packages/hardhat/src/types/artifacts.ts` at NomicFoundation/hardhat@51a2cc4f, read
  2026-11-02, and Hardhat 3.21.2 output on 2026-11-02.
- Hardhat 2 build-info and artifact: `types/artifacts.d.ts` in the `hardhat@2.29.1` npm package,
  read 2026-11-02, and Hardhat 2.29.1 output on 2026-11-02.
- Solidity metadata format: [Contract Metadata](https://docs.soliditylang.org/en/v0.8.24/metadata.html)
  in the Solidity 0.8.24 documentation, read 2026-11-03.
