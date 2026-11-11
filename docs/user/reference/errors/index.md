# Errors

<!-- docs-style: legacy -->

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Audience: developers and agents handling errors from explorer-verify.

Every error the library throws is an `ExplorerVerifyError`, except on abort, where the call rejects
with `signal.reason` unchanged. Check `error.code`; TypeScript then narrows `error.details` to that
code's data. Each error has:

| Field       | Contents                                                                              |
| ----------- | ------------------------------------------------------------------------------------- |
| `code`      | A stable code from the list below                                                     |
| `message`   | What went wrong                                                                       |
| `hint`      | What to do next                                                                       |
| `docsUrl`   | The code's own page, listed under [Codes](#codes)                                     |
| `retryable` | `true` when trying again may succeed; for `not-confirmed`, try `checkStatus` again    |
| `details`   | The code's data, such as the handle                                                   |
| `cause`     | A redacted copy of the underlying error. `toJSON()` and `JSON.stringify` leave it out |

`Object.keys(error)` lists `code`, `hint`, `retryable`, `details` and `docsUrl`.
`JSON.stringify(error)` prints `code`, `message`, `hint`, `docsUrl`, `retryable`, the handle in its
one-line form when there is one, and `details`, redacted, with each handle in its one-line form. It
never prints `cause`, the stack or an API key. Its type, `ErrorJson`, is a union keyed by `code`, so
checking `code` narrows `details` there too.

`ExplorerVerifyError`, `ERROR_CODES`, `ERROR_HINTS`, `hintFor` and the error types are also
exported from `explorer-verify/errors`. Code that only checks or maps errors imports them from there: that entry
never reaches the verification code, so any bundler emits one file for it.

```ts
import { ExplorerVerifyError, formatHandle, verify } from "explorer-verify";

try {
  await verify(input);
} catch (error) {
  if (error instanceof ExplorerVerifyError && error.code === "not-confirmed") {
    localStorage.setItem("pending-verification", formatHandle(error.details.handle));
  }
  throw error;
}
```

### Recognise an error

`ExplorerVerifyError.is(error, code)` checks the error and its code in one call, and narrows
`error.details` to that code. Leave out `code` to accept any code; a `switch` on `error.code` then
narrows `details` in each case:

```ts
import { ExplorerVerifyError, checkStatus } from "explorer-verify";
import type { Handle } from "explorer-verify";

async function resume(handle: Handle): Promise<void> {
  try {
    await checkStatus(handle);
  } catch (error) {
    if (ExplorerVerifyError.is(error, "rate-limited")) {
      console.error(`Wait ${String(error.details.retryAfterMs ?? 5_000)} ms.`);
    } else if (ExplorerVerifyError.is(error)) {
      switch (error.code) {
        case "not-confirmed":
          console.error(error.details.handle.jobId);
          break;
        default:
          console.error(error.code, error.hint);
      }
    }
    throw error;
  }
}
```

To pass a caught error to your own function and still narrow it by code there, type the parameter
as `AnyExplorerVerifyError`, not `ExplorerVerifyError`.

`ExplorerVerifyError.is` and `instanceof` check a brand, `Symbol.for("explorer-verify.error")`, not
the class. Both hold for an error from another installed copy of explorer-verify, for example when
a build helper resolves another version than your code. The brand is a symbol key, so
`structuredClone` and `postMessage` drop it; send `error.toJSON()` to a worker or another window.

### Create an error

Library code creates these errors. Code that builds one itself, such as a wrapper that reports its
own failures the same way, passes the code's default hint from `ERROR_HINTS`. Without a `hint`, the
error's hint points to `docsUrl`:

```ts
import { ERROR_HINTS, ExplorerVerifyError } from "explorer-verify";

const error = new ExplorerVerifyError({ code: "internal-error" }, "The wrapper failed.", {
  hint: ERROR_HINTS["internal-error"],
  secrets: [],
});
```

### Hints for your tool's users

`error.hint` is written for the developer who calls the library. It may name a function, such as
`checkStatus`, or an option, such as `timeoutMs`. It names each value in words; a field path such as
`details.retryAfterMs` follows only in parentheses, so the hint still reads correctly where your
tool gives the error's fields other names.

`hintFor(error, "user")` returns a hint for the people who use your tool, such as an IDE, a dapp or
a verification service. It names no function, option, field or command. It reads the error's
details, so it can:

- give the wait the explorer asked for;
- say when an explorer with an Etherscan-style API has not indexed the contract yet;
- say when Blockscout, hosted or not, gave no job id for each submit, as it can right after a
  deployment;
- tell a cancelled run with a handle to check the explorer before submitting again.

`hintFor(error, "developer")` returns `error.hint`. Both take the error or its JSON form. `hintFor`
never throws: a value it cannot read, or a code it does not know, gets a general hint. Each code's
page gives its end-user hint on its "For end users" line.

<!-- no-run: it calls a terminal function of the host tool, which a test run does not have. -->

```ts no-run
import { ExplorerVerifyError, hintFor, verify } from "explorer-verify";
import type { VerifyInput } from "explorer-verify";

declare const input: VerifyInput;
declare function showInTerminal(text: string): void;

try {
  await verify(input);
} catch (error) {
  if (ExplorerVerifyError.is(error)) {
    showInTerminal(`Verification failed. ${hintFor(error, "user")}`);
  }
  throw error;
}
```

### From the CLI

The CLI prints the same codes, with a hint in its own words: flags, environment variables and
commands instead of the library's options. Each code's page gives that hint on its "From the CLI"
line. Under the error line, it lists the issues of `invalid-input` that the message does not
already state, and the candidates or missing sources of `incomplete-input`. For example, with a
build-info that holds two contracts and no `--contract`:

```console
error: The documents hold 2 contracts and none was chosen. (incomplete-input)
  candidates: src/Base.sol:Base, src/Greeter.sol:Greeter
  hint: Pass --contract with one of: src/Base.sol:Base, src/Greeter.sol:Greeter.
  docs: https://aelmanaa.github.io/explorer-verify/reference/errors/incomplete-input
```

For `not-confirmed`, and for `cancelled` with one handle, a `next:` line gives the command that
resumes the job, and `--json` puts it in `nextCommand`.
[JSON output](../json-output.md#from-the-cli) describes both.

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

The details are frozen. An optional number that is not finite, such as a `retryAfterMs` of `NaN`,
is left out. A required number, such as the `status` of `unexpected-response`, is kept as it is:
an error built by code that bypassed the types with `NaN` or `Infinity` there is refused by
`toEnvelope()` and `exitCodeOf()` with `invalid-input`, because JSON has no such number.

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

The CLI exits with one code per outcome. `ERROR_EXIT_CODES`, from `explorer-verify/envelope`, maps
each error code to its exit code.

| Exit code | Meaning                                                                                                                                                          | Error codes                                                                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0         | `verified` or `already-verified`                                                                                                                                 | None                                                                                                                                                                                                                                  |
| 1         | `failed`: the explorer definitively rejected the submission                                                                                                      | None. A `failed` result is not an error                                                                                                                                                                                               |
| 2         | Usage or input error, including a chain the backend does not support, or a refusal of your server handler in the library; nothing was submitted for verification | `invalid-input`, `unsupported-chain`, `incomplete-input`, `insufficient-artifact`, `unsupported-compiler`, `source-mismatch`, `no-metadata-hash`, `constructor-args-unavailable`, `handler-refused` (library only, with `handlerUrl`) |
| 3         | Missing, invalid or under-privileged API key                                                                                                                     | `missing-api-key`, `api-key-rejected`, `quota-exceeded`                                                                                                                                                                               |
| 4         | No verdict yet: still pending at the time budget (the output carries the handle), the job ended without one, or the explorer has not indexed the contract yet    | `not-confirmed`, `verification-inconclusive`, `proxy-link-pending` (no handle: call `linkProxy()` with `resumeJobId`), `not-indexed` (no handle: call `verify()` again)                                                               |
| 5         | Network or explorer unavailable after retries; call again later                                                                                                  | `network`, `rate-limited`, `timeout`, `unexpected-response`, `in-progress`, `metadata-unavailable`                                                                                                                                    |
| 6         | Unknown state; the output carries the handle of a verification. Or a bug in the CLI, with no handle. A person checks it                                          | `unknown-state`, `job-not-found`, `proxy-link-unknown-state` (no handle), `internal-error` (created by the CLI)                                                                                                                       |
| 130       | Cancelled                                                                                                                                                        | `cancelled`, created by the CLI. In the library, an abort rejects with `signal.reason`                                                                                                                                                |

`unexpected-response` and `unknown-state` differ in who answered. `unexpected-response` means the
answer did not come from the explorer's API, or not in its format: a 5xx status, an HTML page or a
wrong content type, after retries. `unknown-state` means the explorer's API answered in its format,
for a submission with a job id, with a status the library cannot classify, or that a job reported
the contract as already verified and the lookup for its match failed or found no match.

## Retries

Before it throws `network`, `rate-limited` or `unexpected-response`, the library retries the
request with the same URL and body:

- at most 5 attempts, the first one included;
- after a wait that starts at 1 second and doubles each time, with jitter that keeps between half
  and all of it;
- at least as long as the `Retry-After` header asks, in seconds or as a date. A `Retry-After`
  above 30 seconds ends the retries at once. A Routescan 429 without `Retry-After` is read the
  same way from its `x-ratelimit-rpm-retry-after` header;
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

Each code has its own page with the cause, the fix, the default hint, the end-user hint, whether to
retry and the exit code. `docsUrl` links that page.

- [`invalid-input`](invalid-input.md)
- [`not-confirmed`](not-confirmed.md)
- [`unsupported-chain`](unsupported-chain.md)
- [`network`](network.md)
- [`rate-limited`](rate-limited.md)
- [`timeout`](timeout.md)
- [`unexpected-response`](unexpected-response.md)
- [`in-progress`](in-progress.md)
- [`unknown-state`](unknown-state.md)
- [`job-not-found`](job-not-found.md)
- [`cancelled`](cancelled.md)
- [`incomplete-input`](incomplete-input.md)
- [`insufficient-artifact`](insufficient-artifact.md)
- [`unsupported-compiler`](unsupported-compiler.md)
- [`verification-inconclusive`](verification-inconclusive.md)
- [`source-mismatch`](source-mismatch.md)
- [`missing-api-key`](missing-api-key.md)
- [`api-key-rejected`](api-key-rejected.md)
- [`quota-exceeded`](quota-exceeded.md)
- [`internal-error`](internal-error.md)
- [`no-metadata-hash`](no-metadata-hash.md)
- [`metadata-unavailable`](metadata-unavailable.md)
- [`constructor-args-unavailable`](constructor-args-unavailable.md)
- [`proxy-link-pending`](proxy-link-pending.md)
- [`proxy-link-unknown-state`](proxy-link-unknown-state.md)
- [`handler-refused`](handler-refused.md)
- [`not-indexed`](not-indexed.md)
