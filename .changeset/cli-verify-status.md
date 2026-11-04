---
"explorer-verify": patch
"@explorer-verify/cli": patch
---

The CLI gains `verify` and `status`. `explorer-verify verify <address> --chain <id> --input <file>`
reads build files, builds the input with `buildVerifyInput()` and calls `verify()`; the address may
come first, without the word `verify`. `--input` repeats, and `--contract`, `--compiler-version`,
`--constructor-args`, `--creation-tx`, `--library` and `--timeout` fill the rest of the request.
`explorer-verify status <handle>` resumes a submission with `checkStatus()` and never submits. A run
that ends pending exits 4 with the handle.

`--dry-run` validates the input, resolves the route and looks the contract up, then stops before
the submit. It needs no API key: when the backend needs one and none is set, it sends no request
and says `lookup: "skipped"`. It exits 0 and prints the envelope of the dry-run result, which the
envelope schema now lists.

`--input-json <file>` reads the whole request as JSON, and `--input-json -` reads it from stdin. The
core package ships its schema as `explorer-verify/input.schema.json`. Only the output, log,
`--dry-run`, `--timeout` and key options may go with it. Unknown properties exit 2 with one issue
that counts them and never names them.

`--backend` and `--input-json` given twice now exit 2: a run uses one backend and one request.

The core package exports `dryRun()` and the `DryRunResult` type. `toEnvelope()` and `exitCodeOf()`
accept a `DryRunResult`: `ok: true`, exit code 0, its fields in a fixed order and redacted.

[#101](https://github.com/aelmanaa/explorer-verify/issues/101)
