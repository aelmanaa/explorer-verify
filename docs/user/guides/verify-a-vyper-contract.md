# Verify a Vyper contract

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who deploy a contract written in Vyper and want its source verified.

You need: Node.js 22.18 or later, the contract's address and chain ID, and one of its build files:
the output of `vyper -f solc_json`, a Foundry build-info, or its Standard JSON input. A dry run
needs no API key.

explorer-verify never compiles. It reads the compiler input from your build files and sends it to
the explorer. Each step below says where Vyper differs from Solidity.

## Check the Vyper version

Vyper 0.3.10 and every later stable release verify. The version is the long form,
`x.y.z+commit.<8 hex>`, such as `0.4.3+commit.bff19ea2`.

Two kinds of version throw [`unsupported-compiler`](../reference/errors/unsupported-compiler.md)
on `compiler.version` before any request:

- a release before 0.3.10. Such builds end the bytecode in other layouts, which were not tested
  on any explorer;
- a prerelease, such as `0.4.0rc1` or `0.4.0b1`. No explorer's spelling of one was tested.

This release cannot verify a contract built with either.

## Choose the explorer

Sourcify and Etherscan v2 verify Vyper, each on every chain whose
[routing](../reference/routing.md) row lists it. The routing table picks between them as it does
for Solidity: Etherscan v2 when it comes first in the row and its key or `handlerUrl` is set, else
Sourcify. Name one with `route.backend` to choose it yourself.

Blockscout, Routescan and the standalone Etherscan-compatible explorers do not verify Vyper in this
release. A route to one of them throws `unsupported-compiler` on `compiler.kind` before any
request.

Two more rules apply:

- Sourcify cannot take Vyper 0.3.x input with `interfaces`. The routing table then takes
  Etherscan v2, which needs its key; naming Sourcify throws `unsupported-compiler`. To use
  Sourcify, inline each interface into the source, or build with 0.4.0 or later.
- Through the [server handler](../reference/server-handler.md), the handler must run this release
  too. An older one refuses a Vyper submit with `bad-request`.

## Build the input

`buildVerifyInput` takes any of the three files and returns `compiler.kind: "vyper"`:

| You have                         | Options needed                                      |
| -------------------------------- | --------------------------------------------------- |
| Output of `vyper -f solc_json`   | None, for one target                                |
| A Foundry Vyper build-info       | `contract`, unless one contract is built            |
| A Vyper Standard JSON input file | `compilerVersion`, and `contract` unless one target |

The contract is `path:Name`, named after its file, such as `src/Vault.vy:Vault`. A version
without its commit, such as `0.4.3`, is completed from a table of the stable releases. The
[npm package guide](verify-a-contract-from-an-npm-package.md#vyper-documents) lists every rule.

Here the contract imports a module installed in a Python environment:

```ts [build.ts]
import { readFile } from "node:fs/promises";

import { buildVerifyInput } from "explorer-verify";

const output: unknown = JSON.parse(
  await readFile("Vault.solc_json.json", "utf8"),
);
const built = buildVerifyInput([output]);
console.log(built.contractName);
console.log(built.compiler.kind, built.compiler.version);
console.log(Object.keys(built.compiler.input.sources).join("\n"));
```

```text
src/Vault.vy:Vault
vyper 0.4.3+commit.bff19ea2
vylib/auth/owned.vy
src/Vault.vy
```

`vyper -f solc_json` keyed the module by the path of the Python environment, such as
`0/1/2/3/home/user/.venv/lib/python3.12/site-packages/vylib/auth/owned.vy`. That key would
publish your home folder with the source. The builder keeps the part after the last
`site-packages`, which compiles to the same bytecode.

Any other indexed, absolute or climbing key, or one under `dist-packages`, throws
`invalid-input`. So does
an input with `storage_layout_overrides`, which `--storage-layout-file` adds and no explorer
request carries. Compile from the project root, without that flag.

## Build from a Foundry project

`@explorer-verify/foundry` reads a Vyper contract's build-info. Build with
`forge build --build-info`, or set `build_info = true` in `foundry.toml`, then name the contract
by its path, such as `src/Counter.vy:Counter`.
[Verify from a Foundry project](verify-from-a-foundry-project.md#a-vyper-contract) shows the call.

Hardhat writes no Vyper build-info, so `@explorer-verify/hardhat` refuses a Vyper contract with
`insufficient-artifact`. Use `vyper -f solc_json` there.

## Dry run from Node.js

This example reads the Standard JSON input of a Vyper 0.4.3 contract deployed on Sepolia, then
looks it up with `dryRun()`:

```ts [dry-run.ts]
import { readFile } from "node:fs/promises";

import { buildVerifyInput, dryRun } from "explorer-verify";

const input: unknown = JSON.parse(
  await readFile("Scoreboard.input.json", "utf8"),
);
const built = buildVerifyInput([input], {
  compilerVersion: "0.4.3+commit.bff19ea2",
});
console.log(built.contractName);

const result = await dryRun({
  chainId: 11155111,
  address: "0xf3dc8196fd8dfdacc30040c47f383212c0581caa",
  ...built,
});
console.log(result.status, result.backend, result.lookup);
```

```text
src/Scoreboard.vy:Scoreboard
dry-run sourcify exact
```

No key is set, so the Sepolia row's first backend, Etherscan v2, is skipped and Sourcify is
picked. Put your own address and chain ID in place of these. `lookup` is `none` when
`verify()` would submit. Call `verify()` with the same input to submit.

> [!WARNING]
> A submit publishes the source on the explorer and cannot be undone.

## Dry run from the command line

`--input` reads the same files. A Standard JSON input needs `--compiler-version`:

```sh [dry-run.sh]
npx @explorer-verify/cli verify 0xf3dc8196fd8dfdacc30040c47f383212c0581caa \
  --chain 11155111 --input Scoreboard.input.json \
  --compiler-version 0.4.3+commit.bff19ea2 \
  --backend sourcify --dry-run --json
```

It exits 0 and prints:

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0xf3dc8196fd8dfdacc30040c47f383212c0581caa","routedBy":"caller"}}
```

Drop `--dry-run` to submit. In a Foundry project, pass `--foundry .` and
`--contract src/Counter.vy:Counter` instead of `--input`. The
[CLI reference](../reference/cli.md#verify) lists every option.

## Read the match grade

The `match` that `verify()` returns depends on the explorer and the Vyper version:

| Explorer     | Vyper 0.4.1 and later | Vyper 0.3.10 and 0.4.0               |
| ------------ | --------------------- | ------------------------------------ |
| Sourcify     | `exact`               | `partial`                            |
| Etherscan v2 | `exact`               | `exact`, read from `Pass - Verified` |

Vyper writes no metadata hash. From 0.4.1, the end of its bytecode holds an integrity hash of the
sources, so an explorer can check the exact text. A build before 0.4.1 holds nothing derived from
the source text, so Sourcify grades it `partial`, and no submit raises it.

Etherscan states no grade. Its `Pass - Verified` reads `exact`, so for a build before 0.4.1 it
says only that the source compiles to the deployed code. When Etherscan matched the contract from
another contract's source, `SimilarMatch` names it and the result is `partial`.
[Match types](../explanation/match-types.md#vyper-builds) explains each grade.

## Sources

- Versions, routes and request fields: decisions 0075 to 0078 in the repository, under
  `docs/contributor/decisions/`.
- Sourcify: a Vyper 0.4.3 contract with a `.vyi` interface, deployed on Ethereum Sepolia and
  verified exact on 2026-11-19. The example's address is that contract.
- Etherscan v2: three Vyper 0.4.3 contracts on Ethereum Sepolia, verified on 2026-11-19.
- The builder: the output of Vyper 0.4.3 and the Vyper 0.4.0 PyPI build, a Foundry 1.8.1 Vyper
  build-info and a Vyper 0.3.10 Standard JSON input, built on 2026-11-17 and 2026-11-19. Each input
  compiled to the original creation bytecode.

## Next steps

- [Match types](../explanation/match-types.md#vyper-builds): what `exact` and `partial` mean.
- [Sourcify](../reference/sourcify.md#vyper) and [Etherscan](../reference/etherscan.md#vyper-input):
  what each client sends for Vyper.
- [Verify from CI with the CLI](verify-from-ci-with-the-cli.md): keys, exit codes and a workflow.
- [Errors](../reference/errors/index.md): each code and its fix.
