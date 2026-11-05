# 2026-11-05: Routescan with a real key, its rate-limit answer and CORS

Audience: whoever maintains the Routescan client (R-BE-5), its key placement (decision 0016) or its
retry handling (R-FLOW-6). Assumes the [Routescan client note](2026-11-04-routescan-client.md) and
the [API key placement note](2026-11-03-api-key-placement.md). This note answers three of their
open questions: whether Routescan reads a key in the `apikey` header, what it answers over its rate
limit, and whether a keyed request works from a browser.

## Method

Every request went to Avalanche Fuji,
`https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api`, between 19:32 and 19:36 UTC
on 2026-11-05, with the `fetch` of Node.js 24.21.0 unless the row says otherwise. Lookups were
`getsourcecode` for the probe B contract `0x636522C3785337399Aa9105498d2Bd95Dc01D749`; the
rate-limit bursts were `checkverifystatus` with made-up job ids. Every GET carried a new `nocache`
value, so no answer came from the CDN cache.

The key was a registered free-plan Routescan key. It was read inside the process and never printed;
the fixtures show it as `[redacted]`. The made-up key had the real key's length and format, with
random letters and digits; the fixtures show it as `[made-up key]`.

The fixtures are under `packages/explorer-verify/test/fixtures/routescan/2026-11-05-*.json`.

## A key in the `apikey` header is read

| Request                                           | Answer                     | Rate-limit headers                                | Fixture                              |
| ------------------------------------------------- | -------------------------- | ------------------------------------------------- | ------------------------------------ |
| No key                                            | HTTP 200, `OK`, the source | None                                              | `getsourcecode-no-key`               |
| The key in the `apikey` header                    | HTTP 200, `OK`, the source | `x-ratelimit-rpm-limit: 300`, `rpd-limit: 100000` | `getsourcecode-key-in-apikey-header` |
| The key as an `apikey` query parameter, no header | HTTP 200, `OK`, the source | The same as the header                            | `getsourcecode-key-in-query`         |
| The made-up key in the `apikey` header            | HTTP 200, `OK`, the source | None                                              | `getsourcecode-made-up-key-header`   |
| The made-up key as a query parameter              | HTTP 200, `OK`, the source | None                                              | Not saved                            |

A keyed answer carries six headers: `x-ratelimit-rpm-limit`, `x-ratelimit-rpm-remaining`,
`x-ratelimit-rpm-reset` (seconds, 60 on the first request), and the same three with `rpd` for the
day (`86400` seconds). It also carries an `x-request-id`. A keyless answer has none of them.

So:

- Routescan reads a key in the `apikey` header. The limits in the headers, 300 a minute and 100,000
  a day, match the registered free plan of Routescan's rate-limit page, 5 requests a second and
  100,000 calls a day ([rate limits](https://docs.routescan.io/plans-and-limits/rate-limits), read
  2026-11-03).
- Routescan also reads the key as a query parameter. The library still sends it only in the header
  (decision 0016): a URL is logged by proxies and servers, and a header is not.
- A key Routescan does not know is not refused. The answer is the keyless one, on the keyless tier.
  Nothing in the body tells the two apart; only the missing `x-ratelimit-*` headers do. So no answer
  maps to `api-key-rejected` for Routescan.

## The rate-limit answer

Keyed: 20 concurrent requests, then 350 sent in batches of 50 within 3.3 s. The first 300 were
answered `Verification not found`, the 300th with `x-ratelimit-rpm-remaining: 0`. Each of the last
50 got this answer (fixture `checkverifystatus-rate-limit-keyed`):

```text
HTTP 429
x-ratelimit-rpm-limit: 300
x-ratelimit-rpm-remaining: 0
x-ratelimit-rpm-reset: 58
x-ratelimit-rpm-retry-after: 58
cf-cache-status: BYPASS

{"statusCode":429,"code":"rate-limit","error":"Too Many Requests","message":"You are reaching the maximum number of requests for this API. To avoid disruptions, please consider slowing down your requests. If you need a higher limit, consider requesting a personalized API key by visiting: https://rscan.link/api."}
```

There is no `Retry-After` header: the wait is only in `x-ratelimit-rpm-retry-after`, in seconds.
The 300 requests passed within 2.6 s, so the keyed limit is counted per minute, not per second.

Keyless: three bursts of concurrent requests, 30 and then 60 between 19:32 and 19:34 UTC, and 150
at 19:35:24 UTC. The first two were all answered. Of the 150, 118 were answered and 32 got the same 429 and body, with no
`x-ratelimit-*` header and no `Retry-After` (fixture `checkverifystatus-rate-limit-keyless`). With
the two keyless requests a browser sent 20 s before, 120 keyless requests were answered within the
minute, which matches the documented 2 requests a second counted per minute. Five keyless requests
sent while the key was over its limit were answered, so the key's count and the keyless count are
kept apart.

The daily limit was not reached, so its answer is not known.

## CORS and a keyed request from a browser

| Request                                                                                              | Answer                                                                                                                            | Fixture                         |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `OPTIONS`, `Origin: https://example.com`, method `GET`, headers `apikey`                             | HTTP 204, `access-control-allow-origin: *`, `access-control-allow-headers: apikey`, methods `GET, HEAD, PUT, PATCH, POST, DELETE` | `options-preflight-get-apikey`  |
| `OPTIONS`, `Origin: https://example.com`, method `POST`, headers `apikey,content-type`               | HTTP 204, the same, with `access-control-allow-headers: apikey,content-type`                                                      | `options-preflight-post-apikey` |
| Keyed GET with `Origin: https://example.com`                                                         | HTTP 200, `access-control-allow-origin: *`, the keyed headers                                                                     | Not saved                       |
| `fetch()` GET from a page on `http://127.0.0.1`, Chromium 148.0.7778.96 headless (Playwright 1.64.1) | No key, the key, and the made-up key in the `apikey` header: each HTTP 200, `OK`                                                  | `browser-getsourcecode-keyed`   |

A keyed request works from a browser: the preflight allows the `apikey` header from any origin, and
the answer, a 429 included, carries `access-control-allow-origin: *`. The page cannot read the
`x-ratelimit-*` headers, because no answer has `access-control-expose-headers`. In a browser,
`x-ratelimit-rpm-retry-after` therefore reads as missing.

A key placed in a page is readable by everyone who loads the page.

## How the client maps them

| Finding                                               | Client                                                                                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `apikey` header is read                           | No change: `withKey` puts the key there (decision 0016)                                                                                                                                                  |
| A key in the query is read too                        | No change: the key never goes in a URL                                                                                                                                                                   |
| An unknown key gets the keyless answer                | No change: there is nothing to map to `api-key-rejected`                                                                                                                                                 |
| Keyless 429, no wait header                           | No change: a 429 is retried with backoff, then `rate-limited`                                                                                                                                            |
| Keyed 429, wait only in `x-ratelimit-rpm-retry-after` | Every Routescan request names that header as `retryAfterHeader`. The HTTP layer reads it when `Retry-After` is absent; a wait above 30 s ends the retries at once with `rate-limited` and `retryAfterMs` |
| The header is not exposed to a page                   | In a browser a keyed 429 is retried with backoff, as a keyless one is                                                                                                                                    |

Before this change a keyed 429 was retried four times within about 15 s, inside the same minute, so
each retry got the 429 again and the error had no `retryAfterMs`.

## Open questions

- Routescan's answer when a key's daily limit is spent. Not reached.
- Whether a paid-plan key gets other header names, such as a per-second limit. Only a free-plan key
  was tested.

## Sources

- Routescan: [rate limits](https://docs.routescan.io/plans-and-limits/rate-limits),
  [get started](https://docs.routescan.io/getting-started/get-started) (read 2026-11-03).
- Local runs, Node.js 24.21.0 `fetch`, 2026-11-05, 19:32 to 19:36 UTC, against
  `https://api.routescan.io`, with and without a key: the requests listed above.
- Local run, Chromium 148.0.7778.96 headless through Playwright 1.64.1, 2026-11-05 19:35 UTC.
