# 0023: The routing table's size is measured apart from the code

Status: Accepted (2026-11-03). Amends the measurement of
[decision 0014](0014-measured-bundle-ceilings.md) and the `apiKeys` host rule of
[decision 0016](0016-api-keys-bound-to-hosts.md).

Research: none (maintainer choice).

## Context

Issue [#59](https://github.com/aelmanaa/explorer-verify/issues/59) adds `routing/table.json`, the
routing table the resolver imports as a JSON module. R-RUN-3 says the table loads as data and its
size is reported on its own line. Decision 0014 measures each public entry as one bundle, so the
table's rows would count against the `verify` ceiling, and each row added later would look like
code growth.

The table shipped with #59 has five rows, each with Sourcify only: 286 bytes, minified and gzipped.
A review of #59 estimates the full table of #60, about 67 rows with Etherscan, Routescan and
Sourcify entries, at about 2 KB gzipped. On 2026-11-03, with esbuild 0.28.2 and Node 24.21.0 zlib,
`verify` measured 16,624 bytes without the rows and 16,793 bytes with them, against a ceiling of
17,283.

#59 also replaced the temporary `KEY_HOSTS` list of the key module with the routing table.

## Decision

### Size

- The four code entries of `size-budget.json` (`verify`, `checkStatus`, `buildVerifyInput` and
  `index`) set `withoutTable`: `pnpm run size` measures them with an empty routing table. Their
  ceilings measure code.
- A `routing table` entry measures the rows alone. Its ceiling is the measured size plus 20%, as
  decision 0014 sets for every entry.
- A page that imports `verify` ships about the code plus the table. So one more entry,
  `verify with table`, measures that whole bundle, and its ceiling is the `verify` ceiling of
  decision 0014, 17,283 bytes. That ceiling still bounds what a page ships.
- The full table of #60, at about 2 KB, will not fit under 17,283 bytes with the current code. #60
  and #61 settle that question: a raised ceiling with its measurement, the table as its own entry
  point, or rows that ship only what `verify()` reads. This decision does not raise a ceiling.

### Keys

- Each route records `overridden`, whether `route.apiUrl` set it, and `tableHost`, the host the
  routing table lists for its backend and chain. `KEY_HOSTS` is removed.
- A key from `apiKeys` goes only to `https://<tableHost>` on the default port, and only for a route
  the caller did not override. No `route.apiUrl` gets a key from `apiKeys`, even one that names the
  table's own host; such a route takes only `route.apiKey`. This is stricter than decision 0016,
  which sent `apiKeys` to an overridden URL on the table's host.

## Alternatives considered

- Keep one bundle per entry, as decision 0014 does. Rejected: each row added would count as code
  growth, and the table's own size would not be visible, as R-RUN-3 asks.
- Measure code and table apart with no full-bundle gate. Rejected: nothing would bound what a page
  ships, and the code and table ceilings could each pass while the sum grows without limit.
- Raise the `verify` ceiling in #59 for the full table. Rejected: #59 ships five rows, and the
  measurement belongs to the pull request that adds the rest.

## Consequences

- `size-budget.json` gains `withoutTable` on the code entries and two entries, `verify with table`
  and `routing table`. `scripts/bundle.ts` replaces the table with an empty one for the code
  entries.
- #60 reports the seeded table's size and, with #61, decides the ceiling of `verify with table`.
- The key module no longer holds any host. A test checks the hosts in the routing table instead.
