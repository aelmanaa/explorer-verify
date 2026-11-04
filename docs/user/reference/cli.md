# CLI

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: people, CI jobs and agents that run the `explorer-verify` command.

The command ships in the `@explorer-verify/cli` package, which is not published yet. It runs on
Node 22.18 and later. This page describes the output contract that every command follows. The
`verify` and `status` commands come next; until then, a hidden `simulate` command runs a
verification with no network so the contract can be tested.

The sections from Usage to Exit codes are generated from the CLI's own help, so they match
`explorer-verify --help` for this version.

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
  {"schemaVersion":1,"ok":true,"result":{"cli":"0.1.0","core":"0.1.0","routingTableDate":"2026-11-03"}}
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

## Commands

This version has no public commands yet.

## Hidden commands

Usage messages and the CLI's own help do not list these commands, and a later release removes them. `explorer-verify help <command>` still shows their help.

### `simulate`

Run a simulated verification with no network, to test the output contract. Replaced by verify and status.

```text
explorer-verify simulate [options]
```

Examples:

- `explorer-verify simulate --json --outcome not-confirmed`: Print a not-confirmed envelope with a handle, and exit 4.
- `explorer-verify simulate --verbose --polls 3`: Show every stage event and three polls on stderr, then print verified.

| Option             | What it does                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--outcome <name>` | The outcome: verified, already-verified, failed, missing-api-key, not-confirmed, network, unknown-state, internal-error, pending, which polls until cancelled. Default verified. |
| `--polls <n>`      | Polls before the outcome, 0 to 1000. Default 0.                                                                                                                                  |
| `--retries <n>`    | verify.retry events before the submit, 0 to 1000. Default 0.                                                                                                                     |
| `--message <text>` | The message of the exception that --outcome internal-error throws.                                                                                                               |

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

| Variable              | What it does                                                               |
| --------------------- | -------------------------------------------------------------------------- |
| `EXPLORER_VERIFY_LOG` | The stderr log level when no flag sets one: debug, info, warn, error, off. |
| `NO_COLOR`            | Any value but empty turns colour off under --color auto.                   |
| `TERM`                | dumb turns colour and the spinner off under --color auto.                  |
| `CI`                  | Any value but empty turns the spinner and the pager off.                   |

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

## stdout

- With `--json`, stdout holds exactly one line: the
  [JSON envelope](json-output.md#the-envelope), for every exit code, usage errors and
  cancellation included. `ok` is `true` exactly when the exit code is 0.
- Help and the version print their own envelopes, with `ok: true` and a `result` of another
  shape. Validate them with `@explorer-verify/cli/help.schema.json` and
  `@explorer-verify/cli/version.schema.json`, not with the core envelope schema.
- Without `--json`, stdout holds a short summary of a result, such as
  `verified: exact match on sourcify` and the explorer page. An error prints nothing on stdout.
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

Only the first signal counts. Once the outcome is fixed, further signals are ignored, so the
envelope is always written in full. A signal that arrives in the first moments of a run, before
Node has loaded the CLI, cannot be caught: it ends the process with no
envelope, and the shell reports the signal instead of exit code 130.

An unexpected exception inside the CLI gives an [`internal-error`](errors/internal-error.md): exit
code 6, not retryable, no handle, and a message with keys removed. The error is always written to
stderr, whatever the level. With `--verbose`, stderr also shows the redacted stack, with `~` in
place of the home directory.
