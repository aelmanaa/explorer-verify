# Verify a contract from a Hardhat project

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers with a Hardhat 2 or Hardhat 3 project who want to verify a deployed contract.
Nothing is released yet. The package `@explorer-verify/hardhat` exists in the repository and is
not published to npm.

`@explorer-verify/hardhat` finds the build files of one contract in the project folder, reads them,
and passes them to [`buildVerifyInput`](verify-a-contract-from-an-npm-package.md). It runs on Node
22.18 and later, and was tested on macOS and Linux only; Windows is untested. It reads files only:
it does not compile, does not load the Hardhat config, and does not need the `hardhat` package.
`explorer-verify` is a peer dependency: install it next to the helper, so the project has one
copy of the core and `instanceof ExplorerVerifyError` works on the helper's errors.

## Steps

1. Compile the project with the settings you deployed with: `npx hardhat compile` on Hardhat 2,
   `npx hardhat build` on Hardhat 3. See [Build with the deploy profile](#build-with-the-deploy-profile).
2. Install `explorer-verify` and `@explorer-verify/hardhat`.
3. Call `buildVerifyInputFromHardhat` with the project folder and the contract.
4. Add the chain ID and the deployed address, and pass the input to
   [`verify`](../reference/verify.md).

```ts
import { buildVerifyInputFromHardhat } from "@explorer-verify/hardhat";
import type { VerifyInput } from "explorer-verify";

const built = await buildVerifyInputFromHardhat({
  root: ".",
  contract: "contracts/Greeter.sol:Greeter",
});
console.log(built.contractName);

const input: VerifyInput = {
  chainId: 11155111,
  address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  ...built,
};

// verify() looks the contract up and submits the input only when the explorer lacks it.
// const result = await verify(input);
```

On Hardhat 3 it prints the input source name, which adds `project/`:

```text
project/contracts/Greeter.sol:Greeter
```

On Hardhat 2 it prints `contracts/Greeter.sol:Greeter`.

`built` has no `chainId` and no `address`, so `verify(built)` does not compile. When the chain ID
or the address comes from untyped data, such as parsed JSON, check the whole input with
`validateInput` before you pass it to `verify`.

## Build with the deploy profile

The build files must come from the build that produced the deployed bytecode. Hardhat 3 has build
profiles, and Hardhat Ignition deploys with the `production` profile. Unless the config sets them,
that profile turns the optimizer on, compiles each contract in its own isolated job, and records
the tool versions in the build-info. A default `npx hardhat build` uses the `default` profile, so its
metadata hash, and often its bytecode, differ from what Ignition deployed. Build with the same
profile before you call the helper:

```sh
npx hardhat build --build-profile production
```

When the build files do not match the deployed code, the explorer rejects the submission or gives
only a partial match.

## Options

| Option            | Required | What it is                                                                                                                                                                                                                                   |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`            | Yes      | The project folder, absolute or relative to the working directory                                                                                                                                                                            |
| `contract`        | Yes      | `path:Name`, with the source path as the artifacts folder names it (`contracts/Greeter.sol:Greeter`), or a bare `Name` that matches exactly one artifact. A Hardhat 3 input source name (`project/contracts/Greeter.sol:Greeter`) also works |
| `outDir`          | No       | The artifacts folder, relative to `root` or absolute. Defaults to `artifacts`. Pass the `paths.artifacts` value when the Hardhat config sets it                                                                                              |
| `artifact`        | No       | The contract's artifact file, relative to `root` or absolute. It replaces the search under `outDir`, and must be the `<Name>.json` artifact of `contract` inside `outDir`                                                                    |
| `compilerVersion` | No       | Passed to `buildVerifyInput`, which checks it against the version in the build-info. `buildVerifyInputFromHardhat` only                                                                                                                      |
| `sources`         | No       | Passed to `buildVerifyInput`. A Hardhat build-info holds every source, so it is rarely needed. `buildVerifyInputFromHardhat` only                                                                                                            |

`@explorer-verify/foundry` takes the same options, and also `buildInfoDir`.

`path` is the source path that Hardhat uses for the artifact folder, such as
`contracts/Greeter.sol`, on both versions. On Hardhat 3 the returned name uses the input source
name, which adds `project/` in front. You can pass that name back as `contract`: when no artifact
exists under `artifacts/project/...`, the helper drops the leading `project/`. A bare `Name` is
searched for in the artifacts folder, outside `build-info/`, without following symlinks.

Each file the helper reads, with its symlinks resolved, must be a regular file inside the artifacts
folder and at most 256 MiB long. A Hardhat 2 `buildInfo` path must point into
`<outDir>/build-info/`.

## Which files it reads

| Version   | Files                                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardhat 3 | The artifact `<outDir>/<path>/<Name>.json`; the build-info `<outDir>/build-info/<id>.json` and its output file `<id>.output.json`, where `<id>` is the artifact's `buildInfoId` |
| Hardhat 2 | The artifact `<outDir>/<path>/<Name>.json`; the build-info that the `buildInfo` field of `<Name>.dbg.json`, next to the artifact, names                                         |

The version is detected per contract: an artifact with `buildInfoId` is read as Hardhat 3, one
without it through its `.dbg.json` file.

To read the files without building the input, call `findHardhatBuild` with the same options. It
returns the same shape as `findFoundryBuild`: the `contract` as `path:Name` from where the artifact
is, the parsed `documents`, an empty `sources` and the `files` the documents came from, relative to
`root`:

```ts
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

`buildVerifyInputFromHardhat` returns the same result as passing those documents to `buildVerifyInput`
by hand. The helper holds no format logic of its own: `buildVerifyInput` reads the compiler input,
the version and the contract name.

## Linked libraries

Hardhat links libraries when it deploys, not when it compiles, so the build-info's `settings` has
no `libraries` and the input the helper returns has none either. The artifact records each link
in `linkReferences`.

To record the addresses, pass them in `libraries`, keyed by `path:Name`. Each key of
`linkReferences` is a source path, and each name under it a library:

```ts
import { buildVerifyInputFromHardhat } from "@explorer-verify/hardhat";
import { validateInput } from "explorer-verify";

const built = await buildVerifyInputFromHardhat({
  root: ".",
  contract: "contracts/Counter.sol:Counter",
});
// The artifact's linkReferences: { "project/contracts/Tally.sol": { Tally: [...] } }
const input = validateInput({
  chainId: 11155111,
  address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  ...built,
  libraries: { "project/contracts/Tally.sol:Tally": "0x5A0b54D5dc17e0AadC383d2db43B0a0D3E029c4c" },
});
console.log(JSON.stringify(input.libraries));
```

On Hardhat 3 it prints the address in lower case:

```text
{"project/contracts/Tally.sol:Tally":"0x5a0b54d5dc17e0aadc383d2db43b0a0d3e029c4c"}
```

`verify()` submits the input as it is, without the addresses. Sourcify wants `settings.libraries`
exactly as it was at compile time: adding the addresses changes the metadata hash. In a live test
on 2026-11-03, Sourcify then gave only a partial match, and Etherscan found the address itself. `linkLibraries(input)` adds the
addresses to `settings.libraries` for an explorer that needs them there. See
[Linked libraries](../reference/verify.md#linked-libraries).

## Errors

The helper throws an `ExplorerVerifyError` from the same catalogue as the core. See
[Errors](../reference/errors/index.md) for each code.

| Code               | When                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invalid-input`    | An option of the wrong type; an artifacts folder that is missing or is a file; no artifact for the contract; an `artifact` file that is not the contract's artifact; a source path outside the artifacts folder; a file that is not JSON, cannot be read, is not a regular file, is larger than 256 MiB or resolves outside the artifacts folder; a `.dbg.json` file without a `buildInfo` path, or with one outside the build-info folder |
| `incomplete-input` | `details.field` is `contract` when a bare name matches several artifacts, listed in `details.candidates`. It is `input` when a build-info file, a Hardhat 3 output file or a Hardhat 2 `.dbg.json` file is missing; the message names the file, relative to `root`                                                                                                                                                                         |

Each `invalid-input` message repeats its issue, so it names the option or the file, for example
`The input is invalid: contract matches no artifact: artifacts/contracts/Missing.sol/Missing.json does not exist.`
`details.issues` holds the same field and message.

Errors from `buildVerifyInput` pass through unchanged. When the artifact names a contract that the
build-info does not hold, for example an artifact left from an older build, it throws
`invalid-input` on `contract`. Compile again so the artifact and the build-info come from one build.

Tested on 2026-11-03 with the output of Hardhat 2.29.1 and Hardhat 3.21.2 for one contract, two
contracts in one file, and a contract that calls an external library.
