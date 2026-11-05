# 2026-11-05: Blockscout's hosted API with a key

Audience: whoever changes how the Blockscout client reaches `api.blockscout.com`, or where
its key goes. Assumes [the Blockscout client note](2026-11-04-blockscout-client.md)
and [the deprecation watch note](2026-11-05-blockscout-deprecation-watch.md).

This note records a live run against Blockscout's hosted multichain API with a free-plan key: the
routes, where the API reads a key, how it answers a missing, wrong or under-privileged key, the
rate limit, CORS, and one verification from submit to `Pass - Verified`. It is the evidence for
[decision 0041](../decisions/0041-blockscout-hosted-api.md).

## Method

- Node.js 24.21.0 `fetch`, `redirect: "manual"`, `accept: application/json`, on 2026-11-05 between
  19:35 and 19:40 UTC. One request at a time, 1.2 to 1.5 s apart, except the rate-limit burst.
- The key is the maintainer's, on the free plan. It is 79 characters from the RFC 3986 unreserved
  set and starts with `proapi_`. It was read inside the probe process and replaced with
  `[redacted]` in every recorded request; the recorded files were checked for it before they were
  saved.
- Each answer is saved under
  `packages/explorer-verify/test/fixtures/blockscout/2026-11-05-hosted-<name>.json`. Lookup bodies
  are kept whole; a Standard JSON input in a request is replaced by its length.
- Contracts: `0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC` on Sepolia (11155111), verified with a
  full match before this run; `0x0d7ba9133629d6732a3ef5a3f5f09c68dac4be65` on Base Sepolia (84532),
  also verified; and a contract deployed for this run (below).

## Routes

[API general info, pricing, and routes](https://docs.blockscout.com/devs/pro-api-routes) (read
2026-11-05) lists three route forms for the hosted API, shown for Optimism:

- `https://api.blockscout.com/v2/api?chain_id=10&module=...`, the "JSON RPC API v2";
- `https://api.blockscout.com/10/api?module=...`, the "JSON RPC API";
- `https://api.blockscout.com/10/api/v2/...`, the REST API.

[Blockscout smart contract verification API](https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api)
(read 2026-11-05) shows the verification actions on the first form.

Live: `getsourcecode` and `checkverifystatus` gave the same answer on
`/v2/api?chain_id=11155111` and on `/11155111/api`. The REST lookup
`/11155111/api/v2/smart-contracts/{address}` answered as an instance's does. So
`https://api.blockscout.com/<chainId>/api` works as an instance's `/api`: the client's requests are
unchanged, and the chain is in the path of every request.

## Key placement

The routes page says: "Pass an API key using either: `apikey` query parameter, `authorization`
header". The docs' JSON-RPC example sends `authorization: Bearer proapi_...`, and
[the developer portal's llms.txt](https://dev.blockscout.com/llms.txt) (read 2026-11-05) says
"`Authorization: Bearer <api-key>` header on every request".

| Request                                    | Key placement                   | Answer                                            |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------- |
| REST lookup, Sepolia                       | `authorization: Bearer <key>`   | 200, the contract with `is_fully_verified` `true` |
| REST lookup, Sepolia                       | `authorization: <key>`          | 200, the same                                     |
| REST lookup, Sepolia                       | `apikey` query parameter        | 200, the same                                     |
| `getsourcecode` POST, Sepolia              | `authorization: Bearer <key>`   | 200, `status` `"1"`, the source                   |
| `getsourcecode` POST, Sepolia              | `apikey` field of the form body | 200, the same                                     |
| `getsourcecode` POST, `/v2/api?chain_id=…` | `authorization: Bearer <key>`   | 200, the same                                     |

The header works for every request, the GET lookup included. The form body works only for POSTs,
and the query puts the key in a URL, which R-SEC-1 forbids.

## Key answers

| Request        | Key                                  | HTTP | Body                                                                                                               |
| -------------- | ------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------ |
| Lookup, submit | None                                 | 402  | `{"error":"Proceed with API key or make a X402 payment to continue"}`                                              |
| Lookup, submit | Made up, `proapi_` and 32 hex digits | 401  | `{"error":"Unauthorized"}`                                                                                         |
| Every request  | The free-plan key, on Base Sepolia   | 402  | `{"error":"Featured chain 84532 requires one of the following plans: Builder, Business, Pro","source":"internal"}` |
| Lookup         | The free-plan key, chain 999999999   | 404  | `{"error":"Network not supported","source":"internal"}`                                                            |

The free-plan key worked on Sepolia and was refused on Base Sepolia, which the API calls a
"featured chain". No answer about spent credits was seen: the key had 99,420 credits left after
the run. [The credits section](https://docs.blockscout.com/devs/pro-api-routes) (read 2026-11-05)
says that on the free plan, once the daily 100,000 credits are spent, "further requests are
rejected until the daily reset", without the answer's status or text. The x402 page
([x402 payments for the Blockscout API](https://docs.blockscout.com/devs/x402-payments), read
2026-11-05) explains the 402: a request without a key may pay per call instead, which is out of
scope here.

## Verification answers

The texts are the instances' texts of [the client note](2026-11-04-blockscout-client.md), with the
same `status` values:

| Request                                                       | Answer                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Submit for the verified Sepolia contract                      | `status` `"0"`, `Smart-contract already verified.`                |
| Submit for `0x000000000000000000000000000000000000dEaD`       | `status` `"0"`, `Address is not a smart-contract`                 |
| Lookup of that address                                        | 404, `{"message":"Not found"}`                                    |
| `checkverifystatus` with a made-up job id                     | `status` `"1"`, `Unknown UID`                                     |
| Submit with a wrong source, for the contract below            | `status` `"1"`, a job id                                          |
| `checkverifystatus` for that job, twice, then once more       | `Pending in queue`, `Pending in queue`, `Fail - Unable to verify` |
| Submit with the right source                                  | `status` `"1"`, a job id                                          |
| `checkverifystatus` for that job, three times, then once more | `Pending in queue` three times, then `Pass - Verified`            |
| Lookup after the pass                                         | 200, `is_verified` `true`, `is_fully_verified` `true`             |

The contract, `Probe96`, holds one constant. It was compiled with solc 0.8.24+commit.e11b9ed9,
optimizer on with 200 runs, `evmVersion` `cancun`, and deployed on Sepolia from the maintainer's
funded test key:

- Address: `0x47740d3eb5c98ba53a3aba3a39df120a6f168403`
- Transaction: `0x1cff4aaf596544a550f366eed67cd79be476b2401bfe83374e83a067d8a0722a`, block 12071602
- Cost: 0.000000000008298465 ETH

Before any submit, the hosted lookup answered 200 with the contract's code and no verification
fields, as an instance does for an unverified contract. Right after the pass, the instance
`eth-sepolia.blockscout.com` answered its own lookup with `is_fully_verified` `true` and
`verified_at` `2026-11-05T19:39:10.807452Z`, without a key: a verification through the hosted API
shows on the instance.

## Rate limit

Each answer carried `x-ratelimit-limit` `5`, `x-ratelimit-remaining`, `x-ratelimit-reset` in
milliseconds and `x-credits-remaining`. Twelve `checkverifystatus` requests sent at once got five
200 answers and seven HTTP 429 `{"error":"Too Many Requests"}`, with no `Retry-After`. The docs give
the free plan 5 requests per second.

## CORS

- A preflight `OPTIONS` from origin `https://dapp.example` asking for `authorization` and
  `content-type` answered 204 with `access-control-allow-headers` that lists `Authorization`, and
  `access-control-allow-methods`, but no `access-control-allow-origin`.
- A GET with that origin and the key answered 200 with no `access-control-allow-origin`.

A browser reads neither answer. A browser reaches the hosted API only through a server, which the
issue's non-goals already state.

## Terms

A search of [the docs' full text](https://docs.blockscout.com/llms-full.txt) (read 2026-11-05) for
terms of use, sharing a key, and browser or client-side use of the hosted API found no text on
whether a key may be exposed or shared. The server handler docs are unchanged.

## Sources

- [API general info, pricing, and routes](https://docs.blockscout.com/devs/pro-api-routes), read
  2026-11-05.
- [Blockscout API overview](https://docs.blockscout.com/devs/pro-api), read 2026-11-05.
- [Blockscout smart contract verification API](https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api),
  read 2026-11-05.
- [x402 payments for the Blockscout API](https://docs.blockscout.com/devs/x402-payments), read
  2026-11-05.
- [Developer portal llms.txt](https://dev.blockscout.com/llms.txt), read 2026-11-05.
- [Blockscout docs, full text](https://docs.blockscout.com/llms-full.txt), read 2026-11-05.
- The page https://docs.blockscout.com/devs/pro-api/make-your-first-call answered HTTP 404 on
  2026-11-05.
- Live answers: Node.js 24.21.0 `fetch`, 2026-11-05, as described above.
