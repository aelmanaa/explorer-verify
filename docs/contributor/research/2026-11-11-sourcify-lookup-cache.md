# 2026-11-11: How old a Sourcify lookup can be

Audience: whoever changes the Sourcify client (`packages/explorer-verify/src/backends/sourcify.ts`).
Assumes [Sourcify v2](2026-11-02-sourcify-v2.md).

This note records how Sourcify's shared cache serves the contract lookup,
`GET /v2/contract/{chainId}/{address}`, and what a client can do about it. The probes come from
issue [#356](https://github.com/aelmanaa/explorer-verify/issues/356), run on 2026-11-11 against
`https://sourcify.dev/server` with a contract verified on Ethereum Sepolia, and from one more probe
with curl 8.7.1 on 2026-11-11 at 17:36 UTC.

## The cached answer

A 200 lookup comes with `cache-control: public,max-age=3600`. A shared cache in front of the server
keeps it for up to an hour and adds an `age` header. A 404 lookup, for a contract that is not
verified, has no `cache-control`.

On 2026-11-11 a submit upgraded contract `0x6c7ff2cf19865fa06523c01bc76dc4c68f16a7b1` on Ethereum
Sepolia from `match` to `exact_match`. The lookup with `?fields=compilation`, which `verify()` sends
(decision 0063), still answered `match` with `age: 2684`, about 44 minutes old. The same lookup
without the query answered `exact_match`, because it was another cache entry.

At 17:36 UTC the same URL answered `exact_match` with `age: 3141` and a `date` of 16:43:41 GMT. The
URL with the address in upper case answered `exact_match` with no `age`. The fixtures
`2026-11-11-lookup-cached-match.json` and `2026-11-11-lookup-fresh-exact-match.json` under
`packages/explorer-verify/test/fixtures/sourcify/` hold the two grades with their headers.

## What a fresh read can use

| Request                                                  | Result                                                |
| -------------------------------------------------------- | ----------------------------------------------------- |
| Same URL from separate clients, 2 s apart                | Same `date`; `age` 20, 22, 24: one shared cache entry |
| Request header `cache-control: no-cache`                 | Same cached answer, same `age`                        |
| Request header `cache-control: max-age=0`                | Same cached answer, same `age`                        |
| An extra query parameter, such as `nocache=x1`           | 400, `customCode` `invalid_parameter`                 |
| `fields=compilation,compilation` or another `fields` set | 200, no `age`: a separate entry                       |
| The address in upper case                                | 200, no `age`: a separate entry                       |
| A 404 lookup (not verified)                              | No `cache-control`                                    |

Sourcify's API docs (https://docs.sourcify.dev/docs/api/) and its OpenAPI spec, version 2.1.0
(https://sourcify.dev/server/api-docs/swagger.json), both fetched on 2026-11-11, say nothing about
caching. The spec lists `fields` and `omit` as the only query parameters of the lookup.

So no request header reaches the shared cache, and the query that the Routescan client varies
(`freshQuery`) gets a 400. A URL that differs only in the order of `fields` or in the address case
works today, but no document promises it.

## The runtime's own cache

`cache: "no-store"` on the `fetch` keeps a browser's HTTP cache from storing the answer and adding a
second hour on top of the shared cache. It does not reach the shared cache. Node.js 24.21.0 keeps
the field on a `Request` (`new Request(url, { cache: "no-store" }).cache` is `"no-store"`, checked
on 2026-11-11). Cloudflare Workers throw "The 'cache' field on 'RequestInitializerDict' is not
implemented" without the `cache_option_enabled` flag, which is the default from compatibility date
2024-11-11 (https://developers.cloudflare.com/workers/configuration/compatibility-flags/, fetched
on 2026-11-11). That flag enables only `no-store`; `no-cache` needs `cache_no_cache_enabled`, the
default from 2025-08-07 (same page). The client therefore sends `no-store` only where a `Request`
built with it keeps it, and only through the platform's `fetch`: an injected `fetch` may refuse a
field it does not know, and it handles caching itself.

The field also changes the request on the wire. The Fetch Standard's HTTP-network-or-cache fetch
appends `Pragma: no-cache` and `Cache-Control: no-cache` to a request whose cache mode is
`no-store` or `reload`, when the request does not hold them already
(https://fetch.spec.whatwg.org/#http-network-or-cache-fetch, Living Standard last updated
2026-10-19, read 2026-11-11). The runtime adds them, not the page, so they are no CORS request
headers and cause no preflight. In this project's browser smoke test on 2026-11-11, the Sourcify
lookup from Node.js 24.21.0 carried both headers, and the Chromium run passed against the
recorded Sourcify CORS answers with no preflight for them.

## What the client does

- It sends the lookup with `cache: "no-store"` through the platform's `fetch`, where the runtime
  keeps the field. An injected `fetch` gets no `cache` field.
- It treats a lookup grade as up to an hour old. A job's answer is newer and wins over it.
- `dryRun()` and the Sourcify reference page say a lookup grade can be up to an hour old.
- A cached `match` of the caller's own contract ends `verify()` as `already-verified`, `partial`,
  until the cache entry expires.
- A cached match of another contract makes `verify()` submit (decision 0063). Sourcify then answers
  409 `already_verified` when the address already has an exact match. The result keeps the other
  contract in `storedContract` with `partial`, and a `warn` line says that contract may be out of
  date.

## Sources

- WHATWG Fetch Standard, [HTTP-network-or-cache fetch](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch),
  Living Standard last updated 2026-10-19, read 2026-11-11: the `Pragma` and `Cache-Control` steps
  for cache mode `no-store`.
- `pnpm run test:browser` on 2026-11-11, Node.js 24.21.0 and Playwright's Chromium headless shell:
  the headers on the lookup, and no preflight for them.

## Sources

- Issue [#356](https://github.com/aelmanaa/explorer-verify/issues/356): the probes of 2026-11-11
  against `https://sourcify.dev/server`, with the cached `match` at `age: 2684` and the table above.
- Sourcify: [API docs](https://docs.sourcify.dev/docs/api/) and the
  [OpenAPI spec 2.1.0](https://sourcify.dev/server/api-docs/swagger.json), read 2026-11-11.
- Cloudflare:
  [compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/),
  the `cache_option_enabled` entry, read 2026-11-11.
- Local run, curl 8.7.1, 2026-11-11, 17:36 UTC: the lookup of
  `0x6c7ff2cf19865fa06523c01bc76dc4c68f16a7b1` on chain 11155111 with `fields=compilation`, with the
  address in lower and in upper case.
- Local run, Node.js 24.21.0, 2026-11-11: `new Request(url, { cache: "no-store" }).cache`.
- The recorded lookup of 2026-11-11T07:42:14Z that answered `match` for the same contract, with the
  `fetch` of Node.js 24.21.0 (the body of `2026-11-11-lookup-cached-match.json`).
