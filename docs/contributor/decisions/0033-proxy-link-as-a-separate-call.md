# 0033: Link a proxy with a separate call whose explorer code loads on demand

Status: Accepted (2026-11-04). Amends the error code list of
[decision 0009](0009-options-handle-and-errors.md) and the actions the server handler forwards
under [decision 0021](0021-server-handler-forwards-a-reduced-lookup.md).

Research: [2026-11-04: how Etherscan, Blockscout and Sourcify link a proxy](../research/2026-11-04-proxy-linking.md).

## Context

R-FLOW-8 asks the library to link a verified proxy to its implementation, so the explorer shows the
implementation's functions on the proxy's page. Issue
[#94](https://github.com/aelmanaa/explorer-verify/issues/94) sets the scope. The explorers differ:
Etherscan links on request and checks the link as a job; Blockscout detects proxies itself and
takes a request to read the implementation again; Sourcify detects them when it verifies and takes
no request. A link can stay pending: Etherscan answered `Pending in queue` with `status` `"0"` for
more than a minute, and Blockscout stayed at `Verification in progress` for an address that is not
a proxy. Blockscout refuses a link request within 12 seconds of verifying the proxy, which is the
documented order of the steps. Etherscan links a proxy whose source it has not verified.

## Decision

- `linkProxy(target, options?)` is its own export, next to `verify()`. `target` holds `chainId`,
  `address` and an optional `expectedImplementation`; other fields are ignored, as `verify()`
  ignores them. `options` is `VerifyOptions`, and the route, keys, budget and logger work as in
  `verify()`. `verify()`'s result type does not change.
- Each explorer's proxy-link code sits in its own module, loaded with a dynamic `import()` only when
  a call is routed to it, through the same bounded loader as the clients (decision 0031): the load
  counts against `timeoutMs` and ends on abort. `src/backends/proxy-etherscan.ts` serves Etherscan
  v2 and standalone Etherscan-compatible explorers, `proxy-blockscout.ts` Blockscout and
  `proxy-sourcify.ts` Sourcify. A caller who imports only `verify` bundles none of it (R-RUN-5),
  and `linkProxy` and each chunk get their own size ceiling by decision 0014's rule.
- The result has three statuses:
  - `linked`, with the implementation the explorer reports, in lower case, and
    `implementationVerified`;
  - `mismatch`, when the explorer holds another implementation than `expectedImplementation`, with
    that implementation and the expected one. Etherscan's refusal does not name it, so one
    `getsourcecode` reads its record of the proxy; it is absent when the record holds none;
  - `not-linked`, with the explorer's reason, for a refusal: the proxy is not verified there, or no
    implementation is detected.
- An implementation must be exactly `0x` and 40 hex digits followed by a non-hex boundary, and not
  the zero address. A longer run of digits, several addresses or the zero address is never read as
  a link.
- When the explorer's answer does not say whether the implementation is verified (Blockscout,
  Sourcify), one more lookup of the implementation reads it.
- Blockscout's `Only one attempt in <n>ms` is waited once, when the wait fits the budget, and the
  request sent again. When it is refused again, or the wait does not fit, the REST lookup of the
  proxy gives the implementation Blockscout already holds.
- A link request answered in a form the client does not know, such as a `result` that is not a job
  id of the documented form, throws `unexpected-response`: nothing started. A status check or a
  lookup answered with a link state the client cannot classify throws the new code
  `proxy-link-unknown-state`: exit code 6, not retryable, details `backend` and `excerpt`, no
  handle.
- A link still pending when `timeoutMs` runs out, or after 3 failed status checks in a row, throws
  the new code `proxy-link-pending`: exit code 4, retryable, no handle. Its fix is "call
  `linkProxy()` again later". A new request is safe on every explorer: it undoes nothing.
- Routescan throws `invalid-input` on `route.backend`, before routing and before any request, until
  a live run shows what its `verifyproxycontract` does.
- The server handler forwards `verifyproxycontract` (fields `address`, `expectedimplementation`)
  and `checkproxyverification` (`guid`) only with the new option `allowProxyLink: true`. It is off
  by default: a link request needs no source, so it widens what a reachable handler lets anyone do
  with the operator's key. The deployer check runs on the proxy's address; `expectedimplementation`
  is not checked against `deployers`.

## Alternatives considered

- A `proxy` option on `verify()`. Rejected: it would grow the `verify` bundle for every caller and
  change `verify()`'s result type.
- `unknown-state` with its `handle` made optional, for a link with no handle. Rejected: callers and
  the CLI read `details.handle` of `unknown-state` as always present, and R-AX-7 promises a handle
  with it. A separate code keeps that promise and names the backend.
- Report another implementation than expected as `not-linked`. Rejected: a caller then cannot tell
  a refusal from a proxy that points elsewhere, which needs another `expectedImplementation`.
- Throw `rate-limited` for Blockscout's repeat-interval refusal. Rejected: it would fail the
  documented order of the steps on every first call.
- Forward the proxy-link actions by default in the server handler. Rejected for the reason above.
- A handle for a pending link, resumed with `checkStatus()`. Rejected: it needs a second handle
  kind and changes the handle format of decision 0009, while asking again is cheap and safe.
- Map a pending link at the budget to `timeout`. Rejected: `timeout` means the explorer had not
  accepted anything, and its exit code is 5; a link in progress is "no verdict yet", exit code 4.
- Read the EIP-1967 slot over JSON-RPC to fill `expectedImplementation`. Deferred: the caller passes
  it, and the explorers read the slot themselves.

## Ceilings

The new entry and chunks get decision 0014's ceiling, the measured size plus 20%, rounded up.
Measured with esbuild 0.28.2 and Node 24.21.0 zlib on 2026-11-04, on main 2c9ad23 plus this
change: `linkProxy` 11,260 (ceiling 13,512), `proxy-etherscan` 4,429 (5,315), `proxy-blockscout`
3,974 (4,769) and `proxy-sourcify` 3,350 (4,020).

The `index` entry, `export *`, holds `linkProxy()`'s flow, which the dynamic imports keep small but
not empty. On main 38365f3, which added `verifyEach()` (decision 0034), plus this change it
measured 26,258 bytes, above the 26,132 ceiling of decision 0031. Its ceiling is reset by decision
0014's rule to 31,510. The `verify`, `verify with table` and `checkStatus` entries stay under their
ceilings and hold no proxy-link code.

## Consequences

- Two more error codes, each with its page under `docs/user/reference/errors/`.
- One more server handler option, `allowProxyLink`.
- Three more chunks under `chunks` in `size-budget.json`, and one entry, `linkProxy`; the `index`
  ceiling is reset.
- The guide [Verify a proxy](../../user/guides/verify-a-proxy.md) states the order of the steps:
  verify the implementation, verify the proxy, then link.
