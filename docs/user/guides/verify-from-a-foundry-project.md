# Verify a contract from a Foundry project

Version: explorer-verify 0.2.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who build with Foundry and verify a contract from TypeScript code.

You need: Node.js 22.18 or later, a Foundry project, and the contract's address and chain ID. A
dry run needs no API key.

> [!TIP]
> To verify from the command line only, follow
> [Quickstart: a Foundry project](../start/quickstart-foundry.md). It needs no install.

## Install

Install the core and the Foundry helper:

```bash
npm install explorer-verify @explorer-verify/foundry
```

`explorer-verify` is a peer dependency of the helper, so the project keeps one copy of the core.
Then `error instanceof ExplorerVerifyError` works for the errors the helper throws.

## Build with build-info

Run the build in the project root:

```bash
forge build --build-info
```

The helper reads files only. It runs no `forge` command and does not read `foundry.toml`. A
default `forge build` also works, with limits: see
[Build-info or a default build](#build-info-or-a-default-build).

## Dry run

`buildVerifyInputFromFoundry` reads the build of one contract. `dryRun()` then looks the contract
up and says what `verify()` would do, without a submit:

```ts [dry-run.ts]
import { buildVerifyInputFromFoundry } from "@explorer-verify/foundry";
import { dryRun } from "explorer-verify";

const built = await buildVerifyInputFromFoundry({
  root: ".",
  contract: "src/Greeter.sol:Greeter",
});
console.log(built.contractName, built.compiler.version);

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

```text
src/Greeter.sol:Greeter 0.8.24+commit.e11b9ed9
dry-run sourcify exact
```

The address is the sample Greeter on Sepolia, which Sourcify already holds. Put your own address
and chain ID in its place. `lookup` tells what `verify()` will do:

- `exact` or `partial`: the explorer holds the contract, so nothing is submitted.
- `none`: `verify()` will submit the input.

## Verify

Call `verify()` with the same input and options:

```ts [verify.ts]
import { buildVerifyInputFromFoundry } from "@explorer-verify/foundry";
import { verify } from "explorer-verify";

const built = await buildVerifyInputFromFoundry({
  root: ".",
  contract: "src/Greeter.sol:Greeter",
});
const result = await verify(
  {
    chainId: 11155111,
    address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
    ...built,
  },
  { route: { backend: "sourcify" } },
);
console.log(result.status);
```

```text
already-verified
```

> [!WARNING]
> A submit publishes the source on the explorer and cannot be undone.

`built` has no `chainId` and no `address`, so `verify(built)` does not compile. When either comes
from untyped data, such as parsed JSON or command-line arguments, check the whole input with
`validateInput` first.

## From the command line

`@explorer-verify/cli` calls this helper when you pass `--foundry` and `--contract`. In the
project root, after the build:

```sh [dry-run.sh]
# exit code 0
npx @explorer-verify/cli verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \
  --chain 11155111 --foundry . --contract src/Greeter.sol:Greeter \
  --backend sourcify --dry-run --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"caller"}}
```

Drop `--dry-run` to submit. `--out-dir` and `--artifact` set the options of the same names
below. No flag sets `buildInfoDir`. The [CLI reference](../reference/cli.md#verify) lists every
option.

## Options

| Option            | Default               | Meaning                                                                       |
| ----------------- | --------------------- | ----------------------------------------------------------------------------- |
| `root`            | required              | The folder that holds `foundry.toml`, absolute or relative to the process     |
| `contract`        | required              | `path:Name`, such as `src/Greeter.sol:Greeter`, or a bare unique `Name`       |
| `outDir`          | `out`                 | The build output folder. Pass it when `foundry.toml` sets `out`               |
| `buildInfoDir`    | `<outDir>/build-info` | The build-info folder. When you pass it, it must exist                        |
| `artifact`        | none                  | The contract's artifact file. It replaces the search under `outDir`           |
| `compilerVersion` | none                  | Passed to `buildVerifyInput`. `buildVerifyInputFromFoundry` only              |
| `sources`         | none                  | Source contents by path, passed to `buildVerifyInput`. The same function only |

`outDir`, `buildInfoDir` and `artifact` are relative to `root`, or absolute. A field set to
`undefined` counts as absent. Any other key throws `invalid-input` before a file is read, and
names the option it may mean.

The path in `contract` is the source path relative to the root, as Foundry writes it in the
metadata. A leading `./` and backslashes are accepted. `@explorer-verify/hardhat` takes the same
options except `buildInfoDir`.

## One contract, several compiler versions

Foundry can compile one file with two compiler versions. It then writes one artifact per version,
such as `Context.0.8.20.json` and `Context.0.8.24.json`, and `contract` alone cannot choose. The
error lists both files, and `forge clean` does not help. Pass the artifact of the build you
deployed:

```ts [pick-version.ts]
import { buildVerifyInputFromFoundry } from "@explorer-verify/foundry";

const built = await buildVerifyInputFromFoundry({
  root: ".",
  contract: "lib/utils/Context.sol:Context",
  artifact: "out/Context.sol/Context.0.8.20.json",
});
console.log(built.compiler.version);
```

```text
0.8.20+commit.a1b79de6
```

The helper then takes the build-info whose metadata for the contract equals that artifact's, so
the input comes from the same compile.

## What it reads

The helper works in four steps:

1. **The artifact.** Without the `artifact` option, it searches `outDir` for `Name.json` or
   `Name.<suffix>.json`. When `contract` has a path, it looks under a folder named after the
   source file. It skips `Name.metadata.json`.
2. **The match.** It keeps the artifacts whose Solidity metadata names the contract in
   `settings.compilationTarget`. When two source files share a file name, the metadata tells them
   apart. The search never follows a symbolic link and goes at most 32 folders deep.
3. **The build-info.** It reads `buildInfoDir` in name order and takes the first file whose
   `output.contracts` lists the contract with the artifact's metadata. A build-info from another
   build has other metadata and is skipped.
4. **The sources**, only when no build-info lists the contract. It reads each source file the
   metadata lists, from the root, and `buildVerifyInput` rebuilds the input from the metadata.

A source file is read only when it is a regular file of at most 16 MB inside the root, after
symbolic links. A file that fails this check is left out, and `buildVerifyInput` reports it as
missing. `buildVerifyInput` checks each source's keccak-256 hash against the metadata.

The helper trusts the files under `outDir` and `buildInfoDir`, and parses each one up to 256 MB.

## Read the files without building the input

`findFoundryBuild` runs the same search and returns what it found:

```ts [find-build.ts]
import { findFoundryBuild } from "@explorer-verify/foundry";
import { buildVerifyInput } from "explorer-verify";

const build = await findFoundryBuild({ root: ".", contract: "Greeter" });
console.log(build.contract);
console.log(build.files.join("\n"));
const built = buildVerifyInput(build.documents, {
  contract: build.contract,
  sources: build.sources,
});
```

After `forge build --build-info`, it prints:

```text
src/Greeter.sol:Greeter
out/Greeter.sol/Greeter.json
out/build-info/cc03796b40982b2b.json
```

The result has four fields:

- `contract`: the contract as `path:Name`.
- `documents`: the parsed artifact, then the parsed build-info when one was found.
- `sources`: the source contents by path when no build-info was found, else empty.
- `files`: the files read, relative to the root. A file outside the root starts with `..`.

`findHardhatBuild` returns the same shape.

## Build-info or a default build

Prefer `forge build --build-info`. The input then comes from the build-info as solc received it,
and no source file on disk is read.

A default `forge build` writes a build-info stub without the compiler input. The helper then
rebuilds the input from the artifact's metadata and the source files, which must be on disk and
unchanged since the build. The result differs in two ways:

- it holds only the sources the contract needs, not every file of the compile;
- a linked library's address in `settings.libraries` is in lower case, as the metadata records it.

A contract in `test/` or `script/` that deploys another contract needs `--build-info`. Its
metadata can list a source under `foundry-pp/`, which Foundry generates and does not keep. A
default build then fails with `incomplete-input` naming that file.

## Linked libraries

Foundry links libraries after compiling, unless `foundry.toml` sets `libraries`. Submit the input
as it is: adding the addresses to `settings.libraries` changes the metadata hash, and Sourcify then
gives only a partial match.

To record the addresses, pass them in the input's `libraries` field. See
[Linked libraries](../reference/verify.md#linked-libraries).

## Errors

Every error is an `ExplorerVerifyError` from `explorer-verify`.
[Errors](../reference/errors/index.md) describes each code.

| Code                    | When                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `invalid-input`         | A bad option or folder; no artifact or several match; a file too large, unreadable or not JSON |
| `incomplete-input`      | No build-info lists the contract, and a source file is missing. Run `forge build --build-info` |
| `source-mismatch`       | No build-info lists the contract, and a source file changed since the build                    |
| `insufficient-artifact` | The artifact holds no metadata, and no build-info lists the contract                           |

With several matches, the issue lists each `path:Name` and its file. An `incomplete-input` error
lists the missing paths in `details.candidates`. A file that cannot be read gives `invalid-input`
with its path relative to the root, and keeps the Node error as `cause`. Errors from
`buildVerifyInput` pass through unchanged.

## Sources

- Tested with Foundry 1.8.1 and solc 0.8.24 on 2026-11-03: a contract that inherits from another
  file, two contracts in one file, a linked library, and two contracts named `Token` in different
  folders. Each gave the same input as `buildVerifyInput` on the same files, after
  `forge build --build-info` and after a default build.
- A library file built with solc 0.8.20 and 0.8.24 in one build, on 2026-11-03: with `artifact`,
  each version's input equals the one built by hand.
- Linked libraries: in a live test on 2026-11-03, Sourcify gave only a partial match when the
  addresses were added to `settings.libraries`.

## Next steps

- [Quickstart: a Foundry project](../start/quickstart-foundry.md): the same flow from the command
  line.
- [Verify from CI with the CLI](verify-from-ci-with-the-cli.md): keys, exit codes and a workflow.
- [verify()](../reference/verify.md): every option, and the dry run.
- [Errors](../reference/errors/index.md): each code and its fix.
