# 2026-11-04: the routing table's Etherscan v2 entries

Audience: whoever changes the routing table's Etherscan v2 entries (R-RT-1), or adds the Routescan
rows (#62). Assumes [the routing table note](2026-11-03-routing-table.md) and
[decision 0024](../decisions/0024-compact-routing-table.md).

This note records the check behind the `etherscan-v2` entries that
[#122](https://github.com/aelmanaa/explorer-verify/issues/122) adds, the order of each row, and
the size of the result. [Decision 0027](../decisions/0027-etherscan-rows-and-paid-plan-chains.md)
takes the choices.

## The check of 2026-11-04

| Source                                                       | Read                                     | What it gave                                                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Etherscan chainlist](https://api.etherscan.io/v2/chainlist) | 2026-11-04 08:29 UTC, curl 8.7.1, no key | 57 chains, all with status 1. 46 say "Free-tier available" and 11 say "Paid Plan required". Same chain ids, explorer hosts and comments as the frozen copy of 2026-11-03 |
| [Sourcify chains](https://sourcify.dev/server/chains)        | 2026-11-04 08:29 UTC, curl 8.7.1, no key | 288 chains with `supported: true`. All 57 chainlist chains are among them                                                                                                |

The frozen copy is the `etherscan` list of
[data/2026-11-03-routing-seed.json](data/2026-11-03-routing-seed.json). The download of 2026-11-04
was compared with it field by field (Node.js 24.21.0): no chain added or removed, no explorer host
moved, no paid-plan comment changed. So the data file stays as it is, and the table's `checked`
date moves to 2026-11-04.

`node scripts/compare-routing-table.ts`, run on 2026-11-04 at 08:33 UTC after the change, printed
`routing table: no differences`. From this change on, it also reports a chainlist chain without an
`etherscan-v2` entry, an entry whose explorer host differs from the chainlist's, an entry in the
wrong place for the chain's plan, and an entry for a chain the chainlist no longer lists.

## The entries

Each of the 57 chainlist chains already had a row with Sourcify. Each row now also has
`{ "backend": "etherscan-v2", "explorer": "<host>" }`, with the host of the chainlist's
`blockexplorer` field. The resolver turns it into `https://<host>/address/<address>#code`
(decision 0024).

Order of the backends in a row:

- 46 free-tier chains: `etherscan-v2`, then `sourcify`. A caller with an Etherscan key reaches
  Etherscan; a caller without one falls through to Sourcify, which needs no key (R-RT-1).
- 11 paid-plan chains: `sourcify`, then `etherscan-v2`. They are 10 (OP Mainnet), 56 (BNB Smart
  Chain Mainnet), 97 (BNB Smart Chain Testnet), 100 (Gnosis), 4663 (Robinhood Chain), 5042 (Arc
  Mainnet), 8453 (Base Mainnet), 43113 (Avalanche Fuji Testnet), 43114 (Avalanche C-Chain), 84532
  (Base Sepolia Testnet) and 11155420 (OP Sepolia Testnet). A caller reaches Etherscan there with
  `route.backend` `etherscan-v2` and a key in `apiKeys`.

The 37 rows outside the chainlist keep Sourcify only.

## Size

Measured with esbuild 0.28.2 and Node.js 24.21.0 zlib on 2026-11-04, minified and gzipped, with
`pnpm run size`. "Before" is main at commit 5faa6a6, "After" is that commit with this change.

| Entry                 | Before (5faa6a6) | After  |
| --------------------- | ---------------- | ------ |
| `verify` (code only)  | 19,081           | 19,081 |
| `verify with table`   | 19,738           | 20,233 |
| `checkStatus`         | 17,120           | 17,120 |
| `index`               | 26,557           | 26,557 |
| `routing table`       | 471              | 933    |
| `buildVerifyInput`    | 11,624           | 11,624 |
| `createVerifyHandler` | 12,089           | 12,089 |

The 57 entries add 462 bytes to the table on its own and 495 bytes to `verify with table`. Most of
it is the explorer hosts: 57 host names, many of them unlike the others (`basescan.org`,
`xdcscan.com`, `sepolia.arbiscan.io`).

## Open questions

- Etherscan's answer for a free-plan key on a paid-plan chain. The
  [key placement note](2026-11-03-api-key-placement.md#open-questions) quotes it from memory as
  starting `Free API access is not supported for this chain`. It was not requested for this note,
  which used no key. The order above does not depend on the exact text.
- Whether every explorer host serves the page `/address/<address>#code`. The hosts come from the
  chainlist; the pages were not opened one by one.

## Sources

- Etherscan chainlist: https://api.etherscan.io/v2/chainlist (read 2026-11-04)
- Sourcify chains: https://sourcify.dev/server/chains (read 2026-11-04)
- Issue: https://github.com/aelmanaa/explorer-verify/issues/122
- The frozen chainlist of 2026-11-03: [data/2026-11-03-routing-seed.json](data/2026-11-03-routing-seed.json)
