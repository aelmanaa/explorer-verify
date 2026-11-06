# 0016: API keys are bound to their hosts

Status: Accepted (2026-11-03). Amends the `apiKeys` direction and the error code list of
[decision 0009](0009-options-handle-and-errors.md).

Amended by [decision 0046](0046-handler-url-and-keyed-backend-names.md): point 4 no longer holds; an
injected `fetch` leaves the missing-key check on, and only `handlerUrl` turns it off for Etherscan.

Research: [2026-11-03-api-key-placement.md](../research/2026-11-03-api-key-placement.md) for where
Etherscan and Routescan read a key and what they answer;
[2026-11-02-explorer-apis.md](../research/2026-11-02-explorer-apis.md) for the first key answers;
[2026-11-03-routescan-zksync.md](../research/2026-11-03-routescan-zksync.md#key-policy-and-rate-limits)
for Routescan's keyless tier; [2026-11-02-etherscan-terms.md](../research/2026-11-02-etherscan-terms.md)
for the plan rule; [2026-11-05-routescan-key.md](../research/2026-11-05-routescan-key.md) for
Routescan's reading of a real key.

## Context

Decision 0009 planned `VerifyOptions.apiKeys?: Partial<Record<BackendName, string>>` for M2, but did
not say where a key may go. A key sent to the wrong host is a leak (R-SEC-2). Two paths could send
one there:

- a handle that names `etherscan-v2` for a chain routed elsewhere;
- a route override such as `{ backend: "etherscan-v2", apiUrl: "https://attacker.example" }` read
  from untrusted configuration.

Live answers on 2026-11-03: Etherscan reads a key only from the request parameters. A key in an
`apikey` or `x-api-key` header gets `Missing/Invalid API Key`, the same answer as no key. A key in
the form body of a POST works for `getsourcecode`, `checkverifystatus` and `verifysourcecode`. An
unknown key gets `Invalid API Key (#err2)`. Routescan answers keyless requests, and answered a
made-up key in its `apikey` header without refusing it.

Issue #58 left three points open: what `apiKeys["etherscan-compatible"]` means when each standalone
explorer has its own host; whether the missing-key check runs when the caller injects `fetch`; and
which codes key failures get.

## Decision

### 1. A key from `apiKeys` goes only to its backend's table host

`apiKeys` accepts `etherscan-v2` and `routescan`. A key goes with a request only when:

- the request's backend equals the route's backend. A status poll passes the handle's backend, so
  a handle that names another backend never gets a key. `checkStatus()` already refuses such a
  handle with `invalid-input` before any request;
- the request URL has the origin of the route's API base;
- the URL is `https://` on the backend's host, `api.etherscan.io` or `api.routescan.io`, on the
  default port. An overridden `apiUrl` on another host gets no key from `apiKeys`.

One function, `keyFor`, decides this, and every keyed client sends its requests through
`withKey`, which calls it. The table hosts live in the key module until the routing table (#59)
holds them.

### 2. Standalone explorers take their key as `route.apiKey`

`apiKeys["etherscan-compatible"]` throws `invalid-input`: no single host can be bound to it. A
standalone explorer's key goes in `route.apiKey`, next to the override's `apiUrl`, and is bound to
that route's host. `route.apiKey` without `apiUrl` throws `invalid-input`: once the routing table
routes a chain, a key meant for one explorer would otherwise reach the table's host for that chain.
`route.apiKey` wins over `apiKeys` for the route's backend. A backend that takes no key
(`sourcify`, and `blockscout` until M3) refuses it, and refuses an `apiKeys` entry too.

### 3. Placement: never in a URL

- Etherscan v2: the `apikey` field of a form-encoded POST body, with `chainid` in the query,
  confirmed live. `withKey` throws a plain `Error` for a keyed Etherscan-style request that is not a
  POST with a `URLSearchParams` body: that is a bug in a client, which the caller cannot fix, so it
  is not a catalogue error. The CLI reports it as `internal-error`.
- Standalone explorers: the same form-body placement. Not confirmed live.
- Routescan: the `apikey` request header, as its docs show. Confirmed live on 2026-11-05 with a
  real key: the answer carried the keyed tier's `x-ratelimit-*` headers, which a keyless answer
  lacks. Routescan also reads the key as a query parameter; the client does not use it, because a
  URL is logged where a header is not. A made-up key gets the keyless answer, not a refusal
  ([Routescan with a real key](../research/2026-11-05-routescan-key.md)).

A proxy that adds keys is reached through an injected `fetch`, not through `route.apiUrl`.

### 4. The missing-key check runs only without an injected `fetch`

When the route's backend needs a key (`etherscan-v2`), no key is bound to its host, and
`options.fetch` is not set, the call throws `missing-api-key` before any request. With an injected
`fetch`, as in the server handler setup of R-SRV-5, the request goes out without a key, and the
explorer's `Missing/Invalid API Key` answer maps to `missing-api-key`.

### 5. Three new codes, each exit code 3 and not retryable

| Code               | When                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `missing-api-key`  | The backend needs a key and none is bound to its host, or the explorer says it is missing |
| `api-key-rejected` | The explorer refused the key, as `Invalid API Key (#err2)`                                |
| `quota-exceeded`   | The key's daily limit is spent                                                            |

`details` holds the backend only, never the key or the explorer's text. `keyErrorOf` maps an
Etherscan-style answer with `status` `"0"` to these codes.

### 6. Every key is a secret of the call

Each string value of `apiKeys`, valid or not, and `route.apiKey` join the call's secrets, so the
logger, `onEvent`, errors and results never show them (R-SEC-1). The context holds the checked keys
behind a function, so printing it shows none.

A key must be 8 to 1024 characters from the RFC 3986 unreserved set, `A-Z`, `a-z`, `0-9`, `.`, `_`,
`~` and `-`. Redaction ignores shorter secrets. A key with other characters, such as `&`, `<`, `"`,
`/` or a non-ASCII letter, can come back from an explorer as an HTML entity, as `\/` in JSON or as
mojibake, forms that redaction does not match; a non-Latin-1 key also cannot travel in a header.
Etherscan keys are letters and digits, and UUID-style keys fit. Any made-up value of 8 or more
allowed characters works as a placeholder.

A key that is all digits, or that occurs in any case in `ev1:<backend>:<chainId>:<address>`, throws
`invalid-input` before any request: redacting it would corrupt the address in events and the
handle, and show where the key sits.

## Alternatives considered

- Bind `apiKeys["etherscan-compatible"]` to whatever host the route names. Rejected: a route
  override from untrusted configuration would then choose where the key goes, the leak R-SEC-2
  forbids.
- Run the missing-key check with an injected `fetch` too. Rejected: it would break the handler
  setup, where the browser holds no key and the server adds it.
- Map key failures to `invalid-input` or `unexpected-response`. Rejected: R-AX-7 gives key problems
  their own exit code, 3, and an agent acts on them differently: it asks a person for a key.
- Make `quota-exceeded` retryable. Rejected: a daily limit does not reset within one call.

## Consequences

- `VerifyOptions` gains `apiKeys` and `RouteOverride` gains `apiKey`. Both are optional.
- `ERROR_CODES`, `ERROR_EXIT_CODES`, the error pages, the JSON reference and the envelope schema's
  code list gain the three codes. Exit code 3 has its first codes.
- The Etherscan v2, Routescan and standalone clients (#61, #62, #63) build each request without a
  key and pass it through `withKey`, and pass each answer through `keyErrorOf`.
- R-AX-9 points at `apiKeys`: the CLI's key input fills `apiKeys` for the route's backend.
