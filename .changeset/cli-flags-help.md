---
"@explorer-verify/cli": minor
---

Breaking: an option that takes one value, such as `--chain`, `--contract` or `--compiler-version`, now exits 2 when it is given twice, instead of keeping the last value. `-c` with `--chain` counts as a repeat. `status` with `--api-url` and no `--backend` now exits 2, as `verify` does. A bare `explorer-verify`, `explorer-verify verify` or `explorer-verify status` now prints a short help on stderr, with the usage and two examples, and exits 2. The text of `explorer-verify help <command>` no longer repeats the global options, the environment variables and the exit codes; it points to `explorer-verify --help`, and the `--json` help still holds them. `-V` now means `--version`.

New in the CLI:

- `--chain` takes a chain name, such as `sepolia` or `op-sepolia`, as well as a chain ID. The CLI reference lists the names. An unknown name exits 2, and the hint names the closest name that keeps the chain or the network of the typed one.
- Short flags: `-c` (`--chain`), `-i` (`--input`), `-n` (`--dry-run`) and `-V` (`--version`).
- `--backend all` verifies with `verifyEach()` on every backend of the chain's routing-table row that can run, and prints the same envelope as `--backend` repeated for each of them. A backend skipped because its key is not set gets a warning line on stderr that names it and the variable. With `--dry-run` it exits 2, and the hint lists the chain's backends to dry run one at a time.
- `--poll-interval <seconds>` sets the wait between two status polls for `verify` and `status`, at least 1 second. It may go with `--input-json`.
- In a run on several backends, each backend's error also goes to stderr, with its hint.
- A command's usage lines name the options it needs, such as `--chain` and `--input`.
- At the default level, each fact prints one line on stderr. The library's `info` lines that repeat `verify.submitted`, `verify.result` or a dry run's lookup show only at `--verbose`. `--log-format json` keeps them.
- An unknown command is the only problem reported. An unknown option close to one of the CLI's names, such as `--colour`, is named as typed, and the argument after it counts as its value. Any other unknown argument is still named by its position.
- The spinner shows the stage of the run, such as `Waiting for sourcify: pending, poll 3`, and the seconds since the start.
- The help no longer mentions a pager: the CLI has none.

Issue: https://github.com/aelmanaa/explorer-verify/issues/225
