# 0036: A row for every chain Sourcify supports or Etherscan lists, and a larger table ceiling

Status: Accepted (2026-11-05). Amends the row rule of
[decision 0024](0024-compact-routing-table.md) and the `routing table` ceiling of
[decision 0027](0027-etherscan-rows-and-paid-plan-chains.md).

Research: [the routing table's rows](../research/2026-11-03-routing-table.md),
[the Etherscan v2 entries](../research/2026-11-04-etherscan-rows.md).

## Context

Decision 0024 shipped the rule of the research note of 2026-11-03: a chain gets a row when
Sourcify lists it with `supported: true` and it is in the Etherscan chainlist or in the prior art's
rows. That gave 94 rows. Sourcify lists 288 chains as supported
([research](../research/2026-11-03-routing-table.md#the-check-of-2026-11-05)), so 194 chains that
Sourcify serves throw `unsupported-chain` unless the call sets `allowSourcifyFallback: true`, and
the CLI needs `--backend sourcify --api-url https://sourcify.dev/server`.

Issue [#166](https://github.com/aelmanaa/explorer-verify/issues/166) names 49 such chains among
145 surveyed EVM chains, including 324 (ZKsync Era), 534352 (Scroll), 8217 (Kaia) and 7777777
(Zora). Foundry v1.9.0 (`crates/verify/src/provider.rs`) and `@nomicfoundation/hardhat-verify`
3.1.4 (`src/internal/sourcify.ts`) send any chain id to Sourcify by default, with no chain check.
A user moving from either tool gets an error on these chains where the tool succeeded.

## Decision

### Rows

- A chain gets a row when Sourcify's chain list (`https://sourcify.dev/server/chains`) marks it
  `supported: true`, or when it is in the Etherscan chainlist. Being in the prior art is no longer
  a condition.
- The row has `sourcify` when Sourcify supports the chain. A chainlist chain also has
  `etherscan-v2`, in the order decision 0027 sets. A chainlist chain that Sourcify does not
  support gets a row with `etherscan-v2` alone, so a chain the table serves today is not dropped
  when Sourcify drops it. On 2026-11-05 no chain is in that case: Sourcify supports all 55
  chainlist chains.
- The table has 288 rows on 2026-11-05: the 94 it had, unchanged, and 194 with `sourcify` only.
  Its `checked` date stays 2026-11-05.
- `tableOf()` in `scripts/routing-seed.ts` builds the table from the two live lists, and
  `node scripts/compare-routing-table.ts --rows` prints it. The rows of this change come from that
  command, not from hand edits. The comparison no longer reports a row "in neither the chainlist
  nor the prior art". It reports a missing row for every chain Sourcify supports and for every
  chainlist chain.

### Size ceiling

Measured with `pnpm run size` (esbuild 0.28.2, Node.js 24.21.0 zlib) on 2026-11-05: "Before" is
main at commit 60f089c, "After" is that commit with this change.

| Entry               | Before (60f089c) | After  | Old ceiling | New ceiling |
| ------------------- | ---------------- | ------ | ----------- | ----------- |
| `routing table`     | 929              | 1,662  | 1,120       | 1,995       |
| `verify with table` | 15,493           | 16,577 | 17,632      | 17,632      |

The `routing table` ceiling is reset by decision 0014's rule, the measured size plus 20% rounded
up. `verify with table`, which bounds what a page ships, fits under its ceiling with 1,055 bytes
to spare, so it keeps its ceiling. The code entries measure an empty table and do not change.

## Alternatives considered

- Add only the 49 chains of #166. Rejected: no rule picks those 49 over the other 145, and the
  weekly comparison could not tell a missing row from an omitted one.
- A compact encoding: Sourcify-only rows as one list of chain ids next to `chains`. Estimated with
  Python's zlib on the minified JSON, which read the current table at 1,692 bytes against the
  measured 1,662: about 1,410 bytes as a plain list, about 1,220 bytes with each id stored as the
  difference from the one before. Both are over the old ceiling of 1,120, so a raise is needed
  either way. Rejected for now: it needs a schema 3, a second reader in the resolver and in the
  table checks, and a new empty table in `scripts/bundle.ts`, to save about 250 to 450 bytes that
  `verify with table` does not need.
- Keep the old rule and document `allowSourcifyFallback`. Rejected: Foundry and Hardhat need no option
  on these chains, and a caller cannot tell from the table which chains Sourcify serves.
- Load the table as a separate entry point, as decision 0024 names for a crossed `verify with
  table` ceiling. Rejected: that ceiling is not crossed.

## Consequences

- R-RT-1 states the new rule and the count.
- Each chain Sourcify adds or drops shows in the weekly comparison as a difference in Sourcify's
  list; a pull request regenerates the table with `--rows`.
- The `routing table` entry has 333 bytes left under its new ceiling, about 90 Sourcify-only rows
  at the measured cost of about 3.8 bytes a row.
- `allowSourcifyFallback` still sends a chain Sourcify does not list to Sourcify; it now matters
  only for such chains and for chains Sourcify adds after the table's date.
