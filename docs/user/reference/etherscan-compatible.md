# Etherscan-compatible explorers

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who verify on an explorer that serves Etherscan's API on its own
host, and who need to know what explorer-verify sends there and how it reads each answer.

Some chains have an explorer that serves Etherscan's API from its own host, for that one chain,
with its own key. The `etherscan-compatible` backend talks to such an explorer. It is the
[Etherscan](etherscan.md) client with these differences:

- The API URL comes from the routing table's row for the chain, or from `route.apiUrl`.
- No request sends a `chainid` parameter, because the host serves one chain.
- A key comes only from `route.apiKey` and goes only to the route's host.
- A lookup or a status request without a key is a GET.
- A lookup answered with an empty `result` list means "not verified".

[verify()](verify.md), [checkStatus()](check-status.md), [dry runs](verify.md#dry-run) and
[`verifyEach()`](verify.md#several-backends-in-one-call) use this client, with the routing
table's entry or with `route.apiUrl`. [`linkProxy()`](../guides/verify-a-proxy.md) uses it only
with `route.apiUrl`: on a chain whose row lists a
standalone explorer, it throws [`invalid-input`](errors/invalid-input.md) naming `route.backend`
before any request, because no standalone explorer's proxy answers have been recorded and
Bitlayer refuses the POSTs a link request sends.

## Route a call to the explorer

The routing table lists one standalone explorer in this release: Bitlayer (200901), at
`https://api.btrscan.com/scan/api`. A call on that chain goes there with no route option, and a
result carries `https://www.btrscan.com/address/<address>#code`
([Routing](routing.md#standalone-etherscan-compatible-entries)).

<!-- no-run: a live call to Bitlayer; the tests run the same call against a fake fetch. -->

```ts no-run
import { verify } from "explorer-verify";

const result = await verify({ ...input, chainId: 200901 });
console.log(`${result.status} ${result.backend}`);
```

For any other explorer, set `route.backend` to `etherscan-compatible` and `route.apiUrl` to its
API URL ([Routing](routing.md#route)). With `route.backend` alone, on a chain whose row lists no
standalone explorer, the call throws [`unsupported-chain`](errors/unsupported-chain.md) before any
request.

<!-- no-run: a live call to a placeholder host; the tests run the same call against a local fake explorer. -->

```ts no-run
import { verify } from "explorer-verify";

const result = await verify(input, {
  route: {
    backend: "etherscan-compatible",
    apiUrl: "https://explorer.example.org/api",
    apiKey: explorerKey,
  },
});
console.log(`${result.status} ${result.backend}`);
```

A result through `route.apiUrl` has no `explorerUrl`, because the library does not know the
explorer's page format ([verify()](verify.md)).

From the CLI, pass `--backend etherscan-compatible --api-url <url>`, and the key with
`--api-key-file <path>` or `--api-key-stdin` ([CLI](cli.md)). On a chain whose row lists a
standalone explorer, `--api-url` can be left out; a key then needs an entry with `needsKey`.

## API key

Pass the key as `route.apiKey`, next to `route.apiUrl`. On a chain whose row lists a standalone
explorer with `needsKey: true`, `route: { backend: "etherscan-compatible", apiKey }` without
`apiUrl` binds the key to the row's host; no entry in this release has `needsKey`. For an entry
without it, such as Bitlayer's, that form throws [`invalid-input`](errors/invalid-input.md)
naming `route.apiKey` before any request: a keyed lookup is a form POST, which Bitlayer refuses.
The key goes in the `apikey` field of the form body, never in the URL or a header, and only to
the route's origin ([API keys](api-keys.md#routeapikey)).

- `apiKeys["etherscan-compatible"]` throws [`invalid-input`](errors/invalid-input.md): each such
  explorer has its own host, so no single host can be bound to that entry.
- A key in `apiKeys` for another backend, such as `etherscan-v2`, is never sent to the explorer.
- Without `route.apiKey`, requests go out with no key. For an explorer you reach through
  `route.apiUrl`, the library does not check for a missing key before the call, because some
  explorers need none. An explorer that needs one answers `Missing/Invalid API Key`, which throws
  [`missing-api-key`](errors/missing-api-key.md).
- A routing-table entry can say that its explorer needs a key. A call to it without
  `route.apiKey` throws `missing-api-key` before any request, whether `fetch` is set or not. No
  entry in this release says so: Bitlayer answers without a key.

The form-body placement follows Etherscan's, which was confirmed live on 2026-11-03. It has not
been confirmed on a standalone explorer.

## Requests

The submit is `POST <apiUrl>` with a form-encoded body (`application/x-www-form-urlencoded`):
`module=contract`, the action, its fields and, with `route.apiKey`, `apikey`. A lookup and a
status request without a key are `GET <apiUrl>?module=contract&action=...` with the fields in the
query; Bitlayer refuses a lookup sent as a POST (live, 2026-11-05). With `route.apiKey`, they are
form POSTs too, so the key stays out of the URL. A query string in your `route.apiUrl` is kept as
you wrote it, before the fields.

A GET carries no cache-busting parameter, as the Routescan client's does. If a caching proxy sits
in front of the host of your `route.apiUrl`, it could answer a status request with an old
`Pending in queue`; send such requests past the cache.

| Step   | `action`            | Fields                                    | Sends                                                        |
| ------ | ------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| Lookup | `getsourcecode`     | `address`                                 | Nothing. Safe to repeat                                      |
| Submit | `verifysourcecode`  | as for [Etherscan](etherscan.md#requests) | The source. Outward and permanent: the explorer publishes it |
| Status | `checkverifystatus` | `guid`, the job id from the submit        | Nothing. Safe to repeat                                      |

## How answers are read

The client reads each answer as the [Etherscan](etherscan.md#how-answers-are-read) client does,
and names `etherscan-compatible` in `details.backend`. One more answer means "not verified": a
lookup with `"status":"1"` and an empty `result` list, as Bitlayer answers for an address with no
verified source. An answer that neither table lists throws an error. It never reads as "not
verified", as `failed` or as success.

Bitlayer's answers to a submit of a deployed contract and to the status of a real job have not
been recorded. An answer that differs from Etherscan's throws
[`unexpected-response`](errors/unexpected-response.md).

One answer needs care. Etherscan's former per-chain hosts, such as
`https://api-sepolia.basescan.org/api`, still answer, with HTTP 200 and
`You are using a deprecated V1 endpoint, switch to Etherscan API V2` (live, 2026-11-04). That
answer means the route points at a retired Etherscan host. It throws
[`unexpected-response`](errors/unexpected-response.md) with the hint
`Use the etherscan-v2 backend without route.apiUrl.` ([Etherscan](etherscan.md)).

## Behaviour to know

- The routing table lists a standalone explorer only when its API answered a recorded keyless
  probe: Bitlayer (200901) in this release. Core (1116) and Kaia (8217), which Foundry's chain list
  names, refused a request without a key and have no entry; reach them with `route.apiUrl` and
  `route.apiKey`. The verifier table this library started from listed 12 such API hosts; on
  2026-11-03 and again on 2026-11-04, 10 did not resolve in DNS, one answered HTTP 404 and one
  redirected to a host that does not resolve. For another explorer, find the API URL in its own
  documentation.
- A lookup reports `partial` only when the explorer's `getsourcecode` answer has a `SimilarMatch`
  field that names a contract, as Etherscan's does.
