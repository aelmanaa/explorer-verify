# Errors

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents handling errors from explorer-verify.

Every error the library throws is an `ExplorerVerifyError`, except on abort, where the call rejects
with `signal.reason` unchanged. Check `error.details.code` to read the data for that code. Each
error has:

| Field       | Contents                                                                              |
| ----------- | ------------------------------------------------------------------------------------- |
| `code`      | A stable code from the list below                                                     |
| `message`   | What went wrong                                                                       |
| `hint`      | What to do next                                                                       |
| `docsUrl`   | The code's entry on this page                                                         |
| `retryable` | `true` when trying again may succeed; for `not-confirmed`, try `checkStatus` again    |
| `details`   | The code's data, such as the handle                                                   |
| `cause`     | A redacted copy of the underlying error. `toJSON()` and `JSON.stringify` leave it out |

`JSON.stringify(error)` prints `code`, `message`, `hint`, `docsUrl`, `retryable` and, when there is
one, the handle in its one-line form. It never prints `cause`, the stack or an API key.

```ts
import { ExplorerVerifyError } from "explorer-verify";

try {
  await verify(input);
} catch (error) {
  if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
    localStorage.setItem("pending-verification", JSON.stringify(error.details.handle));
  }
  throw error;
}
```

## API keys in errors

The error removes API keys before it stores anything. The message, the hint, every string in
`details` and the cause all show `[redacted]` in place of:

- the API key of the call, in any case, also URL-encoded or form-encoded;
- the value of a key-like URL or form parameter, in any case, in the query string or the
  fragment, also percent-encoded inside another URL: `apikey`, `api_key`, `api-key`, `x-api-key`,
  `key`, `token`, `access_token`, `refresh_token`, `client_secret`, `auth`, `secret` and
  `password`;
- `apikey: value` and a JSON member such as `"apiKey": "value"`;
- the user name and password of a URL;
- a bearer token;
- a bare 34-character Etherscan-style key: upper-case letters and digits, with at least one of
  each. This rule skips the job id of a handle: an explorer may issue a job id of that shape, and
  redacting it would make the handle impossible to resume. A job id that equals the call's API
  key, or holds a key-like parameter, is still redacted.

The error builds `details` again from the fields its code declares, so an extra field never
reaches the error. A `details.backend` outside the list of backends reads `unknown`. That happens
only when code bypassed the types.

The `cause` is a copy of the underlying error. It is a plain `Error` with the original name. Its
message, stack, `code`, `errno` and `syscall`, a one-line summary of an `AggregateError`'s errors,
and its own cause are redacted. Other fields of the original are left out. So `console.log(error)`
does not print a key, even when `fetch` failed with a URL that held one. A cause that is an object
but not an `Error` reads `[cause omitted]`.

Redaction does not cover these cases. Keep such values out of errors:

- request headers other than a bearer token;
- base64 text, and a URL encoded three or more times;
- seed phrases, and private keys written as 64 hex digits. A rule for those would also redact
  every transaction hash.

## Exit codes

The CLI exits with one code per outcome. `ERROR_EXIT_CODES` maps each error code to its exit code.

| Exit code | Meaning                                                                                                        | Error codes                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 0         | `verified` or `already-verified`                                                                               | None                                                                                                      |
| 1         | `failed`: the explorer definitively rejected the submission                                                    | None. A `failed` result is not an error                                                                   |
| 2         | Usage or input error, including a chain the backend does not support; nothing was submitted for verification   | `invalid-input`, `unsupported-chain`, `incomplete-input`, `insufficient-artifact`, `unsupported-compiler` |
| 3         | Missing, invalid or under-privileged API key                                                                   | None yet. Key errors arrive with the first keyed backend                                                  |
| 4         | No verdict yet: still pending at the time budget (the output carries the handle), or the job ended without one | `not-confirmed`, `verification-inconclusive`                                                              |
| 5         | Network or explorer unavailable after retries; call again later                                                | `network`, `rate-limited`, `timeout`, `unexpected-response`, `in-progress`                                |
| 6         | Unknown state; the output carries the handle. A person checks it                                               | `unknown-state`, `job-not-found`                                                                          |
| 130       | Cancelled                                                                                                      | `cancelled`, created by the CLI. In the library, an abort rejects with `signal.reason`                    |

`unexpected-response` and `unknown-state` differ in who answered. `unexpected-response` means the
answer did not come from the explorer's API, or not in its format: a 5xx status, an HTML page or a
wrong content type, after retries. `unknown-state` means the explorer's API answered in its format,
for a submission with a job id, with a status the library cannot classify.

## Retries

Before it throws `network`, `rate-limited` or `unexpected-response`, the library retries the
request with the same URL and body:

- at most 5 attempts, the first one included;
- after a wait that starts at 1 second and doubles each time, with jitter that keeps between half
  and all of it;
- at least as long as the `Retry-After` header asks, in seconds or as a date. A `Retry-After`
  above 30 seconds ends the retries at once;
- for a lookup or a poll: after a network error, a request that took longer than 30 seconds, and
  HTTP 429, 502, 503 or 504;
- for a submit: only after HTTP 429 or 503, which refuse the request before the explorer processes
  it. A submit that got no answer, timed out, or got a 500, 502 or 504 is not sent again, because
  the explorer may have received it. Check the contract's state before you submit again.

A Sourcify 429 whose `customCode` is `duplicate_verification_request` means the contract is
already being verified. It is not retried. A wait that would end after the time budget
(`timeoutMs`) ends the retries with the last error. An abort stops every request and wait at once,
and the call rejects with `signal.reason`.

Some answers end the call at once with `unexpected-response`, without a retry:

- a redirect. The library never follows one, so a request never reaches a host you did not
  configure;
- a body larger than 16 MiB;
- a body that fails or stalls after the headers arrived.

## Codes

Each entry below gives the cause, the fix, whether to retry and the exit code.

### invalid-input

Cause: the input failed validation, or a handle did not parse. From `buildVerifyInput`, it also
means a document of no known shape, documents from different builds (their build ids or full
compiler versions differ), a contract path that is not in the sources, or a local path in the
compiler input. The issue gives the position of a local path, never the path. A handle with any field it does not
know, a URL included, is rejected: a handle never sets the host. All unknown fields are reported as
one issue on `handle` that gives their count, not their names.

Fix: correct each field listed in `details.issues` (`field` and `message`), then call again. For a
handle, pass it exactly as `verify()` or a `not-confirmed` error returned it.

Retryable: no. Nothing was sent to an explorer.

Exit code: 2

### not-confirmed

Cause: the time budget (`timeoutMs`) ran out after the explorer accepted the submission, while it
was still verifying the contract.

Fix: store `details.handle` and pass it to `checkStatus()` later to continue polling. Raise
`timeoutMs` if this happens often.

Retryable: yes, with `checkStatus(details.handle)`. Do not call `verify()` again: it would submit
the contract again.

Exit code: 4

### unsupported-chain

Cause: the backend answered that it does not serve the chain in `details.chainId`.
`details.backend` names the backend.

Fix: check the chain ID. If it is right, pick a backend that serves the chain with the `route`
option.

Retryable: no.

Exit code: 2

### network

Cause: every request to the backend failed before it answered, retries included. DNS, TLS, a
closed connection or a CORS block in a browser all end here, or every request took longer than the
per-request timeout. `details.attempts` gives the number of requests tried.

Fix: check the network connection and the explorer's status page, then call again.

Retryable: yes.

Exit code: 5

### rate-limited

Cause: the backend answered HTTP 429 on every try. `details.retryAfterMs` holds the wait the
backend asked for, when it sent a `Retry-After` header. `details.attempts` gives the number of
requests tried, when the library gave up after retries. The library stops at once when
`Retry-After` asks for more than 30 seconds.

Fix: wait `details.retryAfterMs`, or a few seconds when it is not set, then call again. Lower the
request rate if this happens often.

Retryable: yes.

Exit code: 5

### timeout

Cause: the time budget (`timeoutMs`) ran out before the explorer accepted the submission. There is
no job id yet, so the error carries no handle. `details.timeoutMs` gives the budget.

Fix: call again, or raise `timeoutMs`. If the explorer did receive the submission, the next call
may report the contract as verified or in progress.

Retryable: yes.

Exit code: 5

### unexpected-response

Cause: the answer did not come from the explorer's API, or not in its format, after retries: a 5xx
status, an HTML page, a wrong content type, a redirect or a body that is too large or cannot be
read. `details.status` holds the status and `details.excerpt` the first 300 characters of the
body, redacted. `details.retryAfterMs` holds the wait the backend asked for, when its last answer
had a `Retry-After` header. A status or body that the backend's client does not recognise ends here
too, such as Sourcify's `400 invalid_parameter`, or an answer about another contract.

Fix: call again later. If the error persists, check the explorer's status page and report
`details.status` and `details.excerpt` in an issue.

Retryable: yes.

Exit code: 5

### in-progress

Cause: the backend is already verifying this contract from another submission. This call has no
job id, so the error carries no handle. It also happens when a submit got no clear answer, the
library submitted once more, and the explorer said a job for the contract was already running: the
first submit most likely reached it.

Fix: wait for the explorer to finish that verification, then call again.

Retryable: yes.

Exit code: 5

### unknown-state

Cause: the explorer's API answered for a submission with a job id, in its format, with a status the
library cannot classify. The library does not report it as verified. `details.handle` identifies
the verification and `details.excerpt` holds the first 300 characters of the answer, redacted.

Fix: do not retry automatically. Check the contract on the explorer, then report `details.excerpt`
in an issue.

Retryable: no.

Exit code: 6

### job-not-found

Cause: the explorer no longer knows the job id in `details.handle`. Explorers drop old jobs.

Fix: do not retry automatically. Check the contract on the explorer. If it is not verified, call
`verify()` again to submit it again.

Retryable: no. Checking the same handle again fails the same way.

Exit code: 6

### cancelled

Cause: the run was cancelled, for example with Ctrl-C. The CLI creates this error, so that its
JSON output for exit code 130 has a typed error. The library never throws it: when the caller's
`signal` aborts, the call rejects with `signal.reason` unchanged. `details.handle` is present when
the explorer accepted the submission before the cancel.

Fix: if the CLI printed `verify.submitted`, or `details.handle` is present, resume with
`checkStatus()` and that handle. Otherwise run the command again.

Retryable: no.

Exit code: 130

### incomplete-input

Cause: `buildVerifyInput` found no way to build part of the input from the documents passed.
`details.field` names the part:

- `input`: no document holds the compiler input. A Foundry build-info written without
  `--build-info` holds only `id`, `source_id_to_path` and `language`; a Hardhat 3 `.output.json`
  holds the output but not the input. Solidity metadata, alone or in an artifact, is not a compiler
  input either: rebuilding the input from it arrives in #21.
- `compilerVersion`: no document holds the full version with its commit, such as
  `0.8.24+commit.e11b9ed9`. Foundry build-info records only `0.8.24` in `solcLongVersion`; the full
  version is in each contract's metadata.
- `contract`: the documents hold several contracts and none was chosen, or a bare name matches
  more than one. `details.candidates` lists the fully qualified names found, sorted, at most 20.

Fix: for `input`, rebuild with build-info enabled (`forge build --build-info`) and pass the new
build-info file. For `compilerVersion`, add the artifact or build-info output that holds the
contract metadata, or pass `options.compilerVersion`. For `contract`, pass `options.contract` as
`path:Name` or as a name that matches one entry of `details.candidates`.

Retryable: no. Nothing was sent to an explorer.

Exit code: 2

### insufficient-artifact

Cause: the documents passed to `buildVerifyInput` hold only ABI and bytecode, with no compiler
input, settings or metadata. The explorer needs the sources and the exact settings, and these
files do not have them. `details.field` is `input`.

Fix: three routes remain.

1. Ask the publisher to ship the build-info or the Solidity metadata of the build.
2. Use the bytecode-metadata resolver (planned), when the deployed bytecode carries a
   metadata hash and the metadata is published.
3. Rely on the explorer's own matching (Etherscan Similar Match, Sourcify similarity; see
   [automatic matching](https://github.com/aelmanaa/explorer-verify/blob/main/docs/contributor/research/2026-11-02-explorer-apis.md#automatic-matching-no-submission-needed)),
   when an identical contract is already verified.

Retryable: no. Nothing was sent to an explorer.

Exit code: 2

### unsupported-compiler

Cause: the documents passed to `buildVerifyInput` come from a compiler other than solc.
`details.field` names what showed it: `compilerType` (a Hardhat 3 build-info with a `compilerType`
other than `solc`) or `language` (a compiler input whose language is not `Solidity`, such as
Vyper).

Fix: verify the contract with its compiler's own tooling. This release supports Solidity compiled
with solc only.

Retryable: no. Nothing was sent to an explorer.

Exit code: 2

### verification-inconclusive

Cause: the explorer finished the verification job without a verdict. The job ended with an error
that may clear up later, such as Sourcify's `internal_error`, or `contract_not_deployed` right after
a deployment. `details.reason` holds the explorer's code and message, redacted, at most 300
characters, and `details.backend` names the backend. The
[Sourcify page](sourcify.md#how-answers-are-read) lists those errors. The finished job will not
change, so the error carries no handle.

Fix: wait a minute, then call `verify()` again. It looks the contract up first and submits only
when the contract is not verified. Do not call `checkStatus()`: it would read the same finished
job.

Retryable: yes, with a new `verify()`.

Exit code: 4
