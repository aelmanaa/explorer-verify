# JSON output and exit codes

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents that read the outcome of a verification as data: a script, a
server handler, a CI job or the CLI with `--json`.

A call to `verify()` or `checkStatus()` ends with a result or an `ExplorerVerifyError`. Two
functions turn either one into data that a program reads without parsing messages:

- `exitCodeOf(outcome)` gives the exit code.
- `toEnvelope(outcome)` gives the JSON envelope.

The CLI, once it ships, prints the envelope on stdout with `--json` and exits with that code. Both
functions are in the library now.

```ts
import { ExplorerVerifyError, exitCodeOf, toEnvelope } from "explorer-verify";
import type { VerifyOutcome } from "explorer-verify";

let outcome: VerifyOutcome;
try {
  outcome = await verify(input);
} catch (error) {
  if (!(error instanceof ExplorerVerifyError)) throw error;
  outcome = error;
}
console.log(JSON.stringify(toEnvelope(outcome, { secrets: [apiKey] })));
process.exitCode = exitCodeOf(outcome);
```

## The envelope

The envelope has one of three forms:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "result": { "status": "verified", "backend": "sourcify", "match": "exact" }
}
```

```json
{
  "schemaVersion": 1,
  "ok": false,
  "result": { "status": "failed", "backend": "etherscan-v2", "reason": "..." }
}
```

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "not-confirmed",
    "message": "...",
    "hint": "Call checkStatus with details.handle later to continue polling.",
    "docsUrl": "https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/errors.md#not-confirmed",
    "retryable": true,
    "handle": "ev1:sourcify:11155111:0x5fbdb2315678afecb367f032d93f642f64180aa3:550e8400-e29b-41d4-a716-446655440000"
  }
}
```

The rules:

- `ok` is `true` exactly when the exit code is 0. A `failed` result has `ok: false`, the result,
  and no `error`.
- `result` is a `VerifyResult` with only the fields its status declares. `explorerUrl` is absent
  when the library knows no public page for the contract.
- `error` is the error's `toJSON()`: `code`, `message`, `hint`, `docsUrl`, `retryable` and, when the
  error carries one, `handle` in its one-line form. It never holds `cause`, the stack or `details`.
  [Errors](errors.md) has an entry for each code.
- Keys are always in the order shown, and the envelope holds no timestamp. The same outcome gives
  the same JSON, byte for byte.
- Every string is redacted. Key-like URL and form parameters, bearer tokens and bare Etherscan-style
  keys become `[redacted]`. Pass the call's API key in `secrets` to remove it wherever it appears.
- Within `schemaVersion` 1, a release only adds fields, so ignore any field you do not know.

`toEnvelope` and `exitCodeOf` throw `invalid-input` for a value that is neither a `VerifyResult` nor
an `ExplorerVerifyError`. Only code that bypasses the types can pass one.

## JSON Schema

The package ships a JSON Schema (draft 2020-12) for the envelope. Import it as
`explorer-verify/envelope.schema.json`, or read `schema/envelope.schema.json` in the installed
package. The schema allows fields it does not list, so a reader that validates against it keeps
working when a later release adds a field.

## Exit codes

Each outcome has one exit code. `ERROR_EXIT_CODES` holds the codes of the errors, and `exitCodeOf`
covers results and errors.

| Outcome               | Kind   | `ok`    | Exit code |
| --------------------- | ------ | ------- | --------- |
| `verified`            | Result | `true`  | 0         |
| `already-verified`    | Result | `true`  | 0         |
| `failed`              | Result | `false` | 1         |
| `invalid-input`       | Error  | `false` | 2         |
| `unsupported-chain`   | Error  | `false` | 2         |
| `not-confirmed`       | Error  | `false` | 4         |
| `network`             | Error  | `false` | 5         |
| `rate-limited`        | Error  | `false` | 5         |
| `timeout`             | Error  | `false` | 5         |
| `unexpected-response` | Error  | `false` | 5         |
| `in-progress`         | Error  | `false` | 5         |
| `unknown-state`       | Error  | `false` | 6         |
| `job-not-found`       | Error  | `false` | 6         |
| `cancelled`           | Error  | `false` | 130       |

Exit code 3 is for a missing, invalid or under-privileged API key. No error code uses it yet: key
errors arrive with the first backend that needs a key. [Errors](errors.md#exit-codes) explains what
to do for each exit code.
