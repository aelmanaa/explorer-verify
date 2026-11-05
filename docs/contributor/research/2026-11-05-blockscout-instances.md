# 2026-11-05: the Blockscout instances that answer the API

Audience: whoever changes the routing table's Blockscout entries (R-RT-1). Assumes
[the routing table note](2026-11-03-routing-table.md), [the Blockscout client note](2026-11-04-blockscout-client.md)
and [decision 0036](../decisions/0036-a-sourcify-row-for-every-sourcify-chain.md).

This note records which Blockscout instances
[#169](https://github.com/aelmanaa/explorer-verify/issues/169) adds to the routing table, where
each comes from and what each answered. [Decision 0038](../decisions/0038-blockscout-rows.md) takes
the choices. The probe's answers are in
[data/2026-11-05-blockscout-instances.json](data/2026-11-05-blockscout-instances.json), which
`scripts/routing-seed.ts` reads.

## Sources

| Source                                                                                                                                  | Read                                                  | What it gave                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Blockscout chain registry](https://chains.blockscout.com/api/chains)                                                                   | 2026-11-05 11:37 UTC, Node.js 24.21.0 `fetch`, no key | 645 chains, each with one or more explorers. 112 explorers have `hostedBy` `blockscout`; the others are `self` (462), `caldera` (28), `conduit` (21), `protofire` (9), `gateway` (8), `altlayer-raas` (4) and `self-hosted` (2) |
| Hardhat's built-in chain descriptors, npm package `hardhat` 3.21.2, `src/internal/builtin-plugins/network-manager/chain-descriptors.ts` | 2026-11-05, `npm pack`                                | 24 chains with a `blockscout` explorer and its `apiUrl`                                                                                                                                                                         |
| `@nomicfoundation/hardhat-verify` 3.1.4, `src/internal/blockscout.ts`                                                                   | 2026-11-05, `npm pack`                                | Takes a chain's Blockscout explorer from the chain descriptors first. Otherwise it reads the registry above at run time, keeps the explorer whose `hostedBy` is `blockscout`, and uses `<url>/api` as the API                   |
| [#169](https://github.com/aelmanaa/explorer-verify/issues/169)                                                                          | 2026-11-05                                            | Six self-hosted registry explorers it found answering with curl: 1088, 1750, 43111, 46630, 47763 and 743111                                                                                                                     |

The candidates are the 112 registry explorers hosted by Blockscout, the 7 Hardhat explorers on
chains with none of those (1101, 59141, 59144, 1313161554, 1313161555, 1666600000, 1666700000),
and the 6 self-hosted explorers of #169: 125 in all. Hardhat lists another host than the registry
for 3 chains: `optimism.blockscout.com` (10), `optimism-sepolia.blockscout.com` (11155420) and
`gnosis.blockscout.com` (100). Each answered with HTTP 301 to the registry's host, so the
registry's host is the candidate.

## The probe

On 2026-11-05, from 11:38 UTC, with the `fetch` of Node.js 24.21.0, no key, `redirect: "manual"`,
`accept: application/json` and a 20-second timeout, each candidate host got two requests:

1. `GET https://<host>/api/v2/config/backend-version`
2. `GET https://<host>/api?module=contract&action=getsourcecode&address=0xcA11bde05977b3631167028862bE2a173976CA11`

The address is Multicall3's. An instance answers when the first request gets HTTP 200 with a
`backend_version` and the second HTTP 200 with a `status` field. When either answer was a
redirect, the target host got the same two requests once. The probe ran four hosts at a time,
each host getting its requests one after the other: 2 requests per host, 4 for a host that
redirected.

The library never follows a redirect (R-SEC-2), so an entry holds the host that answered
directly, not the one listed.

## Results

111 of the 125 candidates answered: 102 of the 112 registry explorers hosted by Blockscout, 3 of
the 7 Hardhat explorers (1313161554, 1666600000, 1666700000) and the 6 self-hosted explorers of
#169. Every host of #169's table answered at the host the issue names.

Backend versions of the 111 instances: v12.0.4 on 94, v12.0.4 with a commit suffix on 2, v12.0.3
on 1, v11.3.3 on 4, v11.2.6 on 1, v10.2.6 on 1, v9.3.2 on 1, v9.0.2 on 1, v6.9.0-hemi.25 on 2,
v6.5.0-beta on 1, v6.1.0 on 2 and v0.1.0 on 1. The client's mappings were recorded on v12.0.4
([client note](2026-11-04-blockscout-client.md)); the probe does not check the other versions'
submit and status answers.

The 14 that did not answer:

- Bot-check page, HTTP 403 with `Just a moment...`, on both requests: 137, 4663, 5042, 8453,
  13371, 13473, 42161 and 421614. #169 reported the six of these that it probed with curl; Node.js
  `fetch` got the same page. The probe did not try to get past it.
- 2366 (`kitescan.ai`): `backend-version` answered, `getsourcecode` got HTTP 400 with
  `Params 'module' and 'action' are required parameters`.
- 4460 (`testnet-explorer.orderly.org`): HTTP 500 on both.
- 1313161555 (`explorer.testnet.aurora.dev`): `backend-version` answered v9.3.2, `/api` got
  HTTP 404 with an HTML page.
- 1101 (`zkevm.blockscout.com`): HTTP 404 `default backend - 404` on both.
- 59141 and 59144 (`explorer.sepolia.linea.build`, `explorer.linea.build`): HTTP 302 to
  `sepolia.lineascan.build` and `lineascan.build`, which answered `backend-version` with another
  redirect and `getsourcecode` with `status` `"0"` and `NOTOK`: not a Blockscout API.

### Per instance

"Source" says where the candidate comes from: the registry (hosted by Blockscout unless marked
self-hosted), Hardhat's chain descriptors, or both. "Entry" says whether the table has a
`blockscout` entry for it.

| Chain id   | Name                           | Source                | Listed host                               | Probed host                                  | `backend-version`                                       | `getsourcecode`                                                   | Entry |
| ---------- | ------------------------------ | --------------------- | ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------- | ----- |
| 1          | Ethereum                       | registry, Hardhat     | `eth.blockscout.com`                      | `eth.blockscout.com`                         | 200 v11.3.3                                             | 200 status 1 OK                                                   | yes   |
| 10         | OP Mainnet                     | registry, Hardhat     | `explorer.optimism.io`                    | `explorer.optimism.io`                       | 200 v11.3.3                                             | 200 status 1 OK                                                   | yes   |
| 30         | Rootstock                      | registry              | `rootstock.blockscout.com`                | `rootstock.blockscout.com`                   | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 31         | Rootstock Testnet              | registry              | `rootstock-testnet.blockscout.com`        | `rootstock-testnet.blockscout.com`           | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 61         | Ethereum Classic               | registry              | `etc.blockscout.com`                      | `etc.blockscout.com`                         | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 63         | Ethereum Classic Mordor        | registry              | `etc-mordor.blockscout.com`               | `etc-mordor.blockscout.com`                  | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 81         | Astar Shibuya                  | registry              | `shibuya.blockscout.com`                  | `shibuya.blockscout.com`                     | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 100        | Gnosis                         | registry, Hardhat     | `gnosisscan.io`                           | `gnosisscan.io`                              | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 122        | Fuse                           | registry              | `explorer.fuse.io`                        | `explorer.fuse.io`                           | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 123        | Fuse Sparknet                  | registry              | `explorer.fusespark.io`                   | `explorer.fusespark.io`                      | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 130        | Unichain                       | registry              | `unichain.blockscout.com`                 | `unichain.blockscout.com`                    | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 137        | Polygon PoS                    | registry, Hardhat     | `polygon.blockscout.com`                  | `polygon.blockscout.com`                     | 403 challenge page                                      | 403 challenge page                                                | no    |
| 177        | HashKey                        | registry              | `hsk.blockscout.com`                      | `hsk.blockscout.com`                         | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 239        | TAC Mainnet                    | registry              | `explorer.tac.build`                      | `explorer.tac.build`                         | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 291        | Orderly                        | registry              | `explorer.orderly.network`                | `explorer.orderly.network`                   | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 300        | ZKsync Era Sepolia Testnet     | registry, Hardhat     | `zksync-sepolia.blockscout.com`           | `zksync-sepolia.blockscout.com`              | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 314        | Filecoin Virtual Machine       | registry              | `filecoin.blockscout.com`                 | `filecoin.blockscout.com`                    | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 324        | ZKsync Era                     | registry, Hardhat     | `zksync.blockscout.com`                   | `zksync.blockscout.com`                      | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 360        | Shape                          | registry              | `shapescan.xyz`                           | `shapescan.xyz`                              | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 480        | World Chain                    | registry              | `worldchain-mainnet.explorer.alchemy.com` | `worldchain-mainnet.explorer.alchemy.com`    | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 484        | Camp Network                   | registry              | `camp.cloud.blockscout.com`               | `camp.cloud.blockscout.com`                  | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 488        | BXN                            | registry              | `blackfortscan.com`                       | `blackfortscan.com`                          | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 545        | Flow Testnet                   | registry              | `testnet.evm.flow.com`                    | `testnet.evm.flow.com`                       | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 592        | Astar                          | registry              | `astar.blockscout.com`                    | `astar.blockscout.com`                       | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 714        | Eden                           | registry              | `eden.blockscout.com`                     | `eden.blockscout.com`                        | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 747        | Flow Mainnet                   | registry              | `evm.flow.com`                            | `evm.flow.com`                               | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 869        | World Mobile                   | registry              | `explorer.worldmobile.io`                 | `explorer.worldmobile.io`                    | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 901        | Derive Testnet                 | registry              | `testnet-explorer.derive.xyz`             | `testnet-explorer.derive.xyz`                | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 957        | Derive Mainnet                 | registry              | `explorer.derive.xyz`                     | `explorer.derive.xyz`                        | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 1076       | IOTA EVM Testnet               | registry              | `explorer.evm.testnet.iota.cafe`          | `explorer.evm.testnet.iota.cafe`             | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 1088       | Metis                          | registry, self-hosted | `andromeda-explorer.metis.io`             | `andromeda-explorer.metis.io`                | 200 v6.5.0-beta                                         | 200 status 1 OK                                                   | yes   |
| 1101       | Polygon zkEVM                  | Hardhat               | `zkevm.blockscout.com`                    | `zkevm.blockscout.com`                       | 404 "default backend - 404"                             | 404 "default backend - 404"                                       | no    |
| 1135       | Lisk                           | registry              | `blockscout.lisk.com`                     | `blockscout.lisk.com`                        | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 1301       | Unichain Sepolia Testnet       | registry              | `unichain-sepolia.blockscout.com`         | `unichain-sepolia.blockscout.com`            | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 1315       | DATA Network Aeneid            | registry              | `aeneid.datanetscan.io`                   | `aeneid.datanetscan.io`                      | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 1514       | DATA Network                   | registry              | `www.datanetscan.io`                      | `www.datanetscan.io`                         | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 1729       | Reya                           | registry              | `explorer.reya.network`                   | `explorer.reya.network`                      | 200 v12.0.3                                             | 200 status 1 OK                                                   | yes   |
| 1750       | Metal L2                       | registry, self-hosted | `explorer.metall2.com`                    | `explorer.metall2.com`                       | 200 v9.0.2                                              | 200 status 1 OK                                                   | yes   |
| 1829       | Playnance Playblock            | registry              | `explorer.playblock.io`                   | `explorer.playblock.io`                      | 200 v12.0.4.+commit.2fdda3db                            | 200 status 1 OK                                                   | yes   |
| 1868       | Soneium                        | registry              | `soneium.blockscout.com`                  | `soneium.blockscout.com`                     | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 1890       | LightLink Phoenix Mainnet      | registry              | `phoenix.lightlink.io`                    | `phoenix.lightlink.io`                       | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 1891       | LightLink Pegasus Testnet      | registry              | `pegasus.lightlink.io`                    | `pegasus.lightlink.io`                       | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 1946       | Soneium Minato Testnet         | registry              | `soneium-minato.blockscout.com`           | `soneium-minato.blockscout.com`              | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 2020       | Ronin Mainnet                  | registry              | `explorer.roninchain.com`                 | `explorer.roninchain.com`                    | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 2288       | Moca Chain                     | registry              | `scan.mocachain.org`                      | `scan.mocachain.org`                         | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 2366       | KiteAI Mainnet                 | registry              | `kitescan.ai`                             | `kitescan.ai`                                | 200 v12.0.4                                             | 400 status 0 Params 'module' and 'action' are required parameters | no    |
| 2368       | KiteAI Testnet                 | registry              | `testnet.kitescan.ai`                     | `testnet.kitescan.ai`                        | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 2391       | TAC SPB                        | registry              | `spb.explorer.tac.build`                  | `spb.explorer.tac.build`                     | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 4326       | MegaETH                        | registry              | `megaeth.blockscout.com`                  | `megaeth.blockscout.com`                     | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 4460       | Orderly Testnet                | registry              | `testnet-explorer.orderly.org`            | `testnet-explorer.orderly.org`               | 500 JSON without backend_version                        | 500 JSON without status                                           | no    |
| 4663       | Robinhood Chain                | registry              | `robinhoodchain.blockscout.com`           | `robinhoodchain.blockscout.com`              | 403 challenge page                                      | 403 challenge page                                                | no    |
| 4801       | World Chain Testnet            | registry              | `worldchain-sepolia.explorer.alchemy.com` | `worldchain-sepolia.explorer.alchemy.com`    | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 4888       | BXN Testnet                    | registry              | `testnet.blackfortscan.com`               | `testnet.blackfortscan.com`                  | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 5042       | Arc Mainnet                    | registry              | `explorer.arc.io`                         | `explorer.arc.io`                            | 403 challenge page                                      | 403 challenge page                                                | no    |
| 6497       | Awaji                          | registry              | `awaji.blockscout.com`                    | `awaji.blockscout.com`                       | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 6498       | Mizuhiki                       | registry              | `mizuhiki.blockscout.com`                 | `mizuhiki.blockscout.com`                    | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 7000       | ZetaChain                      | registry              | `zetascan.com`                            | `zetascan.com`                               | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 7001       | ZetaChain Testnet              | registry              | `testnet.zetascan.com`                    | `testnet.zetascan.com`                       | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 8021       | Numine                         | registry              | `numine.blockscout.com`                   | `numine.blockscout.com`                      | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 8453       | Base                           | registry, Hardhat     | `base.blockscout.com`                     | `base.blockscout.com`                        | 403 challenge page                                      | 403 challenge page                                                | no    |
| 8822       | IOTA EVM                       | registry              | `explorer.evm.iota.org`                   | `explorer.evm.iota.org`                      | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 10200      | Gnosis Chiado Testnet          | registry, Hardhat     | `gnosis-chiado.blockscout.com`            | `gnosis-chiado.blockscout.com`               | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 10901      | Zama Gateway Testnet           | registry              | `explorer.testnet.zama.org`               | `explorer.testnet.zama.org`                  | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 11011      | Shape Testnet                  | registry              | `sepolia.shapescan.xyz`                   | `sepolia.shapescan.xyz`                      | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 13371      | Immutable zkEVM                | registry              | `explorer.immutable.com`                  | `explorer.immutable.com`                     | 403 challenge page                                      | 403 challenge page                                                | no    |
| 13473      | Immutable zkEVM Testnet        | registry              | `explorer.testnet.immutable.com`          | `explorer.testnet.immutable.com`             | 403 challenge page                                      | 403 challenge page                                                | no    |
| 32769      | Zilliqa 2 Mainnet              | registry              | `zilliqa.blockscout.com`                  | `zilliqa.blockscout.com`                     | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 33101      | Zilliqa 2 Testnet              | registry              | `testnet.zilliqa.blockscout.com`          | `testnet.zilliqa.blockscout.com`             | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 33111      | APE Curtis                     | registry              | `apechain-curtis.blockscout.com`          | `apechain-curtis.blockscout.com`             | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 33139      | ApeChain                       | registry              | `apechain.blockscout.com`                 | `apechain.blockscout.com`                    | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 34443      | Mode                           | registry              | `explorer.mode.network`                   | `explorer.mode.network`                      | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 42161      | Arbitrum One Nitro             | registry, Hardhat     | `arbitrum.blockscout.com`                 | `arbitrum.blockscout.com`                    | 403 challenge page                                      | 403 challenge page                                                | no    |
| 42170      | Arbitrum Nova                  | registry, Hardhat     | `arbitrum-nova.blockscout.com`            | `arbitrum-nova.blockscout.com`               | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 42220      | Celo                           | registry              | `celo.blockscout.com`                     | `celo.blockscout.com`                        | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 42793      | Etherlink                      | registry              | `explorer.etherlink.com`                  | `explorer.etherlink.com`                     | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 43111      | Hemi                           | registry, self-hosted | `explorer.hemi.xyz`                       | `explorer.hemi.xyz`                          | 200 v6.9.0-hemi.25                                      | 200 status 1 OK                                                   | yes   |
| 46630      | Robinhood Chain Testnet        | registry, self-hosted | `explorer.testnet.chain.robinhood.com`    | `explorer.testnet.chain.robinhood.com`       | 200 v10.2.6                                             | 200 status 1 OK                                                   | yes   |
| 47763      | Neo Smart Economy              | registry, self-hosted | `xexplorer.neo.org`                       | `xexplorer.neo.org`                          | 200 v0.1.0                                              | 200 status 1 OK                                                   | yes   |
| 52014      | Electroneum                    | registry              | `electroneum.blockscout.com`              | `electroneum.blockscout.com`                 | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 57073      | Ink                            | registry, Hardhat     | `explorer.inkonchain.com`                 | `explorer.inkonchain.com`                    | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 59141      | Linea Sepolia                  | Hardhat               | `explorer.sepolia.linea.build`            | `sepolia.lineascan.build` (after a redirect) | 302 to sepolia.lineascan.build HTML; 302 to ../404 HTML | 302 to sepolia.lineascan.build HTML; 200 status 0 NOTOK           | no    |
| 59144      | Linea                          | Hardhat               | `explorer.linea.build`                    | `lineascan.build` (after a redirect)         | 302 to lineascan.build HTML; 302 to ../404 HTML         | 302 to lineascan.build HTML; 200 status 0 NOTOK                   | no    |
| 69420      | Alchemy Sepolia                | registry              | `alchemy-sepolia.explorer.alchemy.com`    | `alchemy-sepolia.explorer.alchemy.com`       | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 84532      | Base Sepolia                   | registry, Hardhat     | `base-sepolia.blockscout.com`             | `base-sepolia.blockscout.com`                | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 97476      | Doma Testnet                   | registry              | `explorer-testnet.doma.xyz`               | `explorer-testnet.doma.xyz`                  | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 97477      | Doma Mainnet                   | registry              | `explorer.doma.xyz`                       | `explorer.doma.xyz`                          | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 97741      | Pepe Unchained                 | registry              | `pepuscan.com`                            | `pepuscan.com`                               | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 98866      | Plume Mainnet                  | registry              | `explorer.plume.org`                      | `explorer.plume.org`                         | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 98867      | Plume Testnet                  | registry              | `testnet-explorer.plume.org`              | `testnet-explorer.plume.org`                 | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 101010     | Stability Global Trust Network | registry              | `explorer.stabilityprotocol.com`          | `explorer.stabilityprotocol.com`             | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 102030     | Creditcoin                     | registry              | `creditcoin.blockscout.com`               | `creditcoin.blockscout.com`                  | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 102031     | Creditcoin Testnet             | registry              | `creditcoin-testnet.blockscout.com`       | `creditcoin-testnet.blockscout.com`          | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 102032     | Creditcoin Devnet              | registry              | `creditcoin-devnet.blockscout.com`        | `creditcoin-devnet.blockscout.com`           | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 127823     | Etherlink Shadownet            | registry              | `shadownet.explorer.etherlink.com`        | `shadownet.explorer.etherlink.com`           | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 181228     | HPP Sepolia                    | registry              | `sepolia-explorer.hpp.io`                 | `sepolia-explorer.hpp.io`                    | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 190415     | HPP Mainnet                    | registry              | `explorer.hpp.io`                         | `explorer.hpp.io`                            | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 202601     | Ronin Saigon Testnet           | registry              | `saigon-explorer.roninchain.com`          | `saigon-explorer.roninchain.com`             | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 222888     | Moca Chain Testnet             | registry              | `testnet-scan.mocachain.org`              | `testnet-scan.mocachain.org`                 | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 261131     | Zama Gateway Mainnet           | registry              | `explorer.mainnet.zama.org`               | `explorer.mainnet.zama.org`                  | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 314159     | Filecoin Calibration Testnet   | registry              | `filecoin-testnet.blockscout.com`         | `filecoin-testnet.blockscout.com`            | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 323432     | World Mobile Testnet           | registry              | `testnet-explorer.worldmobile.net`        | `testnet-explorer.worldmobile.net`           | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 421614     | Arbitrum Sepolia               | registry, Hardhat     | `arbitrum-sepolia.blockscout.com`         | `arbitrum-sepolia.blockscout.com`            | 403 challenge page                                      | 403 challenge page                                                | no    |
| 529375     | LayerK                         | registry              | `explorer.layerk.com`                     | `explorer.layerk.com`                        | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 534352     | Scroll                         | registry              | `scrollscan.com`                          | `scrollscan.com`                             | 200 v12.0.4.+commit.c107e910                            | 200 status 1 OK                                                   | yes   |
| 560048     | Hoodi                          | registry, Hardhat     | `eth-hoodi.blockscout.com`                | `eth-hoodi.blockscout.com`                   | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 612044     | Cross Testnet                  | registry              | `testnet.crossscan.io`                    | `testnet.crossscan.io`                       | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 612055     | Cross Mainnet                  | registry              | `www.crossscan.io`                        | `www.crossscan.io`                           | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 685685     | Gensyn Testnet                 | registry              | `gensyn-testnet.explorer.alchemy.com`     | `gensyn-testnet.explorer.alchemy.com`        | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 685689     | Gensyn                         | registry              | `gensyn-mainnet.explorer.alchemy.com`     | `gensyn-mainnet.explorer.alchemy.com`        | 200 v11.2.6                                             | 200 status 1 OK                                                   | yes   |
| 743111     | Hemi Sepolia                   | registry, self-hosted | `testnet.explorer.hemi.xyz`               | `testnet.explorer.hemi.xyz`                  | 200 v6.9.0-hemi.25                                      | 200 status 1 OK                                                   | yes   |
| 763373     | Ink Sepolia                    | registry, Hardhat     | `explorer-sepolia.inkonchain.com`         | `explorer-sepolia.inkonchain.com`            | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 5042002    | Arc Testnet                    | registry              | `explorer.testnet.arc.io`                 | `explorer.testnet.arc.io`                    | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 5201420    | Electroneum Testnet            | registry              | `electroneum-testnet.blockscout.com`      | `electroneum-testnet.blockscout.com`         | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 11142220   | Celo Sepolia                   | registry              | `celo-sepolia.blockscout.com`             | `celo-sepolia.blockscout.com`                | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 11155111   | Ethereum Sepolia               | registry, Hardhat     | `eth-sepolia.blockscout.com`              | `eth-sepolia.blockscout.com`                 | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 11155420   | OP Sepolia                     | registry, Hardhat     | `testnet-explorer.optimism.io`            | `testnet-explorer.optimism.io`               | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 20180427   | Stability Testnet              | registry              | `explorer.testnet.stabilityprotocol.com`  | `explorer.testnet.stabilityprotocol.com`     | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 89346162   | Reya Cronos                    | registry              | `reya-cronos.blockscout.com`              | `reya-cronos.blockscout.com`                 | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |
| 245022926  | Neon Devnet                    | registry              | `neon-devnet.blockscout.com`              | `neon-devnet.blockscout.com`                 | 200 v11.3.3                                             | 200 status 1 OK                                                   | yes   |
| 245022934  | Neon                           | registry              | `neon.blockscout.com`                     | `neon.blockscout.com`                        | 200 v11.3.3                                             | 200 status 1 OK                                                   | yes   |
| 1313161554 | Aurora Mainnet                 | Hardhat               | `explorer.mainnet.aurora.dev`             | `explorer.mainnet.aurora.dev`                | 200 v9.3.2                                              | 200 status 1 OK                                                   | yes   |
| 1313161555 | Aurora Testnet                 | Hardhat               | `explorer.testnet.aurora.dev`             | `explorer.testnet.aurora.dev`                | 200 v9.3.2                                              | 404 HTML                                                          | no    |
| 1666600000 | Harmony                        | Hardhat               | `explorer.harmony.one`                    | `explorer.harmony.one`                       | 200 v6.1.0                                              | 200 status 1 OK                                                   | yes   |
| 1666700000 | Harmony Testnet                | Hardhat               | `explorer.testnet.harmony.one`            | `explorer.testnet.harmony.one`               | 200 v6.1.0                                              | 200 status 1 OK                                                   | yes   |
| 3735928814 | Eden Testnet                   | registry              | `eden-testnet.blockscout.com`             | `eden-testnet.blockscout.com`                | 200 v12.0.4                                             | 200 status 1 OK                                                   | yes   |

## The rows

`node scripts/compare-routing-table.ts --rows`, run on 2026-11-05 after this change, read the
Etherscan chainlist and Sourcify's chain list live, the probe data above and the Routescan probe
data of [decision 0037](../decisions/0037-routescan-rows-from-an-api-probe.md), and printed the
table. Without the Blockscout entries it is the table of main c2142eb, unchanged. With them:

- 325 rows, 11 more than the 314 of main c2142eb.
- 111 rows with a `blockscout` entry, always right after `sourcify` when the row has it, and
  before `routescan`:

  | Backends, in order                                    | Rows |
  | ----------------------------------------------------- | ---- |
  | `sourcify`, `blockscout`                              | 82   |
  | `etherscan-v2`, `sourcify`, `blockscout`              | 7    |
  | `etherscan-v2`, `sourcify`, `blockscout`, `routescan` | 3    |
  | `sourcify`, `blockscout`, `routescan`                 | 3    |
  | `sourcify`, `blockscout`, `etherscan-v2` (paid plan)  | 4    |
  | `blockscout`, `routescan`                             | 1    |
  | `blockscout`                                          | 11   |

  The paid-plan rows are 10, 100, 84532 and 11155420. The `blockscout`, `routescan` row is Numine
  (8021). The 11 rows with `blockscout` alone are 484, 901, 957, 1076, 10901, 261131, 529375,
  89346162, 245022926, 1666700000 and 3735928814.

## Size

Measured with `pnpm run size` (esbuild 0.28.2, Node.js 24.21.0 zlib) on 2026-11-05.

| Entry               | main b53f688 | b53f688 with this change | main c2142eb | c2142eb with this change |
| ------------------- | ------------ | ------------------------ | ------------ | ------------------------ |
| `routing table`     | 1,662        | 2,757                    | 1,912        | 2,971                    |
| `verify with table` | 16,574       | 17,851                   | 16,867       | 18,208                   |

c2142eb holds the Routescan rows of decision 0037. The entries add about 9.5 to 9.9 bytes each,
gzipped. Most of that is the host, which differs per instance: 42 of the 111 hosts end in
`.blockscout.com`. Measured with Node.js zlib on the minified JSON of the table at b53f688 with
this change:

| Encoding                                                   | Gzipped |
| ---------------------------------------------------------- | ------- |
| The table without Blockscout entries                       | 1,667   |
| As shipped, `{"backend":"blockscout","instance":"<host>"}` | 2,767   |
| `.blockscout.com` left out of the 42 hosts that end in it  | 2,752   |
| That, and each entry written as `{"blockscout":"<host>"}`  | 2,706   |
