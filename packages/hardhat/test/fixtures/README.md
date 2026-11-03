# Hardhat project fixtures

The `artifacts/` folders of one Hardhat project, built twice on 2026-11-03 with Node 24.21.0 and
solc 0.8.24 (`0.8.24+commit.e11b9ed9`), optimizer on with 200 runs. The tests of
`@explorer-verify/hardhat` use them as project roots (R-DX-2).

| Folder           | Tool and command                      | EVM version (tool default) |
| ---------------- | ------------------------------------- | -------------------------- |
| `hardhat-2.29.1` | Hardhat 2.29.1, `npx hardhat compile` | `paris`                    |
| `hardhat-3.21.2` | Hardhat 3.21.2, `npx hardhat build`   | `shanghai`                 |

## The contracts

Five files in `contracts/`, all in one build:

- `Greeter.sol` and `Base.sol`: the Greeter of the core's build-format fixtures
  (`packages/explorer-verify/test/fixtures/build-formats/sources/`), one contract that inherits
  from another file;
- `Pair.sol`: two contracts in one file, `First` and `Second`;
- `Counter.sol` and `Tally.sol`: `Counter` calls the external library `Tally`, as in the core's
  `solc-0.8.24-library` fixture.

The sources are in each build-info's `input.sources`.

## Changes from the tool output

- Build-info `output` (Hardhat 2) and the `.output.json` file (Hardhat 3): each contract keeps only
  `abi`, and `metadata` when solc wrote it; each source keeps only `id`. The ASTs and `evm` are
  removed to keep the files small. The helper does not read the output, and the core's builder
  reads only the contract names and the metadata.
- Build-info files are written with two-space indentation; Hardhat 2 writes them on one line.
- The `artifacts.d.ts` files that Hardhat 3 writes are left out: they are TypeScript declarations
  that the helper never reads.

Every other file is as the tools wrote it, file names and build ids included. No file holds a path
on the build machine.
