# 2026-11-05: standalone Etherscan-compatible hosts, and what Bitlayer's API answers

Audience: whoever changes the routing table's `etherscan-compatible` entries (R-RT-1) or the
standalone client (R-BE-2). Assumes [the standalone client note](2026-11-04-etherscan-compatible-client.md)
and [decision 0016](../decisions/0016-api-keys-bound-to-hosts.md).

This note records the probe behind the `etherscan-compatible` entry that
[#170](https://github.com/aelmanaa/explorer-verify/issues/170) adds.
[Decision 0039](../decisions/0039-standalone-hosts-in-the-routing-table.md) takes the choices.

## The candidates

Foundry reads its chain list from alloy-chains. The list is a JSON file,
`assets/chains.json`, whose `chains` object maps each chain id to fields that include
`etherscanApiUrl` and `etherscanBaseUrl`. In version 0.2.39, read on 2026-11-05, 74 chains have an
`etherscanApiUrl` whose host is not `api.etherscan.io` and does not hold `routescan` or
`blockscout`. Many of them are Blockscout instances on their own domains. Issue #170 names three whose API is a standalone
Etherscan-style explorer and which the table does not route otherwise:

| Chain id | Chain    | `etherscanApiUrl`                      | `etherscanBaseUrl`         |
| -------- | -------- | -------------------------------------- | -------------------------- |
| 200901   | Bitlayer | `https://api.btrscan.com/scan/api`     | `https://www.btrscan.com`  |
| 1116     | Core     | `https://openapi.coredao.org/api`      | `https://scan.coredao.org` |
| 8217     | Kaia     | `https://mainnet-oapi.kaiascan.io/api` | `https://kaiascan.io`      |

The same three entries are in alloy-chains' `main` branch on 2026-11-05.

## The keyless probe

Each API was sent one request with curl 8.7.1 on 2026-11-05 at 13:28 UTC:

```text
GET https://<api>?module=contract&action=getsourcecode&address=0x0000000000000000000000000000000000000000
```

| Chain    | HTTP | Body                                                                                                                                                                  |
| -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bitlayer | 200  | `{"status":"1","message":"OK","result":[]}`                                                                                                                           |
| Core     | 401  | `{"status":401,"error":"Unauthorized","message":"401 Permission Verification Failed. This apikey is illegal!"}`                                                       |
| Kaia     | 401  | `{"title":"unauthorized access","message":"Please confirm your authority. (Access denied: The request is missing a valid access key.)","code":"UNAUTHORIZED_ACCESS"}` |

Core and Kaia need a key for every request. Neither answer is Etherscan's `Missing/Invalid API Key`,
so the client would read them as `unexpected-response`, not `missing-api-key`. No run with a key
has been made, so neither gets an entry.

## Bitlayer's API

More requests to `https://api.btrscan.com/scan/api`, all keyless, on 2026-11-05 between 13:20 and
13:35 UTC. The answers to the requests the client sends are recorded with Node.js 24.21.0 `fetch`
in `packages/explorer-verify/test/fixtures/etherscan-compatible/2026-11-05-bitlayer-*.json`.

| Request                                                                      | HTTP | Body                                                                                                             |
| ---------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------- |
| `GET` `getsourcecode` for an address with no verified source                 | 200  | `{"status":"1","message":"OK","result":[]}`                                                                      |
| `POST` form `getsourcecode`, same address                                    | 200  | `{"code":4405,"timestamp":…,"message":"Request method 'POST' not supported"}`                                    |
| `GET` `getsourcecode` for WBTC, `0xff204e2681a6fa0e2c3fade68a1b28fb90e4fc5f` | 200  | `status` `"1"`, one record with a non-empty `SourceCode`, `contractName` `WBTC`, no `SimilarMatch`               |
| `GET` or `POST` form `checkverifystatus`, `guid=abc`                         | 200  | `{"status":"-1","message":"The contract has not been verified"}`                                                 |
| `POST` form `checkverifystatus`, `guid=abc`, a made-up `apikey`              | 200  | The same answer: the made-up key was not refused                                                                 |
| `POST` form `verifysourcecode` with no other field                           | 200  | `{"status":"10000","message":"SYSTEM ERROR"}`                                                                    |
| `POST` form `verifysourcecode` with the fields Etherscan takes, for `0x…01`  | 200  | `{"status":"-1","message":"The contract address does not exist","result":"The contract address does not exist"}` |
| `GET https://www.btrscan.com/address/0xff20…fc5f`                            | 200  | The contract page                                                                                                |

What follows for the client and the table:

- A lookup sent as a form POST, as the client sent it before #170, cannot work: Bitlayer refuses
  the method. A keyless lookup and status request go as a GET. A keyed one stays a POST, so the key
  is never in a URL; no keyed standalone host has been checked yet.
- An unverified address gets an empty `result` list, not Etherscan's record with an empty
  `SourceCode`. The standalone client reads the empty list as "not verified".
- A verified contract's record has the fields Etherscan's has, so a lookup of a verified contract
  is read as `exact`.
- The submit takes Etherscan's form fields, and its errors use `status` `"-1"`. The answer to a
  submit of a real contract, and the status of a real job, were not seen: no contract was deployed
  on Bitlayer. Until then they are read as Etherscan's, and an answer that differs throws
  `unexpected-response`, never `failed` (R-FLOW-4).
- An unknown job id gets `The contract has not been verified` with no `result`, which the client
  reads as `unexpected-response`, not `job-not-found`.
- Bitlayer needs no key for these requests. The entry has no `needsKey`.
- `www.btrscan.com` serves the contract page at `/address/<address>`, so the entry names it as
  `explorer`. `btrscan.com` answers HTTP 301 to `www.btrscan.com`.

## Size

Measured with `pnpm run size` on 2026-11-05, main at d233f17 against the same commit with #170:
the `routing table` entry grows 42 bytes, `verify with table` 235, and the `etherscan-compatible`
chunk 109. [Decision 0039](../decisions/0039-standalone-hosts-in-the-routing-table.md#size) has the
table.

## Keeping it current

The weekly comparison reads alloy-chains' list from its `main` branch and reports a probed chain
whose `etherscanApiUrl` moved or that left the list. It does not probe the APIs: a person runs the
request above again and updates the data file.

## Open questions

- How Core's and Kaia's APIs answer with a key, and where they read it.
- What Bitlayer answers to a submit of a deployed contract, and to the status of a real job.

## Sources

- alloy-chains 0.2.39 chain list:
  https://raw.githubusercontent.com/alloy-rs/chains/v0.2.39/assets/chains.json (read 2026-11-05)
- alloy-chains chain list on `main`:
  https://raw.githubusercontent.com/alloy-rs/chains/main/assets/chains.json (read 2026-11-05)
- Live requests: curl 8.7.1 and Node.js 24.21.0 `fetch` on 2026-11-05, as described above.
