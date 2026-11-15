# Verify a contract from a Hardhat project

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers with a Hardhat 2 or Hardhat 3 project who verify a contract from TypeScript code.

You need: Node.js 22.18 or later, a compiled Hardhat project, and the contract's address and
chain ID. A dry run needs no API key.

> [!TIP]
> To verify from the command line only, follow
> [Quickstart: a Hardhat project](../start/quickstart-hardhat.md). It needs no install.

`@explorer-verify/hardhat` is not a Hardhat plugin. It reads the build files under `artifacts/`,
needs no change to the Hardhat config and does not load the `hardhat` package. It works alongside
`hardhat-verify`.

## Install

Install the core and the Hardhat helper:

```bash
npm install explorer-verify @explorer-verify/hardhat
```

`explorer-verify` is a peer dependency of the helper, so the project keeps one copy of the core.
Then `error instanceof ExplorerVerifyError` works for the errors the helper throws.

## Build with the deploy profile

> [!WARNING]
> The build files must come from the build that produced the deployed bytecode. Hardhat Ignition
> deploys with the `production` profile, and a default `npx hardhat build` uses `default`. Their
> metadata hash, and often their bytecode, differ, so the explorer rejects the input or gives
> only a partial match.

On Hardhat 3, build with the profile you deployed with:

```bash
npx hardhat build --build-profile production
```

Unless the config sets them, the `production` profile turns the optimizer on, compiles each
contract in its own job, and records the tool versions in the build-info. On Hardhat 2, run
`npx hardhat compile`.

## Dry run

`buildVerifyInputFromHardhat` reads the build of one contract. `dryRun()` then looks the contract
up and says what `verify()` would do, without a submit:

```ts [dry-run.ts]
import { buildVerifyInputFromHardhat } from "@explorer-verify/hardhat";
import { dryRun } from "explorer-verify";

const built = await buildVerifyInputFromHardhat({
  root: ".",
  contract: "contracts/Greeter.sol:Greeter",
});
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

On Hardhat 3 the name is the input source name, which adds `project/`:

```text
project/contracts/Greeter.sol:Greeter
dry-run sourcify exact
```

On Hardhat 2 the first line is `contracts/Greeter.sol:Greeter`.

The address is the sample Greeter on Sepolia, which Sourcify already holds. Put your own address
and chain ID in its place. `lookup` tells what `verify()` will do:

- `exact` or `partial`: the explorer holds the contract, so nothing is submitted.
- `none`: `verify()` will submit the input.

## Verify

Call `verify()` with the same input and options:

```ts [verify.ts]
import { buildVerifyInputFromHardhat } from "@explorer-verify/hardhat";
import { verify } from "explorer-verify";

const built = await buildVerifyInputFromHardhat({
  root: ".",
  contract: "contracts/Greeter.sol:Greeter",
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
from untyped data, such as parsed JSON, check the whole input with `validateInput` first.

## From the command line

`@explorer-verify/cli` calls this helper when you pass `--hardhat` and `--contract`. In the
project folder, after the build:

```sh [dry-run.sh]
npx @explorer-verify/cli verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \
  --chain 11155111 --hardhat . --contract contracts/Greeter.sol:Greeter \
  --backend sourcify --dry-run --json
```

It exits 0 and prints:

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"caller"}}
```

Drop `--dry-run` to submit. `--out-dir` and `--artifact` set the options of the same names
below. The [CLI reference](../reference/cli.md#verify) lists every option.

## Options

| Option            | Required | What it is                                                                         |
| ----------------- | -------- | ---------------------------------------------------------------------------------- |
| `root`            | Yes      | The project folder, absolute or relative to the working directory                  |
| `contract`        | Yes      | `path:Name`, such as `contracts/Greeter.sol:Greeter`, or a bare unique `Name`      |
| `outDir`          | No       | The artifacts folder. Defaults to `artifacts`. Pass the config's `paths.artifacts` |
| `artifact`        | No       | The contract's `<Name>.json` artifact inside `outDir`. It replaces the search      |
| `compilerVersion` | No       | Passed to `buildVerifyInput`, which checks it against the build-info               |
| `sources`         | No       | Passed to `buildVerifyInput`. Rarely needed: a build-info holds every source       |

`outDir` and `artifact` are relative to `root`, or absolute. `compilerVersion` and `sources` apply
to `buildVerifyInputFromHardhat` only. A field set to `undefined` counts as absent. Any other key
throws `invalid-input` before a file is read, and names the option it may mean.

`@explorer-verify/foundry` takes the same options, and also `buildInfoDir`.

## Contract names on Hardhat 3

The `path` in `contract` is the source path of the artifact folder, such as
`contracts/Greeter.sol`, on both versions. On Hardhat 3 the returned name is the input source
name, with `project/` in front.

You can pass that name back as `contract`. When no artifact exists under `artifacts/project/`, the
helper drops the leading `project/`. A bare `Name` is searched for in the artifacts folder,
outside `build-info/`, without following symbolic links.

## Which files it reads

| Version   | Files                                                                                |
| --------- | ------------------------------------------------------------------------------------ |
| Hardhat 3 | The artifact, the build-info `<id>.json` and its output file `<id>.output.json`      |
| Hardhat 2 | The artifact, and the build-info that `<Name>.dbg.json`, next to the artifact, names |

The artifact is `<outDir>/<path>/<Name>.json`, and the build-info is under
`<outDir>/build-info/`. On Hardhat 3, `<id>` is the artifact's `buildInfoId`. The version is
detected per contract: an artifact with `buildInfoId` is read as Hardhat 3.

Each file must be a regular file inside the artifacts folder, after symbolic links, and at most
256 MiB. A Hardhat 2 `buildInfo` path must point into `<outDir>/build-info/`.

## Read the files without building the input

`findHardhatBuild` takes the same options and returns what it found:

```ts [find-build.ts]
import { findHardhatBuild } from "@explorer-verify/hardhat";
import { buildVerifyInput } from "explorer-verify";

const build = await findHardhatBuild({ root: ".", contract: "Greeter" });
console.log(build.files.join("\n"));
const built = buildVerifyInput(build.documents);
```

On Hardhat 3 it prints the artifact, the build-info and its output file:

```text
artifacts/contracts/Greeter.sol/Greeter.json
artifacts/build-info/solc-0_8_24-2c15e64bd16481586acae188ce2eaa479a4781e0.json
artifacts/build-info/solc-0_8_24-2c15e64bd16481586acae188ce2eaa479a4781e0.output.json
```

The result has the shape `findFoundryBuild` returns, with an empty `sources`. Its `files` are
relative to `root`. The helper holds no format logic:
`buildVerifyInput` reads the compiler input, the version and the contract name.

## Linked libraries

Hardhat links libraries when it deploys, not when it compiles. The build-info's `settings` has no
`libraries`, and the artifact records each link in `linkReferences`.

To record the addresses, pass them in `libraries`, keyed by `path:Name`:

```ts [libraries.ts]
import { buildVerifyInputFromHardhat } from "@explorer-verify/hardhat";
import type { VerifyInput } from "explorer-verify";

const built = await buildVerifyInputFromHardhat({
  root: ".",
  contract: "contracts/Counter.sol:Counter",
});
// linkReferences: { "project/contracts/Tally.sol": { Tally: [...] } }
const input: VerifyInput = {
  chainId: 11155111,
  address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  ...built,
  libraries: {
    "project/contracts/Tally.sol:Tally":
      "0x5a0b54d5dc17e0aadc383d2db43b0a0d3e029c4c",
  },
};
console.log(JSON.stringify(input.libraries));
```

On Hardhat 3 it prints the address in lower case:

```text
{"project/contracts/Tally.sol:Tally":"0x5a0b54d5dc17e0aadc383d2db43b0a0d3e029c4c"}
```

`verify()` submits the compiler input unchanged. Adding the addresses to `settings.libraries`
changes the metadata hash, and Sourcify then gives only a partial match. For an explorer that
needs them there, `linkLibraries(input)` adds them. See
[Linked libraries](../reference/verify.md#linked-libraries).

## Errors

The helper throws an `ExplorerVerifyError`. [Errors](../reference/errors/index.md) describes each
code.

| Code               | When                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `invalid-input`    | A bad option or folder; no artifact; a file that is not JSON, too large or outside the folder |
| `incomplete-input` | A bare name matches several artifacts, or a build-info, output or `.dbg.json` file is missing |

Each `invalid-input` message names the option or the file, for example:

```text
The input is invalid: contract matches no artifact: artifacts/contracts/Missing.sol/Missing.json does not exist.
```

For `incomplete-input`, `details.field` is `contract` for several matches, which
`details.candidates` lists. It is `input` for a missing file. Errors from `buildVerifyInput` pass through.
An artifact left from an older build gives `invalid-input` on `contract`: compile again.

## Sources

- Tested on 2026-11-03 with the output of Hardhat 2.29.1 and Hardhat 3.21.2: one contract, two
  contracts in one file, and a contract that calls an external library. Tested on macOS and
  Linux; Windows is untested.
- Linked libraries: in a live test on 2026-11-03, Sourcify gave only a partial match when the
  addresses were added to `settings.libraries`, and Etherscan found the address itself.

## Next steps

- [Quickstart: a Hardhat project](../start/quickstart-hardhat.md): the same flow from the command
  line.
- [Verify from CI with the CLI](verify-from-ci-with-the-cli.md): keys, exit codes and a workflow.
- [verify()](../reference/verify.md): every option, and the dry run.
- [Errors](../reference/errors/index.md): each code and its fix.
