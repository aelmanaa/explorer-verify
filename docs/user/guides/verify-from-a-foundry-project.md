# Verify a contract from a Foundry project

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who build with Foundry and want the verification input for one contract.
Nothing is released yet. `@explorer-verify/foundry` 0.0.0 exists in the repository and needs
Node 22.18 or later.

After `forge build`, the files that verification needs are under `out/`: one artifact per contract
and, with `--build-info`, one build-info file per compile. `@explorer-verify/foundry` finds the
files of one contract, parses them and passes them to `buildVerifyInput` from `explorer-verify`.
The format checks all happen in `buildVerifyInput`; the helper only picks and reads files. It runs
no `forge` command and does not read `foundry.toml`.

## Install

Install both packages: `explorer-verify` and `@explorer-verify/foundry`. The helper declares
`explorer-verify` as a peer dependency, so it uses your copy of the core. With one copy,
`error instanceof ExplorerVerifyError` works for the errors the helper throws.

## Steps

1. Build with build-info in the project root: `forge build --build-info`.
2. Call `verifyInputFromFoundry` with the project root and the contract.
3. Add the chain ID and the deployed address, and check the result with `validateInput`.
4. Pass the input to [`verify`](../reference/verify.md).

```ts
import { verifyInputFromFoundry } from "@explorer-verify/foundry";
import { validateInput } from "explorer-verify";

const built = await verifyInputFromFoundry({
  root: ".",
  contract: "src/Greeter.sol:Greeter",
});
// built.contractName: "src/Greeter.sol:Greeter"
// built.compiler.version: "0.8.24+commit.e11b9ed9"

const input = validateInput({
  chainId: 11155111,
  address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  ...built,
});

// verify() looks the contract up and submits the input only when the explorer lacks it.
// const result = await verify(input);
```

## Options

| Option         | Default            | Meaning                                                                                                                     |
| -------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `root`         | required           | The project root, the directory that holds `foundry.toml`. A relative path resolves against the process's working directory |
| `contract`     | required           | `path:Name`, such as `src/Greeter.sol:Greeter`, or a bare `Name` that matches one artifact                                  |
| `out`          | `out`              | The output directory of the build, relative to `root` or absolute. Pass it when `foundry.toml` sets `out`                   |
| `buildInfoDir` | `<out>/build-info` | The build-info directory, relative to `root` or absolute. When you pass it, it must exist                                   |
| `artifact`     | none               | The contract's artifact file, relative to `root` or absolute. It replaces the search under `out`                            |

The path in `contract` is the source path relative to the root, as Foundry writes it in the
metadata. A leading `./` and backslashes are accepted.

## One contract, several compiler versions

When sources need different compiler versions, Foundry can compile one file with each of them.
It then writes one artifact per version, such as `out/Context.sol/Context.0.8.20.json` and
`out/Context.sol/Context.0.8.24.json`. Both name the same contract, so `contract` alone cannot
choose. The error lists both files, and `forge clean` does not help: the next build writes both
again. Pass the file of the build you deployed:

```ts
import { verifyInputFromFoundry } from "@explorer-verify/foundry";

const built = await verifyInputFromFoundry({
  root: ".",
  contract: "lib/utils/Context.sol:Context",
  artifact: "out/Context.sol/Context.0.8.20.json",
});
// built.compiler.version: "0.8.20+commit.a1b79de6"
```

The helper then takes the build-info whose metadata for the contract equals that artifact's, so
the input comes from the same compile.

## What it reads

1. The artifact. Without the `artifact` option, it looks under `out` for files named
   `Name.json` or `Name.<suffix>.json`, in a directory named after the source file when
   `contract` has a path. It skips `Name.metadata.json`, which `extra_output_files = ["metadata"]`
   writes. It keeps the files that hold `abi`, `bytecode` or `deployedBytecode` and whose Solidity
   metadata names the contract in `settings.compilationTarget`. When two source files share a
   file name, Foundry writes the second artifact under more of its path, such as
   `out/b/Token.sol/Token.json`; the metadata tells them apart. The search never follows a
   symbolic link and goes at most 32 directories deep.
2. The build-info. It reads the files in `buildInfoDir` in name order and takes the first whose
   `output.contracts` lists the contract with the same metadata string as the artifact. A
   build-info from another build of the contract has other metadata and is skipped.
3. The sources, only when no build-info lists the contract. A default `forge build` writes a stub
   build-info (`id`, `source_id_to_path` and `language`) without the compiler input. Then the
   helper reads each source file that the artifact's metadata lists, from the root, and
   `buildVerifyInput` rebuilds the input from the metadata. It reads a file only when it is a
   regular file of at most 16 MB whose real path, after symbolic links, is under the root. A
   source that fails this check is left out, and `buildVerifyInput` reports it as missing.

The helper trusts the files under `out` and `buildInfoDir`: it parses them as they are, up to
256 MB each. It does not check the source contents it reads. `buildVerifyInput` checks each
source's keccak-256 hash against the metadata.

`findFoundryBuild` does steps 1 to 3 and returns what it found, without building the input:

```ts
import { findFoundryBuild } from "@explorer-verify/foundry";
import { buildVerifyInput } from "explorer-verify";

const build = await findFoundryBuild({ root: ".", contract: "Greeter" });
// build.contract: "src/Greeter.sol:Greeter"
// build.files: {
//   artifact: "out/Greeter.sol/Greeter.json",
//   buildInfo: "out/build-info/cc03796b40982b2b.json",
//   sources: [],
// }
const built = buildVerifyInput(build.documents, {
  contract: build.contract,
  sources: build.sources,
});
```

`build.documents` holds the parsed artifact, then the parsed build-info when one was found.
`build.sources` holds the source contents by path when no build-info was found, else it is empty.
The paths in `build.files` are relative to the root; a file outside the root, such as an `out`
directory elsewhere, gets a path that starts with `..`. `buildVerifyInput` still rejects any local
path in the input.

## Build-info or a default build

Prefer `forge build --build-info`. The input then comes from the build-info as solc received it,
and the source files on disk are not read.

After a default `forge build`, the input is rebuilt from the artifact's metadata and the source
files. It works when every source file is on disk, unchanged since the build. Two differences from
the build-info input:

- the input holds only the sources the contract needs, not every file of the compile;
- Solidity metadata records a linked library's address in lower case, so `settings.libraries`
  holds it in lower case. The address is the same.

A contract in `test/` or `script/` that deploys another contract needs `--build-info`. Its
metadata can list a source under `foundry-pp/`, which Foundry generates for the compile and does
not write to the project. After a default build, the rebuild fails with `incomplete-input` naming
that file.

## Errors

Every error is an `ExplorerVerifyError` from `explorer-verify`. See
[Errors](../reference/errors/index.md) for each code.

| Code                    | When                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-input`         | An option is not valid; `root`, `out` or a passed `buildInfoDir` is not a directory; no artifact matches (with a wrong path, the issue lists the contracts of that name); more than one matches (the issue lists each `path:Name` and its file); the `artifact` file is not the contract's artifact; a file is too large, cannot be read or is not JSON |
| `incomplete-input`      | No build-info lists the contract and a source file the metadata lists is missing. `details.candidates` lists the paths, and the hint says to run `forge build --build-info`                                                                                                                                                                             |
| `source-mismatch`       | No build-info lists the contract and a source file changed since the build. The hint says to run `forge build --build-info`                                                                                                                                                                                                                             |
| `insufficient-artifact` | The artifact holds no metadata and no build-info lists the contract                                                                                                                                                                                                                                                                                     |

A file that cannot be read gives `invalid-input` with the file's path relative to the root; the
Node error is kept as the error's `cause`. Any other error from `buildVerifyInput` passes through
unchanged.

## Tested with

Foundry 1.8.1, on 2026-11-03, with solc 0.8.24: one contract that inherits from another file, two
contracts in one file, a contract linked to an external library, and two contracts named `Token`
in different directories. For each, the helper gave the same result as passing the same files to
`buildVerifyInput` by hand, after `forge build --build-info` and after a default `forge build`.
Also a library file built with solc 0.8.20 and 0.8.24 in one build, with
`extra_output_files = ["metadata"]`: with the `artifact` option, each version's input equals the
one built by hand from that version's artifact and build-info.
