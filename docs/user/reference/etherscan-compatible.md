# Etherscan-compatible explorers

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who verify on an explorer that serves Etherscan's API on its own
host, and who need to know what explorer-verify sends there and how it reads each answer.

Some chains have an explorer that serves Etherscan's API from its own host, for that one chain,
with its own key. The `etherscan-compatible` backend talks to such an explorer.

| Fact         | Value                                                                        |
| ------------ | ---------------------------------------------------------------------------- |
| Server       | The routing table's row for the chain, or `route.apiUrl`                     |
| API key      | Optional, in `route.apiKey` only                                             |
| Chains       | One standalone explorer in the table: Bitlayer (200901)                      |
| Explorer URL | From the row; none through `route.apiUrl`                                    |
| Match type   | [`exact`, or `partial` with a `SimilarMatch`](../explanation/match-types.md) |

It is the [Etherscan](etherscan.md) client with these differences:

- The API URL comes from the routing table's row for the chain, or from `route.apiUrl`.
- No request sends a `chainid` parameter, because the host serves one chain.
- A key comes only from `route.apiKey` and goes only to the route's host.
- A lookup or a status request without a key is a GET.
- A lookup answered with an empty `result` list means "not verified".

## Which calls use it

| Call                                                     | Uses this client                         |
| -------------------------------------------------------- | ---------------------------------------- |
| [verify()](verify.md) and [dry runs](verify.md#dry-run)  | With the table's entry or `route.apiUrl` |
| [checkStatus()](check-status.md)                         | With the table's entry or `route.apiUrl` |
| [`verifyEach()`](verify.md#several-backends-in-one-call) | With the table's entry or `route.apiUrl` |
| [`linkProxy()`](../guides/verify-a-proxy.md)             | Only with `route.apiUrl`                 |

On a chain whose row lists a standalone explorer, `linkProxy()` throws
[`invalid-input`](errors/invalid-input.md) naming `route.backend` before any request. No
standalone explorer's proxy answers have been recorded, and Bitlayer refuses the POSTs a link
request sends.

## Route a call to the explorer

The routing table lists one standalone explorer in this release: Bitlayer (200901), at
`https://api.btrscan.com/scan/api`. A call on that chain goes there with no route option. A result
carries `https://www.btrscan.com/address/<address>#code`
([Routing](routing.md#standalone-etherscan-compatible-entries)).

This script verifies a contract on Bitlayer, from a request in `verify-input.json`:

<!-- no-run: a live call to Bitlayer; the tests run the same call against a fake fetch. -->

```ts no-run [bitlayer.ts]
import { readFile } from "node:fs/promises";

import { validateInput, verify } from "explorer-verify";

const text = await readFile("verify-input.json", "utf8");
const input = validateInput(JSON.parse(text));
const result = await verify({ ...input, chainId: 200901 });
console.log(`${result.status} ${result.backend}`);
```

For any other explorer, set `route.backend` to `etherscan-compatible` and `route.apiUrl` to its
API URL ([Routing](routing.md#route)). With `route.backend` alone, on a chain whose row lists no
standalone explorer, the call throws [`unsupported-chain`](errors/unsupported-chain.md) before any
request.

This script sends the same request to a placeholder explorer, with its key:

<!-- no-run: a live call to a placeholder host; the tests run the same call against a local fake explorer. -->

```ts no-run [other-explorer.ts]
import { readFile } from "node:fs/promises";

import { validateInput, verify } from "explorer-verify";

const text = await readFile("verify-input.json", "utf8");
const input = validateInput(JSON.parse(text));
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

From the CLI, pass `--backend etherscan-compatible --api-url <url>`. Pass the key with
`--api-key-file <path>` or `--api-key-stdin` ([CLI](cli.md)). On a chain whose row lists a
standalone explorer, `--api-url` can be left out; a key then needs an entry with `needsKey`.

## API key

Pass the key as `route.apiKey`, next to `route.apiUrl`.

> [!IMPORTANT]
> The key goes in the `apikey` field of the form body, never in the URL or a header, and only to
> the route's origin ([API keys](api-keys.md#routeapikey)).

| Where the key is                                  | What happens                                                  |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `route.apiKey` with `route.apiUrl`                | Sent to that host                                             |
| `route.apiKey` alone, on a row with `needsKey`    | Bound to the row's host                                       |
| `route.apiKey` alone, on a row without `needsKey` | [`invalid-input`](errors/invalid-input.md) before any request |
| `apiKeys["etherscan-compatible"]`                 | [`invalid-input`](errors/invalid-input.md): no single host    |
| `apiKeys` for another backend                     | Never sent to the explorer                                    |
| None                                              | Requests go out with no key                                   |

No entry in this release has `needsKey`. For an entry without it, such as Bitlayer's, a key alone
throws because a keyed lookup is a form POST, which Bitlayer refuses.

Through `route.apiUrl`, the library does not check for a missing key before the call, because
some explorers need none. An explorer that needs one answers `Missing/Invalid API Key`, which
throws [`missing-api-key`](errors/missing-api-key.md).

A table entry with `needsKey` makes a call without `route.apiKey` throw `missing-api-key` before
any request, whether `fetch` is set or not.

The form-body placement follows Etherscan's. It has not been confirmed on a standalone explorer.

## Requests

The submit is `POST <apiUrl>` with a form-encoded body. The body holds `module=contract`, the
action, its fields and, with `route.apiKey`, `apikey`.

| Request | Without `route.apiKey`         | With `route.apiKey` |
| ------- | ------------------------------ | ------------------- |
| Lookup  | `GET`, the fields in the query | Form POST           |
| Status  | `GET`, the fields in the query | Form POST           |
| Submit  | Form POST                      | Form POST           |

Bitlayer refuses a lookup sent as a POST. A query string in your `route.apiUrl` is kept as you
wrote it, before the fields.

A GET carries no cache-busting parameter, as the Routescan client's does. A caching proxy in front
of your `route.apiUrl` could answer a status request with an old `Pending in queue`. Send such
requests past the cache.

| Step   | `action`            | Fields                                    | Sends                                                        |
| ------ | ------------------- | ----------------------------------------- | ------------------------------------------------------------ |
| Lookup | `getsourcecode`     | `address`                                 | Nothing. Safe to repeat                                      |
| Submit | `verifysourcecode`  | as for [Etherscan](etherscan.md#requests) | The source. Outward and permanent: the explorer publishes it |
| Status | `checkverifystatus` | `guid`, the job id from the submit        | Nothing. Safe to repeat                                      |

## How answers are read

The client reads each answer as the [Etherscan](etherscan.md#how-answers-are-read) client does,
and names `etherscan-compatible` in `details.backend`. One more answer means "not verified": a
lookup with `"status":"1"` and an empty `result` list, as Bitlayer answers for an address with no
verified source.

An answer that neither table lists throws an error. It never reads as "not verified", as `failed`
or as success.

Bitlayer's answers to a submit of a deployed contract and to the status of a real job have not
been recorded. An answer that differs from Etherscan's throws
[`unexpected-response`](errors/unexpected-response.md).

One answer needs care. Etherscan's former per-chain hosts, such as
`https://api-sepolia.basescan.org/api`, still answer with HTTP 200 and
`You are using a deprecated V1 endpoint, switch to Etherscan API V2`. That answer means the route
points at a retired Etherscan host. It throws [`unexpected-response`](errors/unexpected-response.md)
with the hint `Use the etherscan-v2 backend without route.apiUrl.`

## Behaviour to know

- The lookup reads `ContractName` and `CompilerVersion`, as on Etherscan, and `verify()` compares
  them with the input ([Another contract's source](verify.md#another-contracts-source)). An
  explorer whose answer has neither field names no contract: `verify()` then takes its match as
  your source, and logs at `info` that the answer names no contract.
- The routing table lists a standalone explorer only when its API answered a recorded keyless
  probe: Bitlayer (200901) in this release.
- Core (1116) and Kaia (8217), which Foundry's chain list names, refused a request without a key
  and have no entry. Reach them with `route.apiUrl` and `route.apiKey`.
- Of the 12 API hosts in the verifier table this library started from, none answers: 10 do not
  resolve in DNS, one answers HTTP 404, and one redirects to a host that does not resolve. For
  another explorer, find the API URL in its own documentation.
- A lookup reports `partial` only when the explorer's `getsourcecode` answer has a `SimilarMatch`
  field that names a contract, as Etherscan's does.

## Sources

- The key in Etherscan's form body: live run on 2026-11-03.
- The deprecated V1 answer of Etherscan's former per-chain hosts: live run on 2026-11-04.
- Bitlayer refusing a lookup sent as a POST: live run on 2026-11-05.
- The 12 API hosts of the prior verifier table: checked on 2026-11-03 and 2026-11-04.
