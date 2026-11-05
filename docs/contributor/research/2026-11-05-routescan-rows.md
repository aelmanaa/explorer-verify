# 2026-11-05: the chains Routescan's API serves

Audience: whoever changes the routing table's Routescan entries (R-RT-1). Assumes
[the Routescan client note](2026-11-04-routescan-client.md) and
[decision 0036](../decisions/0036-a-sourcify-row-for-every-sourcify-chain.md).

This note records the probe behind the `routescan` entries that
[#168](https://github.com/aelmanaa/explorer-verify/issues/168) adds.
[Decision 0037](../decisions/0037-routescan-rows-from-an-api-probe.md) takes the choices.

## The explorer list is not the API's list

Routescan publishes one explorer list per network:

- `https://api.routescan.io/v2/network/mainnet/evm/all/blockchains`
- `https://api.routescan.io/v2/network/testnet/evm/all/blockchains`

Each item has a `name` and an `evmChainId`. Read on 2026-11-05 at 11:36 UTC with Python 3 urllib
and no key, the mainnet list named 27 chains and the testnet list 18. No chain id was on both.

These lists name the chains Routescan's explorer shows, not the chains its Etherscan-compatible
API serves. 7 of the 45 answered `chain not supported`, so the table cannot take its rows from the
lists.

## The probe

Each of the 45 chains was sent one keyless request on its listed network, 0.7 seconds apart,
between 11:37:17 and 11:38:02 UTC:

```text
GET https://api.routescan.io/v2/network/<network>/evm/<chain id>/etherscan/api?module=contract&action=checkverifystatus&guid=abc
```

`abc` is not a job id. Every answer was HTTP 200, with one of two bodies:

| Body                                                                 | Read as | Chains |
| -------------------------------------------------------------------- | ------- | ------ |
| `{"status":"0","message":"NOTOK","result":"Verification not found"}` | served  | 38     |
| `{"status":"0","message":"chain not supported","result":null}`       | refused | 7      |

Two checks followed, between 11:38:34 and 11:39:20 UTC:

- Each of the 38 served chains answered a `getsourcecode` for address
  `0x0000000000000000000000000000000000000001` with `status` `1`, `message` `OK` and an empty
  `SourceCode`: the API reads the chain.
- Each of the 7 refused chains answered `chain not supported` on the other network as well.

One request at 11:39 UTC read the source of `0x636522c3785337399aa9105498d2bd95dc01d749` on
Avalanche Fuji (43113), a contract verified through Routescan on 2026-11-03. Chain 137, which
neither list names, answered `chain not supported`.

The answers were printed while the requests ran and are not stored: they hold nothing beyond the
two bodies above. The result is in
[data/2026-11-05-routescan-chains.json](data/2026-11-05-routescan-chains.json), with each chain's
id, name and network.

### Served

| Network   | Chain ids                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mainnet` | 1, 151, 288, 1015, 1088, 1234, 2786, 3011, 4337, 5000, 5566, 6119, 6900, 8021, 8227, 10507, 13322, 43111, 43114, 43419, 53935, 68414, 81457, 84358, 88888, 432204 |
| `testnet` | 153, 3012, 6911, 13337, 28882, 43113, 88882, 432201, 560048, 743111, 11155111, 168587773                                                                          |

68414 (Henesys) has no Sourcify support and is not in the Etherscan chainlist: Routescan is the
only API the table knows for it.

### Refused

| Network   | Chain ids                                                     |
| --------- | ------------------------------------------------------------- |
| `mainnet` | 10 (OP Mainnet)                                               |
| `testnet` | 17000, 167008, 167009, 421614, 5278000, 11155420 (OP Sepolia) |

### Against earlier counts

The client note of 2026-11-04 confirmed the network of 24 chains from Routescan's supported-chains
page. All 24 are served here. #168 named 10 served chains among the 145 chains of #166's survey;
the other 28 served here were not in that survey.

## The rows

Applied to the table of decision 0036 (288 rows):

| Row before                 | Chains | Row after                               |
| -------------------------- | ------ | --------------------------------------- |
| none                       | 26     | `routescan`                             |
| `sourcify`                 | 7      | `sourcify`, `routescan`                 |
| `etherscan-v2`, `sourcify` | 4      | `etherscan-v2`, `sourcify`, `routescan` |
| `sourcify`, `etherscan-v2` | 1      | `sourcify`, `etherscan-v2`, `routescan` |

The table has 314 rows. The 7 `sourcify` rows are 288, 1088, 43111, 43113, 81457, 743111 and
168587773; the 4 free-tier Etherscan rows are 1, 5000, 560048 and 11155111; the paid-plan row is 43114.

## Size

Measured with `pnpm run size` (esbuild 0.28.2, Node.js 24.21.0 zlib) on 2026-11-05, main at
b53f688 with this change:

| Entry               | Before (decision 0036) | After  | Ceiling |
| ------------------- | ---------------------- | ------ | ------- |
| `routing table`     | 1,662                  | 1,912  | 1,995   |
| `verify with table` | 16,577                 | 16,868 | 17,632  |

The 38 entries and 26 rows add 250 bytes, about 6.6 bytes an entry. Both entries stay under their
ceilings; `routing table` has 83 bytes left.

## Keeping it current

`node scripts/compare-routing-table.ts` reads Routescan's two explorer lists with the other public
lists. It reports a chain new in a list or moved to the other list, which the probe has not
checked, and a served chain that left its list. It also reports a table entry that differs from
the probe data. A new probe needs one request per listed chain:
`node scripts/compare-routing-table.ts --probe-routescan` runs it at the documented keyless rate
and prints a new data file.

## Sources

- Routescan explorer lists, mainnet and testnet:
  https://api.routescan.io/v2/network/mainnet/evm/all/blockchains and
  https://api.routescan.io/v2/network/testnet/evm/all/blockchains, read 2026-11-05.
- Routescan API, Etherscan-compatible endpoint per network and chain, probed 2026-11-05:
  https://api.routescan.io/v2/network/mainnet/evm/68414/etherscan/api
- Routescan rate limits, 2 requests a second on the keyless tier:
  https://docs.routescan.io/plans-and-limits/rate-limits, read 2026-11-03.
- Issue #168: https://github.com/aelmanaa/explorer-verify/issues/168
