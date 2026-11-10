# CLI

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: people, CI jobs and agents that run the `explorer-verify` command.

This page covers the commands and their options. [CLI output](cli-output.md) covers stdout,
stderr, exit codes and help.

## Install

The CLI is the `@explorer-verify/cli` package, for Node.js 22.18 or later. npx runs it with no
install. In a project or a CI job, add it as a development dependency:

```bash
npm install --save-dev @explorer-verify/cli
```

> [!WARNING]
> Then run `npx @explorer-verify/cli`, which uses that copy. A bare `explorer-verify` exits 127.

## Examples

Each example checks the Greeter on Sepolia, which Sourcify already holds, with no API key. Dry run
the docs' sample request, [`greeter-sepolia.json`](../start/greeter-sepolia.json):

```sh
# exit code 0
npx @explorer-verify/cli verify --input-json greeter-sepolia.json --dry-run
```

```text
dry run on sourcify at sourcify.dev, the routing table's pick: exact match already, so a run without --dry-run would not submit.
https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

Verify from a Foundry project on Sourcify. `ADDRESS` holds
`0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc`. `--backend auto` would let the
[routing table](#where-verify-submits) pick:

```sh
# exit code 0
npx @explorer-verify/cli verify "$ADDRESS" --chain sepolia \
  --foundry . --contract src/Greeter.sol:Greeter --backend sourcify
```

```text
already-verified: exact match on sourcify
https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

Verify from build files kept outside a project. Repeat `--input` for each file:

```sh
# exit code 0
npx @explorer-verify/cli verify "$ADDRESS" --chain sepolia \
  --input build/build-info.json --input build/Greeter.json \
  --backend sourcify
```

```text
already-verified: exact match on sourcify
https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

Resume a verification that ended with exit code 4, from the handle it printed:

```sh
# exit code 0
npx @explorer-verify/cli status "$HANDLE"
```

```text
verified: exact match on sourcify
https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc
```

<!-- Generated from the CLI's help by scripts/generate-cli-reference.ts. Edit the command table, not this part. -->

## Usage

Run a command, or print the help:

```text
explorer-verify <command> [options]
explorer-verify help [<command>]
```

| Command  | What it does                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `verify` | Verify a deployed contract's source. Looks it up first, and submits only when the explorer lacks it. |
| `status` | Resume a submitted verification from its handle, such as after exit code 4. Never submits.           |

### `verify`

Usage:

```text
explorer-verify verify <address> --chain <chain> --input <file>...
  (--backend <name> | --dry-run) [options]
```

| Option                          | What it does                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--backend <name>`              | Where to submit: etherscan-v2, etherscan-compatible, blockscout, blockscout-hosted, sourcify, routescan; auto for the routing table's pick; or all for every backend of the chain's row that can run, not with --dry-run. Needed to submit; a dry run takes one backend or none. Give it more than once to verify on each backend named in one run. Repeatable. |
| `--api-url <url>`               | Use this explorer API URL instead of the routing table's.                                                                                                                                                                                                                                                                                                       |
| `--api-key-file <path>`         | Read one API key from this regular file. Needs --backend, or --api-url with --backend.                                                                                                                                                                                                                                                                          |
| `--api-key-stdin`               | Read one API key piped on stdin. Needs --backend, or --api-url with --backend.                                                                                                                                                                                                                                                                                  |
| `-c`, `--chain <chain>`         | The chain the contract is deployed on: its ID, such as 11155111, or its name, such as sepolia. The CLI reference lists the names.                                                                                                                                                                                                                               |
| `--foundry <dir>`               | Read the build of the Foundry project in this folder: finds the build-info and artifact of --contract. . is the current folder, not the git root that forge uses. Run forge build --build-info first.                                                                                                                                                           |
| `--hardhat <dir>`               | Read the build of the Hardhat 2 or Hardhat 3 project in this folder, . for the current one: finds the artifact and build-info of --contract. Compile the project first.                                                                                                                                                                                         |
| `--out-dir <dir>`               | With --foundry or --hardhat: the build's output folder, relative to the project folder or absolute, when the config moves it. Default out for Foundry, artifacts for Hardhat.                                                                                                                                                                                   |
| `--artifact <file>`             | With --foundry or --hardhat: the contract's artifact file, relative to the project folder or absolute, when the build wrote one for each compiler version or profile. For Hardhat it must be inside the output folder.                                                                                                                                          |
| `--contract <path:Name>`        | The contract as path:Name, such as src/Greeter.sol:Greeter, or as Name when one contract has that name. Needed with --foundry and --hardhat, and when the build files hold several.                                                                                                                                                                             |
| `-i`, `--input <file>`          | A build file: a build-info, an artifact, Solidity metadata or a Standard JSON input. Repeat it for each file. In a project, use --foundry or --hardhat instead. Repeatable.                                                                                                                                                                                     |
| `--compiler-version <version>`  | The full solc version, such as 0.8.24+commit.e11b9ed9, when the files lack it.                                                                                                                                                                                                                                                                                  |
| `--constructor-args <hex>`      | The ABI-encoded constructor arguments, 0x first, without the selector.                                                                                                                                                                                                                                                                                          |
| `--creation-tx <hash>`          | The hash of the transaction that created the contract.                                                                                                                                                                                                                                                                                                          |
| `--library <path:Name=address>` | The address of a linked library. Repeatable.                                                                                                                                                                                                                                                                                                                    |
| `--timeout <seconds>`           | The time budget of the whole run, polling included, in whole seconds. Default 120. A run that ends pending exits 4 with the handle.                                                                                                                                                                                                                             |
| `--poll-interval <seconds>`     | The wait between two status polls of a submitted job, in whole seconds, at least 1. Default 3.                                                                                                                                                                                                                                                                  |
| `--rpc-url <url>`               | A JSON-RPC endpoint of the chain, to derive the constructor arguments with --creation-tx. Refused when a part can hold a key; use --rpc-url-file or --rpc-url-stdin then.                                                                                                                                                                                       |
| `--rpc-url-file <path>`         | Read the JSON-RPC endpoint URL from this regular file. Use it for a URL with a key.                                                                                                                                                                                                                                                                             |
| `--rpc-url-stdin`               | Read the JSON-RPC endpoint URL piped on stdin. Use it for a URL with a key.                                                                                                                                                                                                                                                                                     |
| `--allow-sourcify-fallback`     | Send a chain that the routing table does not list to the public Sourcify API. No effect on a listed chain. Cannot be combined with --api-url or with a --backend other than sourcify.                                                                                                                                                                           |
| `-n`, `--dry-run`               | Check the input, resolve the route and look the contract up, then stop before the submit. Needs no API key.                                                                                                                                                                                                                                                     |
| `--input-json <file>`           | Read the whole verify request as JSON from this file, or from stdin when it is -. See input.schema.json in the explorer-verify package.                                                                                                                                                                                                                         |

### `status`

Usage:

```text
explorer-verify status <handle> [options]
```

| Option                      | What it does                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--backend <name>`          | Use this backend instead of the routing table's: etherscan-v2, etherscan-compatible, blockscout, blockscout-hosted, sourcify, routescan.                                              |
| `--api-url <url>`           | Use this explorer API URL instead of the routing table's.                                                                                                                             |
| `--api-key-file <path>`     | Read one API key from this regular file. Needs --backend, or --api-url with --backend.                                                                                                |
| `--api-key-stdin`           | Read one API key piped on stdin. Needs --backend, or --api-url with --backend.                                                                                                        |
| `--timeout <seconds>`       | The time budget of the whole run, polling included, in whole seconds. Default 120. A run that ends pending exits 4 with the handle.                                                   |
| `--poll-interval <seconds>` | The wait between two status polls of a submitted job, in whole seconds, at least 1. Default 3.                                                                                        |
| `--allow-sourcify-fallback` | Send a chain that the routing table does not list to the public Sourcify API. No effect on a listed chain. Cannot be combined with --api-url or with a --backend other than sourcify. |
| `--input-json <file>`       | Read the whole status request as JSON from this file, or from stdin when it is -. See input.schema.json in the explorer-verify package.                                               |

## Chain names

`--chain` takes these names, in any case, as well as any chain ID.

<details>
<summary>The names of 48 chains</summary>

| Names                            | Chain ID |
| -------------------------------- | -------- |
| `mainnet`, `ethereum`            | 1        |
| `sepolia`                        | 11155111 |
| `holesky`                        | 17000    |
| `hoodi`                          | 560048   |
| `optimism`, `op`                 | 10       |
| `optimism-sepolia`, `op-sepolia` | 11155420 |
| `arbitrum`                       | 42161    |
| `arbitrum-nova`                  | 42170    |
| `arbitrum-sepolia`               | 421614   |
| `base`                           | 8453     |
| `base-sepolia`                   | 84532    |
| `polygon`                        | 137      |
| `polygon-amoy`, `amoy`           | 80002    |
| `polygon-zkevm`                  | 1101     |
| `bsc`, `bnb`                     | 56       |
| `bsc-testnet`                    | 97       |
| `gnosis`                         | 100      |
| `chiado`, `gnosis-chiado`        | 10200    |
| `avalanche`                      | 43114    |
| `fuji`, `avalanche-fuji`         | 43113    |
| `linea`                          | 59144    |
| `linea-sepolia`                  | 59141    |
| `scroll`                         | 534352   |
| `scroll-sepolia`                 | 534351   |
| `zksync`                         | 324      |
| `zksync-sepolia`                 | 300      |
| `blast`                          | 81457    |
| `mantle`                         | 5000     |
| `mantle-sepolia`                 | 5003     |
| `celo`                           | 42220    |
| `mode`                           | 34443    |
| `zora`                           | 7777777  |
| `fraxtal`                        | 252      |
| `worldchain`                     | 480      |
| `worldchain-sepolia`             | 4801     |
| `unichain`                       | 130      |
| `unichain-sepolia`               | 1301     |
| `ink`                            | 57073    |
| `ink-sepolia`                    | 763373   |
| `sonic`                          | 146      |
| `berachain`                      | 80094    |
| `cronos`                         | 25       |
| `metis`                          | 1088     |
| `sei`                            | 1329     |
| `abstract`                       | 2741     |
| `taiko`                          | 167000   |
| `apechain`                       | 33139    |
| `lisk`                           | 1135     |

</details>

<!-- End of the generated part. -->

## Where verify submits

A submit publishes the source on the explorer, and it cannot be undone. So `verify` without
`--dry-run` needs a target:

| Target               | Where `verify` submits                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `--backend <name>`   | That backend, at the URL the routing table lists for the chain                              |
| `--backend auto`     | The routing table's pick: the first backend of the chain's row that needs no key or has one |
| `--backend all`      | Every backend of the chain's row that can run                                               |
| `--backend` repeated | Each backend named, in one run                                                              |
| `route.backend`      | The same, in a [request read as JSON](#the-request-as-json)                                 |

Without a target, `verify` exits 2 before any request. The hint lists the chain's backends and
says what `auto` would pick.

- `--api-url` replaces the routing table's URL. It needs `--backend` naming the backend that
  serves that API, and not `auto`.
- `auto` and `all` stand alone: with another `--backend` or a key flag, they exit 2.
- The pick of `auto` depends on the keys set: on Sepolia, Etherscan with `ETHERSCAN_API_KEY` and
  Sourcify without it. Dry run in the same environment as the real run.

## Dry run

`--dry-run` (`-n`) validates the input, resolves the route and looks the contract up, then stops
before the submit. It needs no API key and no `--backend`, and exits 0. An error before the submit
exits as it would without `--dry-run`.

The [dry-run result](json-output.md#dry-run) names the `backend` a real run would use. Its
`lookup` is `none` when `verify` would submit.

## Several backends

`--backend` given more than once, or `--backend all`, runs
[`verifyEach()`](verify.md#several-backends-in-one-call). The backends verify at once, with one
time budget, and the run prints one envelope with one outcome per backend in `result.outcomes`.

- `--backend all` skips a backend that needs a key you have not set, with a warning on stderr.
- Each backend uses its routing-table URL and the key in its variable. A key flag, `--api-url` or
  `--dry-run` exits 2.
- The exit code is 0 only when every backend verified. Otherwise it is the first of 6, 4, 3, 2, 5,
  1 and 130 that a backend has.

## Projects and build files

`--foundry <dir>` or `--hardhat <dir>` reads the build of the project in that folder, with
`--contract`. Build first with `forge build --build-info`, `npx hardhat build` (Hardhat 3) or
`npx hardhat compile` (Hardhat 2).

- `.` is the current folder. Unlike `forge verify-contract`, the CLI does not look for the Git
  root.
- The CLI finds the artifact and the build-info file that lists the contract, as
  [`buildVerifyInputFromFoundry`](../guides/verify-from-a-foundry-project.md) and
  [`buildVerifyInputFromHardhat`](../guides/verify-from-a-hardhat-project.md) do.
- `--out-dir` and `--artifact` name the output folder and the artifact when the layout differs.

`--input <file>` reads build files kept outside a project, once for each file, at most 64 MiB each.
[`buildVerifyInput()`](../guides/verify-a-contract-from-an-npm-package.md) accepts:

- a build-info and the contract's artifact, from Foundry or Hardhat;
- a Standard JSON input, with `--contract path:Name` and `--compiler-version`;
- Solidity metadata with its sources embedded. The CLI does not read `.sol` files.

A shell glob such as `--input out/*.json` that expands to two files exits 2: repeat `--input` for
each. An input error exits 2 before any request, and names the option, never a path or a value.

## The request as JSON

`--input-json <file>`, or `-` for stdin, reads the whole request as one JSON document. Its JSON
Schema ships as `explorer-verify/input.schema.json`:

- for `verify`, a `VerifyInput` with an optional `route: { "backend", "apiUrl" }`. A submit
  needs `route.backend`, which may be `"auto"`;
- for `status`, `{ "handle": "ev1:…" }` with an optional `route`.

Only the output, run, key and RPC URL options may go with it: put any other option in the request.
The request has no field for an API key or an RPC URL. The same request as flags and as JSON prints
the same stdout.

## Chains the routing table does not list

A chain with no row in the [routing table](routing.md) exits 2 with `unsupported-chain`.
`--allow-sourcify-fallback` sends it to the public Sourcify API instead, as
[`allowSourcifyFallback`](routing.md#allowsourcifyfallback) does.

- It is not a target: a submit also needs `--backend auto` or `--backend sourcify`.
- It has no effect on a chain the table lists.
- With `--api-url`, or a `--backend` other than `sourcify`, it exits 2.
- Give `status` the flag when the submit had it.

## Status

`status <handle>` calls [`checkStatus()`](check-status.md): it polls the job and never submits.
Resume a pending job with `status`, never with a new `verify`, which would submit again. Pass the
route options the submit used: the handle never chooses the host.

## API keys and route options

The CLI reads API keys from `ETHERSCAN_API_KEY`, `ROUTESCAN_API_KEY` and `BLOCKSCOUT_API_KEY`, from
a file or from stdin. No flag takes a key as its value: a key on the command line shows in the
process list. [API keys](api-keys.md) says which host each key goes to.

`--api-key-file <path>` and `--api-key-stdin` read one key, and need a named backend that takes it:

| Route                                                      | Where the key goes                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `--backend etherscan-v2`, `routescan`, `blockscout-hosted` | That backend's key, in place of its variable                         |
| `--backend etherscan-compatible`                           | The standalone host the routing table lists for the chain            |
| `--api-url <url>` with one of these backends               | Only that host. Use this for a standalone explorer                   |
| No `--backend`, `auto`, or a backend with no key           | Nowhere: exit 2, so a key never reaches an explorer you did not name |

Pipe a key from a variable with `--api-key-stdin`, here to resume an Etherscan job:

```bash
printf '%s' "$ETHERSCAN_API_KEY" | npx @explorer-verify/cli status \
  "$HANDLE" --backend etherscan-v2 --api-key-stdin
```

- A key-like flag, such as `--api-key`, exits 2, and its value never shows in a message.
- `--api-key-stdin` exits 2 when stdin is a terminal, because the CLI never prompts.
- The CLI removes every key it read from stdout and stderr, as `[redacted]`.

## RPC URL

With an RPC endpoint of the chain and the `--creation-tx` hash, `verify` derives missing
constructor arguments from the creation transaction; see
[verify()](verify.md#constructor-arguments). Providers often put a key in the URL, so the CLI
treats the URL like a key:

| Option                  | Takes                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `--rpc-url <url>`       | A URL with no part that can hold a key, such as `https://ethereum-sepolia-rpc.publicnode.com` |
| `--rpc-url-file <path>` | Any URL, from a regular file                                                                  |
| `--rpc-url-stdin`       | Any URL, piped on stdin                                                                       |

A part that can hold a key is a path segment, a query, a user name, a password or a fragment of 8
or more characters. `--rpc-url` refuses it with exit 2, even in a public URL such as
`https://rpc.ankr.com/eth_sepolia`. Each such part is removed from the output as `[redacted]`.

Pipe the URL with `--rpc-url-stdin`:

```bash
printf '%s\n' "$SEPOLIA_RPC_URL" | npx @explorer-verify/cli verify \
  0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc --chain sepolia \
  --foundry . --contract src/Greeter.sol:Greeter --backend auto \
  --creation-tx "$CREATION_TX" --rpc-url-stdin
```
