# 0056: CLI flags, help and progress lines for a shell user

Status: Accepted (2026-11-06). Amends R-AX-6, R-AX-11, R-AX-12 and R-AX-14, and the target rules
of [decision 0043](0043-verify-needs-an-explicit-target.md).

Research: [2026-11-06-cli-shell-conventions.md](../research/2026-11-06-cli-shell-conventions.md).

## Context

Issue [#225](https://github.com/aelmanaa/explorer-verify/issues/225), with one finding of the
black-box run of [#221](https://github.com/aelmanaa/explorer-verify/issues/221). A bare
`explorer-verify` exited 2 with an error instead of help. `--chain` took only a number, and only
`-h` and `-q` had short forms. An option that takes one value kept the last value when given
twice. Each fact printed twice on stderr. `help verify` repeated the global sections, and the help
described a pager that did not exist. forge takes chain names with `-c`; clig.dev asks for concise
help on a bare command and binds `-n` to `--dry-run`; cargo binds `-V` to `--version`.

## Decision

- `--chain` takes a chain ID or a chain name, in any case. The routing table holds no names, so
  the CLI keeps its own list, `CHAIN_NAMES`: one short lowercase name for each of 47 chains the
  table lists, and other common names for some of them, such as `ethereum`, `op`, `op-sepolia`,
  `amoy`, `avalanche-fuji`, `gnosis-chiado`, `bnb` and `zksync-sepolia`. Each ID matches the
  chain's entry on chainid.network, and a test checks that the table has a row for each ID. The
  CLI reference lists the names, generated from the list.
- An unknown name exits 2. The hint names the closest name only when it keeps one half of the
  typed name, split at the first `-`: the chain (`base-sepolai` gives `base-sepolia`) or the
  network (`optimsm-sepolia` gives `optimism-sepolia`). So a suggestion never moves to another
  chain's network, as `op-sepolia` to `ink-sepolia` would.
- Short flags: `-c` (`--chain`), `-i` (`--input`), `-n` (`--dry-run`) and `-V` (`--version`). `-v`
  stays unbound.
- Every option that takes one value exits 2 when it is given twice, `-c` with `--chain` included,
  instead of keeping the last value. This replaces the per-option `once` flag. A repeatable option
  still collects its values.
- `--backend all` runs `verifyEach()` with `backends: "all"`. The library leaves out a backend
  that needs a key it lacks; the CLI keeps that rule and writes one warning line on stderr for
  each backend left out, naming the key's variable. Like `auto`, `all` stands alone: not with
  another `--backend`, `--api-url` or a key flag. With `--dry-run` it exits 2, and the hint lists
  the backends of the chain's row to dry run one at a time; a dry run on every backend would need
  a result shape the envelope does not have. `status` refuses `all`.
- `--poll-interval <seconds>`, a whole number from 1, sets `pollIntervalMs` for `verify` and
  `status`, with `--input-json` too.
- `status` with `--api-url` needs `--backend`, as `verify` does: a URL alone would send the
  handle's backend's requests to another server.
- A bare `explorer-verify`, or a command that needs arguments typed alone, prints a short help on
  stderr, with the usage and two examples, and exits 2. A command's text help gives a usage line
  for each way to call it, naming the options it needs, and points to `explorer-verify --help` for
  the global options, the environment variables and the exit codes. The help envelope keeps every
  field.
- The CLI has no pager. The help and the requirements no longer mention one.
- In text, a library `info` log line that repeats what the CLI already prints shows at `debug`:
  the line of `verify.submitted`, known by "accepted the submission. Resume it with this handle:"
  and its `handle` field; the line of `verify.result`, known by "Result: " and its `status` field;
  and a dry run's lookup line, known by "Dry run: " and its `routedBy` field. The match reads each
  line alone, never the order of the lines. `--log-format json` keeps every line. The core is
  unchanged.
- In a run on several backends, each backend's error goes to stderr too, with its hint.
- An unknown command is the only issue reported: the options after it are not checked. An unknown
  option of `--` and up to 32 lowercase letters and `-` is named as typed only when it is close to
  one of the CLI's names, as a typo is; any other unknown argument keeps the position-only rule of
  R-AX-9. After the first positional, the argument that follows an unknown option is its value.
- The spinner shows the stage of the last event, at any level, and the whole seconds since the
  run started.

## Alternatives considered

- Add chain names to the routing table. That changes the core's table schema and its size budget
  for a CLI feature, so the list stays in the CLI until the core needs names.
- Demote the core's duplicate `info` logs in the core. SDK callers without an event listener read
  those lines, so the CLI demotes them for its own text output only.

## Consequences

- Breaking for the CLI before 0.1.0: a repeated single-value option now exits 2, `status` with
  `--api-url` alone exits 2, the text of `help <command>` drops three sections, and a bare
  command exits 2 with help on stderr instead of a usage error envelope.
- A new chain name is a code change in `packages/cli/src/chains.ts`, checked against the table. A
  table change that drops a chain with a CLI name removes the name too, or the CLI test fails.
