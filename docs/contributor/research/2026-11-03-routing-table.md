# 2026-11-03: the routing table's rows

Audience: whoever changes the routing table (R-RT-1) or adds the Etherscan v2 (#61) or Routescan
(#62) client. Assumes the [Routescan note](2026-11-03-routescan-zksync.md) and
[decision 0024](../decisions/0024-compact-routing-table.md).

This note records where the 94 rows of `routing/table.json` come from, how they were derived, and
what changed against the prior art's verifier table (see [prior art](../prior-art.md)). The data
behind it is in [data/2026-11-03-routing-seed.json](data/2026-11-03-routing-seed.json), which does
not ship with the package.

## Sources and counts

| Source                                                                                   | Read                     | What it gave                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Etherscan chainlist](https://api.etherscan.io/v2/chainlist)                             | 2026-11-03, curl, no key | 57 chains, all with status 1. 46 say "Free-tier available" and 11 say "Paid Plan required"                                                                            |
| [Sourcify chains](https://sourcify.dev/server/chains)                                    | 2026-11-03, curl, no key | 457 chains, 288 with `supported: true`. All 57 chainlist chains are supported                                                                                         |
| [Routescan supported chains](https://docs.routescan.io/getting-started/supported-chains) | 2026-11-03               | curl got HTTP 403. A browser render of the page on 2026-11-03 showed 24 mainnet chains; the testnet tab, which the page says holds 11 chains, did not render          |
| The prior art's verifier table, dated 2026-07-28 ([prior art](../prior-art.md))          | 2026-11-03               | 67 rows, all testnets: 22 Sourcify, 21 Etherscan v2, 12 standalone Etherscan-style hosts, 5 Blockscout, 7 with no backend. 56 of the 67 chains are Sourcify-supported |

The 11 chains that need a paid Etherscan plan: 10 (OP Mainnet), 56 (BNB Smart Chain Mainnet), 97
(BNB Smart Chain Testnet), 100 (Gnosis), 4663 (Robinhood Chain), 5042 (Arc Mainnet), 8453 (Base
Mainnet), 43113 (Avalanche Fuji Testnet), 43114 (Avalanche C-Chain), 84532 (Base Sepolia Testnet)
and 11155420 (OP Sepolia Testnet) (Etherscan chainlist, 2026-11-03).

Facts from the survey in [issue #60](https://github.com/aelmanaa/explorer-verify/issues/60),
not run again for this note (curl 8.7.1 and `dig`, 2026-11-03):

- The chainlist no longer lists two of the prior art's Etherscan v2 chains, 5611 and 33111. Both
  keep a Sourcify row: they are prior art, and Sourcify lists them as supported.
- None of the prior art's 12 standalone API hosts answers: 10 do not resolve, one returns HTTP
  404, and one redirects to a host that does not resolve.

## The rule

A chain gets a row when Sourcify lists it with `supported: true` and it is in the Etherscan
chainlist or in the prior art's rows. Each row lists `sourcify` only, because Sourcify is the one
backend with a client in this release (R-RT-1).

- 57 rows come from the chainlist, 19 of which are also prior art.
- 37 rows come from the prior art alone.
- Total: 94 rows. The table's date is 2026-11-03.

The Etherscan v2 and Routescan entries found on the same day are kept in the data file, with chain
names, for #61 and #62: the 57 chainlist chains with their explorer hosts and paid-plan flags, and
the Routescan chains with their network. They enter the table with their clients.

`scripts/compare-routing-table.ts` applies the rule to the live lists and prints every difference
from the table and the frozen chainlist; see [Regenerating the comparison](#regenerating-the-comparison).

## Named chains

Each resolves to Sourcify without `allowSourcifyFallback`, with the page
`https://repo.sourcify.dev/<chainId>/<address>`. A unit test names each one.

| Chain id | Chain             | Etherscan chainlist | Routescan                                                                                      | Row      |
| -------- | ----------------- | ------------------- | ---------------------------------------------------------------------------------------------- | -------- |
| 1        | Ethereum Mainnet  | free tier           | mainnet (page)                                                                                 | sourcify |
| 11155111 | Ethereum Sepolia  | free tier           | not listed                                                                                     | sourcify |
| 43113    | Avalanche Fuji    | paid plan           | testnet (live, [Routescan note](2026-11-03-routescan-zksync.md))                               | sourcify |
| 43114    | Avalanche C-Chain | paid plan           | mainnet (live, [Routescan note](2026-11-03-routescan-zksync.md))                               | sourcify |
| 80002    | Polygon Amoy      | free tier           | answered `chain not supported` on `testnet` ([Routescan note](2026-11-03-routescan-zksync.md)) | sourcify |
| 84532    | Base Sepolia      | paid plan           | not listed                                                                                     | sourcify |
| 421614   | Arbitrum Sepolia  | free tier           | not listed                                                                                     | sourcify |

Chain 324 (ZKsync Era) has no row and no `routescan` or `etherscan-v2` entry, because it is in
neither the chainlist nor the prior art. Routescan also answered `chain not supported` for
`mainnet/evm/324` ([Routescan note](2026-11-03-routescan-zksync.md)). Sourcify lists it as supported, so a caller can
verify there with `allowSourcifyFallback: true`.

## Prior-art rows

Every row of the prior art, with the backend it had, what the table gives it now and why. "Kept in
this file" means the data file.

| Chain id  | Chain (Sourcify's name)    | Prior-art backend    | Now      | Reason                                                                                          |
| --------- | -------------------------- | -------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| 31        | Rootstock Testnet          | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 51        | XDC Apothem Testnet        | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 81        | Astar Shibuya              | blockscout           | sourcify | The Blockscout URL is kept for M3. Sourcify ships.                                              |
| 97        | BNB Smart Chain Testnet    | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 133       | HSKChain Testnet           | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 157       | (not in Sourcify list)     | etherscan-standalone | no row   | The standalone API host did not answer, and Sourcify does not list the chain; no row.           |
| 240       | Cronos zkEVM Testnet       | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 296       | Hedera Testnet             | etherscan-standalone | sourcify | The standalone API host did not answer; it waits for #63. Sourcify ships.                       |
| 300       | ZKsync Era Sepolia Testnet | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 338       | Cronos Testnet             | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 679       | (not in Sourcify list)     | unknown              | no row   | No known backend, and Sourcify does not list the chain; no row.                                 |
| 919       | Mode Testnet               | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 998       | Hyperliquid EVM Testnet    | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 1001      | Kaia Kairos Testnet        | etherscan-standalone | sourcify | The standalone API host did not answer; it waits for #63. Sourcify ships.                       |
| 1112      | WEMIX3.0 Testnet           | etherscan-standalone | sourcify | The standalone API host did not answer; it waits for #63. Sourcify ships.                       |
| 1114      | Core Blockchain Testnet2   | etherscan-standalone | sourcify | The standalone API host did not answer; it waits for #63. Sourcify ships.                       |
| 1123      | (not in Sourcify list)     | unknown              | no row   | No known backend, and Sourcify does not list the chain; no row.                                 |
| 1301      | Unichain Sepolia Testnet   | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 1328      | Sei Testnet                | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 1687      | (not in Sourcify list)     | unknown              | no row   | No known backend, and Sourcify does not list the chain; no row.                                 |
| 1740      | Metal L2 Testnet           | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 1946      | Soneium Minato Testnet     | blockscout           | sourcify | The Blockscout URL is kept for M3. Sourcify ships.                                              |
| 2391      | TAC SPB                    | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 2910      | Morph Hoodi                | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 4202      | Lisk Sepolia Testnet       | blockscout           | sourcify | The Blockscout URL is kept for M3. Sourcify ships.                                              |
| 4801      | World Sepolia Testnet      | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 5003      | Mantle Sepolia Testnet     | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 5611      | opBNB Testnet              | etherscan-v2         | sourcify | Not in the Etherscan chainlist; Sourcify ships.                                                 |
| 6343      | MegaETH Testnet            | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 9746      | Plasma Testnet             | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 10143     | Monad Testnet              | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 10200     | Gnosis Chiado Testnet      | blockscout           | sourcify | The Blockscout URL is kept for M3. Sourcify ships.                                              |
| 11124     | Abstract Sepolia Testnet   | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 14601     | Sonic Testnet              | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 16602     | 0G Galileo Testnet         | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 33111     | Curtis                     | etherscan-v2         | sourcify | Not in the Etherscan chainlist; Sourcify ships.                                                 |
| 33431     | (not in Sourcify list)     | unknown              | no row   | No known backend, and Sourcify does not list the chain; no row.                                 |
| 37111     | Lens Testnet               | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 42431     | Tempo Testnet Moderato     | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 43113     | Avalanche Fuji Testnet     | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 46630     | Robinhood Chain Testnet    | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 53302     | Superseed Sepolia Testnet  | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 59141     | Linea Sepolia Testnet      | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 59902     | Metis Sepolia Testnet      | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 80002     | Polygon Amoy Testnet       | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 84532     | Base Sepolia Testnet       | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 98867     | Plume Testnet              | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 99999     | (not in Sourcify list)     | unknown              | no row   | No known backend, and Sourcify does not list the chain; no row.                                 |
| 192940    | (not in Sourcify list)     | unknown              | no row   | No known backend, and Sourcify does not list the chain; no row.                                 |
| 200810    | Bitlayer Testnet           | etherscan-standalone | no row   | The standalone API host did not answer, and Sourcify does not list the chain; no row.           |
| 202601    | Ronin Saigon Testnet       | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 421614    | Arbitrum Sepolia Testnet   | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 534351    | Scroll Sepolia Testnet     | etherscan-standalone | sourcify | The standalone API host did not answer; it waits for #63. Sourcify ships.                       |
| 560048    | Ethereum Hoodi Testnet     | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 686868    | (not in Sourcify list)     | etherscan-standalone | no row   | The standalone API host did not answer, and Sourcify does not list the chain; no row.           |
| 688689    | Pharos Atlantic Testnet    | etherscan-standalone | sourcify | The standalone API host did not answer; it waits for #63. Sourcify ships.                       |
| 743111    | Hemi Sepolia               | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 763373    | Ink Sepolia                | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 808813    | BOB Sepolia                | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |
| 2019775   | (not in Sourcify list)     | unknown              | no row   | No known backend, and Sourcify does not list the chain; no row.                                 |
| 5042002   | Arc Testnet                | etherscan-standalone | sourcify | The standalone API host did not answer; it waits for #63. Sourcify ships.                       |
| 6281971   | DogeOS Chikyu Testnet      | blockscout           | sourcify | The Blockscout URL is kept for M3. Sourcify ships.                                              |
| 11155111  | Ethereum Sepolia Testnet   | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 11155420  | OP Sepolia Testnet         | etherscan-v2         | sourcify | Sourcify ships now; the Etherscan v2 entry waits for its client (#61) and is kept in this file. |
| 12227332  | Neo X Testnet T4           | etherscan-standalone | sourcify | The standalone API host did not answer; it waits for #63. Sourcify ships.                       |
| 21000001  | (not in Sourcify list)     | etherscan-standalone | no row   | The standalone API host did not answer, and Sourcify does not list the chain; no row.           |
| 999999999 | Zora Sepolia Testnet       | sourcify             | sourcify | Kept: Sourcify lists the chain as supported.                                                    |

The five Blockscout API URLs, kept for M3:

| Chain id | Chain                  | API URL                                   |
| -------- | ---------------------- | ----------------------------------------- |
| 81       | Astar Shibuya          | https://shibuya.blockscout.com/api        |
| 1946     | Soneium Minato Testnet | https://soneium-minato.blockscout.com/api |
| 4202     | Lisk Sepolia Testnet   | https://sepolia-blockscout.lisk.com/api   |
| 10200    | Gnosis Chiado Testnet  | https://gnosis-chiado.blockscout.com/api  |
| 6281971  | DogeOS Chikyu Testnet  | https://blockscout.testnet.dogeos.com/api |

Chains of the prior art left without a row, because Sourcify does not list them as supported: 157,
679, 1123, 1687, 33431, 99999, 192940, 200810, 686868, 2019775 and 21000001. Four of them had a
standalone host (157, 200810, 686868, 21000001), which #63 may revisit; seven had no backend.

## Routescan

The supported-chains page lists these 24 mainnet chains (read 2026-11-03): 1, 151, 288, 1234, 2786,
3011, 4337, 5000, 5566, 6119, 6900, 8021, 8227, 10507, 13322, 43111, 43114, 43419, 68414, 81457,
84358, 88888, 432204 and one entry, PHASE, whose id the browser render of 2026-11-03 showed as `1015_2`. That entry is
left out of the data file.

Only two networks were confirmed with a live request: 43114 on `mainnet` and 43113 on `testnet`
([Routescan note](2026-11-03-routescan-zksync.md)). The data file marks these two with
`confirmed: true`. The issue planned one keyless `checkverifystatus` request per chain; that
waits for #62, which adds the entries.

## Size

Measured with esbuild 0.28.2 and Node 24.21.0 zlib on 2026-11-03, minified and gzipped. "Before"
is main at commit c9a656e, "After" is that commit with this change. Decision 0024 gives the same
measurement on the later main it merges onto.

| Entry                | Before (main) | After  |
| -------------------- | ------------- | ------ |
| `verify` (code only) | 16,603        | 16,688 |
| `verify with table`  | 16,773        | 17,278 |
| `checkStatus`        | 15,061        | 15,154 |
| `index`              | 23,899        | 23,987 |
| `routing table`      | 286           | 471    |

The 94 chain ids alone gzip to about 295 bytes. Each row adds about 2 bytes of structure, and
other row shapes tried (tuples, shorter keys, bare backend names) saved under 20 bytes. Inside the
`verify` bundle the rows cost 590 bytes, against an earlier estimate of 438. With the schema 1
form, `verify with table` measured 18,570 bytes for the same 94 rows. [Decision 0024](../decisions/0024-compact-routing-table.md) sets
the ceilings.

## Regenerating the comparison

```sh
node scripts/compare-routing-table.ts
```

It fetches the chainlist and Sourcify's chain list, reads `table.json` and the data file, and
prints:

- a chain that should have a Sourcify row and has none, with the list it comes from;
- a row whose chain Sourcify no longer supports (until 2026-11-05 also a row in neither list; see
  [the check of 2026-11-05](#the-check-of-2026-11-05));
- a chain added to or removed from the chainlist, a changed paid-plan comment, or a moved explorer
  host, compared with the frozen copy.

It never writes the table and exits with 1 when it finds a difference. Routescan is not compared,
because its page has no list a script can read. The unit test runs it on recorded answers with a
fake fetch.

The data file was built by this rule from the downloads of 2026-11-03. Each prior-art row's
`reason` follows from its prior-art backend, its presence in the chainlist and its Sourcify
support.

## The check of 2026-11-05

Added for [#166](https://github.com/aelmanaa/explorer-verify/issues/166). The rule above changes
([decision 0036](../decisions/0036-a-sourcify-row-for-every-sourcify-chain.md)): a chain gets a
row when Sourcify lists it with `supported: true` or it is in the Etherscan chainlist. The row has
Sourcify when Sourcify supports the chain. Being in the prior art is no longer a condition. The
`etherscan-v2` entries keep the rule of
[decision 0027](../decisions/0027-etherscan-rows-and-paid-plan-chains.md); a chainlist chain that
Sourcify does not support would get `etherscan-v2` alone. On 2026-11-05 there is none.

| Source                                                       | Read                                     | What it gave                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Sourcify chains](https://sourcify.dev/server/chains)        | 2026-11-05 10:37 UTC, curl 8.7.1, no key | 457 chains, 288 with `supported: true`, the same counts as on 2026-11-03 and 2026-11-04                         |
| [Etherscan chainlist](https://api.etherscan.io/v2/chainlist) | 2026-11-05 10:37 UTC, curl 8.7.1, no key | 55 chains, the same chain ids, explorer hosts and comments as the frozen copy updated earlier that day for #165 |

The 288 supported chains hold the 94 rows the table had. The other 194 get a row with `sourcify`
only. Among them are the 49 chains #166 names from a survey of 145 EVM chains, such as 25 (Cronos),
324 (ZKsync Era), 534352 (Scroll), 8217 (Kaia), 7777777 (Zora), 728126428 (Tron) and 3448148188
(Tron Nile). Chain 324 now has a row; the "Named chains" section above records the rule of
2026-11-03.

The rows come from `node scripts/compare-routing-table.ts --rows`, which applies the rule to the
two live lists and prints the table, formatted afterwards with oxfmt. The 94 rows it printed match
the table before the change entry for entry. The data file's `rows` gain the 194 chains with
Sourcify's names and `from` set to `sourcify-chains`.

After the change, at 10:43 UTC and again at 10:48 UTC, `node scripts/compare-routing-table.ts --json` printed
`"differences": []` and the note `table checked 2026-11-05; 288 rows`.

Size, with `pnpm run size` (esbuild 0.28.2, Node.js 24.21.0 zlib), minified and gzipped. "Before"
is main at commit 60f089c, "After" is that commit with this change.

| Entry                | Before (60f089c) | After  |
| -------------------- | ---------------- | ------ |
| `verify` (code only) | 14,426           | 14,426 |
| `verify with table`  | 15,493           | 16,577 |
| `routing table`      | 929              | 1,662  |

The 194 rows cost 733 bytes on their own, about 3.8 bytes a row, and 1,084 bytes inside the
`verify` bundle. Decision 0036 records the alternatives that were estimated for a smaller table.

## Open questions

- Routescan's testnet chains and their networks. The page's testnet tab did not render, and curl
  got HTTP 403. #62 confirms each chain with a keyless `checkverifystatus` request before it adds
  Routescan entries.
- Routescan's contract page format. No template is derived yet; a Routescan route has no
  `explorerUrl`.
- The PHASE entry on the Routescan page, read as `1015_2`.

## Sources

- Etherscan chainlist: https://api.etherscan.io/v2/chainlist (read 2026-11-03)
- Sourcify chains: https://sourcify.dev/server/chains (read 2026-11-03 and 2026-11-05)
- Chains Sourcify serves that had no row, and how Foundry v1.9.0 and Hardhat 3 pick Sourcify:
  https://github.com/aelmanaa/explorer-verify/issues/166
- Routescan supported chains: https://docs.routescan.io/getting-started/supported-chains (read
  2026-11-03)
- Survey of the standalone hosts and the chainlist: https://github.com/aelmanaa/explorer-verify/issues/60
- Prior art's verifier table: [prior-art.md](../prior-art.md)

## Corrections

- 2026-11-04 (issue #63): adds the result of the 2026-11-03 survey for each of the 12 standalone
  API hosts, which this note gave only as counts. The survey sent `dig` and one keyless request to
  each host with curl 8.7.1 on 2026-11-03. The same checks on 2026-11-04 gave the same results
  ([standalone client note](2026-11-04-etherscan-compatible-client.md)). No host answered, so no
  `etherscan-compatible` row ships.

  | Chain id | API host from the prior art       | 2026-11-03 result                                                |
  | -------- | --------------------------------- | ---------------------------------------------------------------- |
  | 157      | `api-puppyscan.shib.io`           | Does not resolve                                                 |
  | 296      | `api.hashscan.io`                 | Does not resolve                                                 |
  | 1001     | `api-kairos.kaiascan.io`          | Does not resolve                                                 |
  | 1112     | `api-scan.wemix.com`              | Does not resolve                                                 |
  | 1114     | `api-scan.test2.btcs.network`     | Does not resolve                                                 |
  | 200810   | `api-testnet.btrscan.com`         | HTTP 404                                                         |
  | 534351   | `api-sepolia.scrollscan.dev`      | HTTP 301 to `api-sepolia.scrollscan.com`, which does not resolve |
  | 686868   | `api-testnet-scan.merlinchain.io` | Does not resolve                                                 |
  | 688689   | `api-atlantic.pharosscan.xyz`     | Does not resolve                                                 |
  | 5042002  | `api-testnet.arcscan.app`         | Does not resolve                                                 |
  | 12227332 | `api-xt4scan.ngd.network`         | Does not resolve                                                 |
  | 21000001 | `api-testnet.cornscan.io`         | Does not resolve                                                 |

  Each API URL is `https://<host>/api`. The explorers' web hosts, such as `kairos.kaiascan.io`,
  `hashscan.io` and `testnet.arcscan.app`, did resolve on 2026-11-03.
