# JSON output and exit codes

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents that read the outcome of a verification as data: a script, a
server handler, a CI job or the CLI with `--json`.

A call to `verify()` or `checkStatus()` ends with a result or an `ExplorerVerifyError`. Two
functions of `explorer-verify/envelope` turn either one into data that a program reads without
parsing messages:

| Function              | Gives                                  |
| --------------------- | -------------------------------------- |
| `toEnvelope(outcome)` | The [JSON envelope](#the-envelope)     |
| `exitCodeOf(outcome)` | The [exit code](#exit-codes), a number |

The CLI prints the envelope on stdout with `--json`, and exits with that code.

## Print the envelope

This script verifies the Greeter of a Foundry project, prints the envelope and sets the exit code:

```ts [print-envelope.ts]
import { buildVerifyInputFromFoundry } from "@explorer-verify/foundry";
import { ExplorerVerifyError, verify } from "explorer-verify";
import { exitCodeOf, toEnvelope } from "explorer-verify/envelope";
import type { VerifyOutcome } from "explorer-verify/envelope";

const built = await buildVerifyInputFromFoundry({
  root: ".",
  contract: "src/Greeter.sol:Greeter",
});
let outcome: VerifyOutcome;
try {
  outcome = await verify({
    chainId: 11155111,
    address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
    ...built,
  });
} catch (error) {
  if (!(error instanceof ExplorerVerifyError)) throw error;
  outcome = error;
}
console.log(JSON.stringify(toEnvelope(outcome)));
process.exitCode = exitCodeOf(outcome);
```

When Sourcify already has the contract, it prints one line and exits with 0:

```text
{"schemaVersion":1,"ok":true,"result":{"status":"already-verified","backend":"sourcify","match":"exact","explorerUrl":"https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc"}}
```

Pass the call's API keys in `secrets`, as `toEnvelope(outcome, { secrets: [key] })`, to remove
them wherever they appear.

## The envelope

The envelope has six forms. Tell them apart by `ok`, `error` and `result.status`:

| Form                                                            | `ok`                         | Holds                                                                           |
| --------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| A verified result                                               | `true`                       | `result`                                                                        |
| A `failed` result                                               | `false`                      | `result`, with `reason` and `reasonCode`, and no `error`                        |
| Another contract's source, CLI with `--require-own-source` only | `false`                      | `result` with `status: "already-verified"` and `storedContract`, and no `error` |
| An error                                                        | `false`                      | `error`                                                                         |
| A [dry run](#dry-run)                                           | `true`                       | `result` with `status: "dry-run"`                                               |
| [Several backends](#several-backends)                           | `true` when every one passed | `result.outcomes`                                                               |

A verified result:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "result": { "status": "verified", "backend": "sourcify", "match": "exact" }
}
```

A result the explorer rejected:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "result": {
    "status": "failed",
    "backend": "etherscan-v2",
    "reason": "...",
    "reasonCode": "bytecode-mismatch"
  }
}
```

An error, here a job still pending:

<!-- code-width: JSON strings do not break -->

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "not-confirmed",
    "message": "...",
    "hint": "Call checkStatus later with the error's handle (details.handle) to continue polling.",
    "docsUrl": "https://aelmanaa.github.io/explorer-verify/reference/errors/not-confirmed",
    "retryable": true,
    "handle": "ev1:sourcify:11155111:0x5fbdb2315678afecb367f032d93f642f64180aa3:550e8400-e29b-41d4-a716-446655440000",
    "details": {
      "code": "not-confirmed",
      "handle": "ev1:sourcify:11155111:0x5fbdb2315678afecb367f032d93f642f64180aa3:550e8400-e29b-41d4-a716-446655440000"
    }
  }
}
```

`ok` is `true` exactly when the exit code is 0. `result` is a `VerifyResult` with only the fields
its status declares. `explorerUrl` is absent when the library knows no public page for the
contract.

`storedContract`, on `already-verified`, names another contract whose source the explorer holds
([verify()](verify.md#another-contracts-source)). Your source is then not on the explorer, yet
`ok` stays `true` and the exit code 0.

To require your own source, pass `--require-own-source` to `verify`. The run then exits 1, and the
envelope keeps the result with `ok: false`. On several backends, each such outcome gets
`ok: false` and counts as exit code 1. `toEnvelope()` and `exitCodeOf()` take no such option: a
script that calls them checks `result.storedContract === undefined`. `status` never sets
`storedContract`, so the flag is `verify`'s only
([decision 0069](../../contributor/decisions/0069-require-own-source.md)).

### The error object

`error` is the error's `toJSON()`. It never holds `cause` or the stack:

| Field       | Holds                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| `code`      | The error code. [Errors](errors/index.md) lists every code                    |
| `message`   | What went wrong, for people                                                   |
| `hint`      | What to do next                                                               |
| `docsUrl`   | The code's own page                                                           |
| `retryable` | Whether the same call may succeed later                                       |
| `handle`    | The handle, in its one-line form, when the error carries one                  |
| `details`   | The error's `details` in the library, redacted, with `details.code` as `code` |

Checking `code` tells you which fields `details` has. Each code's page lists them, and the JSON
Schema checks them:

| `code`                | Fields of `details` |
| --------------------- | ------------------- |
| `invalid-input`       | `issues`            |
| `incomplete-input`    | `candidates`        |
| `rate-limited`        | `retryAfterMs`      |
| `unexpected-response` | `status`, `excerpt` |

A `cancelled` error of a CLI run on several backends also holds `handles`. It lists one
`{ "backend", "handle" }` for each backend that accepted a submission and had not ended, in
`--backend` order. `handle` is then set only when one backend submitted. Resume each handle.

### Stable output

- Keys are always in the order shown, and the envelope holds no timestamp. The same outcome gives
  the same JSON, byte for byte.
- Every string is redacted. Key-like URL and form parameters, bearer tokens and bare
  Etherscan-style keys become `[redacted]`.
- The job id in `handle` is an exception to the bare-key rule, so a job id of 34 upper-case
  letters and digits still resumes. `secrets` and key-like parameters still apply to it.
- Within `schemaVersion` 1, a release may add fields, error codes and backends, and changes nothing
  else. Ignore a field you do not know. Handle an unknown error code by its `retryable` value and
  its exit code.

### Dry run

`toEnvelope()` of a `DryRunResult` gives the dry-run form, with exit code 0. Its `result` is the
`DryRunResult` of [`dryRun()`](verify.md#dry-run), and nothing was submitted.
`npx @explorer-verify/cli verify --dry-run --json` prints it:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "result": {
    "status": "dry-run",
    "backend": "etherscan-v2",
    "apiHost": "api.etherscan.io",
    "lookup": "skipped",
    "routedBy": "api-url"
  }
}
```

| Field            | Values                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `lookup`         | `exact`, `partial`, `none`, or `skipped`: the backend needs a key and none was set                                     |
| `storedContract` | The other contract's `name` and `compilerVersion`, for a match from its source: a run without `--dry-run` would submit |
| `routedBy`       | `caller`, `table`, `fallback` or `api-url`: how the backend was chosen                                                 |
| `apiHost`        | A host name, with the port when it is not the scheme's default, such as `127.0.0.1:5555`                               |

### Several backends

`toEnvelope()` of a `VerifyEachResult` gives the form of several backends. The CLI prints it for
`--backend` given more than once. Its `result.outcomes` holds one outcome per backend of
[`verifyEach()`](verify.md#several-backends-in-one-call), in the order the call listed them:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "result": {
    "outcomes": [
      {
        "backend": "sourcify",
        "ok": true,
        "result": {
          "status": "verified",
          "backend": "sourcify",
          "match": "exact"
        }
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

Each outcome has `backend`, `ok`, and either the backend's `result` or its `error`, redacted as in
the other forms. `ok` is `true` only when every outcome's `ok` is `true`. A `not-confirmed`
outcome carries the handle that resumes that backend alone with `checkStatus()`.

In the library, an error outcome holds the `ExplorerVerifyError` itself; the envelope holds its
`toJSON()`.

### From the CLI

The CLI prints the same envelope with two changes for an error:

- `error.hint` names the CLI's flags, environment variables and commands, not the library's
  options. For `missing-api-key` on Etherscan, it says to set `ETHERSCAN_API_KEY` or pass
  `--api-key-file`. Each error page gives its CLI hint.
- `nextCommand`, after `error`, is the command that resumes the run as it is, as an argument
  array. It is set for `not-confirmed`, and for `cancelled` with one handle.

`nextCommand` runs `explorer-verify status` with the handle, which never submits, and adds
`--json` when the run had it. It holds no key, RPC URL or file path. It is left out when the
command would need more:

- a handle that does not parse, such as one whose job id was redacted;
- a handle of `etherscan-compatible`, which needs the API URL;
- a run that read its key from a key flag. Its hint then says to add the same flag.

A `not-confirmed` error from the CLI:

<!-- code-width: JSON strings do not break -->

```json
{
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "not-confirmed",
    "message": "...",
    "hint": "The explorer is still verifying. Run explorer-verify status ev1:sourcify:11155111:0x5fbdb2315678afecb367f032d93f642f64180aa3:550e8400-e29b-41d4-a716-446655440000 later to continue polling, or raise --timeout. Running verify again would submit again.",
    "docsUrl": "https://aelmanaa.github.io/explorer-verify/reference/errors/not-confirmed",
    "retryable": true,
    "handle": "ev1:sourcify:11155111:0x5fbdb2315678afecb367f032d93f642f64180aa3:550e8400-e29b-41d4-a716-446655440000",
    "details": {
      "code": "not-confirmed",
      "handle": "ev1:sourcify:11155111:0x5fbdb2315678afecb367f032d93f642f64180aa3:550e8400-e29b-41d4-a716-446655440000"
    }
  },
  "nextCommand": [
    "explorer-verify",
    "status",
    "ev1:sourcify:11155111:0x5fbdb2315678afecb367f032d93f642f64180aa3:550e8400-e29b-41d4-a716-446655440000",
    "--json"
  ]
}
```

Without `--json`, stderr shows the same hint, and the next command on a `next:` line.
[CLI output](cli-output.md#the-error-block) describes that error block. The other details are in
`--json` only.

## Errors from another copy

`toEnvelope()` and `exitCodeOf()` throw `invalid-input` for any value they do not accept. They
accept a `VerifyResult`, a `DryRunResult`, a `VerifyEachResult` or an `ExplorerVerifyError`. `toEnvelope()` also throws it
for options other than `{ secrets?: string[] }`. Only code that bypasses the types can pass such
values.

When a program holds two copies of explorer-verify, `instanceof` and `ExplorerVerifyError.is`
recognise an error from the other copy by its brand. A copy released before the brand has none.
Both functions still accept its error when:

- its `name` is `"ExplorerVerifyError"`;
- its `toJSON()` returns a valid error object with a code this copy knows;
- its handle has a known backend, a chain ID in decimal digits, `0x` and 40 hex digits, and a job
  id of letters, digits, `_` and `-` (or `[redacted]`).

Any other handle gives `invalid-input`. An error object read this way, from another copy or from
a server handler's answer, must hold `details` with its own `code`. A `not-confirmed`,
`job-not-found` or `unknown-state` error must also hold `handle`.

The details are rebuilt from the fields its code declares, with these limits:

| What                                  | Limit                                                 |
| ------------------------------------- | ----------------------------------------------------- |
| Each string                           | Redacted again, cut to 1,000 characters               |
| Each excerpt                          | Cut to 300 characters                                 |
| Each list                             | Cut to 50 items                                       |
| A metadata hash                       | Kept only in the shape of one                         |
| A handle                              | Taken from the checked `handle` or `handles`          |
| An optional number that is not finite | Left out, so the JSON never holds `null` for a number |
| A required number that is not finite  | `invalid-input`                                       |
| The message and the hint              | Cut to 2,000 characters                               |
| `docsUrl`                             | Rebuilt from the code                                 |

## JSON Schema

The package ships a JSON Schema (draft 2020-12) for the envelope. Import it as
`explorer-verify/envelope.schema.json`, or read `schema/envelope.schema.json` in the installed
package. It compiles in strict mode, for example with ajv's `strict: true`.

The schema allows fields it does not list. It accepts any error code or backend of the form
`^[a-z0-9]+(-[a-z0-9]+)*$`, so a reader that validates against it keeps working when a later
release adds one. Its descriptions list the codes and backends this release knows.

`explorer-verify/input.schema.json` describes the request that the CLI's `--input-json` reads. For
`verify`, it is a `VerifyInput` with an optional `route`. For `status`, it is a `handle` with an
optional `route`. It has no field for an API key. See [CLI](cli.md#the-request-as-json).

## Exit codes

Each outcome has one exit code. `exitCodeOf` covers results and errors, and `ERROR_EXIT_CODES` of
`explorer-verify/envelope` holds the codes of the errors.

| Outcome                                                                  | Kind   | `ok`    | Exit code |
| ------------------------------------------------------------------------ | ------ | ------- | --------- |
| `verified`                                                               | Result | `true`  | 0         |
| `already-verified`                                                       | Result | `true`  | 0         |
| `already-verified` with `storedContract`                                 | Result | `true`  | 0         |
| The same, CLI `verify --require-own-source` only; `exitCodeOf` returns 0 | Result | `false` | 1         |
| `failed`                                                                 | Result | `false` | 1         |
| `invalid-input`                                                          | Error  | `false` | 2         |
| `unsupported-chain`                                                      | Error  | `false` | 2         |
| `incomplete-input`                                                       | Error  | `false` | 2         |
| `insufficient-artifact`                                                  | Error  | `false` | 2         |
| `unsupported-compiler`                                                   | Error  | `false` | 2         |
| `source-mismatch`                                                        | Error  | `false` | 2         |
| `no-metadata-hash`                                                       | Error  | `false` | 2         |
| `constructor-args-unavailable`                                           | Error  | `false` | 2         |
| `handler-refused`                                                        | Error  | `false` | 2         |
| `missing-api-key`                                                        | Error  | `false` | 3         |
| `api-key-rejected`                                                       | Error  | `false` | 3         |
| `quota-exceeded`                                                         | Error  | `false` | 3         |
| `not-confirmed`                                                          | Error  | `false` | 4         |
| `verification-inconclusive`                                              | Error  | `false` | 4         |
| `proxy-link-pending`                                                     | Error  | `false` | 4         |
| `not-indexed`                                                            | Error  | `false` | 4         |
| `proxy-link-unknown-state`                                               | Error  | `false` | 6         |
| `network`                                                                | Error  | `false` | 5         |
| `rate-limited`                                                           | Error  | `false` | 5         |
| `timeout`                                                                | Error  | `false` | 5         |
| `unexpected-response`                                                    | Error  | `false` | 5         |
| `in-progress`                                                            | Error  | `false` | 5         |
| `metadata-unavailable`                                                   | Error  | `false` | 5         |
| `unknown-state`                                                          | Error  | `false` | 6         |
| `job-not-found`                                                          | Error  | `false` | 6         |
| `internal-error`                                                         | Error  | `false` | 6         |
| `cancelled`                                                              | Error  | `false` | 130       |

The CLI creates `cancelled` and `internal-error`; the library never throws them.
[Errors](errors/index.md#exit-codes) explains what to do for each exit code.

### The exit code of several backends

A `verifyEach()` result has one exit code for all its outcomes. It is 0 only when every outcome is 0. Otherwise it is the first of 6, 4, 3, 2, 5, 1 and 130 that any outcome has, in this order:

1. 6: a state a person must check;
2. 4: a job to resume;
3. 3 and 2: a key or an input to fix;
4. 5: what a retry may settle;
5. 1 and 130: a rejection or a cancel.

So Sourcify `verified` with Etherscan `missing-api-key` exits 3. Sourcify `not-confirmed` with
Blockscout `unsupported-chain` exits 4. The code names only the first outcome that has it: read
`result.outcomes` for every backend.

### Help and version

`npx @explorer-verify/cli --help --json` and `--version --json` print envelopes of their own, with
`ok: true` and exit code 0. Their `result` is not a `VerifyResult`. Validate them with
`@explorer-verify/cli/help.schema.json` and `@explorer-verify/cli/version.schema.json`, not with
this schema. [CLI output](cli-output.md) describes the CLI's streams.

## Proxy results in the SDK

`toEnvelope()` and `exitCodeOf()` accept a `LinkProxyResult`:

| Status                     | Envelope                                  | Exit code |
| -------------------------- | ----------------------------------------- | --------- |
| `linked`                   | `{ schemaVersion: 1, ok: true, result }`  | 0         |
| `mismatch` or `not-linked` | `{ schemaVersion: 1, ok: false, result }` | 1         |

The CLI has no proxy-link command. `proxy-link-pending` and `proxy-link-unknown-state` are
SDK-only errors.

## Types

`Envelope<Result>` keeps the result type, with errors serialized as `ErrorJson`.

- In a successful `verifyEach()` envelope, `ok: true` narrows every outcome to a successful
  result.
- A failed verification is a result with `ok: false`, while a thrown error has `error`. Check
  `envelope.error !== undefined` to tell them apart.
- `BackendOutcome` makes `result` and `error` mutually exclusive in TypeScript.
