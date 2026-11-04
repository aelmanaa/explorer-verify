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

The table is `src/routing/table.json` in the package. In this release it lists 94 chains, each with
Sourcify only, the one backend with a client. A chain has a row when
[Sourcify's chain list](https://sourcify.dev/server/chains) marks it as supported and it is in the
[Etherscan chainlist](https://api.etherscan.io/v2/chainlist) or in the verifier table this library
started from. Both lists were read on 2026-11-03.

The rows include Ethereum Mainnet (1), Ethereum Sepolia (11155111), Avalanche Fuji (43113) and
C-Chain (43114), Polygon Amoy (80002), Base Sepolia (84532) and Arbitrum Sepolia (421614). To see
whether a chain has a row, search `table.json` for its chain id. A later release adds the Etherscan
v2 and Routescan entries, as their clients land. Until then, verify on a chain without a row with
`allowSourcifyFallback: true`.

The rows are the list under the table's top-level `chains` key. Each row holds the chain id and its
backends, in order of preference. An entry holds the backend
name and only what varies per chain:

```json
{
  "chainId": 43113,
  "backends": [{ "backend": "routescan", "network": "testnet" }, { "backend": "sourcify" }]
}
```

| Field      | Meaning                                                                            |
| ---------- | ---------------------------------------------------------------------------------- |
| `chainId`  | The EVM chain id. Rows are in ascending order, one per chain                       |
| `backends` | The chain's backends, in order of preference. A chain with no backend has no row   |
| `backend`  | A name in `BACKEND_NAMES`                                                          |
| `network`  | `routescan` only, required: `mainnet` or `testnet`                                 |
| `explorer` | `etherscan-v2` only, optional: the explorer's host, such as `sepolia.etherscan.io` |

The table also has `schemaVersion`, 2, and `checked`, the date its rows were last checked.

The library derives every URL from the entry:

| Backend        | API base                                                                     | Contract page                                                           |
| -------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `sourcify`     | `https://sourcify.dev/server`                                                | `https://repo.sourcify.dev/<chain id>/<address>`                        |
| `etherscan-v2` | `https://api.etherscan.io/v2/api`                                            | `https://<explorer>/address/<address>#code`, or none without `explorer` |
| `routescan`    | `https://api.routescan.io/v2/network/<network>/evm/<chain id>/etherscan/api` | None yet                                                                |

A chain without a row that goes to Sourcify through `allowSourcifyFallback` gets the same Sourcify
page. `<address>` is the address in lower case, as `verify()` uses it (see
[verify](verify.md)), and percent-encoded. The EIP-55 checksum is not checked.

The unit tests check every row: the fields of each backend, the backend names, the date, and the
API host and path of each derived URL. The table decides which hosts receive a key, so a malformed
row fails CI.

## Request URLs

- Etherscan v2 serves every chain from one URL. The route adds `chainid=<chain id>` to the query
  of every Etherscan v2 request, in one place. A `chainid` in the query of your `route.apiUrl`, in
  any letter case, is dropped, so a request never goes to another chain than the call's.
- Routescan URLs hold the network and the chain id in the path, so the route adds no query.

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
