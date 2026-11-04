# 2026-11-04: Etherscan v2 answers the client maps

Audience: whoever changes the Etherscan v2 client (`packages/explorer-verify/src/backends/etherscan.ts`).
Assumes [explorer APIs](2026-11-02-explorer-apis.md), [API key placement](2026-11-03-api-key-placement.md)
and the [M2 live probes](2026-11-03-m2-live-probes.md).

This note lists every `result` text the client maps, with where it was seen. Answers recorded on
2026-11-04 were sent with the `fetch` of Node.js 24.21.0 to `https://api.etherscan.io/v2/api` (and
to the v1 URL for one probe), as form-encoded POST requests with the key in the body. Each is saved
under `packages/explorer-verify/test/fixtures/etherscan/2026-11-04-<call>.json`, the key replaced by
`[redacted]`. A fixture named `2026-11-02-documented-<call>.json` is not a recorded response; its
`source` field says which text it follows.

## The POST form

Every request the client sends is `POST https://api.etherscan.io/v2/api?chainid=<id>` with a
form body holding `module`, `action`, the action's fields and `apikey`. Etherscan read `module`,
`action` and the key from the form body for `getsourcecode` and `checkverifystatus` (live,
2026-11-03, [API key placement](2026-11-03-api-key-placement.md)) and for `verifysourcecode`
(live, 2026-11-03 and 2026-11-04). The `verifysourcecode` docs show the key in the query
([verifysourcecode](https://docs.etherscan.io/api-reference/endpoint/verifysourcecode), read
2026-11-04); the client never puts it there (decision 0016).

## Answers

Every answer below came with HTTP 200 and `message` `NOTOK`, `status` `"0"`, unless the row says
otherwise.

| `result` (start)                                                       | Seen for            | Source                                                                                                        |
| ---------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------- |
| A 50-character GUID, `status` `"1"`                                    | `verifysourcecode`  | Live, 2026-11-03 (probes A, D, E)                                                                             |
| `Contract source code already verified`                                | `verifysourcecode`  | Live, 2026-11-04: a second submit of probe D1's input                                                         |
| `Already Verified`                                                     | `checkverifystatus` | Matched by the prior art ([explorer APIs](2026-11-02-explorer-apis.md)); not seen live                        |
| `Unable to locate ContractCode at 0x…`                                 | `verifysourcecode`  | Live, 2026-11-02 ([explorer APIs](2026-11-02-explorer-apis.md)) and 2026-11-04                                |
| `Max calls per sec rate limit reached (3/sec)`                         | any                 | Live, 2026-11-04: 9 of 12 `getsourcecode` requests sent at once, and one submit                               |
| `Max daily rate limit reached. …`, `Daily limit of 500 source code …`  | any                 | Live, 2026-11-02, quoted in `src/http/api-keys.ts`; not recorded                                              |
| `Missing/Invalid API Key`, `Invalid API Key (#err2)`                   | any                 | Live, 2026-11-03 ([API key placement](2026-11-03-api-key-placement.md))                                       |
| `Missing or unsupported chainid parameter (required for v2 api), …`    | any                 | Live, 2026-11-02 and 2026-11-04, chain id 999999999                                                           |
| `You are using a deprecated V1 endpoint, switch to Etherscan API V2 …` | any                 | Live, 2026-11-04: `getsourcecode` sent to `https://api.etherscan.io/api`                                      |
| `Pending in queue`                                                     | `checkverifystatus` | Live, 2026-11-03 (probes A, D, E)                                                                             |
| `Pass - Verified`, `status` `"1"`                                      | `checkverifystatus` | Live, 2026-11-03, and [checkverifystatus](https://docs.etherscan.io/api-reference/endpoint/checkverifystatus) |
| `Fail - Unable to verify`                                              | `checkverifystatus` | Classified by the prior art ([explorer APIs](2026-11-02-explorer-apis.md)); not recorded                      |
| `Unable to locate guid`                                                | `checkverifystatus` | Live, 2026-11-04: a made-up GUID of 50 letters                                                                |
| `Invalid GUID length`                                                  | `checkverifystatus` | Live, 2026-11-04: a GUID of 3 letters                                                                         |

The rate-limit text came with HTTP 200, not 429, so the HTTP status alone does not show it.
Neither the [rate limits page](https://docs.etherscan.io/resources/rate-limits) nor the
[checkverifystatus page](https://docs.etherscan.io/api-reference/endpoint/checkverifystatus) quotes
an error text (read 2026-11-04).

`Pending in queue` comes with `status` `"0"`, so `status` alone does not mean an error during a
poll. The client reads the text.

## The lookup and Similar Match

`getsourcecode` answers `status` `"1"` with `result` as an array of one object (live, 2026-11-03).
The object's `SourceCode` is empty for a contract that is not verified. `SimilarMatch` is empty for
a contract verified from its own source, and holds the address of the matched contract for one
verified by Similar Match ([probe D](2026-11-03-m2-live-probes.md#d-similar-match-and-getcontractcreation-for-a-factory-deployment)).
Etherscan says a Similar Match does not take constructor arguments into account
([types of contract verification](https://info.etherscan.com/types-of-contract-verification/),
read 2026-11-03). That is not what sets it apart: in probe A, contracts submitted with omitted or
wrong arguments got an exact match of their own. What sets it apart is that the stored source was
submitted for another contract. The client reports it as `partial`, so a result never claims that
the source was verified for this address. The explorer page of probe D2 showed `Exact Match` next to
`Similar Match:` (observation, 2026-11-03), so this mapping is a choice, not what the page shows.

## Sources

- Etherscan: [verifysourcecode](https://docs.etherscan.io/api-reference/endpoint/verifysourcecode),
  [checkverifystatus](https://docs.etherscan.io/api-reference/endpoint/checkverifystatus),
  [rate limits](https://docs.etherscan.io/resources/rate-limits), read 2026-11-04;
  [types of contract verification](https://info.etherscan.com/types-of-contract-verification/),
  read 2026-11-03.
- Earlier notes: [explorer APIs](2026-11-02-explorer-apis.md),
  [API key placement](2026-11-03-api-key-placement.md),
  [M2 live probes](2026-11-03-m2-live-probes.md).

Local runs on 2026-11-04, Node.js 24.21.0 `fetch`, against `https://api.etherscan.io`: the
`checkverifystatus`, `getsourcecode` and `verifysourcecode` requests in the fixtures dated
2026-11-04, and the burst of 12 `getsourcecode` requests for
`0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5` on chain 421614.
