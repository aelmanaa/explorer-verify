# 0046: `handlerUrl` says that a server adds the key, and `apiKeys` takes only keyed backends

Status: Accepted (2026-11-05). Amends point 4 of [decision 0016](0016-api-keys-bound-to-hosts.md),
the `apiKeys` type of [decision 0009](0009-options-handle-and-errors.md), and R-SRV-5.

Research: [2026-11-02-etherscan-terms.md](../research/2026-11-02-etherscan-terms.md) for the rule
that keeps an Etherscan key out of browser code;
[2026-11-03-api-key-placement.md](../research/2026-11-03-api-key-placement.md) for where Etherscan
reads a key and what it answers without one;
[2026-11-05-fetch-redirect-signals.md](../research/2026-11-05-fetch-redirect-signals.md) for what
the answer of a handler on another origin looks like;
[2026-11-05-server-adds-the-secret.md](../research/2026-11-05-server-adds-the-secret.md) for how
other client SDKs name the server that holds a secret.

## Context

Issue [#217](https://github.com/aelmanaa/explorer-verify/issues/217) reports two gaps.

`VerifyOptions.apiKeys` was typed `Partial<Record<BackendName, string | undefined>>`. Autocomplete
offered `sourcify`, `blockscout` and `etherscan-compatible`, and all three throw `invalid-input` at
run time. Only the TSDoc said so.

Decision 0016 point 4 turned off the missing-key check whenever `fetch` was set, so that a browser
could reach the server handler without a key. People also inject `fetch` for logging, retries,
tests, proxies and edge runtimes. Each of those turned a local `missing-api-key` into a keyless
request to Etherscan and a remote refusal. `verifyEach(input, { backends: ["sourcify",
"etherscan-v2"], fetch })` with no key sent such a request.

The browser setup also needed two pieces of glue: a hand-written `fetch` that rewrote each
Etherscan URL to the handler, about 25 lines in the guide, and `route: { backend: "etherscan-v2"
}`. Without the second, a keyless call went to Sourcify with no warning.

The issue lists three ways to say "a server adds the key": a `handlerUrl` option, a sentinel such
as `apiKeys: { "etherscan-v2": "server" }`, and a flag such as `keyHeldBy: "server"`.

## Decision

### 1. `VerifyOptions.handlerUrl`

`handlerUrl` is the URL of the caller's server handler. With it:

- A route whose backend is `etherscan-v2` and whose API is Etherscan's own goes through the
  handler. Its HTTP context carries the handler's rewrite; the HTTP layer sends each request to
  Etherscan's origin to the handler URL with the request's query appended, with the same method,
  headers and body, and every other request as it is. Log lines, the `verify.routed` event, a dry
  run's `apiHost` and errors name the handler URL, path included, for those requests. The URL is
  not redacted, so it must not hold a secret.
- The routing table chooses as if `apiKeys["etherscan-v2"]` were set. A chain whose row lists
  Etherscan first goes to the handler; a paid-plan chain, whose row lists Sourcify first, and a
  chain with no Etherscan entry go where they would with a key; `verifyEach()` with `backends:
  "all"` keeps `etherscan-v2`. `checkStatus()` on a handle that `verify()` gave with the same
  options resolves the same backend. The issue asked that `handlerUrl` set the route's backend;
  forcing `etherscan-v2` would throw `unsupported-chain` on chains with no Etherscan entry and
  send paid-plan chains to a handler whose key Etherscan refuses there, so a caller who wants
  Etherscan on every chain sets `route.backend`.
- That route needs no key, and the missing-key check is off for it alone. A key bound to it,
  `apiKeys["etherscan-v2"]` or a `route.apiKey` on Etherscan's API, throws `invalid-input` before
  any request, in every function, a dry run included: the handler adds its own key, and the
  browser must not hold one.
- A route whose `apiUrl` is on another host keeps that host and its own key rules.
- An answer of the handler that the client does not read throws `unexpected-response` whose
  message names "your server handler", not Etherscan. When the answer carries the handler's
  stable `code`, the message names it. A 4xx refusal such as `chain-not-allowed`, other than a 408
  or a 429, holds until the handler's options change: it is not retryable, and its hint points at
  the `createVerifyHandler` options. A 5xx answer, such as `internal-error`, or an
  `upstream-error` after the retries, stays retryable and names the code. A dedicated error code
  is left to [#215](https://github.com/aelmanaa/explorer-verify/issues/215).
  `ExplorerVerifyErrorOptions` gains `retryable` for this.
- The value is checked and stored as an absolute URL. A path that starts with one `/` resolves
  against the page (`globalThis.location.href`), and takes the page's scheme, so on a plain
  `http:` page it is that `http:` origin; with no page, as in Node, or a `location` that throws
  when read, it throws `invalid-input`. An absolute value starts with `https://`, or `http://` on `localhost`,
  `127.0.0.1` or `[::1]`. Refused: a user name or password, a query or fragment, any whitespace
  (Unicode spaces included), a control character or a backslash, which a URL parser drops or
  rewrites so that `/\t/evil.example` would name another host, and Etherscan's API host with any
  port or trailing dot. At most 2048 characters. Anything else throws `invalid-input` naming
  `handlerUrl`.

The handler URL is absolute and the HTTP layer sends to it, so with the platform's `fetch` the
origin check of decision 0035 compares the answer with the handler's origin and still applies.
With an injected `fetch`, it does not apply, as decision 0035 says. The redirect checks always
apply.

### 1a. The handler code loads on demand

The project weighs bundle size heavily, for pages and for SDKs that wrap it. A caller who never
sets `handlerUrl` should not pay for it. The value check, the key refusal, the rewrite and the
wording of the handler's errors live in `src/http/handler-url.ts`, which every flow loads with a
dynamic `import()` through `bounded()`, as the clients load (decision 0031), only when
`handlerUrl` is set. The always-loaded path reads the option, asks the loaded code whether a
route goes through the handler, and passes its rewrite to the HTTP layer and its error wording to
the clients. A bad value therefore rejects the call once it starts, not before.

### 2. The missing-key check runs whatever `fetch` is

A route that needs a key and has none bound to its host throws `missing-api-key` before any request,
whether `fetch` is set or not, unless `handlerUrl` serves the route. A dry run skips its lookup in
that case, and looks the contract up through the handler when `handlerUrl` is set. Only the
message of the error for `etherscan-v2` names `handlerUrl`: the handler serves Etherscan alone.

### 3. `apiKeys` takes only keyed backends

`KeyedBackendName` is `"etherscan-v2" | "routescan" | "blockscout-hosted"`, a union in
`backend-names.ts`. The key module's list is built from a record keyed by that union, so a name
missing from the record fails to compile, and the public type does not refer to an internal
value, which the docs site would have to show. `apiKeys` is of the exported type `ApiKeys`,
`{ [B in KeyedBackendName]?: string | undefined }`. For the type, a later keyed backend is one more
union member and one record entry; its client, host and docs are work of their own, as the hosted
Blockscout API of [#229](https://github.com/aelmanaa/explorer-verify/pull/229) was. The run-time
check of other names stays for JavaScript callers. The CLI's key variables use the same type.

### 4. No exported `handlerFetch`

The library does not export a `fetch` helper for the handler. `handlerUrl` already removes the
hand-written `fetch`, and a helper used without `handlerUrl` would hit the missing-key check, since
an injected `fetch` no longer turns it off. The rewrite lives in `src/http/handler-url.ts`, and the
HTTP layer applies it. Other client SDKs take the same shape: a URL option for the server and a
separate `fetch` for interception
([research](../research/2026-11-05-server-adds-the-secret.md)).

## Alternatives considered

- `apiKeys: { "etherscan-v2": "server" }`. Rejected: it mixes a mode with secrets in one field,
  makes `"server"` a reserved key value, and still needs the hand-written `fetch` and the
  `route.backend`. A key-validation message would also have to explain a string that is not a key.
- A flag such as `keyHeldBy: "server"`. Rejected: it says that someone adds the key but not where,
  so the caller still writes the URL-rewriting `fetch`. The library could not tell that the
  requests reach a server at all, so the flag would turn off the check for any `fetch`, the gap
  this issue closes.
- Export `handlerFetch(url)` and keep the old rule. Rejected: a logging or test `fetch` would still
  turn off the check.
- Point `route.apiUrl` at the handler. Rejected: the route then loses the table row, so results
  carry no explorer page, and the key rules of an overridden route apply. Decision 0016 already
  says a proxy is not reached through `route.apiUrl`.

## Consequences

- Breaking before 0.1.0: a call with an injected `fetch`, no key and a route to `etherscan-v2` now
  throws `missing-api-key`, and a dry run skips its lookup there. Callers who reach a server
  handler set `handlerUrl`. A caller who pointed `route.apiUrl` at a proxy and injected `fetch`
  with no key gets `missing-api-key` too: use `handlerUrl` with Etherscan's default URL. Code that
  passes `sourcify`, `blockscout` or `etherscan-compatible` in `apiKeys` no longer compiles.
- R-SRV-5 now names `handlerUrl` as the way the client side uses the handler.
- The `missing-api-key` message names `handlerUrl` for Etherscan only; the catalogue hint is
  unchanged.
- The examples, the browser guide, the server handler guide and reference, the API keys reference
  and step 7 of the dapp tutorial use `handlerUrl`. A result reached through the handler now carries
  the Etherscan page as `explorerUrl`, because the route comes from the routing table.
- Size, with `pnpm run size` on 2026-11-05 against main 1ddf9eb (#231), in bytes gzipped:

  | Entry or chunk       | main   | with #217 | Ceiling |
  | -------------------- | ------ | --------- | ------- |
  | `verify`             | 15,364 | 15,605    | 16,334  |
  | `checkStatus`        | 13,189 | 13,428    | 14,076  |
  | `verifyEach`         | 16,970 | 17,217    | 18,316  |
  | `linkProxy`          | 12,234 | 12,485    | 13,512  |
  | `verify` as one file | 26,205 | 27,520    | 33,024  |
  | `handler-url` chunk  | none   | 1,686     | 2,024   |

  With the handler code in the entry, `verify` had grown by about 775 bytes; loading it on demand
  brings that to 241. The chunk imports no runtime code from the routing or key modules: the
  entry passes it Etherscan's API URL and does the key lookup itself, so a page that imports a
  light name such as `BACKEND_NAMES` loads no more than before (decision 0042). `verify` as one
  file inlines every chunk, so it holds the handler code too: this record sets its ceiling to the
  measured size plus 20%, as decision 0014 sets ceilings, and gives the new `handler-url` chunk its
  own ceiling by the same rule. The other entries keep theirs.
