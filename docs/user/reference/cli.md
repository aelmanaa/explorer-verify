# CLI

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: people, CI jobs and agents that run the `explorer-verify` command.

The command ships in the `@explorer-verify/cli` package, which is not published yet. It runs on
Node 22.18 and later. `verify` verifies a contract from its build files, and `status` resumes a
submitted verification from its handle. This page describes both, and the output contract that
every command follows. A hidden `simulate` command runs a verification with no network, so the
tests can drive every exit path; a later release removes it.

The sections from Usage to Exit codes are generated from the CLI's own help, so they match
`explorer-verify --help` for this version.

## Verify

```sh
explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc --chain 11155111 \
  --input out/build-info/greeter.json --input out/Greeter.sol/Greeter.json --json
```

- The address may come first, without the word `verify`:
  `explorer-verify 0x8275… --chain 11155111 --input …`.
- `--input` repeats. Each file is read as JSON and passed to
  [`buildVerifyInput()`](../guides/verify-a-contract-from-an-npm-package.md), which works out what it is: a
  build-info, an artifact, Solidity metadata or a Standard JSON input. Pass the build-info and the
  contract's artifact for Foundry (`forge build --build-info`) and Hardhat. A bare Standard JSON
  input needs `--contract path:Name` and `--compiler-version`. Metadata needs its sources embedded,
  as `useLiteralContent` writes them: the CLI does not read `.sol` files. Each file may be at most
  64 MiB.
- `--constructor-args`, `--creation-tx` and `--library path:Name=address` (repeatable) fill the
  matching `VerifyInput` fields. `validateInput()` checks the whole input before anything is sent.
- `--timeout <seconds>` sets the time budget of the run, polling included; the default is 120. A
  run that ends while the job is still pending exits 4 with `not-confirmed` and the handle. Resume
  it with `status`.
- `--backend` and `--api-url` pick the route, as in [API keys and route options](#api-keys-and-route-options).
- `--rpc-url`, `--rpc-url-file` or `--rpc-url-stdin` gives a JSON-RPC endpoint, so `verify` can
  derive missing constructor arguments from the `--creation-tx` transaction. See
  [RPC URL](#rpc-url).
- `--backend` given more than once runs [`verifyEach()`](verify.md#several-backends-in-one-call):
  the run verifies on each backend at once, with one time budget, and prints one envelope whose
  `result.outcomes` holds one outcome per backend, in command-line order. Each backend uses its
  routing-table URL and takes its key only from its environment variable, so `--api-url`,
  `--api-key-file`, `--api-key-stdin` and `--dry-run` exit 2 with a repeated `--backend`. So the
  run reaches only backends the routing table lists for the chain; a standalone explorer or a
  self-hosted server needs `verifyEach()` in code, where each entry takes its own `apiUrl`. A
  backend the row does not list ends `unsupported-chain`. The exit code is 0 only when every
  backend verified; otherwise it is the first of 6, 4, 3, 2, 5, 1 and 130 that any backend has
  (see [Exit codes](json-output.md#exit-codes)). That code names only the first backend with it:
  read `result.outcomes` for every backend. Without `--json`, stdout has, for each backend, its
  status line, such as `verified: exact match on sourcify`, then the explorer page when the
  library knows one; for an error, `<code> on <backend>: <message>`, then `Handle: <handle>` when
  the job is still pending. `status` takes one `--backend`.
- The `verify.submitted` line on stderr carries the handle, at the default level. Keep it.

A usage or input error exits 2 before any request. An issue names the option, such as `--chain` or
`--input[2]` for the second `--input`, and never repeats a path or a value.

## Dry run

`--dry-run` validates the input, resolves the route and looks the contract up, then stops before
the submit. It needs no API key. It exits 0 and prints the
[dry-run result](json-output.md#dry-run): the backend, its API host (with the port when it is not
the default one, such as `127.0.0.1:5555`), and the lookup's answer.
`lookup` is `exact` or `partial` when the explorer already holds the contract, so `verify` would
not submit, and `none` when it would submit. When the backend needs an API key and none is set, the
dry run sends no request and says `lookup: "skipped"`. Errors before the submit exit as they would
without `--dry-run`. An [RPC URL](#rpc-url) is read and checked, but the dry run sends it no
request.

```sh
explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc --chain 11155111 \
  --input out/build-info/greeter.json --input out/Greeter.sol/Greeter.json \
  --backend etherscan-v2 --api-url https://api.etherscan.io/v2/api --dry-run --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"etherscan-v2","apiHost":"api.etherscan.io","lookup":"skipped"}}
```

The route depends on the keys: the routing table picks the first backend of the chain's row that
works with the keys set, so the same command line can go to Etherscan with `ETHERSCAN_API_KEY` set
and to Sourcify without it. The dry run's `backend` says which. For a chain whose row has no
Etherscan entry, Etherscan is reached only with
`--backend etherscan-v2 --api-url https://api.etherscan.io/v2/api`. Its key then goes in with
`--api-key-file` or `--api-key-stdin`: `ETHERSCAN_API_KEY` is sent only to the routing table's
host, so with `--api-url` it is not used, and `verify` exits 3 with `missing-api-key` before any
request.

## Status

```sh
explorer-verify status ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718 --json
```

`status <handle>` calls [`checkStatus()`](check-status.md): it polls the job from its handle and
never submits. It takes the same `--timeout`, route options and keys as `verify`, and uses the same
exit codes. Pass the route options the submit used: the handle never chooses the host.

## The request as JSON

`--input-json <file>` reads the whole request as one JSON document, and `--input-json -` reads it
from stdin. The package `explorer-verify` ships its JSON Schema as
`explorer-verify/input.schema.json`.

- For `verify`: a `VerifyInput`, as `validateInput()` returns it, with an optional
  `route: { "backend", "apiUrl" }`.
- For `status`: `{ "handle": "ev1:…" }`, with an optional `route`.

Only `--json`, `--log-format`, `--quiet`, `--verbose`, `--color`, `--dry-run`, `--api-key-file`,
`--api-key-stdin`, `--rpc-url`, `--rpc-url-file`, `--rpc-url-stdin` and `--timeout` may accompany
it, and no argument. Any other option exits 2: put it in the request. The route of the request
counts as `--backend` and `--api-url`, so `--api-key-file` can send its key there. Malformed JSON
exits 2. Properties the schema does not list exit 2 with one issue that counts them and never names
them. The request has no field for an API key or an RPC URL: give the RPC URL with one of its
three options.

`--input-json -` exits 2 at once when stdin is a terminal, and with `--api-key-stdin` or
`--rpc-url-stdin`, which read stdin too. The same request as flags and as JSON prints the same stdout.

## Help and version

- `explorer-verify --help`, `-h` or `explorer-verify help` prints the CLI's help on stdout and
  exits 0. It leads with examples, then lists the usage, the commands, the options, the
  environment variables and the exit codes, and links this page and `llms.txt`.
- `explorer-verify help <command>` or `explorer-verify <command> --help` prints the help of one
  command, its own options first. A hidden command has help too, when you name it.
- With `--json`, help prints one envelope, `{ "schemaVersion": 1, "ok": true, "result": ... }`,
  whose `result` holds the same content as the text: the topic, the usage, the examples, the
  commands with their options, the global options, the environment variables, the exit codes and
  the two links. The package ships its JSON Schema as `@explorer-verify/cli/help.schema.json`.
- `explorer-verify --version` prints two lines: the version of `@explorer-verify/cli` and the
  version of the `explorer-verify` core package it runs.
- `explorer-verify --version --json` prints one envelope whose `result` holds `cli`, `core` and
  `routingTableDate`, the date of the routing table the core ships, as `YYYY-MM-DD`. The package
  ships its JSON Schema as `@explorer-verify/cli/version.schema.json`. For example, with made-up
  versions:

  ```text
  {"schemaVersion":1,"ok":true,"result":{"cli":"0.1.0","core":"0.1.0","routingTableDate":"2026-11-04"}}
  ```

- With `--help` or `--version`, the command does not run, and no explorer is contacted. When
  both are asked for, help wins.
- A usage error wins over both: `explorer-verify --help --colour` exits 2. Help checks the option
  names and the values of the global options, such as `--color`. It does not check the values of
  a command's own options, because the command checks them when it runs:
  `explorer-verify simulate --outcome bogus --help` prints the help and exits 0.

<!-- Generated from the CLI's help by scripts/generate-cli-reference.ts. Edit the command table, not this part. -->

## Usage

```text
explorer-verify <command> [options]
explorer-verify help [<command>]
```

## Examples

- `explorer-verify --version --json`: Print the CLI and core versions and the routing table's date as one envelope.
- `explorer-verify help --json`: List the commands, options, environment variables and exit codes as one envelope.
- `explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc --chain 11155111 --input out/build-info/greeter.json --input out/Greeter.sol/Greeter.json --dry-run --json`: Check a Foundry build and look the contract up, without submitting: one envelope.
- `explorer-verify status ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718 --json`: Poll the job of a handle until it ends or the time budget runs out.

## Commands

| Command  | What it does                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `verify` | Verify a deployed contract's source. Looks it up first, and submits only when the explorer lacks it. |
| `status` | Resume a submitted verification from its handle, such as after exit code 4. Never submits.           |

### `verify`

Verify a deployed contract's source. Looks it up first, and submits only when the explorer lacks it.

```text
explorer-verify verify <address> [options]
```

Examples:

- `explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc --chain 11155111 --input out/build-info/greeter.json --input out/Greeter.sol/Greeter.json --dry-run --json`: Check a Foundry build and look the contract up, without submitting: one envelope.
- `explorer-verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc --chain 11155111 --input out/build-info/greeter.json --input out/Greeter.sol/Greeter.json`: Verify from a Foundry build-info and artifact; the address may come first, without verify.
- `explorer-verify verify --input-json verify-input.json --json`: Verify the request in a JSON file, as validateInput() returns it.

| Option                          | What it does                                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--backend <name>`              | Use this backend instead of the routing table's: etherscan-v2, etherscan-compatible, blockscout, sourcify, routescan. Give it more than once to verify on each backend in one run. Repeatable. |
| `--api-url <url>`               | Use this explorer API URL instead of the routing table's.                                                                                                                                      |
| `--api-key-file <path>`         | Read one API key from this regular file. Needs --backend, or --api-url with --backend.                                                                                                         |
| `--api-key-stdin`               | Read one API key piped on stdin. Needs --backend, or --api-url with --backend.                                                                                                                 |
| `--chain <id>`                  | The chain ID the contract is deployed on, such as 11155111.                                                                                                                                    |
| `--input <file>`                | A build file: a build-info, an artifact, Solidity metadata or a Standard JSON input. Repeatable.                                                                                               |
| `--contract <path:Name>`        | The contract, such as src/Greeter.sol:Greeter, when the files hold several.                                                                                                                    |
| `--compiler-version <version>`  | The full solc version, such as 0.8.24+commit.e11b9ed9, when the files lack it.                                                                                                                 |
| `--constructor-args <hex>`      | The ABI-encoded constructor arguments, 0x first, without the selector.                                                                                                                         |
| `--creation-tx <hash>`          | The hash of the transaction that created the contract.                                                                                                                                         |
| `--library <path:Name=address>` | The address of a linked library. Repeatable.                                                                                                                                                   |
| `--timeout <seconds>`           | The time budget of the whole run, polling included, in whole seconds. Default 120. A run that ends pending exits 4 with the handle.                                                            |
| `--rpc-url <url>`               | A JSON-RPC endpoint of the chain, to derive the constructor arguments with --creation-tx. Refused when a part can hold a key; use --rpc-url-file or --rpc-url-stdin then.                      |
| `--rpc-url-file <path>`         | Read the JSON-RPC endpoint URL from this regular file. Use it for a URL with a key.                                                                                                            |
| `--rpc-url-stdin`               | Read the JSON-RPC endpoint URL piped on stdin. Use it for a URL with a key.                                                                                                                    |
| `--dry-run`                     | Check the input, resolve the route and look the contract up, then stop before the submit. Needs no API key.                                                                                    |
| `--input-json <file>`           | Read the whole verify request as JSON from this file, or from stdin when it is -. See input.schema.json in the explorer-verify package.                                                        |

### `status`

Resume a submitted verification from its handle, such as after exit code 4. Never submits.

```text
explorer-verify status <handle> [options]
```

Examples:

- `explorer-verify status ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718 --json`: Poll the job of a handle until it ends or the time budget runs out.

| Option                  | What it does                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--backend <name>`      | Use this backend instead of the routing table's: etherscan-v2, etherscan-compatible, blockscout, sourcify, routescan.                   |
| `--api-url <url>`       | Use this explorer API URL instead of the routing table's.                                                                               |
| `--api-key-file <path>` | Read one API key from this regular file. Needs --backend, or --api-url with --backend.                                                  |
| `--api-key-stdin`       | Read one API key piped on stdin. Needs --backend, or --api-url with --backend.                                                          |
| `--timeout <seconds>`   | The time budget of the whole run, polling included, in whole seconds. Default 120. A run that ends pending exits 4 with the handle.     |
| `--input-json <file>`   | Read the whole status request as JSON from this file, or from stdin when it is -. See input.schema.json in the explorer-verify package. |

## Hidden commands

Usage messages and the CLI's own help do not list these commands, and a later release removes them. `explorer-verify help <command>` still shows their help.

### `simulate`

Run a simulated verification with no network, to test the output contract. A later release removes it.

```text
explorer-verify simulate [options]
```

Examples:

- `explorer-verify simulate --json --outcome not-confirmed`: Print a not-confirmed envelope with a handle, and exit 4.
- `explorer-verify simulate --verbose --polls 3`: Show every stage event and three polls on stderr, then print verified.

| Option                  | What it does                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--backend <name>`      | Use this backend instead of the routing table's: etherscan-v2, etherscan-compatible, blockscout, sourcify, routescan.                                                            |
| `--api-url <url>`       | Use this explorer API URL instead of the routing table's.                                                                                                                        |
| `--api-key-file <path>` | Read one API key from this regular file. Needs --backend, or --api-url with --backend.                                                                                           |
| `--api-key-stdin`       | Read one API key piped on stdin. Needs --backend, or --api-url with --backend.                                                                                                   |
| `--outcome <name>`      | The outcome: verified, already-verified, failed, missing-api-key, not-confirmed, network, unknown-state, internal-error, pending, which polls until cancelled. Default verified. |
| `--polls <n>`           | Polls before the outcome, 0 to 1000. Default 0.                                                                                                                                  |
| `--retries <n>`         | verify.retry events before the submit, 0 to 1000. Default 0.                                                                                                                     |
| `--message <text>`      | The message of the exception that --outcome internal-error throws.                                                                                                               |

## Global options

| Option                  | What it does                                                                |
| ----------------------- | --------------------------------------------------------------------------- |
| `-h`, `--help`          | Print the help of the command, or of the CLI, on stdout.                    |
| `--version`             | Print the CLI and core versions; with --json, the routing table's date too. |
| `--json`                | Print one JSON envelope on stdout.                                          |
| `-q`, `--quiet`         | Show only errors on stderr.                                                 |
| `--verbose`             | Show debug lines on stderr.                                                 |
| `--log-format <format>` | text (default) for people, or json for one JSON object per stderr line.     |
| `--color <mode>`        | auto (default), always or never.                                            |

## Environment variables

| Variable              | What it does                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `EXPLORER_VERIFY_LOG` | The stderr log level when no flag sets one: debug, info, warn, error, off.               |
| `NO_COLOR`            | Any value but empty turns colour off under --color auto.                                 |
| `TERM`                | dumb turns colour and the spinner off under --color auto.                                |
| `CI`                  | Any value but empty turns the spinner and the pager off.                                 |
| `ETHERSCAN_API_KEY`   | The API key of etherscan-v2, sent only to its routing-table host. Empty counts as unset. |
| `ROUTESCAN_API_KEY`   | The API key of routescan, sent only to its routing-table host. Empty counts as unset.    |

## Exit codes

| Code | Meaning                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| 0    | Verified: verified or already-verified. Help and the version also exit 0                                                     |
| 1    | Failed: the explorer definitively rejected the submission                                                                    |
| 2    | Usage or input error: nothing was submitted for verification                                                                 |
| 3    | API key: missing, invalid or under-privileged                                                                                |
| 4    | No verdict yet: not-confirmed (the output carries the handle) or verification-inconclusive                                   |
| 5    | Network: the explorer was unavailable after retries                                                                          |
| 6    | Unknown state: unknown-state (the output carries the handle) or internal-error, a bug in the CLI. Do not retry automatically |
| 130  | Cancelled: SIGINT or SIGTERM stopped the run                                                                                 |

[Errors](errors/index.md#exit-codes) lists the error codes behind each exit code.

<!-- End of the generated part. -->

## Reading the command line

`-v` is not bound, because it can mean verbose or version. `--quiet` with `--verbose` is a usage
error. An option that takes one value keeps the last one when it is repeated. The CLI never
prompts and never reads stdin unless a flag asks it to.

A usage error names the CLI's own options, such as `--color`, or the position of an argument,
such as `argument 3`. It never repeats what you typed, because a mistyped option or value can be
an API key. It lists at most 20 problems and counts the rest.

When a command or an option is mistyped, the hint of the usage error names the single closest
command or option by edit distance, such as `Did you mean --color?`. A name is close when at most
a third of its characters differ, and one may always differ. Names shorter than three characters
are not compared. A mistyped command comes before a mistyped option, and a hidden command is never
suggested. The word `help` is a command name for this purpose, so `explorer-verify hlp` suggests
`help`. When nothing is close, the hint names nothing. The suggestion is always one of the CLI's
own names, never what you typed. A name whose length differs too much is skipped without
comparing, so a long mistyped argument costs no time.

Short options can be grouped: `-qh` is read as `-q -h`, and `-hh` as `-h` given twice, which is
the same as `-h`. A boolean option given a value, such as `--help=yes`, is a usage error that
names only that option.

## API keys and route options

A command that talks to an explorer reads its API keys from environment variables, from a file or
from stdin. No flag takes a key as its value: a key on the command line shows in the process list
and the shell history. [API keys](api-keys.md) says which host each key goes to.

| Variable            | Fills                                                      |
| ------------------- | ---------------------------------------------------------- |
| `ETHERSCAN_API_KEY` | `apiKeys["etherscan-v2"]`, sent only to `api.etherscan.io` |
| `ROUTESCAN_API_KEY` | `apiKeys.routescan`, sent only to `api.routescan.io`       |

An empty variable counts as unset. A variable that is set but holds a bad key is a usage error
that names the variable, even when the route does not use it.

| Option               | What it does                                                             |
| -------------------- | ------------------------------------------------------------------------ |
| `--backend <name>`   | Use this backend instead of the routing table's choice (`route.backend`) |
| `--api-url <url>`    | Use this explorer API URL (`route.apiUrl`); the library checks the URL   |
| `--api-key-file <p>` | Read one key from the file `p`                                           |
| `--api-key-stdin`    | Read one key from stdin                                                  |

`--api-key-file` and `--api-key-stdin` remove one trailing newline (`\n` or `\r\n`) and need a
place to send the key:

- With `--api-url`, `--backend` must be `etherscan-v2`, `routescan` or `etherscan-compatible`.
  The key becomes `route.apiKey` and goes only to that host. Use this for a standalone explorer:
  `--backend etherscan-compatible --api-url <url> --api-key-file <p>`.
- Without `--api-url`, `--backend` must be `etherscan-v2` or `routescan`. The key fills that
  backend's `apiKeys` entry, in place of its variable.
- Otherwise the command exits 2: with no `--backend`, or with a backend that takes no key, such as
  `sourcify`. The routing table picks a backend partly by the keys it has, so a key without a named
  backend could reach an explorer it was not meant for.

`--api-key-file` reads only a regular file. A FIFO, a device or a directory exits 2 before any
byte is read, so process substitution such as `--api-key-file <(pass show key)` does not work: pipe
the key with `--api-key-stdin` instead.

The two key flags cannot be combined. `--api-key-stdin` exits 2 at once, without reading, when
stdin is a terminal, because the CLI never prompts. It also exits 2 with `--input-json -`, which
reads stdin too. Pipe the key instead:

```sh
printf '%s' "$KEY" | explorer-verify <command> --backend etherscan-v2 --api-key-stdin
```

`--api-key`, `--apikey`, `--api_key`, `--key`, `--etherscan-api-key`, `--etherscan-key` and
`--routescan-api-key` are refused with exit 2. The argument after them is dropped with them, unless
it starts with `-`; it is then read as the next option. Either way the value never shows up as an
argument or in a message. An error about a key names the variable or the flag, never the key. An
error about a key file does not name its path either, because a path typed by mistake can be a
key. The CLI removes every valid key it read, in any letter case, from stdout and stderr, at every
level and in every format, as `[redacted]`. A value shorter than 8 characters is refused as a key
and never printed, but not searched for in other output.

## RPC URL

`verify` derives missing constructor arguments from the creation transaction when it has a JSON-RPC
endpoint of the chain, the `--creation-tx` hash and the build files' creation bytecode. The library
option is `rpcUrl`; [verify()](verify.md#constructor-arguments) describes the derivation. Without
an RPC URL, `verify` asks Etherscan for the creation code on an Etherscan v2 route with a key, and
otherwise submits without arguments.

Providers often put a key in the URL's path or query, so the CLI treats the URL like a key:

| Option               | What it takes                                                              |
| -------------------- | -------------------------------------------------------------------------- |
| `--rpc-url <url>`    | A URL with no part that can hold a key                                     |
| `--rpc-url-file <p>` | Any URL, read from the regular file `p`, with one trailing newline removed |
| `--rpc-url-stdin`    | Any URL, piped on stdin, with one trailing newline removed                 |

- A part that can hold a key is a path segment, a query name or value, a user name, a password or
  a fragment of 8 or more characters, as typed, as parsed or decoded. `--rpc-url` refuses a URL
  with such a part and exits 2, because a flag value shows in the process list and the shell
  history. For example, `https://ethereum-sepolia-rpc.publicnode.com` works with `--rpc-url`, and
  `https://eth-sepolia.example.com/v2/<key>` needs `--rpc-url-file` or `--rpc-url-stdin`.
- A public URL without a key is refused too when it has a long path segment, such as
  `https://rpc.ankr.com/eth_sepolia`. Pass it with `--rpc-url-file` or `--rpc-url-stdin`.
- No environment variable holds the URL, and neither does the request of `--input-json`.
- Only one of the three options may be given. `--rpc-url-file` reads only a regular file, as
  `--api-key-file` does. `--rpc-url-stdin` exits 2 at once when stdin is a terminal, and with
  `--api-key-stdin` or `--input-json -`.
- The URL may be at most 8192 characters, from the set RFC 3986 allows, with no space or quote.
  The library checks the rest: `https`, or `http` on `localhost`, `127.0.0.1` or `[::1]`, with no
  user name, password or fragment. A refused URL exits 2 with `invalid-input` naming `rpcUrl`.
- Each part that can hold a key is removed from stdout and stderr, in any letter case, at every
  level and in every format, as `[redacted]`. An error never repeats the URL, a part of it or the
  path of its file. The host name and a key split into pieces shorter than 8 characters are not
  removed, so never put a key there.
- A part is removed wherever it appears, so a plain word in the URL, such as `eth_sepolia`, also
  shows as `[redacted]` in messages. In the JSON envelope and JSON log lines, the envelope's own
  property names and values that are the CLI's own words, such as a backend name or a status,
  stay as they are; any other property name with a part in it is redacted too.
- An endpoint of another chain exits 2 with `invalid-input` naming `rpcUrl`, before the submit.

```sh
printf '%s\n' "$SEPOLIA_RPC_URL" | explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \
  --chain 11155111 --input out/build-info/greeter.json --input out/Greeter.sol/Greeter.json \
  --creation-tx 0x<hash> --rpc-url-stdin --json
```

## stdout

- With `--json`, stdout holds exactly one line: the
  [JSON envelope](json-output.md#the-envelope), for every exit code, usage errors and
  cancellation included. `ok` is `true` exactly when the exit code is 0.
- Help and the version print their own envelopes, with `ok: true` and a `result` of another
  shape. Validate them with `@explorer-verify/cli/help.schema.json` and
  `@explorer-verify/cli/version.schema.json`, not with the core envelope schema.
- Without `--json`, stdout holds a short summary of a result, such as
  `verified: exact match on sourcify` and the explorer page. An error prints nothing on stdout. A
  run on several backends prints these lines for each backend, and an error line for a backend
  that ended in an error.
- The same input gives the same stdout, byte for byte, at every log level. stdout holds no
  timestamp.
- When stdout is closed, for example by a reader that stopped early, the run still ends with its
  exit code, and the envelope is lost.

The CLI finds `--json` before it checks the other arguments, so a usage error still prints an
envelope. A `--json` after `--` does not count. When an option that needs a value is followed by
an argument that starts with `-`, that argument is read as the next option, so
`--color --json` counts `--json` and reports `--color` as missing its value. `--json=true` also
gives an envelope, with a usage error: `--json` takes no value. `-` and negative numbers are
values.

## stderr

stderr holds logs, progress events, the error of a run and, on a terminal, a spinner. The log level
decides what appears:

| Mode        | Level   | stderr                                                                                  |
| ----------- | ------- | --------------------------------------------------------------------------------------- |
| `--quiet`   | `error` | Errors only                                                                             |
| Default     | `info`  | Errors, warnings, info logs, `verify.retry`, `verify.submitted` and `verify.result`     |
| `--verbose` | `debug` | Adds `verify.validated`, `verify.routed`, `verify.lookup`, `verify.poll` and debug logs |

`EXPLORER_VERIFY_LOG` sets the level when no flag does: `debug`, `info`, `warn`, `error` or `off`.
`warn` shows errors, warnings and `verify.retry`. `off` shows nothing on stderr. An empty value
counts as unset. The value is case-sensitive: `DEBUG` is not a level. Any other value is ignored, with one warning line that names the variable and not
its value; the warning follows the level like any other warning, so `--quiet` hides it.

The `verify.submitted` line carries the handle. Keep it: a run that times out or is cancelled can
be resumed with it.

With `--log-format json`, each stderr line is one JSON object whose first keys are
`schemaVersion`, `level`, `message` and `type`. `type` is an event type, such as
`verify.submitted`, followed by the event's fields, or `log`, followed by the logger's fields. A
field named `schemaVersion`, `level`, `message`, `type` or `fields` goes under a nested `fields`
object, so a field named `fields` appears as `fields.fields`. Read only the lines that start with
`{`: Node can write other text to stderr. Text lines and messages are for people and may change in
any release.

## Colour, spinners and pagers

Each stream is decided on its own:

- `--color=always` colours both streams; `--color=never` colours neither.
- With `--color=auto`, a non-empty `NO_COLOR` or `TERM=dumb` turns colour off. Otherwise each
  stream is coloured only when it is a terminal. `--color=always` wins over `NO_COLOR`.
- A spinner runs only when stderr is a terminal, `CI` is unset or empty, `TERM` is not `dumb`,
  `--log-format` is `text` and the level shows more than errors.
- A pager runs only when stdout is a terminal and `CI` is unset or empty.

## Cancel and unexpected errors

SIGINT (Ctrl-C) and SIGTERM abort the run at once and exit 130. The output is a
[`cancelled`](errors/cancelled.md) error, with the handle in `error.handle` when the explorer
accepted the submission before the cancel. Resume from that handle with the `status` command
instead of submitting again.

A run with `--backend` repeated may have several jobs running. Its `cancelled` error then carries
`error.handles`: one `{ backend, handle }` for each backend that accepted a submission and had not
ended, in `--backend` order. `error.handle` is set only when exactly one backend submitted. The
error block on stderr shows one `handle: <backend> <handle>` line for each, and a JSON log line
holds them in its `handles` field, joined with `, `. Resume each handle with `status`.

Only the first signal counts. Once the outcome is fixed, further signals are ignored, so the
envelope is always written in full. A signal that arrives in the first moments of a run, before
Node has loaded the CLI, cannot be caught: it ends the process with no
envelope, and the shell reports the signal instead of exit code 130.

An unexpected exception inside the CLI gives an [`internal-error`](errors/internal-error.md): exit
code 6, not retryable, no handle, and a message with keys removed. The error is always written to
stderr, whatever the level. With `--verbose`, stderr also shows the redacted stack, with `~` in
place of the home directory.
