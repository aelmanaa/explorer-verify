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
functions, [verify()](verify.md) and [checkStatus()](check-status.md) are in the library now.

```ts
import { ExplorerVerifyError, exitCodeOf, toEnvelope, verify } from "explorer-verify";
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

When Sourcify already has the contract, it prints one line and exits with 0:

```text
{"schemaVersion":1,"ok":true,"result":{"status":"already-verified","backend":"sourcify","match":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc"}}
```

## The envelope

The envelope has one of three forms, a fourth for a dry run and a fifth for
[several backends](#several-backends):

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
    "docsUrl": "https://aelmanaa.github.io/explorer-verify/reference/errors/not-confirmed",
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
  `docsUrl` is the code's own page. [Errors](errors/index.md) lists every code.
- A `cancelled` error of a CLI run on several backends also holds `handles`: one
  `{ "backend", "handle" }` for each backend that accepted a submission and had not ended before
  the cancel, in `--backend` order. `handle` is then set only when exactly one backend submitted.
  Resume each handle.
- Keys are always in the order shown, and the envelope holds no timestamp. The same outcome gives
  the same JSON, byte for byte.
- Every string is redacted. Key-like URL and form parameters, bearer tokens and bare Etherscan-style
  keys become `[redacted]`. Pass the call's API key in `secrets` to remove it wherever it appears.
- The job id in `handle` is an exception to the bare-key rule, so a job id of 34 upper-case
  letters and digits still resumes. `secrets` and key-like parameters still apply to it, and the
  rest of the handle is never changed.
- Within `schemaVersion` 1, a release may add fields, error codes and backends, and changes nothing
  else. Ignore any field you do not know. Handle an error code you do not know by its `retryable`
  value and the exit code.

### Dry run

`toEnvelope()` of a `DryRunResult` gives a fourth form, with exit code 0, and
`explorer-verify verify --dry-run --json` prints it. Its `result` is the `DryRunResult` of
[`dryRun()`](verify.md#dry-run), and nothing was submitted:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "result": {
    "status": "dry-run",
    "backend": "etherscan-v2",
    "apiHost": "api.etherscan.io",
    "lookup": "skipped"
  }
}
```

`lookup` is `exact`, `partial`, `none` or `skipped`. `skipped` means the backend needs an API key
and none was set, so the dry run sent no request. A reader that knows only the other forms tells
this one apart by `result.status`. `apiHost` is a host name, with the port when it is not the
scheme's default, such as `127.0.0.1:5555`.

### Several backends

`toEnvelope()` of a `VerifyEachResult` gives a fifth form, and `explorer-verify verify` with
`--backend` repeated prints it. Its `result` holds one outcome per backend of
[`verifyEach()`](verify.md#several-backends-in-one-call), in the order the call listed them. Each
outcome has `backend`, `ok`, and either the backend's `result` or its `error`, copied and redacted
as in the forms above:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "result": {
    "outcomes": [
      {
        "backend": "sourcify",
        "ok": true,
        "result": { "status": "verified", "backend": "sourcify", "match": "exact" }
      },
      {
        "backend": "etherscan-v2",
        "ok": false,
        "error": {
          "code": "not-confirmed",
          "message": "...",
          "hint": "...",
          "docsUrl": "...",
          "retryable": true,
          "handle": "ev1:etherscan-v2:..."
        }
      }
    ]
  }
}
```

`ok` is `true` only when every outcome's `ok` is `true`. A reader that knows only the other forms
tells this one apart by `result.outcomes`. A `not-confirmed` outcome carries the handle that
resumes that backend alone with `checkStatus()`. In the library, an error outcome holds the
`ExplorerVerifyError` itself; the envelope holds its `toJSON()`.

`toEnvelope` and `exitCodeOf` throw `invalid-input` for a value that is not a `VerifyResult`, a
`DryRunResult`, a `VerifyEachResult` or an `ExplorerVerifyError`, and `toEnvelope` throws it for options other than `{ secrets?: string[] }`.
Only code that bypasses the types can pass such values.

When a program holds two copies of explorer-verify, `instanceof` and `ExplorerVerifyError.is`
recognise an error from the other copy by its brand. A copy released before the brand has none.
Both functions still accept its error when its `name` is `"ExplorerVerifyError"` and its `toJSON()`
returns a valid error object with a code this copy knows. Its fields are checked and redacted like
any other error's. Its handle must have a known backend, a chain ID in decimal digits, `0x` and 40
hex digits, and a job id of letters, digits, `_` and `-` (or `[redacted]`); any other handle gives
`invalid-input`.

## JSON Schema

The package ships a JSON Schema (draft 2020-12) for the envelope. Import it as
`explorer-verify/envelope.schema.json`, or read `schema/envelope.schema.json` in the installed
package. It compiles in strict mode, for example with ajv's `strict: true`. The schema allows
fields it does not list, and accepts any error code or backend of the form
`^[a-z0-9]+(-[a-z0-9]+)*$`, so a reader that validates against it keeps working when a later
release adds a field, a code or a backend. Its descriptions list the codes and backends this
release knows.

`explorer-verify/input.schema.json` describes the request that the CLI's `--input-json` reads: a
`VerifyInput` with an optional `route` for `verify`, or a `handle` with an optional `route` for
`status`. It has no field for an API key. See [CLI](cli.md#the-request-as-json).

## Exit codes

Each outcome has one exit code. `ERROR_EXIT_CODES` holds the codes of the errors, and `exitCodeOf`
covers results and errors.

| Outcome                        | Kind   | `ok`    | Exit code |
| ------------------------------ | ------ | ------- | --------- |
| `verified`                     | Result | `true`  | 0         |
| `already-verified`             | Result | `true`  | 0         |
| `failed`                       | Result | `false` | 1         |
| `invalid-input`                | Error  | `false` | 2         |
| `unsupported-chain`            | Error  | `false` | 2         |
| `incomplete-input`             | Error  | `false` | 2         |
| `insufficient-artifact`        | Error  | `false` | 2         |
| `unsupported-compiler`         | Error  | `false` | 2         |
| `source-mismatch`              | Error  | `false` | 2         |
| `no-metadata-hash`             | Error  | `false` | 2         |
| `constructor-args-unavailable` | Error  | `false` | 2         |
| `missing-api-key`              | Error  | `false` | 3         |
| `api-key-rejected`             | Error  | `false` | 3         |
| `quota-exceeded`               | Error  | `false` | 3         |
| `not-confirmed`                | Error  | `false` | 4         |
| `verification-inconclusive`    | Error  | `false` | 4         |
| `proxy-link-pending`           | Error  | `false` | 4         |
| `proxy-link-unknown-state`     | Error  | `false` | 6         |
| `network`                      | Error  | `false` | 5         |
| `rate-limited`                 | Error  | `false` | 5         |
| `timeout`                      | Error  | `false` | 5         |
| `unexpected-response`          | Error  | `false` | 5         |
| `in-progress`                  | Error  | `false` | 5         |
| `metadata-unavailable`         | Error  | `false` | 5         |
| `unknown-state`                | Error  | `false` | 6         |
| `job-not-found`                | Error  | `false` | 6         |
| `internal-error`               | Error  | `false` | 6         |
| `cancelled`                    | Error  | `false` | 130       |

The CLI creates `cancelled` and `internal-error`; the library never throws them.

A `verifyEach()` result has one exit code for all its outcomes. It is 0 only when every outcome
is 0. Otherwise it is the first of 6, 4, 3, 2, 5, 1 and 130 that any outcome has: a state a
person must check comes first, then a job to resume, then a key or input to fix, then what a
retry may settle, then a rejection. So Sourcify `verified` with Etherscan `missing-api-key` exits
3, and Sourcify `not-confirmed` with Blockscout `unsupported-chain` exits 4. The code names only the
first outcome that has it: read `result.outcomes` for every backend.
[Errors](errors/index.md#exit-codes) explains what to do for each exit code, and the
[CLI reference](cli.md) describes the CLI's streams. `explorer-verify --help --json` and `explorer-verify --version --json`
print envelopes of their own, with `ok: true` and exit code 0. Their `result` is not a
`VerifyResult`: validate them with `@explorer-verify/cli/help.schema.json` and
`@explorer-verify/cli/version.schema.json`, not with this schema.
