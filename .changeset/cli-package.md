---
"explorer-verify": patch
"@explorer-verify/cli": patch
---

New package `@explorer-verify/cli` with the `explorer-verify` bin and its output contract. With
`--json`, stdout holds one JSON envelope for every exit code, usage errors and cancellation
included. Logs and stage events go to stderr, as text or with `--log-format json` as one JSON
object per line. `--quiet`, `--verbose` and `EXPLORER_VERIFY_LOG` set the level. `--color` and
`NO_COLOR` set colour per stream. SIGINT and SIGTERM exit 130 with a `cancelled` error that
carries the handle when the explorer accepted the submission. A placeholder `simulate` command
runs a verification with no network until the `verify` and `status` commands land.

The core catalogue gains `internal-error`: exit code 6, not retryable, no handle, with its own
error page. The CLI uses it when an unexpected exception reaches its top level; the library never
throws it.

[#98](https://github.com/aelmanaa/explorer-verify/issues/98)
