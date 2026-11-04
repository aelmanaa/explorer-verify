# Etherscan-compatible explorers

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who verify on an explorer that serves Etherscan's API on its own
host, and who need to know what explorer-verify sends there and how it reads each answer.

Some chains have an explorer that serves Etherscan's API from its own host, for that one chain,
with its own key. The `etherscan-compatible` backend talks to such an explorer. It is the
[Etherscan](etherscan.md) client with three differences:

- The API URL is the one you pass as `route.apiUrl`.
- No request sends a `chainid` parameter, because the host serves one chain.
- A key comes only from `route.apiKey` and goes only to the host of `route.apiUrl`.

[verify()](verify.md) and [checkStatus()](check-status.md) use this client.

## Route a call to the explorer

The routing table lists no standalone explorer, so a call reaches one only through `route.backend`
`etherscan-compatible` with `route.apiUrl` set to the explorer's API URL
([Routing](routing.md#route)). Without `route.apiUrl`, the call throws
[`unsupported-chain`](errors/unsupported-chain.md) before any request.

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

A result has no `explorerUrl`, because the library does not know the explorer's page format
([verify()](verify.md)).

From the CLI, pass `--backend etherscan-compatible --api-url <url>`, and the key with
`--api-key-file <path>` or `--api-key-stdin` ([CLI](cli.md)).

## API key

Pass the key as `route.apiKey`, next to `route.apiUrl`. It goes in the `apikey` field of the form
body, never in the URL or a header, and only to the origin of `route.apiUrl`
([API keys](api-keys.md#routeapikey)).

- `apiKeys["etherscan-compatible"]` throws [`invalid-input`](errors/invalid-input.md): each such
  explorer has its own host, so no single host can be bound to that entry.
- A key in `apiKeys` for another backend, such as `etherscan-v2`, is never sent to the explorer.
- Without `route.apiKey`, requests go out with no key. The library does not check for a missing
  key before the call, because some explorers need none. An explorer that needs one answers
  `Missing/Invalid API Key`, which throws [`missing-api-key`](errors/missing-api-key.md).

The form-body placement follows Etherscan's, which was confirmed live on 2026-11-03. It has not
been confirmed on a standalone explorer: none answered on 2026-11-03 or 2026-11-04.

## Requests

Every request is `POST <apiUrl>` with a form-encoded body (`application/x-www-form-urlencoded`):
`module=contract`, the action, its fields and, with `route.apiKey`, `apikey`. A query string in
your `route.apiUrl` is kept as you wrote it.

| Step   | `action`            | Fields                                    | Sends                                                        |
| ------ | ------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| Lookup | `getsourcecode`     | `address`                                 | Nothing. Safe to repeat                                      |
| Submit | `verifysourcecode`  | as for [Etherscan](etherscan.md#requests) | The source. Outward and permanent: the explorer publishes it |
| Status | `checkverifystatus` | `guid`, the job id from the submit        | Nothing. Safe to repeat                                      |

## How answers are read

The client reads each answer as the [Etherscan](etherscan.md#how-answers-are-read) client does,
and names `etherscan-compatible` in `details.backend`. An answer that table does not list throws an
error. It never reads as "not verified", as `failed` or as success.

One answer needs care. Etherscan's former per-chain hosts, such as
`https://api-sepolia.basescan.org/api`, still answer, with HTTP 200 and
`You are using a deprecated V1 endpoint, switch to Etherscan API V2` (live, 2026-11-04). That
answer means the route points at a retired Etherscan host. It throws
[`unexpected-response`](errors/unexpected-response.md) with the hint
`Use the etherscan-v2 backend without route.apiUrl.` ([Etherscan](etherscan.md)).

## Behaviour to know

- The library ships no list of standalone explorers. The verifier table it started from listed 12
  such API hosts; on 2026-11-03 and again on 2026-11-04, 10 did not resolve in DNS, one answered
  HTTP 404 and one redirected to a host that does not resolve. Find the API URL in your explorer's
  own documentation.
- A lookup reports `partial` only when the explorer's `getsourcecode` answer has a `SimilarMatch`
  field that names a contract, as Etherscan's does.
