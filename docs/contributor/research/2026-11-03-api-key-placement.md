# 2026-11-03: where Etherscan and Routescan take an API key

Audience: whoever implements key attachment (#58) or the Etherscan v2 and Routescan clients (#61,
#62). Builds on [explorer APIs](2026-11-02-explorer-apis.md), the
[Routescan note](2026-11-03-routescan-zksync.md#key-policy-and-rate-limits) and the
[M2 live probes](2026-11-03-m2-live-probes.md).

Requests were sent on 2026-11-03 at about 19:22 UTC with the `fetch` of Node.js 24.21.0. Each
answer is saved as a fixture under `packages/explorer-verify/test/fixtures/<backend>/`, with the
real key replaced by `[redacted]`. The made-up key `EXPLORERVERIFYDUMMYKEY000000000001` is kept as
sent. Every conclusion holds for the requests tested: Arbitrum Sepolia (chain id 421614) on
Etherscan, Avalanche Fuji (43113) on Routescan.

## Etherscan API v2

Every request went to `https://api.etherscan.io/v2/api?chainid=421614` as a form-encoded POST,
with `module`, `action` and the action's fields in the body.

| Key sent as                     | Action              | Answer                                           | Fixture (`etherscan/`)                                    |
| ------------------------------- | ------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| `apikey` field of the form body | `getsourcecode`     | `status` `1`, `OK`, the source record            | `2026-11-03-getsourcecode-form-post-key-in-body.json`     |
| `apikey` field of the form body | `checkverifystatus` | `status` `1`, `OK`, `Pass - Verified`            | `2026-11-03-checkverifystatus-form-post-key-in-body.json` |
| `apikey` request header only    | `getsourcecode`     | `status` `0`, `NOTOK`, `Missing/Invalid API Key` | `2026-11-03-getsourcecode-key-in-apikey-header.json`      |
| `x-api-key` request header only | `getsourcecode`     | `status` `0`, `NOTOK`, `Missing/Invalid API Key` | `2026-11-03-getsourcecode-key-in-x-api-key-header.json`   |
| No key                          | `getsourcecode`     | `status` `0`, `NOTOK`, `Missing/Invalid API Key` | `2026-11-03-getsourcecode-no-key.json`                    |
| Made-up key in the form body    | `getsourcecode`     | `status` `0`, `NOTOK`, `Invalid API Key (#err2)` | `2026-11-03-getsourcecode-invalid-key.json`               |

All six answers had HTTP status 200. So:

- A key in the form body works for a read and a status poll. The M2 probes saw the same for
  `verifysourcecode` on 2026-11-03 (fixtures `2026-11-03-verifysourcecode-*.json`). The key never
  has to be in the URL.
- A key in a header is ignored: the answer is the same as with no key.
- A missing key and an unknown key give two different `result` strings. The HTTP status does not
  tell them apart.

Daily limits, as Etherscan reported them through Sourcify's external verification field (live
responses from sourcify.dev, 2026-11-02, fixtures `sourcify/2026-11-02-job-exact-match.json` and
`sourcify/2026-11-02-job-match.json`):

- `Max daily rate limit reached. 100000 (100%) of 100000 day/limit`
- `Daily limit of 500 source code submissions reached`

Etherscan's rate-limit page says "requests are blocked once you reach your plan's daily limit"
and gives no error text ([rate limits](https://docs.etherscan.io/resources/rate-limits), read
2026-11-03).

## Routescan

A `GET` of `getsourcecode` on
`https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api` with the made-up key in an
`apikey` header was answered with `status` `1`, `OK` and the source record
(`routescan/2026-11-03-getsourcecode-invalid-key-header.json`). The same request without a key, and
with the made-up key as an `apikey` query parameter, gave the same answer (not saved). Routescan's
free tier needs no key ([get started](https://docs.routescan.io/getting-started/get-started), read
2026-11-03), so an unknown key on a keyless endpoint is not refused. What Routescan answers for a
bad key on a keyed tier, or when a key's daily limit is spent, stays unknown.

## Open questions

- Routescan's answer for a refused key and for a spent daily limit. Not reached.
- Etherscan's answer when a key passes its per-second limit. Not reached.
- Etherscan's answer for a chain that its free plan does not cover. Answered on 2026-11-04: it is
  `Free API access is not supported for this chain`, mapped to `api-key-rejected`, exit code 3
  ([Etherscan v2 entries](2026-11-04-etherscan-rows.md#a-free-plan-key-on-the-paid-plan-chains)).

## Sources

- [Etherscan rate limits](https://docs.etherscan.io/resources/rate-limits), read 2026-11-03.
- [Routescan get started](https://docs.routescan.io/getting-started/get-started), read 2026-11-03.
- Live requests with the `fetch` of Node.js 24.21.0 on 2026-11-03, saved as the fixtures named
  above.
