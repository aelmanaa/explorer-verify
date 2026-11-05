# 0039: Standalone Etherscan-compatible hosts in the routing table, and route.apiKey for them

Status: Accepted (2026-11-05). Amends the table format of
[decision 0024](0024-compact-routing-table.md) and the `route.apiKey` rule (section 2) of
[decision 0016](0016-api-keys-bound-to-hosts.md). Composes with the row order of decisions
[0037](0037-routescan-rows-from-an-api-probe.md) and [0038](0038-blockscout-rows.md).

Research: [the standalone hosts and Bitlayer's answers](../research/2026-11-05-etherscan-compatible-hosts.md),
[the standalone client](../research/2026-11-04-etherscan-compatible-client.md),
[API key placement](../research/2026-11-03-api-key-placement.md).

## Context

The `etherscan-compatible` client (R-BE-2) has no row, and the schema 2 entry has no field for a
host of its own. A call reaches a standalone explorer only with `route.apiUrl`. Issue
[#170](https://github.com/aelmanaa/explorer-verify/issues/170) names three chains whose only
Etherscan-style API, in Foundry's chain list (alloy-chains 0.2.39), is a host of their own:
Bitlayer (200901), Core (1116) and Kaia (8217). Bitlayer has no Sourcify support and no other
explorer API found, so it has no row today.

A keyless probe on 2026-11-05 found:

- Bitlayer's API, `https://api.btrscan.com/scan/api`, answers `getsourcecode` and
  `checkverifystatus` as a GET without a key. It answers `getsourcecode` sent as a form POST with
  `{"code":4405,"message":"Request method 'POST' not supported"}`, and an address with no
  verified source with `"status":"1"` and an empty `result` list. The client sent every request as
  a form POST, and read an empty list as an unknown answer.
- Core's and Kaia's APIs answer HTTP 401 without a key. No run with a key has been made.

Decision 0016 refuses `apiKeys["etherscan-compatible"]`, because one value cannot be bound to the
host of every standalone explorer, and refuses `route.apiKey` without `route.apiUrl`, because the
table could then send the key to a host it was not meant for. With a standalone host in the table,
a key for it needs a way in that names its host.

## Decision

### Schema 3

- `schemaVersion` is 3. Schema 3 adds the `etherscan-compatible` entry; every schema 2 entry is
  unchanged. The resolver does not read `schemaVersion`, so a schema 2 table that a test or a caller
  passes resolves as before. The table check in the unit tests requires 3 for the shipped file.
- An `etherscan-compatible` entry holds:
  - `api`, required: the API's host and path without the scheme, such as
    `api.btrscan.com/scan/api`. The paths differ per explorer (`/scan/api`, `/api`), so a host alone
    is not enough. The API base is `https://<api>`.
  - `explorer`, optional: the explorer's host. The contract page is
    `https://<explorer>/address/<address>#code`, the template of `etherscan-v2`.
  - `needsKey`, optional: `true` when the API refuses a request without a key.
- The table check reads `api` as a lowercase host followed by a path with no trailing slash, port,
  query, fragment, user name or dot segment, and checks the derived URL's host and path against
  it, as it reads a Blockscout `instance`. An entry without `api` is dropped by `tableTarget`, so
  its host gets no request.

### Rows

- A chain gets an `etherscan-compatible` entry when its API, from alloy-chains' list, answered a
  keyless `getsourcecode` request as Etherscan does, in the probe recorded in
  `docs/contributor/research/data/2026-11-05-etherscan-compatible-hosts.json`.
- An API that refuses a keyless request gets no entry until a run with a key shows its answers.
  Core (1116) and Kaia (8217) are recorded as left out.
- The entry comes after the `sourcify`, `blockscout` and `etherscan-v2` entries and before
  `routescan`. On 2026-11-05 that adds one row, Bitlayer (200901), with the entry alone: 326 rows.
- `withEtherscanCompatible()` in `scripts/routing-etherscan-compatible.ts` adds the entries after
  `withBlockscout()` and before `withRoutescan()`; `node scripts/compare-routing-table.ts --rows`
  prints the table.
- The weekly comparison compares the table with the probe data, and the probe data with
  alloy-chains' live list: a probed chain whose API moved or that left the list asks for a new
  probe, under the list `alloy-chains list`. It does not probe the APIs.

### Keys for a standalone host

- `apiKeys["etherscan-compatible"]` still throws `invalid-input`. One value would go to every
  standalone host the table routes, and `verifyEach()` and the CLI's environment keys would send a
  key meant for one explorer to another.
- `route.apiKey` with `route.backend` `etherscan-compatible` may now be set without
  `route.apiUrl` when the call's row lists an `etherscan-compatible` entry with `needsKey`. The
  key is then bound to that entry's API base: it goes only to that origin, only with
  `etherscan-compatible` requests, and only in the form body. A row whose entry has no `needsKey`
  throws `invalid-input` naming `route.apiKey` before any request: a keyed lookup is a form POST,
  which Bitlayer refuses with code 4405, and a keyless explorer has no use for the key. A chain
  whose row lists no such entry throws `unsupported-chain` before any request, with or without
  `allowSourcifyFallback`. Neither error holds the key. The caller names
  both the backend and the chain, and the host comes from the shipped table, so no configuration
  value chooses where the key goes (R-SEC-2).
- `route.apiKey` without `route.apiUrl` still throws `invalid-input` for `etherscan-v2` and
  `routescan`: their keys go in `apiKeys`.
- The CLI's `--api-key-file` and `--api-key-stdin` with `--backend etherscan-compatible` and no
  `--api-url` fill `route.apiKey`, so the same rules apply: on Bitlayer the command exits 2.

### Other entry points

- `verifyEach()` with `backends: "all"` leaves out an entry with `needsKey` when no key is bound
  and the row lists another backend, as `resolveRoute` does for a single call.
- `linkProxy()` throws `invalid-input` on `route.backend` before any request for an
  `etherscan-compatible` route from the table, as it does for Routescan. A link request is a form
  POST, which Bitlayer refuses, and no standalone explorer's proxy answers were recorded. With
  `route.apiUrl` it works as before.
- The table check refuses an IPv4 or IPv6 literal in `api`, `explorer` and `instance`.

### The missing-key check

- An entry with `needsKey` counts as a backend that needs a key: a call without `route.backend`
  skips it, and when it is the only usable entry, or `route.backend` names it, the call throws
  `missing-api-key` before any request when no key is bound and `fetch` is not set. The message
  names `route.apiKey`. With an injected `fetch` the request goes out, as decision 0016 section 4
  sets.
- The check reads the entry only when the route's API base is the entry's. A `route.apiUrl` on
  another host keeps the rule of decision 0016: only the explorer's answer tells.

### Requests of the standalone client

- A lookup or a status request with no key bound is a GET with its fields in the query, as
  Bitlayer serves them. With a key, it stays a form POST, so the key is never in a URL (R-SEC-1).
  The submit is a form POST in both cases.
- A lookup answered with `"status":"1"` and an empty `result` list is "not verified" for this
  client only. The Etherscan client still throws `unexpected-response` for it, because Etherscan
  answers an unverified address with one record whose `SourceCode` is empty.

### Size

Measured with `pnpm run size` (esbuild 0.28.2, Node.js 24.21.0 zlib) on 2026-11-05: "Before" is
main at commit d233f17, "After" is that commit with this change. No ceiling changes.

| Entry or chunk               | Before | After  | Ceiling |
| ---------------------------- | ------ | ------ | ------- |
| `verify`                     | 14,423 | 14,598 | 16,334  |
| `verify with table`          | 18,208 | 18,443 | 21,850  |
| `checkStatus`                | 12,243 | 12,408 | 14,076  |
| `index`                      | 26,246 | 26,454 | 31,510  |
| `routing table`              | 2,971  | 3,013  | 3,566   |
| chunk `etherscan-compatible` | 3,539  | 3,648  | 3,942   |

## Alternatives considered

- A `host` field holding the host only, with the path fixed at `/api`. Rejected: Bitlayer's API is
  at `/scan/api`.
- Accept `apiKeys["etherscan-compatible"]` and send it to whatever standalone host the row lists.
  Rejected: the one value would reach every standalone host, the leak decision 0016 refuses.
- Keys by host, such as `apiKeys` keyed by `api.btrscan.com`. Rejected for now: it adds an option
  for chains that have no keyed row yet. `route.apiKey` with the backend named binds a key to one
  host already.
- Add Core and Kaia with `needsKey` now. Rejected: no request with a key has shown how their APIs
  answer or where they read the key.
- Leave the client's requests as POSTs. Rejected: every keyless call to Bitlayer would end in
  `unexpected-response` at the first lookup.
- Read an empty `result` list as "not verified" for every Etherscan-style client. Rejected:
  Etherscan has not been seen to answer so, and R-FLOW-4 reads an unknown answer as an error.

## Consequences

- R-RT-1 and R-BE-2 state the standalone entry and the count.
- 200901 resolves to `https://api.btrscan.com/scan/api` without a route option, and its results
  carry `https://www.btrscan.com/address/<address>#code`.
- `Route` gains `needsKey`, and `TableEntry` gains `api` and `needsKey`. Both are internal.
- The submit and the job status answers of a standalone explorer are still read as Etherscan's;
  Bitlayer's were not seen for a real job, because no contract was deployed there.
- A keyed standalone host joins the table through an issue that runs it with a key and records
  where it reads the key.
