# 2026-11-04: Routescan client answers

Audience: whoever maintains the Routescan client (R-BE-5) or adds Routescan rows to the routing
table (R-RT-1). Assumes the [Routescan note](2026-11-03-routescan-zksync.md) of 2026-11-03 and the
[live probes](2026-11-03-m2-live-probes.md) of the same day. This note collects what those probes
answered for the client, adds the requests of 2026-11-04, and says how the client maps each answer.

The 2026-11-04 requests were sent without a key with the `fetch` of Node.js 24.21.0, about 1.5 s
apart, from 08:29 to 08:47 UTC. Each one that a test or a docs example replays is recorded under
`packages/explorer-verify/test/fixtures/routescan/2026-11-04-*.json`.

## Answers from the probes of 2026-11-03

From probes B and C of the [live probes](2026-11-03-m2-live-probes.md), on Avalanche Fuji (43113):

- A keyless `verifysourcecode` sent as a form-encoded POST, every field in the body and no query
  string, was accepted and verified the contract. The job id was the UUID
  `f111a4c8-368c-51d2-8163-c7ab477a1d91`, which matches the handle's `jobId` pattern.
- A repeated `checkverifystatus` GET URL was answered from the CDN cache (`cf-cache-status: HIT`).
  The first answer, `Pending in queue`, was still served at `age: 3044`, about 51 minutes after it
  was cached. A `cache-control: no-cache` request header did not bypass the cache; a unique query
  parameter did.
- The job answered `Pass - Verified`, then `Verification not found` 51 minutes after the submit,
  while `getsourcecode` still returned the verified source.
- `getsourcecode` returned the source with no `SimilarMatch` field.
- Twenty concurrent uncached keyless requests within about one second were all answered with
  HTTP 200. The rate-limit answer was not reached.

## Requests of 2026-11-04

On Avalanche Fuji, `https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api`, unless the
row says otherwise. Every answer came with HTTP 200.

| Request                                                       | Answer (`message`, `result`)                                        | `cf-cache-status` |
| ------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------- |
| POST form `checkverifystatus` with the GUID above, twice      | `NOTOK`, `Verification not found`                                   | `DYNAMIC`         |
| POST form `checkverifystatus` without `guid`                  | `NOTOK`, `Missing guid`                                             | `DYNAMIC`         |
| POST form `getsourcecode` with the probe B address            | `NOTOK`, `Invalid querystring request`                              | `DYNAMIC`         |
| GET `getsourcecode`, probe B address, unique `nocache`        | `OK`, the verified source, no `SimilarMatch` field                  | `MISS`            |
| GET `getsourcecode`, address `0x…0001`, unique `nocache`      | `OK`, `SourceCode` empty, `ABI` `Contract source code not verified` | `MISS`            |
| GET `checkverifystatus` without `guid`, unique `nocache`      | `NOTOK`, `Missing guid`                                             | `MISS`            |
| GET `checkverifystatus` with the GUID above, unique `nocache` | `NOTOK`, `Verification not found`                                   | `MISS`            |
| GET `getsourcecode` on `testnet/evm/324`                      | `chain not supported`, `null`                                       | `MISS`            |
| POST form `verifysourcecode` on `testnet/evm/324`             | `chain not supported`, `null`                                       | `DYNAMIC`         |
| POST form `checkverifystatus` on `mainnet/evm/43113`          | `chain not supported`, `null`                                       | `DYNAMIC`         |

So Routescan reads a POST body for `checkverifystatus` and `verifysourcecode`, but not for
`getsourcecode`. A POST is not cached; a GET is, unless its URL is new.

### Chains confirmed on 2026-11-04

The [routing table note](2026-11-03-routing-table.md#routescan) lists 24 chains from Routescan's
supported-chains page, two of them confirmed. Each was sent a POST `checkverifystatus` on its
listed network and on the other one, between 08:31 and 08:34 UTC. On the listed network, every
chain answered `Verification not found`; on the other, every chain answered `chain not supported`.
That confirms the network of each:

| Network   | Chain ids                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `mainnet` | 1, 151, 288, 1234, 2786, 3011, 4337, 5000, 5566, 6119, 6900, 8021, 8227, 10507, 13322, 43111, 43114, 43419, 68414, 81457, 84358, 88888, 432204 |
| `testnet` | 43113                                                                                                                                          |

These answers were not recorded as fixtures; they were printed while the requests ran. Routescan's
testnet chains other than Fuji are still not known: the page's testnet tab did not render on
2026-11-03.

## How the client maps them

| Finding                                           | Client                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A form POST submit is read                        | The submit is the Etherscan client's form-encoded POST, to the row's URL, with no `chainid`    |
| A form POST `getsourcecode` is refused            | A lookup is a GET with its fields in the query                                                 |
| A repeated GET URL is served from the CDN cache   | Every lookup and status GET adds `nocache` with random characters, new for each attempt        |
| `chain not supported` in `message`, `result` null | `unsupported-chain`, never `failed`                                                            |
| `Verification not found`                          | `job-not-found`; the flow then looks the contract up once, and a match gives `verified`        |
| `Missing guid`                                    | `unexpected-response`: the client sent a malformed request                                     |
| No `SimilarMatch` field                           | A non-empty `SourceCode` is `exact`                                                            |
| Rate-limit answer unknown                         | A 429 and Etherscan's `Max calls per sec rate limit reached` are retried; anything else throws |

A status request could also be a POST, which the CDN does not cache. The client sends it as a GET,
as Routescan's docs show it, so that the lookup and the status request share one request builder.

## Open questions

- What is Routescan's rate-limit answer? Not reached on 2026-11-03. Recording it is left to a
  follow-up issue.
- Is there an API that lists Routescan's supported chains with their network? Not found.
- Does Routescan read a key in the `apikey` header? A made-up key there was answered without a
  refusal on 2026-11-03 ([API key placement](2026-11-03-api-key-placement.md)); no real key was
  available to test. Confirming the header with a real key is left to a follow-up issue, as
  decision 0016 asks.
- Does a keyed request work from a browser? The `apikey` header makes the browser send a CORS
  preflight. Routescan answered a preflight that named `apikey` on 2026-11-03
  ([Routescan note](2026-11-03-routescan-zksync.md#browser-reachability-live-2026-11-03)), but no
  keyed request was sent from a browser.
- Routescan's contract page format, for `explorerUrl`.

## Sources

- Routescan: [contracts API](https://docs.routescan.io/api/etherscan/contracts),
  [supported chains](https://docs.routescan.io/getting-started/supported-chains),
  [rate limits](https://docs.routescan.io/plans-and-limits/rate-limits) (read 2026-11-03).
- [Live probes](2026-11-03-m2-live-probes.md), probes B and C, 2026-11-03.
- Local runs, Node.js 24.21.0 `fetch`, 2026-11-04, against `https://api.routescan.io`, no key: the
  requests listed above.
