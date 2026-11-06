# How Foundry and Hardhat take a project, and where the CLI's file flags fail

Date: 2026-11-06. Issue: [#221](https://github.com/aelmanaa/explorer-verify/issues/221).

Question: how do `forge verify-contract` and `hardhat verify` find the build of the contract to
verify, and what does `explorer-verify verify` ask of a user in a Foundry or Hardhat project?

## forge verify-contract

From the [forge verify-contract reference](https://getfoundry.sh/forge/reference/forge-verify-contract),
read on 2026-11-06. The page shows no forge version.

- Usage: `forge verify-contract [OPTIONS] <ADDRESS> [CONTRACT]`. `CONTRACT` is in brackets, so it
  is optional, and its form is `<path>:<contractname>`.
- `--root`: "The project's root path." Default: "By default root of the Git repository, if in
  one, or the current working directory."
- `--compiler-version`: "The `solc` version to use to build the smart contract".

## hardhat verify (Hardhat 3)

- The task's source,
  [`packages/hardhat-verify/src/internal/tasks/verify/utils.ts`](https://github.com/NomicFoundation/hardhat/blob/main/packages/hardhat-verify/src/internal/tasks/verify/utils.ts)
  on the `main` branch, read on 2026-11-06, adds a `contract` option: "The name of the contract to
  verify, in the format <path>:<contractName>", with no default value. The file defines no option
  for the project folder; the task runs in the project that `npx hardhat` loads.
- The [smart contract verification guide](https://hardhat.org/docs/guides/smart-contract-verification),
  read on 2026-11-06: "By default, the `verify` task uses the `production` build profile", and
  `--build-profile` picks another. Its example is `hardhat verify --network sepolia 0x1234567890...`.

## explorer-verify before #221

From the CLI source and tests at commit 0a07946 (`packages/cli/src/main.ts`,
`packages/cli/src/request.ts`, `packages/cli/test/unit/verify.test.ts`), read on 2026-11-06, and
from the examples in issue #221:

- `--input out` exits 2: `--input[1] must name a regular file`.
- A shell glob over the build-info folder, `--input out/build-info/*.json`, expands to one
  argument per file. With two build-info files, the second lands as a positional argument, and
  `verify` exits 2 with `verify takes at most 1 arguments`.
- Foundry names build-info files by a hash, so a user lists `out/build-info` before the first
  run. Hardhat 3 needs three `--input` flags: the build-info, its output file and the artifact.

## What follows

- Both tools take the contract as `path:Name` and read the project themselves. A flag for the
  project folder with `--contract` matches that.
- forge's default root is the Git root; the CLI's `--foundry .` is the current folder. The help
  says so.
- The R-DX-2 helpers find the contract by name, not by bytecode, so `--contract` is required. A
  lookup by deployed bytecode is a separate mode, left for a follow-up.

## Sources

- forge verify-contract reference:
  https://getfoundry.sh/forge/reference/forge-verify-contract (read 2026-11-06)
- Hardhat 3 verify task options:
  https://github.com/NomicFoundation/hardhat/blob/main/packages/hardhat-verify/src/internal/tasks/verify/utils.ts
  (read 2026-11-06)
- Hardhat smart contract verification guide:
  https://hardhat.org/docs/guides/smart-contract-verification (read 2026-11-06)
- Issue #221: https://github.com/aelmanaa/explorer-verify/issues/221
- CLI source and tests at commit 0a07946: `packages/cli/src/main.ts`, `packages/cli/src/request.ts`
  and `packages/cli/test/unit/verify.test.ts` (read 2026-11-06)
