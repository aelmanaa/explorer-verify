# 0048: Refusals of the server handler map to error codes, and `handler-refused` is new

Status: Accepted (2026-11-06). Amends the point of
[decision 0046](0046-handler-url-and-keyed-backend-names.md), section 1, on the answers of the
handler, which left a dedicated error code to this record.

Research: none (maintainer choice).

## Context

Issue [#215](https://github.com/aelmanaa/explorer-verify/issues/215) reports that a refusal of
`createVerifyHandler` reached `verify()` as `unexpected-response`, exit code 5. With a handler set to
`chains: [1]` and a call on chain 11155111, the handler answers 403 `chain-not-allowed`. Decision
0046 made such a 4xx refusal not retryable and named its code in the message, but the code still
said "the explorer is unavailable" and the handler's `code` was only in `details.excerpt`. A 4xx
answer with no `code`, from a proxy in front of the handler, stayed retryable.

## Decision

1. A new error code, `handler-refused`: the handler refused the request with a code that holds
   until its options or the request change. It is not retryable, exits 2 ("nothing was submitted
   for verification") and has `details.backend`, `details.status`, `details.handlerCode` and
   `details.excerpt`. `handlerCode` is a `string`, not the `HandlerRefusal` union: the redactor
   would need the list of codes at run time to check the union, and that list would then ship in
   every bundle. The redactor keeps it only in the shape of a code, `^[a-z][a-z-]{0,39}$`, else
   `""`. The CLI has no `handlerUrl`, so only the library throws it.
2. `src/server/refusals.ts` holds the `HandlerRefusal` union and `HANDLER_REFUSALS`, a record keyed
   by that union that gives each refusal its client error code and the status the handler sends
   with it. The handler refuses only with a `HandlerRefusal`, the record needs an entry for each,
   and the client reads the record, so the two cannot drift. The record is internal;
   `explorer-verify/server` still exports the type.

   | Refusal                                                                                                                                                              | Status        | Client error          |
   | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------- |
   | `chain-not-allowed`, `address-not-allowed`, `action-not-allowed`, `forbidden-field`, `body-too-large`, `bad-request`, `method-not-allowed`, `unsupported-media-type` | 400 to 415    | `handler-refused`     |
   | `rate-limited`, `upstream-rate-limited`                                                                                                                              | 429           | `rate-limited`        |
   | `request-timeout`, `upstream-timeout`, `upstream-error`                                                                                                              | 408, 504, 502 | `network`             |
   | `address-not-indexed`, `internal-error`                                                                                                                              | 503, 500      | `unexpected-response` |

3. A code maps only when the answer's status is the one in the record. A proxy or Etherscan answer
   that carries a handler code with another status, such as `chain-not-allowed` on a 502, is not a
   refusal of the handler and keeps today's rules. A 429 never reaches the mapping: the HTTP layer
   throws `rate-limited` for it first, so the client has no `rate-limited` branch.
4. The issue lists six codes for `handler-refused`. `method-not-allowed` and
   `unsupported-media-type` join them: the client never sends such a request, so a page that gets
   one has a `fetch` or a proxy that changes the request, and calling again does not help. Four
   codes get a hint that names their option: `chains`, `deployers`, `allowProxyLink`,
   `maxBodyBytes`. Every other mapped code keeps its error code's default hint, which keeps the
   chunk small.
5. `address-not-indexed` stays `unexpected-response`, retryable. The HTTP layer already retries the
   handler's 503 as long as its `Retry-After` asks, which is the not-indexed wait the issue asks
   for; the error comes only once those retries end. `internal-error` stays `unexpected-response`
   too. Amended on 2026-11-11 by
   [decision 0066](0066-wait-for-the-explorer-to-index.md#amendment-2026-11-11-the-server-handlers-address-not-indexed):
   `address-not-indexed` maps to `not-indexed`.
6. `request-timeout` is a 408, which the HTTP layer returns without a retry. It maps to `network`,
   with one attempt. `upstream-timeout` (504) and `upstream-error` (502) map to `network` after the
   HTTP layer's retries. `unexpected-response` gains an optional `details.attempts`, which the HTTP
   layer sets when it gives up after retries, and the `network` error takes it from there. A 502 or
   504 to a submit is not retried; the submit-once logic treats the `network` error as a submit
   that may have reached Etherscan and looks the contract up first. The handler's code stays only in
   the message.
7. For an error the HTTP layer throws, the code is read by parsing the excerpt as JSON and taking a
   top-level string `code`. An excerpt cut at 300 characters, or a `code` inside another field,
   gives no code. The message names the request by the action in its body: the submit, the lookup
   or the job status request.
8. An answer with no `code`, an unknown code or a code with another status stays
   `unexpected-response`, and its message does not repeat the code: a value of a code's shape may be
   a secret that redaction does not catch. A 4xx other than 408 and 429 is then not retryable, with
   or without a `code`, and its hint says to check `handlerUrl` and the `createVerifyHandler`
   options. A 404 from a wrong `handlerUrl` gets the same hint.
9. The mapping lives in `src/http/handler-url.ts`, the chunk that loads only when `handlerUrl` is
   set (decision 0046, section 1a). The always-loaded code gains only the code's catalogue entries
   (name, exit code, redactor, default hint) and `details.attempts`.

## Alternatives considered

- Keep `unexpected-response` and set `retryable: false`, as decision 0046 did. Rejected: the code
  and exit code 5 tell a script that the explorer is down and to call again later.
- Exit code 3 for `handler-refused`, next to the key codes. Rejected: exit 3 means the API key is
  missing or refused, and the handler holds the key. Exit 2 says that the input or the
  configuration must change and that nothing was submitted, which is what happened.
- Type `handlerCode` as `HandlerRefusal`. Rejected for the bundle cost in point 1.

## Consequences

- Breaking before 0.1.0: a call through the handler that its guards refuse throws
  `handler-refused`, exit code 2, not `unexpected-response`, exit code 5. A 4xx answer of the handler without a `code` is no
  longer retryable.
- The `handler-url` chunk grows from 1,685 to 2,279 bytes gzipped, measured with `pnpm run size`
  on main 411169e, for the table, the mapping and one hint template. Its ceiling moves from 2,024 to
  2,735 bytes, the new size plus 20% (decision 0014). Every entry grows by about 100 bytes for the
  catalogue entries and `details.attempts`; no entry passes its ceiling.
- A handler-refused call exits 2 in a script that maps `ERROR_EXIT_CODES`; the CLI never throws it.
- A new refusal code in `createVerifyHandler` does not compile until `HANDLER_REFUSALS` maps it.
