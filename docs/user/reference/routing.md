# Routing

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who need to know which explorer a call goes to, and how to change
it.

Every `verify()` and `checkStatus()` call resolves a route before it sends anything: the backend,
its API URL and the public page of the contract. The route comes from the routing table shipped
with the package and from the call's options, never from a handle or from an explorer's answer.

## How a chain resolves

Without `route.apiUrl`:

1. The routing table has a row for the chain: the call goes to the row's first backend that works
   with the keys you passed. A backend that needs a key is skipped when `apiKeys` has none for it.
   Only `etherscan-v2` needs a key; Routescan and Sourcify do not. When no backend in the row works
   without a key, the call takes the first one, and fails with `missing-api-key` before it sends a
   request.
2. `route.backend` picks another backend that the row lists. A backend the row does not list
   throws `unsupported-chain` naming the chain and the backend.
3. The chain has no row: with `allowSourcifyFallback: true`, the call goes to the public Sourcify
   API. Without it, the call throws `unsupported-chain` before any request. Its hint names
   `allowSourcifyFallback` and the `route` override.

With `route.apiUrl`, the call goes to that URL, for any chain, with or without a row. The backend
is `route.backend`, or `sourcify` when you leave it out. See [`route`](#route) below.

The result's `backend` and the `verify.routed` event name the backend the call used.

## The routing table

The table is `src/routing/table.json` in the package. In this release it lists five chains, each
with Sourcify only, checked against [Sourcify's chain list](https://sourcify.dev/server/chains) on
2026-11-03:

| Chain id | Chain                    | Backends |
| -------- | ------------------------ | -------- |
| 1        | Ethereum Mainnet         | sourcify |
| 43113    | Avalanche Fuji Testnet   | sourcify |
| 84532    | Base Sepolia Testnet     | sourcify |
| 421614   | Arbitrum Sepolia Testnet | sourcify |
| 11155111 | Ethereum Sepolia Testnet | sourcify |

A later release adds the other chains and the Etherscan v2 and Routescan entries, as their
clients land. Until then, verify on another chain with `allowSourcifyFallback: true`.

Each row has this shape:

```json
{
  "chainId": 43113,
  "name": "Avalanche Fuji Testnet",
  "checked": "2026-11-03",
  "backends": [
    {
      "backend": "routescan",
      "apiUrl": "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api",
      "explorerUrl": "https://routescan.io/address/{address}?chainid=43113"
    },
    {
      "backend": "sourcify",
      "apiUrl": "https://sourcify.dev/server",
      "explorerUrl": "https://repo.sourcify.dev/43113/{address}"
    }
  ]
}
```

| Field         | Meaning                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `chainId`     | The EVM chain id. Rows are in ascending order, one per chain                                                                             |
| `name`        | The chain's name, for people                                                                                                             |
| `checked`     | The date the row was last checked against its sources                                                                                    |
| `backends`    | The chain's backends, in order of preference. A chain with no backend has no row                                                         |
| `backend`     | A name in `BACKEND_NAMES`                                                                                                                |
| `apiUrl`      | The full API base for this backend and chain: `https:`, no query string, no trailing slash. For Routescan it holds the network and chain |
| `explorerUrl` | The public page of a contract, with one `{address}` token                                                                                |

The table also has `schemaVersion`, 1, and `checked`, the date of its newest row.

The unit tests check every row: the backend names, the dates, and the API host and path of each
backend. `etherscan-v2` must be `https://api.etherscan.io/v2/api`; `routescan` must be
`https://api.routescan.io/v2/network/<mainnet or testnet>/evm/<the row's chain id>/etherscan/api`;
`sourcify` must be `https://sourcify.dev/server`. The table decides which hosts receive a key, so
a malformed row fails CI.

## Request URLs

- Etherscan v2 serves every chain from one URL. The route adds `chainid=<chain id>` to the query
  of every Etherscan v2 request, in one place. A `chainid` in the query of your `route.apiUrl`, in
  any letter case, is dropped, so a request never goes to another chain than the call's.
- Routescan URLs hold the network and the chain id, so the route uses the row's URL as it is.

## Options

### `allowSourcifyFallback`

`VerifyOptions.allowSourcifyFallback` lets a chain that the table does not list go to the public
Sourcify API. It defaults to `false`. A value that is not a boolean throws `invalid-input`. It has
no effect on a chain the table lists.

```ts
import { verify } from "explorer-verify";

const result = await verify(input, { allowSourcifyFallback: true });
```

### `route`

`VerifyOptions.route` is `{ backend?, apiUrl?, apiKey? }`:

- `backend` without `apiUrl` picks a backend from the chain's row. A backend this version has no
  client for throws `invalid-input` naming `route.backend`, and the hint lists the backends it has.
  In this release that is `sourcify`.
- `apiUrl` sends the call to another server, such as a self-hosted Sourcify server or a local fake
  in tests. It must be `https:`, or `http:` on `localhost`, `127.0.0.1` or `[::1]`, with no user
  name, password or fragment. A query string is sent with every request and shown as `?REDACTED`
  in logs. Results have no `explorerUrl` unless `apiUrl` is the table's own URL for the backend
  and chain.
- `apiKey` is the key for the server at `apiUrl`, and needs `apiUrl` next to it. See
  [API keys](api-keys.md).

## Keys and hosts

A key from `apiKeys` goes only to the host the routing table lists for the route's backend and
chain, over `https:` on the default port, and only when the route comes from the table. A route
whose `apiUrl` you set gets no key from `apiKeys`, even when it names the table's own host: pass
`route.apiKey` for it. [API keys](api-keys.md) has the full rule.

## Resuming

`checkStatus()` resolves the route again from the handle's chain id and its options. A handle never
names a host. Pass the same `route`, `apiKeys` and `allowSourcifyFallback` the submission used, so
the route resolves to the same backend. When it resolves to another backend than the handle names,
`checkStatus()` throws `invalid-input` naming `backend` and sends nothing.

## Errors

| Code                | When                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `unsupported-chain` | The chain has no row and `allowSourcifyFallback` is not set. `details.backend` is `sourcify`                 |
| `unsupported-chain` | `route.backend` names a backend that the chain's row does not list. `details.backend` names it               |
| `unsupported-chain` | The table chose a backend this version has no client for. `details.backend` names it                         |
| `unsupported-chain` | The explorer answered that it does not serve the chain                                                       |
| `invalid-input`     | `route`, `route.backend`, `route.apiUrl`, `route.apiKey` or `allowSourcifyFallback` is invalid               |
| `missing-api-key`   | The route's backend needs a key, none is bound to its host, and `fetch` is not set ([API keys](api-keys.md)) |

Each is thrown before any request, except the explorer's own answer. See
[unsupported-chain](errors/unsupported-chain.md).
