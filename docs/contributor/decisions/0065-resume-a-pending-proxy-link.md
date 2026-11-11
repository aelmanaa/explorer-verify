# 0065: Resume a pending proxy link with its job id

Status: Accepted (2026-11-10). Amends the `proxy-link-pending` point and the rejected "handle for a
pending link" alternative of [decision 0033](0033-proxy-link-as-a-separate-call.md).

Research: [2026-11-04: how Etherscan, Blockscout and Sourcify link a proxy](../research/2026-11-04-proxy-linking.md).

## Context

`linkProxy()` sends `verifyproxycontract`, then checks `checkproxyverification` with the job id the
explorer answers. Under decision 0033, a link still pending at the time budget throws
`proxy-link-pending` with no handle and no job id, and the fix is a new `linkProxy()` call, which
sends a new link request.

Issue [#296](https://github.com/aelmanaa/explorer-verify/issues/296) reports a Remix plugin proof of
concept: a tool that shows progress cannot continue the same link after a reload. Each call sends a
new request. The research note records the answers this depends on, from the live run on Ethereum
Sepolia on 2026-11-04 with the `fetch` of Node.js 24.21.0:

- Etherscan answered `Pending in queue` with `status` `"0"` for more than 60 seconds (curl 8.7.1,
  issue #94), so a link can outlast a short budget.
- Blockscout refused a second `verifyproxycontract` for the same proxy with
  `Only one attempt in 12000ms`.
- Etherscan's job id is 50 lowercase letters and digits; Blockscout's is the proxy's 40 hex digits
  and a hex timestamp.
- A check of a job id the explorer does not know answers `Error!` on Etherscan and `Unknown UID` on
  Blockscout. Both map to `proxy-link-unknown-state`.

## Decision

- `proxy-link-pending` gains `details.jobId`: the job id of the link request, redacted with the
  call's keys as a handle's job id is (R-SEC-1), and cut to 1,000 characters. Every error this
  release creates sets it, but the type and the envelope schema keep it optional: within
  `schemaVersion` 1 a release only adds fields, so saved 0.1.0 output still validates and code
  that builds the error without it still compiles.
- `LinkProxyOptions` gains `resumeJobId?: string`. With it, `linkProxy()` sends no link request. It
  checks the job at once, since the link may have ended while no one checked, then every
  `pollIntervalMs`, and maps the end as before. A link still pending ends with
  `proxy-link-pending` and the same job id.
- `resumeJobId` must be 1 to 100 letters and digits, and of the form the route's backend gives for
  the target: each proxy-link module says so with `acceptsJobId`. Sourcify starts no job and has no
  `acceptsJobId`, so it refuses any value. Routescan is refused on `route.backend` as before. Each
  refusal is `invalid-input` on `resumeJobId`, before any request, and never repeats the value.
- A job id the explorer no longer knows throws `proxy-link-unknown-state`, as an unknown answer to
  a link this call started does. The fix is a call without `resumeJobId`.
- The server handler needs no change: a resumed call sends only `checkproxyverification`, which it
  forwards with `allowProxyLink: true` (R-SRV-3).
- A link request no longer answers `pending` in the internal `ProxyLinker` type. Only a check does,
  so every `proxy-link-pending` has a job id.

## Alternatives considered

- A one-line link handle, `ev1-link:<backend>:<chainId>:<address>:<guid>`, and a new export
  `checkProxyLink(handle)`. Rejected: it adds a handle format and an export, while the caller
  already holds the target and route that the handle would repeat.
- Resume a link with `checkStatus()`. Rejected for the reason decision 0033 gives: it needs a second
  handle kind.
- Keep the first check after `pollIntervalMs`, as for a new request. Rejected: with a `timeoutMs`
  below `pollIntervalMs`, a resumed call would end pending without checking at all.
- Map an unknown job id to `invalid-input`. Rejected: Etherscan's `Error!` does not say that the job
  id is unknown, so the state of the link is not known.

## Consequences

- One more field in the details of `proxy-link-pending`, its page, its default hint, the exit-code
  row of R-AX-7, the skill and the proxy guide.
- One more option of `linkProxy()`, also through `explorer-verify/core`.
- The `linkProxy` entry and the `proxy-etherscan` and `proxy-blockscout` chunks grow by a few
  hundred bytes, within their ceilings.
