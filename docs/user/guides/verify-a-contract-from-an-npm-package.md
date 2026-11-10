# Verify a contract shipped in an npm package

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who deploy a contract that an SDK ships compiled, and want it verified.

You need: Node.js 22.18 or later, the SDK's build files in `node_modules`, and the deployed
address and chain ID. A dry run needs no API key.

An SDK often ships compiled contracts as JSON files, and you may not know whether Hardhat 2,
Hardhat 3 or Foundry wrote them. `buildVerifyInput` works out what each file is from its shape.
If you write the package and deploy its contracts, see
[Verify contracts your package ships](verify-contracts-your-package-ships.md).

## Install

Install the core:

```bash
npm install explorer-verify
```

## Dry run

Find the build-info file and your contract's artifact in the package; the SDK documents where
they are. Parse both, pass them to `buildVerifyInput` in any order, then dry run the result:

```ts [dry-run.ts]
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { buildVerifyInput, dryRun } from "explorer-verify";

const require = createRequire(import.meta.url);
const read = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(require.resolve(`some-sdk/${file}`), "utf8"));

const built = buildVerifyInput([
  await read("artifacts/build-info/solc-0_8_24-e2aa41ca9499e8400cb1090c69ef55b1cafafa86.json"),
  await read("artifacts/contracts/Greeter.sol/Greeter.json"),
]);
console.log(built.contractName);

const result = await dryRun(
  {
    chainId: 11155111,
    address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
    ...built,
  },
  { route: { backend: "sourcify" } },
);
console.log(result.status, result.backend, result.lookup);
```

The contract name is the Hardhat 3 input source name:

```text
project/contracts/Greeter.sol:Greeter
dry-run sourcify exact
```

The address is the sample Greeter on Sepolia, which Sourcify already holds. Put the address your
deployment returned in its place. `lookup` tells what `verify()` will do:

- `exact` or `partial`: the explorer holds the contract, so nothing is submitted.
- `none`: `verify()` will submit the input.

## Verify

Pass the same input and options to [`verify()`](../reference/verify.md). It submits only when
the lookup finds no match.

> [!WARNING]
> A submit publishes the source on the explorer and cannot be undone.

When the chain ID or the address comes from untyped data, such as parsed JSON, check the whole
input with `validateInput` first. `buildVerifyInput` takes parsed objects, uses no Node API and
sends nothing, so it also runs in a browser on JSON your dapp bundles.

## What to pass

| You have                                         | Pass                             | Options needed                                   |
| ------------------------------------------------ | -------------------------------- | ------------------------------------------------ |
| Hardhat 3 build-info and the contract's artifact | Both files                       | None                                             |
| Hardhat 3 build-info and its `.output.json`      | Both files                       | `contract`, unless one contract is built         |
| Hardhat 2 build-info                             | The build-info, and the artifact | `contract` when no artifact is passed            |
| Foundry build-info (built with `--build-info`)   | The build-info, and the artifact | `contract` when no artifact is passed            |
| A Standard JSON input file                       | The file                         | `contract` as `path:Name`, and `compilerVersion` |
| A Foundry artifact, no build-info                | The artifact                     | `sources`, unless the metadata embeds them       |
| Solidity metadata, as an object or a string      | The metadata                     | `sources`, unless the metadata embeds them       |
| Only artifacts with ABI and bytecode             | Not enough: see below            |                                                  |

The options:

- `contract`: `path:Name`, or a bare `Name` when one contract in the documents has it. A Standard
  JSON input lists no contracts, so it needs `path:Name`. For Hardhat 3, the user source name
  `contracts/Greeter.sol:Greeter` maps to `project/contracts/Greeter.sol:Greeter`.
- `compilerVersion`: the full version, such as `0.8.24+commit.e11b9ed9`. Used only when the
  documents hold no full version.
- `sources`: each source path, as the metadata lists it, mapped to the file's content. Used only
  when the input is rebuilt from metadata.

## Rebuild the input from Solidity metadata

Some packages ship a contract's Solidity metadata instead of its build-info. A Foundry artifact
holds it in `rawMetadata` and `metadata`. The metadata records the compiler version, the
settings, the contract and the keccak-256 hash of each source. With the source files, the builder
rebuilds the Standard JSON input:

```ts [rebuild.ts]
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { buildVerifyInput } from "explorer-verify";

const require = createRequire(import.meta.url);
const text = async (file: string): Promise<string> =>
  readFile(require.resolve(`some-sdk/${file}`), "utf8");

const artifact = JSON.parse(await text("out/Greeter.sol/Greeter.json"));
const built = buildVerifyInput([artifact], {
  sources: {
    "src/Base.sol": await text("src/Base.sol"),
    "src/Greeter.sol": await text("src/Greeter.sol"),
  },
});
console.log(built.contractName); // from settings.compilationTarget
console.log(built.compiler.version); // from compiler.version
```

```text
src/Greeter.sol:Greeter
0.8.24+commit.e11b9ed9
```

Pass each file exactly as it was compiled. The builder compares each source's keccak-256 hash
with the metadata, so a file with other line endings, or one run through a formatter, fails with
`source-mismatch`. Metadata built with `useLiteralContent` embeds the sources, and `sources` is
not needed.

## What the rebuilt input holds

The rebuilt input:

- takes `language` from the metadata;
- copies every setting except `compilationTarget`, with three changes so solc accepts it:
  - with `metadata.appendCBOR: false`, it drops `metadata.bytecodeHash`;
  - for solc 0.8.2 to 0.8.4, it moves `optimizer.details.inliner` to `optimizer.enabled`;
  - when a source embeds its content and `useLiteralContent` is unset, it sets it to `true`;
- turns `libraries` from `{ "path:Name": address }` into `{ path: { Name: address } }`;
- adds an `outputSelection` for the ABI, the bytecode and the metadata;
- takes each source's content from the metadata when it embeds it, else from `sources`.

The version comes from `compiler.version`, and the contract from `settings.compilationTarget`.
With the metadata of several contracts, choose one with `contract`. Metadata for one contract must
list the same sources and hashes. A build-info with its input wins over the metadata.

## How the builder reads the files

It classifies each document by its shape, never by file name or tool name:

| Shape                          | Recognised by                                                       | Gives                                      |
| ------------------------------ | ------------------------------------------------------------------- | ------------------------------------------ |
| Build-info                     | An `input` object with `language`, `sources`, `settings`            | The compiler input; the version            |
| Build-info stub                | `source_id_to_path` and no `input`                                  | Nothing: the error says to rebuild         |
| Build-info output              | An `output.contracts` object and no `input`                         | The contract list; the version             |
| Standard JSON input            | `language`, `sources` and `settings` at the top level               | The compiler input                         |
| Solidity metadata              | A top-level `compiler` or `output`, or `settings.compilationTarget` | The contract, the version, a rebuilt input |
| Artifact with metadata         | `metadata` or `rawMetadata`                                         | The contract, the version, a rebuilt input |
| Artifact with ABI and bytecode | `abi` and `bytecode`, none of the above                             | The contract                               |

Then it checks and cleans the result:

- It keeps only `language`, `sources` and `settings` of the compiler input. Foundry's
  `basePath` holds an absolute path on the build machine, so it is dropped.
- It keeps only `content` and `keccak256` of each source.
- It rejects a local path: absolute, home, drive, file URL, or climbing above the project root.
  The error gives the position, never the path.
- It checks that the documents come from one build: every build ID and full compiler version
  must match. A document passed twice counts once.
- It takes the version from `solcLongVersion` when it holds the commit, else from the metadata,
  else from `compilerVersion`.
- It returns a copy checked by `validateInput`. The order of the documents does not matter.

## When the files are not enough

The builder throws an `ExplorerVerifyError` that says what is missing.
[Errors](../reference/errors/index.md) describes each code.

| Code                    | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `incomplete-input`      | `details.field` names what is missing: `input`, `compilerVersion`, `contract` or `sources`   |
| `source-mismatch`       | A source does not match its keccak-256 hash. `details.path` names it                         |
| `insufficient-artifact` | Only ABI and bytecode: no compiler input or settings                                         |
| `unsupported-compiler`  | A compiler other than solc, or a language other than Solidity                                |
| `invalid-input`         | An unknown shape, files of different builds, a local path, or an input that fails validation |

ABI and bytecode alone cannot be verified: the explorer needs the sources and the exact settings.
Three routes remain:

- Ask the publisher to ship build-info or metadata.
- When the bytecode carries a metadata hash and the metadata is published, use
  [Verify from deployed bytecode](verify-from-deployed-bytecode.md).
- When an identical contract is already verified, rely on the explorer's own matching
  ([automatic matching](../../contributor/research/2026-11-02-explorer-apis.md#automatic-matching-no-submission-needed)).

## Sources

The format facts were checked on 2026-11-02 against these type definitions, and against the
output of Foundry 1.8.1, Hardhat 2.29.1 and Hardhat 3.21.2 for one two-file contract:

- Foundry build-info: [`crates/compilers/src/buildinfo.rs` at foundry-rs/compilers@18b51786](https://github.com/foundry-rs/compilers/blob/18b5178625cdd92e47264410d6597c4179dd1d04/crates/compilers/src/buildinfo.rs),
  read 2026-11-02.
- Hardhat 3 build-info, output file and artifact:
  [`solidity-artifacts.ts`](https://github.com/NomicFoundation/hardhat/blob/51a2cc4f9a6dab9172ec6c4418c4390f4318f079/packages/hardhat/src/types/solidity/solidity-artifacts.ts)
  and [`artifacts.ts`](https://github.com/NomicFoundation/hardhat/blob/51a2cc4f9a6dab9172ec6c4418c4390f4318f079/packages/hardhat/src/types/artifacts.ts)
  at NomicFoundation/hardhat@51a2cc4f, read 2026-11-02.
- Hardhat 2 build-info and artifact: `types/artifacts.d.ts` in the
  [`hardhat@2.29.1`](https://www.npmjs.com/package/hardhat/v/2.29.1) npm package, read 2026-11-02.
- Solidity metadata: [Contract Metadata](https://docs.soliditylang.org/en/v0.8.24/metadata.html)
  in the Solidity 0.8.24 documentation, read 2026-11-03. The input rebuilt from the metadata of
  the test fixtures, compiled again with solc-js 0.8.24, gave the original bytecode and metadata.
- Rebuilt inputs: tested with metadata from solc 0.5.0, 0.7.0, 0.8.3 and 0.8.24. Metadata from
  solc before 0.5.0 is read the same way but is not tested. On 2026-11-03, a contract on Base
  Sepolia was verified on Sourcify from an input rebuilt from its metadata alone, with an exact
  match.
- The test fixtures, with the tool versions and build commands, are in
  `packages/explorer-verify/test/fixtures/build-formats/` in the repository.

## Next steps

- [Verify contracts your package ships](verify-contracts-your-package-ships.md): the publisher's
  side.
- [Verify from deployed bytecode](verify-from-deployed-bytecode.md): when the package ships no
  build files.
- [verify()](../reference/verify.md): every option, and the dry run.
- [Errors](../reference/errors/index.md): each code and its fix.
