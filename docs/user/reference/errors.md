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

- the API key of the call;
- the value of a key-like URL or form parameter, such as `apikey`, `api_key`, `key` or `token`, in
  any case, in the query string or the fragment;
- the user name and password of a URL;
- a bearer token.

The `cause` is a copy of the underlying error with its name, message, stack and own cause redacted.
So `console.log(error)` does not print a key, even when `fetch` failed with a URL that held one. A
cause that is an object but not an `Error` reads `[cause omitted]`.

## Exit codes

The CLI exits with one code per outcome. `ERROR_EXIT_CODES` maps each error code to its exit code.

| Exit code | Meaning                                                          | Error codes                                                                  |
| --------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 0         | `verified` or `already-verified`                                 | None                                                                         |
| 1         | `failed`: the explorer rejected the submission                   | None. A `failed` result is not an error                                      |
| 2         | Invalid input, or a chain the backend does not serve             | `invalid-input`, `unsupported-chain`                                         |
| 3         | Missing, invalid or under-privileged API key                     | None yet. Key errors arrive with the first keyed backend                     |
| 4         | Still pending; the output carries the handle when there is one   | `not-confirmed`, `in-progress`                                               |
| 5         | Network or explorer unavailable after retries                    | `network`, `rate-limited`, `timeout`, `unexpected-response`, `job-not-found` |
| 6         | Unknown state; the output carries the handle. A person checks it | `unknown-state`                                                              |
| 130       | Cancelled                                                        | None. An abort rejects with `signal.reason`                                  |

## Codes

Each entry below gives the cause, the fix, whether to retry and the exit code.

### invalid-input

Cause: the input failed validation, or a handle did not parse. A handle with any field it does not
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
closed connection or a CORS block in a browser all end here. `details.attempts` gives the number of
requests tried.

Fix: check the network connection and the explorer's status page, then call again.

Retryable: yes.

Exit code: 5

### rate-limited

Cause: the backend answered HTTP 429 on every try. `details.retryAfterMs` holds the wait the
backend asked for, when it sent a `Retry-After` header.

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

Cause: the backend answered with an HTTP status or a body the library does not recognise.
`details.status` holds the status and `details.excerpt` the first 300 characters of the body,
redacted.

Fix: check the explorer's status page. If the error persists, report `details.status` and
`details.excerpt` in an issue.

Retryable: no.

Exit code: 5

### in-progress

Cause: the backend is already verifying this contract from another submission.

Fix: wait for the explorer to finish that verification, then check the contract again.

Retryable: yes.

Exit code: 4

### unknown-state

Cause: the explorer reported a final state the library cannot classify. The library does not
report it as verified. `details.handle` identifies the verification and `details.excerpt` holds the
first 300 characters of the answer, redacted.

Fix: do not retry automatically. Check the contract on the explorer, then report `details.excerpt`
in an issue.

Retryable: no.

Exit code: 6

### job-not-found

Cause: the explorer no longer knows the job id in `details.handle`. Explorers drop old jobs.

Fix: call `verify()` again to submit the contract again.

Retryable: no. Checking the same handle again fails the same way.

Exit code: 5
