# 0027: Etherscan v2 rows, Sourcify first on paid-plan chains, and a larger table ceiling

Status: Accepted (2026-11-04). Amends the `routing table` ceiling of
[decision 0024](0024-compact-routing-table.md).

Research: [the Etherscan v2 entries](../research/2026-11-04-etherscan-rows.md),
[the routing table's rows](../research/2026-11-03-routing-table.md),
[API key placement](../research/2026-11-03-api-key-placement.md).

## Context

Issue [#122](https://github.com/aelmanaa/explorer-verify/issues/122) adds `etherscan-v2` entries to
the routing table now that the Etherscan v2 client exists (#61). Decision 0024 kept them in the
research data until then. The Etherscan chainlist, read again on 2026-11-04, lists 57 chains: 46
say "Free-tier available" and 11 say "Paid Plan required". All 57 already have a Sourcify row.

R-RT-1 sends a call to the first backend in its row that works with the caller's keys. With
`etherscan-v2` first, any caller with an Etherscan key goes to Etherscan. On a paid-plan chain, a
free-plan key is not enough for Etherscan to answer, while Sourcify serves the same chain without a
key. The CLI fills `apiKeys["etherscan-v2"]` from `ETHERSCAN_API_KEY`, so a person with a free key
in their environment would reach Etherscan on those chains without asking for it.

The entries also grow the table. Measured with esbuild 0.28.2 and Node.js 24.21.0 zlib on
2026-11-04, on main at commit 5faa6a6 with this change: the `routing table` entry is 933 bytes,
over its ceiling of 566; `verify with table` is 20,233 bytes, under its ceiling of 20,897.

## Decision

### Entries and order

- Each chain of the Etherscan chainlist gets `{ "backend": "etherscan-v2", "explorer": "<host>" }`,
  with the host of the chainlist's `blockexplorer` field.
- On a free-tier chain, `etherscan-v2` comes first and `sourcify` second.
- On a paid-plan chain, `sourcify` comes first and `etherscan-v2` second. A caller with a paid plan
  sets `route.backend` to `etherscan-v2`; the key from `apiKeys` goes with it, because the route
  still comes from the table. A CLI user with a paid plan passes `--backend etherscan-v2`.
- The chainlist's "Paid Plan required" is separate from the plan rule of R-SEC-3: a public dapp, or
  any business, protocol, foundation or DAO use, needs an Advanced plan or higher on every chain,
  free tier or not. The docs state both.
- The table's `checked` date is 2026-11-04.
- `scripts/compare-routing-table.ts` reports a chainlist chain without an `etherscan-v2` entry, an
  explorer host other than the chainlist's, an entry in the wrong place for the chain's plan, and
  an entry for a chain the chainlist no longer lists.

### Size ceilings

The `routing table` ceiling is reset by decision 0014's rule, the measured size plus 20% rounded
up. The other ceilings stay.

| Entry               | Before (5faa6a6) | After  | Old ceiling | New ceiling |
| ------------------- | ---------------- | ------ | ----------- | ----------- |
| `routing table`     | 471              | 933    | 566         | 1,120       |
| `verify with table` | 19,738           | 20,233 | 20,897      | 20,897      |
| `verify`            | 19,081           | 19,081 | 20,195      | 20,195      |
| `checkStatus`       | 17,120           | 17,120 | 18,351      | 18,351      |
| `index`             | 26,557           | 26,557 | 28,979      | 28,979      |

`verify with table` still bounds what a page ships, and it fits: the table is not split into its
own entry point.

## Alternatives considered

- `etherscan-v2` first on every chain, as the issue's backend order says. Rejected: a free-plan key
  would turn 11 calls that Sourcify serves into Etherscan refusals, and the CLI fills the key from
  the environment.
- No `etherscan-v2` entry on paid-plan chains. Rejected: a caller with a paid plan could reach
  Etherscan there only with `route.apiUrl` and `route.apiKey`, and its results would have no
  `explorerUrl`.
- Derive the explorer host in code instead of listing it. Rejected: the hosts follow no pattern
  (`basescan.org`, `xdcscan.com`, `sepolia.arbiscan.io`), so the code would carry the same list.
- Raise the `verify with table` ceiling too. Rejected: it is not crossed.

## Consequences

- R-RT-1 records the Etherscan entries and the order on paid-plan chains.
- The Routescan rows (#62) have 664 bytes left under `verify with table` and 187 bytes under the
  new `routing table` ceiling, measured on 2026-11-04. If they cross either, #62 measures and
  records its own raise.
- A chain that moves between the free tier and a paid plan in the chainlist changes the order of
  its row; the comparison script reports it.
