---
"explorer-verify": patch
---

Add `exitCodeOf(outcome)`, which gives the CLI exit code of a `VerifyResult` or an `ExplorerVerifyError`: 0 for `verified` and `already-verified`, 1 for `failed`, and the `ERROR_EXIT_CODES` entry for an error.

Add `toEnvelope(outcome, options?)`, which turns a result or an error into the versioned JSON envelope that the CLI prints with `--json`: `{ schemaVersion: 1, ok, result }` or `{ schemaVersion: 1, ok: false, error }`. `ok` is `true` exactly when the exit code is 0. Keys are always in the same order, and every string is redacted. Pass the call's API key in `secrets` to remove it wherever it appears.

Both functions check the outcome the same way and throw `invalid-input` for a value that is neither a result nor an error, or for options other than `{ secrets?: string[] }`. They accept an error from a second copy of the package, which `instanceof` misses, when its `name` is `ExplorerVerifyError` and its `toJSON()` returns a valid error object.

Add the `Envelope`, `EnvelopeOptions` and `VerifyOutcome` types.

The package ships a JSON Schema for the envelope as `explorer-verify/envelope.schema.json`. It compiles in strict mode and accepts error codes and backends that a later release may add. The new reference page "JSON output and exit codes" lists the exit code of every outcome.

The job id of a handle is no longer redacted for having the shape of a bare Etherscan key, so a 34-character job id still resumes. A job id that equals a known secret or holds a key-like parameter is still redacted.

[#5](https://github.com/aelmanaa/explorer-verify/issues/5)
