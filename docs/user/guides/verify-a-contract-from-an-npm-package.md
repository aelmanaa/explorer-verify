# Verify a contract shipped in an npm package

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who deploy a contract that an SDK ships compiled, and want it verified.
Nothing is released yet. `buildVerifyInput`, `validateInput` and [`verify`](../reference/verify.md) exist.

An SDK often ships compiled contracts as JSON files in its npm package. You may not know whether
Hardhat 2, Hardhat 3 or Foundry produced them. `buildVerifyInput` takes the parsed files, works out
what each one is from its shape, and returns the `compiler` part of the verification input and the
fully qualified contract name.

## Steps

1. Find the build-info file of the build in the package, and the artifact of your contract. The SDK
   documents where they are.
2. Parse them and pass them to `buildVerifyInput`, in any order.
3. Add the chain ID and the deployed address, and check the result with `validateInput`.
4. Pass the input to [`verify`](../reference/verify.md).

```ts
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { buildVerifyInput, validateInput } from "explorer-verify";

const require = createRequire(import.meta.url);
// The SDK documents where its build-info and artifacts live in the package.
const read = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(require.resolve(`some-sdk/${file}`), "utf8"));
// The address your deployment returned.
const deployedAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

const built = buildVerifyInput([
  await read("artifacts/build-info/solc-0_8_24-e2aa41ca.json"),
  await read("artifacts/contracts/Greeter.sol/Greeter.json"),
]);
// built.contractName: "project/contracts/Greeter.sol:Greeter" (Hardhat 3 input source name)

const input = validateInput({ chainId: 11155111, address: deployedAddress, ...built });

// verify() looks the contract up and submits the input only when the explorer lacks it.
// const result = await verify(input);
```

The file reads are yours. `buildVerifyInput` itself takes parsed objects and uses no Node API, so it
also runs in a browser, for example on JSON your dapp bundles. It sends nothing.

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

`options.contract` is `path:Name`, or a bare `Name` when exactly one contract in the documents has
that name. A bare Standard JSON input lists no contracts, so it needs `path:Name`. For Hardhat 3, the user source name (`contracts/Greeter.sol:Greeter`) also works: it is
mapped to the input source name (`project/contracts/Greeter.sol:Greeter`). `options.compilerVersion`
is the full version, such as `0.8.24+commit.e11b9ed9`. It is used only when the documents hold no
full version. `options.sources` maps each source path, as the metadata lists it, to the file's
content. It is used only when the input is rebuilt from metadata.

## Rebuild the input from Solidity metadata

Some packages ship the Solidity metadata of a contract instead of its build-info: a Foundry
artifact holds it in `rawMetadata` and `metadata`, and a build-info output holds it as a string per
contract. The metadata is the JSON whose hash solc appends to the bytecode. It records the compiler
version, the settings, the contract and the keccak-256 hash of each source file. With the source
files, the builder rebuilds the Standard JSON input that produced the bytecode.

```ts
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { buildVerifyInput } from "explorer-verify";

const require = createRequire(import.meta.url);
const text = async (file: string): Promise<string> =>
  readFile(require.resolve(`some-sdk/${file}`), "utf8");

const built = buildVerifyInput([JSON.parse(await text("out/Greeter.sol/Greeter.json"))], {
  sources: {
    "src/Base.sol": await text("src/Base.sol"),
    "src/Greeter.sol": await text("src/Greeter.sol"),
  },
});
// built.contractName: "src/Greeter.sol:Greeter", from settings.compilationTarget
// built.compiler.version: "0.8.24+commit.e11b9ed9", from compiler.version
```

Pass each file exactly as it was compiled. The builder hashes each source's UTF-8 bytes with
keccak-256 and compares the hash with the metadata before it returns. A file with other line
endings, or one run through a formatter, fails with `source-mismatch`. When the metadata was built
with `useLiteralContent` (Foundry's `use_literal_content = true`), it embeds the sources and
`options.sources` is not needed.

The rebuilt input:

- takes `language` from the metadata;
- copies every setting from the metadata (`optimizer`, `evmVersion`, `remappings`, `metadata`,
  `viaIR`, `debug`) except `compilationTarget`, with three changes so solc accepts the input:
  - with `metadata.appendCBOR: false`, it drops `metadata.bytecodeHash`, which solc records but
    rejects in an input;
  - for solc 0.8.2 to 0.8.4, it moves `optimizer.details.inliner` to `optimizer.enabled`: those
    versions record the key but reject it;
  - when a source embeds its content and `metadata.useLiteralContent` is unset, as solc 0.5.0 and
    earlier write it, it sets `useLiteralContent` to `true`;
- turns `libraries` from `{ "path:Name": address }` into `{ path: { Name: address } }`. A bare
  `Name`, as solc 0.7.4 and earlier write it, goes under the empty path `""`;
- adds an `outputSelection` for the ABI, the bytecode and the metadata;
- takes each source's content from the metadata when it embeds it, else from `options.sources`.
  Embedded content wins over `options.sources`.

The version comes from `compiler.version` and the contract from `settings.compilationTarget`,
which must name exactly one contract. When you pass the metadata of several contracts, choose one
with `options.contract`. In a rebuild, `options.contract` must name that target, as `path:Name` or
as `Name`. Metadata documents for one contract must list the same sources with the same hashes.
When a build-info with its input is passed too, the build-info's input is used and
`options.sources` is ignored.

Tested with metadata from solc 0.5.0, 0.7.0, 0.8.3 and 0.8.24: the rebuilt input compiled with the
same version gave the original bytecode and metadata. Metadata from solc before 0.5.0 is read the
same way but is not tested. On 2026-11-03, a contract on Base Sepolia was verified on Sourcify
from an input rebuilt from its metadata alone, with an exact match.

## What the builder does

It classifies each document by its shape, never by file name or tool name:

| Shape                          | Recognised by                                                                                             | Gives                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Build-info                     | An `input` object with `language`, `sources`, `settings`                                                  | The compiler input; the version from `solcLongVersion`                |
| Build-info stub                | `source_id_to_path` and no `input`                                                                        | Nothing: the error says to rebuild with build-info                    |
| Build-info output              | An `output.contracts` object and no `input`                                                               | The contract list; the version from contract metadata                 |
| Standard JSON input            | `language`, `sources` and `settings` at the top level                                                     | The compiler input                                                    |
| Solidity metadata              | A top-level `compiler` or `output` object, or `settings.compilationTarget`, in an object or a JSON string | The contract and the version; without a build-info, the rebuilt input |
| Artifact with metadata         | `metadata` or `rawMetadata` (read first)                                                                  | The contract and the version; without a build-info, the rebuilt input |
| Artifact with ABI and bytecode | `abi` and `bytecode`, none of the above                                                                   | The contract (`inputSourceName` or `sourceName`)                      |

Then it:

- keeps only `language`, `sources` and `settings` of the compiler input. Foundry adds `version`,
  `allowPaths`, `basePath` and `includePaths`; `basePath` is an absolute path on the build
  machine, so publishing it would leak a local path. The input reproduces the bytecode without them.
- keeps only `content`, and `keccak256` when present, of each source. Other fields, such as
  `urls`, may hold a local path.
- rejects a local path, for the same reason: an absolute, home, drive or file-URL path, or a
  path whose `..` segments climb above the project root. It checks the source paths, both sides
  of each remapping, and the keys of `settings.libraries` and `settings.outputSelection`. The
  error gives the position, never the path.
- checks that the documents come from one build: every build id they carry (a build-info's or
  output file's `id`, an artifact's `buildInfoId`) and every full compiler version must match.
  A document passed twice counts once.
- takes the version from `solcLongVersion` when it holds the commit, else from the contract
  metadata, else from `options.compilerVersion`. Foundry writes only `0.8.24` in `solcLongVersion`;
  the full version is in the metadata of its build-info output and of its artifacts.
- takes the contract from `options.contract`, else from the one contract an artifact points at,
  else from the one contract the documents list. Hardhat 3 prefixes input source names with
  `project/`; its artifact's `inputSourceName` holds that name and `sourceName` does not, so the
  builder uses `inputSourceName`.
- returns a copy checked by `validateInput`. The order of the documents does not change the result.

## When the files are not enough

The builder throws an `ExplorerVerifyError` that says what is missing. See
[Errors](../reference/errors/index.md) for each code.

| Code                    | Meaning                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `incomplete-input`      | `details.field` names what is missing: `input`, `compilerVersion`, `contract` or `sources`, with the names or paths in `details.candidates`         |
| `source-mismatch`       | A source file does not match the keccak-256 hash in the metadata. `details.path` names it; `details.expected` and `details.actual` hold the hashes  |
| `insufficient-artifact` | Only ABI and bytecode: no compiler input or settings. The hint lists the routes left                                                                |
| `unsupported-compiler`  | A compiler other than solc, or a language other than Solidity                                                                                       |
| `invalid-input`         | A document of no known shape, documents of different builds or versions, a path not in the sources, a local path, or an input that fails validation |

ABI and bytecode alone cannot be verified: the explorer needs the sources and the exact settings.
Three routes remain: ask the publisher to ship build-info or metadata; use the bytecode-metadata
resolver (planned), when the bytecode carries a metadata hash and the metadata is published; or rely
on the explorer's own matching (Etherscan Similar Match, Sourcify similarity; see
[automatic matching](https://github.com/aelmanaa/explorer-verify/blob/main/docs/contributor/research/2026-11-02-explorer-apis.md#automatic-matching-no-submission-needed)),
when an identical contract is already verified.

## Sources

The format facts above were checked on 2026-11-02 against these type definitions and against
output of Foundry 1.8.1, Hardhat 2.29.1 and Hardhat 3.21.2 built from one two-file contract:

- Foundry build-info: [`crates/compilers/src/buildinfo.rs` at foundry-rs/compilers@18b51786](https://github.com/foundry-rs/compilers/blob/18b5178625cdd92e47264410d6597c4179dd1d04/crates/compilers/src/buildinfo.rs),
  read 2026-11-02.
- Hardhat 3 build-info, output file and artifact:
  [`solidity-artifacts.ts`](https://github.com/NomicFoundation/hardhat/blob/51a2cc4f9a6dab9172ec6c4418c4390f4318f079/packages/hardhat/src/types/solidity/solidity-artifacts.ts)
  and [`artifacts.ts`](https://github.com/NomicFoundation/hardhat/blob/51a2cc4f9a6dab9172ec6c4418c4390f4318f079/packages/hardhat/src/types/artifacts.ts)
  at NomicFoundation/hardhat@51a2cc4f, read 2026-11-02.
- Hardhat 2 build-info and artifact: `types/artifacts.d.ts` in the
  [`hardhat@2.29.1`](https://www.npmjs.com/package/hardhat/v/2.29.1) npm package, read 2026-11-02.
- Solidity metadata: [Contract Metadata](https://docs.soliditylang.org/en/v0.8.24/metadata.html)
  in the Solidity 0.8.24 documentation, read 2026-11-03. On 2026-11-03, the input rebuilt from the
  metadata of the Foundry, Hardhat 2 and linked-library fixtures was compiled again with solc-js
  0.8.24; the bytecode and the metadata equaled the original build's.
- The test fixtures, with the tool versions and build commands, are in
  `packages/explorer-verify/test/fixtures/build-formats/` in the repository.
