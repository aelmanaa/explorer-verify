# 0024: A compact routing table, URLs derived in one place, and reset size ceilings

Status: Accepted (2026-11-03). Amends the table format and the `verify with table` ceiling of
[decision 0023](0023-routing-table-size-measured-apart.md), and the ceilings of
[decision 0014](0014-measured-bundle-ceilings.md).

Research: [the routing table's rows](../research/2026-11-03-routing-table.md),
[Routescan API facts](../research/2026-11-03-routescan-zksync.md).

## Context

Issue [#60](https://github.com/aelmanaa/explorer-verify/issues/60) seeds the routing table. The
rule in the research note gives 94 chains that Sourcify supports. With the schema 1 format of #59,
where each entry carries its full `apiUrl` and `explorerUrl` and each row a name and a date,
`verify with table` measured 18,570 bytes for those rows, over the 17,283-byte ceiling of decision 0023.

Most of each schema 1 entry repeats what the backend fixes: the Sourcify and Etherscan v2 API
bases are the same for every chain, and a Routescan base needs only the network segment and the
chain id.

## Decision

### Format

- `schemaVersion` is 2. The table has `schemaVersion`, `checked` and `chains`. A row has
  `chainId` and `backends`, in order of preference. `name` and the row's `checked` are removed.
  The source list moves to the research data file, which does not ship.
- An entry holds the backend name and only what varies per chain:
  - `sourcify`: nothing more.
  - `etherscan-v2`: an optional `explorer` host, such as `sepolia.etherscan.io`.
  - `routescan`: `network`, `mainnet` or `testnet`, required.
  - `blockscout`: `instance`, the instance's host, required. Amended on 2026-11-04 by #92: API
    base `https://<instance>/api`, page `https://<instance>/address/<address>?tab=contract`. The
    table check reads `instance` as a bare lowercase host, as it reads `explorer`. No Blockscout
    rows ship yet: the hosts of the five prior-art instances were not checked live
    ([research](../research/2026-11-04-blockscout-client.md)).

### Derivation

`tableTarget(chainId, entry)` in `routing/resolve.ts` is the one place that turns an entry into
URLs. The Sourcify fallback goes through it too.

| Backend        | API base                                                                    | Contract page                                                           |
| -------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `sourcify`     | `https://sourcify.dev/server`                                               | `https://repo.sourcify.dev/<chainId>/<address>`                         |
| `etherscan-v2` | `https://api.etherscan.io/v2/api`                                           | `https://<explorer>/address/<address>#code`, or none without `explorer` |
| `routescan`    | `https://api.routescan.io/v2/network/<network>/evm/<chainId>/etherscan/api` | none yet                                                                |

An entry it cannot derive (an unknown name, a backend with no template, a Routescan entry without
a valid network) is dropped from the row, so its host gets no request and no key. The page is a
function that percent-encodes the address. The table check in the unit tests checks the compact
fields, then runs #59's exact host and path rules on the derived URLs.

### Rows

The table ships 94 Sourcify rows. The Etherscan v2 and Routescan entries found on 2026-11-03 stay
in `docs/contributor/research/data/2026-11-03-routing-seed.json`, with chain names, until #61 and
#62 add their clients. A test keeps every backend in the table to the backends with a client.

### Size ceilings

The ceilings are reset by decision 0014's rule, the measured size plus 20% rounded up, for each
entry this change grows. Measured with esbuild 0.28.2 and Node 24.21.0 zlib on 2026-11-04: "Before"
is main at commit 64c1d58, "After" is that commit with this change.

| Entry               | Before (64c1d58) | After  | Old ceiling | New ceiling |
| ------------------- | ---------------- | ------ | ----------- | ----------- |
| `verify`            | 16,743           | 16,829 | 17,283      | 20,195      |
| `verify with table` | 16,909           | 17,414 | 17,283      | 20,897      |
| `checkStatus`       | 15,194           | 15,292 | 15,646      | 18,351      |
| `index`             | 24,069           | 24,149 | 26,163      | 28,979      |
| `routing table`     | 286              | 471    | 344         | 566         |

`buildVerifyInput` (11,362 bytes) and `createVerifyHandler` (12,074 bytes) do not grow and keep
their ceilings of 13,310 and 14,429.

Decision 0023 quotes 16,624 and 16,793 bytes for `verify` without and with the rows. Those were
measured when #59 merged; code merged since then accounts for the difference with the
"Before" column.

The code grows 86 bytes, mostly for the templates; on 2026-11-03 the Routescan template measured
47 bytes and the Etherscan v2 base 33. The rows cost 585 bytes in the bundle. On 2026-11-03, on the main of that day,
the compact form fit under the old ceiling with 5 bytes to spare; at 64c1d58 it is 131 bytes over.
The ceilings are raised now rather than kept at a margin of a few bytes, because:

- #61 adds the Etherscan v2 client and has to raise the code ceilings anyway.
- A margin of a few bytes fails unrelated pull requests that add any code to `verify`.

The new ceilings are the budget #61 and #62 must fit in, clients and rows included. Any later raise
needs its own decision record. If the Etherscan rows push `verify with table` past its ceiling,
the next step is to load the table as a separate entry, so a page that does not need it does not
ship it.

## Alternatives considered

- Keep schema 1 and raise the ceiling for 18,570 bytes. Rejected: about 1,300 bytes of the table
  repeated what the code can derive.
- Keep the source list in the shipped table. Rejected: the resolver never reads it, and it cost 22
  bytes in the bundle. The research data keeps it with the date.
- Leave the Etherscan v2 and Routescan templates to #61 and #62. Rejected: the resolver and key
  tests for those backends would have no format to run on, and the 80 bytes come back with the
  clients.
- Ship fewer rows. Rejected: no rule picks which chains to drop.

## Consequences

- `routing/table.json` is schema 2. `scripts/bundle.ts` replaces it with an empty schema 2 table
  for the code entries.
- `TableEntry`, `TableRow` and `RoutingTable` change shape; they are internal, and the package has
  not been published.
- `scripts/compare-routing-table.ts` compares the table with the public lists and prints the
  differences; it never writes the table.
- `size-budget.json` records the new ceilings above.
