# 2026-11-04: the standalone Etherscan-compatible client

Audience: whoever changes the standalone client
(`packages/explorer-verify/src/backends/etherscan-compatible.ts`) or adds a standalone row to the
routing table. Assumes the [Etherscan client note](2026-11-04-etherscan-client.md), the
[routing table note](2026-11-03-routing-table.md) and
[decision 0016](../decisions/0016-api-keys-bound-to-hosts.md).

This note records why the client is the Etherscan client with three differences, what was checked
live, and what could not be.

## The 12 prior-art hosts, checked again

The verifier table this library started from lists 12 standalone API hosts
([prior art](../prior-art.md)). The [routing table note](2026-11-03-routing-table.md#corrections)
gives each host's result on 2026-11-03. On 2026-11-04 each was checked again with `dig +short A`
and one keyless `GET <api>?module=contract&action=getsourcecode&address=0x…01` (curl 8.7.1,
2026-11-04T12:53Z). The results match those of 2026-11-03:

- 10 hosts have no A record, and curl fails to resolve them (exit 6).
- `api-testnet.btrscan.com` (200810) resolves and answers HTTP 404.
- `api-sepolia.scrollscan.dev` (534351) resolves and answers HTTP 301 to
  `api-sepolia.scrollscan.com`, which has no A record.

No standalone host answered, so the routing table gets no `etherscan-compatible` row, and the
client was not run against a live standalone explorer. Searching for other hosts by guessing from
explorer names is out of scope (issue #63).

## A retired Etherscan host

Etherscan's former per-chain API hosts still resolve and answer. One keyless `getsourcecode`
request, sent as the client sends it (a form-encoded POST without `chainid`), to
`https://api-sepolia.basescan.org/api` got HTTP 200 and this body (Node.js 24.21.0 `fetch`,
2026-11-04T12:53:38Z):

```json
{
  "status": "0",
  "message": "NOTOK",
  "result": "You are using a deprecated V1 endpoint, switch to Etherscan API V2 using https://docs.etherscan.io/v2-migration"
}
```

It is saved as
`packages/explorer-verify/test/fixtures/etherscan-compatible/2026-11-04-getsourcecode-retired-host-keyless.json`.
The same text came from `api.etherscan.io/api`, `api.basescan.org/api` and `api.celoscan.io/api` on
2026-11-03 ([issue #63](https://github.com/aelmanaa/explorer-verify/issues/63)), and from
`api.etherscan.io/api` on 2026-11-04 ([Etherscan client note](2026-11-04-etherscan-client.md)). A route override that names one of
these hosts as a standalone explorer is a likely mistake, so the answer throws
`unexpected-response` with the hint `Use the etherscan-v2 backend without route.apiUrl.`, kept
short for the `index` size ceiling. It is never read as `failed` or "not verified" (R-FLOW-4).

## Design

- Same answers as Etherscan. A standalone explorer is defined by serving Etherscan's request
  format (R-BE-2), so the client is built by `etherscanStyle` and reads each `result` text as the
  Etherscan client does. No standalone explorer could be probed, so no answer specific to one is
  mapped.
- Requests. Every call is a form-encoded POST to `route.apiUrl`, as for Etherscan, with no
  `chainid`: the route adds `chainid` only for `etherscan-v2`. A lookup and a status request are
  POSTs too, so a key always travels in the body.
- Key. Only `route.apiKey`, in the `apikey` form field (decision 0016). The form-body placement
  works on Etherscan (live, 2026-11-03, [key placement](2026-11-03-api-key-placement.md)). It is
  not confirmed on a standalone explorer.
- No missing-key check before the call: some explorers need no key, so only an answer of
  `Missing/Invalid API Key` throws `missing-api-key`.
- No routing template. The routing table has no `etherscan-compatible` entry format yet; the first
  row that a live host earns adds one, with its host rule.

## Size

Measured with `pnpm run size` (esbuild 0.28.2, Node 24.21.0 zlib) on 2026-11-04, on main at
afac930 with this change. Since #136 ([decision 0031](../decisions/0031-clients-load-on-demand-and-chunks-measured-apart.md)),
each client loads with `import()` and is measured as a chunk of its own. The client adds one chunk
and a loader line to the entries. "Before" is the size decision 0031 recorded for #136.

| Entry or chunk               | Before | After  | Ceiling |
| ---------------------------- | ------ | ------ | ------- |
| `verify`                     | 13,611 | 13,693 | 16,334  |
| `verify (one file)`          | 21,663 | 21,804 | 25,996  |
| `verify with table`          | 14,693 | 14,781 | 17,632  |
| `checkStatus`                | 11,730 | 11,813 | 14,076  |
| `index`                      | 21,776 | 21,851 | 26,132  |
| chunk `etherscan-compatible` | none   | 3,285  | 3,942   |

The new chunk's ceiling is its measured size plus 20%, rounded up (decision 0014). It holds the
Etherscan v2 request code it imports, as the `routescan` chunk does. No entry ceiling changes.

## Open questions

- Whether any standalone explorer reads a key from the form body. A row in the routing table, or
  a caller's report, would show it.
- Whether a standalone explorer answers `getsourcecode` and `checkverifystatus` sent as a POST.
  Routescan does not (it answers `Invalid querystring request`,
  [Routescan client note](2026-11-04-routescan-client.md)); Etherscan does.

## Sources

- Etherscan v2 migration notice, linked from the retired host's answer:
  https://docs.etherscan.io/v2-migration (the link as answered on 2026-11-04)
- Issue #63, scope and the 2026-11-03 survey:
  https://github.com/aelmanaa/explorer-verify/issues/63
- Live requests: `dig` and curl 8.7.1, and Node.js 24.21.0 `fetch`, on 2026-11-04, as described
  above.
