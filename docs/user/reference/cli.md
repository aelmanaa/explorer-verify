# CLI

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: people, CI jobs and agents that run the `explorer-verify` command.

The command ships in the `@explorer-verify/cli` package, which is not published yet. It runs on
Node 22.18 and later. This page describes the output contract that every command follows. The
`verify` and `status` commands come next; until then, a placeholder `simulate` command runs a
verification with no network so the contract can be tested. A later release generates this page
from the command's own help.

## Global options

| Option             | What it does                                                        |
| ------------------ | ------------------------------------------------------------------- |
| `--json`           | Print one JSON envelope on stdout, for every outcome                |
| `-q`, `--quiet`    | Show only errors on stderr                                          |
| `--verbose`        | Show debug lines on stderr                                          |
| `--log-format <f>` | `text` (default) for people, or `json` for one JSON object per line |
| `--color <mode>`   | `auto` (default), `always` or `never`                               |

`-v` is not bound, because it can mean verbose or version. `--quiet` with `--verbose` is a usage
error. An option that takes one value keeps the last one when it is repeated. The CLI never
prompts and never reads stdin unless a flag asks it to.

A usage error names the CLI's own options, such as `--color`, or the position of an argument,
such as `argument 3`. It never repeats what you typed, because a mistyped option or value can be
an API key. It lists at most 20 problems and counts the rest.

## stdout

- With `--json`, stdout holds exactly one line: the
  [JSON envelope](json-output.md#the-envelope), for every exit code, usage errors and
  cancellation included. `ok` is `true` exactly when the exit code is 0.
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

## Exit codes

| Code | Meaning                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| 0    | `verified` or `already-verified`                                                                                  |
| 1    | `failed`: the explorer definitively rejected the submission                                                       |
| 2    | Usage or input error; nothing was submitted for verification                                                      |
| 3    | Missing, invalid or under-privileged API key                                                                      |
| 4    | No verdict yet: `not-confirmed` (the output carries the handle) or `verification-inconclusive`                    |
| 5    | Network or explorer unavailable after retries                                                                     |
| 6    | `unknown-state` (the output carries the handle) or `internal-error`, a bug in the CLI. Do not retry automatically |
| 130  | Cancelled by SIGINT or SIGTERM                                                                                    |

[Errors](errors/index.md#exit-codes) lists the error codes behind each exit code.

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

## Placeholder for testing: `simulate`

Until the `verify` and `status` commands land, the hidden `simulate` command runs a verification
with no network, so a script or an agent can exercise the contract above. It is not listed in
usage messages and will be removed.

| Option             | What it does                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--outcome <name>` | `verified` (default), `already-verified`, `failed`, `missing-api-key`, `not-confirmed`, `network`, `unknown-state`, `internal-error`, or `pending`, which polls until cancelled |
| `--polls <n>`      | Polls before the outcome, 0 to 1000; default 0                                                                                                                                  |
| `--retries <n>`    | `verify.retry` events before the submit, 0 to 1000; default 0                                                                                                                   |
| `--message <text>` | The message of the exception that `--outcome internal-error` throws                                                                                                             |

For example, `explorer-verify simulate --json --outcome not-confirmed` prints a `not-confirmed`
envelope with a handle and exits 4.
