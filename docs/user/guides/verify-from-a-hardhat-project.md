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
3. Call `verifyInputFromHardhat` with the project folder and the contract.
4. Add the chain ID and the deployed address, and pass the input to
   [`verify`](../reference/verify.md).

```ts
import { verifyInputFromHardhat } from "@explorer-verify/hardhat";
import { validateInput, verify } from "explorer-verify";

const built = await verifyInputFromHardhat({
  root: ".",
  contract: "contracts/Greeter.sol:Greeter",
});
// built.contractName: "project/contracts/Greeter.sol:Greeter" on Hardhat 3,
// "contracts/Greeter.sol:Greeter" on Hardhat 2.

const input = validateInput({
  chainId: 11155111,
  address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  ...built,
});

// verify() looks the contract up and submits the input only when the explorer lacks it.
const result = await verify(input);
```

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

| Option      | Required | What it is                                                                                                                                                                                                                                   |
| ----------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`      | Yes      | The project folder, absolute or relative to the working directory                                                                                                                                                                            |
| `contract`  | Yes      | `path:Name`, with the source path as the artifacts folder names it (`contracts/Greeter.sol:Greeter`), or a bare `Name` that matches exactly one artifact. A Hardhat 3 input source name (`project/contracts/Greeter.sol:Greeter`) also works |
| `artifacts` | No       | The artifacts folder, relative to `root` or absolute. Defaults to `artifacts`. Pass the `paths.artifacts` value when the Hardhat config sets it                                                                                              |

`path` is the source path that Hardhat uses for the artifact folder, such as
`contracts/Greeter.sol`, on both versions. On Hardhat 3 the returned name uses the input source
name, which adds `project/` in front. You can pass that name back as `contract`: when no artifact
exists under `artifacts/project/...`, the helper drops the leading `project/`. A bare `Name` is
searched for in the artifacts folder, outside `build-info/`, without following symlinks.

Each file the helper reads, with its symlinks resolved, must be a regular file inside the artifacts
folder and at most 256 MiB long. A Hardhat 2 `buildInfo` path must point into
`<artifacts>/build-info/`.

## Which files it reads

| Version   | Files                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardhat 3 | The artifact `<artifacts>/<path>/<Name>.json`; the build-info `<artifacts>/build-info/<id>.json` and its output file `<id>.output.json`, where `<id>` is the artifact's `buildInfoId` |
| Hardhat 2 | The artifact `<artifacts>/<path>/<Name>.json`; the build-info that the `buildInfo` field of `<Name>.dbg.json`, next to the artifact, names                                            |

The version is detected per contract: an artifact with `buildInfoId` is read as Hardhat 3, one
without it through its `.dbg.json` file.

To read the files without building the input, call `findHardhatBuild` with the same options. It
returns the parsed `documents` and the `files` they came from, relative to `root`:

```ts
import { findHardhatBuild } from "@explorer-verify/hardhat";
import { buildVerifyInput } from "explorer-verify";

const build = await findHardhatBuild({ root: ".", contract: "Greeter" });
// build.files on Hardhat 3:
// ["artifacts/contracts/Greeter.sol/Greeter.json",
//  "artifacts/build-info/<id>.json",
//  "artifacts/build-info/<id>.output.json"]
const built = buildVerifyInput(build.documents);
```

`verifyInputFromHardhat` returns the same result as passing those documents to `buildVerifyInput`
by hand. The helper holds no format logic of its own: `buildVerifyInput` reads the compiler input,
the version and the contract name.

## Linked libraries

Hardhat links libraries when it deploys, not when it compiles, so the build-info's `settings` has
no `libraries` and the input the helper returns has none either. The artifact records each link
in `linkReferences`.

- Sourcify: submit the input as it is. Sourcify wants `settings.libraries` exactly as it was at
  compile time; adding the library addresses changes the metadata hash and gives only a partial
  match. See [Sourcify](../reference/sourcify.md#behaviour-to-know).
- Etherscan: passing the library addresses for a linked contract is not supported yet; issue
  [#65](https://github.com/aelmanaa/explorer-verify/issues/65) tracks it.

## Errors

The helper throws an `ExplorerVerifyError` from the same catalogue as the core. See
[Errors](../reference/errors/index.md) for each code.

| Code               | When                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-input`    | An option of the wrong type; an artifacts folder that is missing or is a file; no artifact for the contract; a source path outside the artifacts folder; a file that is not JSON, cannot be read, is not a regular file, is larger than 256 MiB or resolves outside the artifacts folder; a `.dbg.json` file without a `buildInfo` path, or with one outside the build-info folder |
| `incomplete-input` | `details.field` is `contract` when a bare name matches several artifacts, listed in `details.candidates`. It is `input` when a build-info file, a Hardhat 3 output file or a Hardhat 2 `.dbg.json` file is missing; the message names the file, relative to `root`                                                                                                                 |

Each `invalid-input` message repeats its issue, so it names the option or the file, for example
`The input is invalid: contract matches no artifact: artifacts/contracts/Missing.sol/Missing.json does not exist.`
`details.issues` holds the same field and message.

Errors from `buildVerifyInput` pass through unchanged. When the artifact names a contract that the
build-info does not hold, for example an artifact left from an older build, it throws
`invalid-input` on `contract`. Compile again so the artifact and the build-info come from one build.

Tested on 2026-11-03 with the output of Hardhat 2.29.1 and Hardhat 3.21.2 for one contract, two
contracts in one file, and a contract that calls an external library.
