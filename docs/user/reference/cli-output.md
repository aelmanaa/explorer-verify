# CLI output

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: scripts, CI jobs and agents that read what the `explorer-verify` command prints.

stdout holds the result, and stderr holds logs, progress and errors. With `--json`, stdout is one
line of JSON for every run. The [CLI](cli.md) page lists the commands and options;
[JSON output](json-output.md) describes the envelope and the exit codes.

<!-- Generated from the CLI's help by scripts/generate-cli-reference.ts. Edit the command table, not this part. -->

## Global options

| Option                  | What it does                                                                |
| ----------------------- | --------------------------------------------------------------------------- |
| `-h`, `--help`          | Print the help of the command, or of the CLI, on stdout.                    |
| `-V`, `--version`       | Print the CLI and core versions; with --json, the routing table's date too. |
| `--json`                | Print one JSON envelope on stdout.                                          |
| `-q`, `--quiet`         | Show only errors on stderr.                                                 |
| `--verbose`             | Show debug lines on stderr.                                                 |
| `--log-format <format>` | text (default) for people, or json for one JSON object per stderr line.     |
| `--color <mode>`        | auto (default), always or never.                                            |

## Environment variables

| Variable              | What it does                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `EXPLORER_VERIFY_LOG` | The stderr log level when no flag sets one: debug, info, warn, error, off.                |
| `NO_COLOR`            | Any value but empty turns colour off under --color auto.                                  |
| `TERM`                | dumb turns colour and the spinner off under --color auto.                                 |
| `CI`                  | Any value but empty turns the spinner off.                                                |
| `ETHERSCAN_API_KEY`   | The API key of etherscan-v2, sent only to api.etherscan.io. Empty counts as unset.        |
| `ROUTESCAN_API_KEY`   | The API key of routescan, sent only to api.routescan.io. Empty counts as unset.           |
| `BLOCKSCOUT_API_KEY`  | The API key of blockscout-hosted, sent only to api.blockscout.com. Empty counts as unset. |

## Exit codes

| Code | Meaning                                                                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Verified: verified or already-verified. With result.storedContract, the explorer holds another contract's source, not yours. Help and the version also exit 0                          |
| 1    | Failed: the explorer definitively rejected the submission                                                                                                                              |
| 2    | Usage or input error: nothing was submitted for verification                                                                                                                           |
| 3    | API key: missing, invalid or under-privileged                                                                                                                                          |
| 4    | No verdict yet: not-confirmed (the output carries the handle), verification-inconclusive, not-indexed (the explorer has not indexed the contract yet) or proxy-link-pending (SDK only) |
| 5    | Network: the explorer was unavailable after retries                                                                                                                                    |
| 6    | Unknown state: unknown-state (the output carries the handle), proxy-link-unknown-state (SDK only), or internal-error, a bug in the CLI. Do not retry automatically                     |
| 130  | Cancelled: SIGINT or SIGTERM stopped the run                                                                                                                                           |

[Errors](errors/index.md#exit-codes) lists the error codes behind each exit code.

<!-- End of the generated part. -->

## stdout

With `--json`, stdout holds one line: the
[JSON envelope](json-output.md#the-envelope). It is printed for every exit code, usage errors and
cancellation included, and `ok` is `true` exactly when the exit code is 0:

```sh
# exit code 0
npx @explorer-verify/cli verify --input-json greeter-sepolia.json \
  --dry-run --json
```

```text
{"schemaVersion":1,"ok":true,"result":{"status":"dry-run","backend":"sourcify","apiHost":"sourcify.dev","lookup":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc","routedBy":"table"}}
```

Without `--json`, stdout holds a short summary, such as `verified: exact match on sourcify`, and
the explorer page. An error prints nothing on stdout. A run on several backends prints these lines
for each backend.

- The same input gives the same stdout, byte for byte, at every log level. stdout holds no
  timestamp.
- When stdout is closed, for example by a reader that stopped early, the run still ends with its
  exit code. The envelope is lost.
- In the envelope, its own property names and the CLI's own words, such as a backend name or a
  status, are never redacted.

## How --json is found

The CLI finds `--json` before it checks the other arguments, so a usage error still prints an
envelope. A `--json` after `--` does not count.

- An option that needs a value takes the next argument unless it starts with `-`. So
  `--color --json` counts `--json`, and reports `--color` as missing its value.
- `--json=true` also gives an envelope, with a usage error: `--json` takes no value.
- `-` and negative numbers are values.

## stderr

stderr holds logs, progress events, the error of a run and, on a terminal, a spinner. The log
level decides what appears:

| Mode        | Level   | stderr                                                                                  |
| ----------- | ------- | --------------------------------------------------------------------------------------- |
| `--quiet`   | `error` | Errors only                                                                             |
| Default     | `info`  | Errors, warnings, info logs, `verify.retry`, `verify.submitted` and `verify.result`     |
| `--verbose` | `debug` | Adds `verify.validated`, `verify.routed`, `verify.lookup`, `verify.poll` and debug logs |

`--quiet` with `--verbose` is a usage error. `verify.routed` also shows at `info` when the routing
table chose the backend: with `--backend auto`, and in a dry run without `--backend`. Its line
names the backends skipped for lack of a key.

> [!IMPORTANT]
> The `verify.submitted` line carries the handle. Keep it: a run that times out or is cancelled
> resumes from it with `status`.

In text, each fact prints once. The library's `info` lines that repeat `verify.submitted` and
`verify.result`, and a dry run's lookup line, show only with `--verbose`. With
`--log-format json`, every line stays at `info`.

## The log level variable

`EXPLORER_VERIFY_LOG` sets the level when no flag does:

| Value   | stderr shows                        |
| ------- | ----------------------------------- |
| `debug` | Everything, as `--verbose`          |
| `info`  | The default                         |
| `warn`  | Errors, warnings and `verify.retry` |
| `error` | Errors only, as `--quiet`           |
| `off`   | Nothing                             |

An empty value counts as unset. The value is case-sensitive: `DEBUG` is not a level. Any other
value is ignored, with one warning line that names the variable and not its value. `--quiet`
hides that warning, like any other.

## The error block

The error of a run is a block of lines on stderr, in this order:

1. the message and the code;
2. the issues of `invalid-input` that the message does not state, or the candidates of
   `incomplete-input`;
3. the hint, the docs page and the handle;
4. a `next:` line with the command that resumes the run as it is, when there is one.

The hint names the CLI's flags and environment variables, not the library's options. Each error
page gives it on its "From the CLI" line. In the `next:` line, each word that a shell would read
otherwise is in single quotes.

A control character in any value shows as `\uXXXX`, so text from an explorer or a build file
cannot start another line or move the cursor. With `--json`, the envelope holds the same hint, the
error's `details` and `nextCommand`; see [JSON output](json-output.md#from-the-cli).

## JSON log lines

With `--log-format json`, each stderr line is one JSON object. Its first keys are
`schemaVersion`, `level`, `message` and `type`:

- `type` is an event type, such as `verify.submitted`, followed by the event's fields; or `log`,
  followed by the logger's fields.
- A field with the name of one of those keys, or `fields`, goes under a nested `fields` object. A field named `fields` appears as `fields.fields`.
- The error's line holds the next command in its `nextCommand` field, as one string.

Read only the lines that start with `{`: Node can write other text to stderr. Text lines and
messages are for people, and may change in any release.

## Colour and spinners

Each stream is decided on its own:

- `--color=always` colours both streams; `--color=never` colours neither.
- With `--color=auto`, a non-empty `NO_COLOR` or `TERM=dumb` turns colour off. Otherwise a stream
  is coloured only when it is a terminal. `--color=always` wins over `NO_COLOR`.
- A spinner runs only when stderr is a terminal and `CI` is unset or empty. It also needs a `TERM`
  other than `dumb`, `--log-format text`, and a level that shows more than errors.
- The spinner shows the stage of the last event, such as `Waiting for sourcify: pending, poll 3`,
  and the seconds since the run started.
- The CLI has no pager, never prompts, and never reads stdin unless a flag asks it to.

## Help and version

| Command                                   | Prints                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `--help`, `-h` or `help`                  | The CLI's help on stdout: examples, usage, commands, options, variables and exits |
| `help <command>` or `<command> --help`    | One command's help: its examples, usage lines and own options                     |
| No command, or `verify` or `status` alone | A short help on stderr, with the usage and two examples. Exits 2                  |
| `--version` or `-V`                       | The versions of `@explorer-verify/cli` and of the `explorer-verify` core          |

Help and the version exit 0 and contact no explorer. With `--json`, each prints one envelope with
`ok: true`. Validate it with `@explorer-verify/cli/help.schema.json` or
`@explorer-verify/cli/version.schema.json`, not with the core envelope schema.

The version envelope holds `cli`, `core` and `routingTableDate`, the date of the routing table the
core ships. For example, with made-up versions:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "result": {
    "cli": "0.1.0",
    "core": "0.1.0",
    "routingTableDate": "2026-11-04"
  }
}
```

- When both `--help` and `--version` are given, help wins.
- A usage error wins over both: `--help --colour` exits 2. Help checks option names and the
  values of the global options, such as `--color`.
- Help does not check the values of a command's own options:
  `status --timeout soon --help` prints the help and exits 0.

## Usage errors

A usage error exits 2 before any request, and lists at most 20 problems. It names the CLI's own
options, such as `--color`, or the position of an argument, such as `argument 3`. It never repeats
a value, because a mistyped option or value can be a key.

- An unknown option of `--` and up to 32 lowercase letters and `-` is named as typed when it is
  close to one of the CLI's names, as `--colour` is to `--color`.
- After the command and its first argument, the argument after an unknown option counts as its
  value. So `--colour never` reports the option, and no extra argument.
- A command the CLI does not know is the only problem reported.
- An option that takes one value, such as `--chain`, exits 2 when it is given twice, `-c` and
  `--chain` together included.
- A boolean option given a value, such as `--help=yes`, is a usage error.

The hint names the single closest command or option, such as `Did you mean --color?`. At most a
third of a name's characters may differ, and one always may. Names under three characters are not
compared. A mistyped command comes before a mistyped option, and `help` counts as a command, so
`hlp` suggests `help`.

A chain name the CLI does not know gets its own hint, such as `Did you mean sepolia?`. It compares
names without case, `-`, `_` or spaces, and suggests only a name that starts with the same two
characters and differs in length by at most two. So `opsepolia` suggests `op-sepolia`.

## Short options

| Short | Long        | Command  |
| ----- | ----------- | -------- |
| `-h`  | `--help`    | Any      |
| `-V`  | `--version` | Any      |
| `-q`  | `--quiet`   | Any      |
| `-c`  | `--chain`   | `verify` |
| `-i`  | `--input`   | `verify` |
| `-n`  | `--dry-run` | `verify` |

A short option takes its value as the next argument, `-c sepolia`, or attached, `-csepolia`.
`-c=sepolia` reads the value `=sepolia`. Short options group: `-qh` is `-q -h`. `-v` is not bound,
because it can mean verbose or version.

## Cancel and unexpected errors

SIGINT (Ctrl-C) and SIGTERM abort the run and exit 130 with a [`cancelled`](errors/cancelled.md)
error. When the explorer accepted the submission before the cancel, `error.handle` holds the
handle. Resume it with `status` instead of submitting again.

- A run with `--backend` repeated sets `error.handles`: one `{ backend, handle }` for each backend
  that accepted a submission and had not ended, in `--backend` order. `error.handle` is set only
  when one backend submitted.
- On stderr, the error block shows one `handle: <backend> <handle>` line for each. A JSON log line
  holds them in `handles`, joined with `, `.
- Only the first signal counts, so the envelope is always written in full.
- A signal in the first moments of a run, before Node has loaded the CLI, ends the process with no
  envelope. The shell reports the signal instead of exit code 130.

An unexpected exception inside the CLI gives an [`internal-error`](errors/internal-error.md): exit
code 6, not retryable, no handle, and a message with keys removed. It is always written to stderr,
whatever the level. With `--verbose`, stderr also shows the redacted stack, with `~` in place of
the home directory.
