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

The table is `src/routing/table.json` in the package. In this release it lists 94 chains. Every row
has Sourcify, and the 55 chains of the Etherscan chainlist also have Etherscan v2. The Routescan,
Blockscout and Etherscan-compatible clients have no rows yet; reach them with `route.backend` and
`route.apiUrl`, as [Routescan](routescan.md), [Blockscout](blockscout.md) and
[Etherscan-compatible](etherscan-compatible.md) show. A chain has a row when
[Sourcify's chain list](https://sourcify.dev/server/chains) marks it as supported and it is in the
[Etherscan chainlist](https://api.etherscan.io/v2/chainlist) or in the verifier table this library
started from. The Etherscan chainlist was read on 2026-11-05 and Sourcify's list on 2026-11-04.

The rows include Ethereum Mainnet (1), Ethereum Sepolia (11155111), Avalanche Fuji (43113) and
C-Chain (43114), Polygon Amoy (80002), Base Sepolia (84532) and Arbitrum Sepolia (421614). To see
whether a chain has a row, search `table.json` for its chain id. A later release adds Routescan
entries. Verify on a chain without a row with `allowSourcifyFallback: true`.

The rows are the list under the table's top-level `chains` key. Each row holds the chain id and its
backends, in order of preference. An entry holds the backend name and only what varies per chain:

```json
{
  "chainId": 11155111,
  "backends": [
    { "backend": "etherscan-v2", "explorer": "sepolia.etherscan.io" },
    { "backend": "sourcify" }
  ]
}
```

| Field      | Meaning                                                                                |
| ---------- | -------------------------------------------------------------------------------------- |
| `chainId`  | The EVM chain id. Rows are in ascending order, one per chain                           |
| `backends` | The chain's backends, in order of preference. A chain with no backend has no row       |
| `backend`  | A name in `BACKEND_NAMES`                                                              |
| `network`  | `routescan` only, required: `mainnet` or `testnet`                                     |
| `explorer` | `etherscan-v2` only, optional: the explorer's host, such as `sepolia.etherscan.io`     |
| `instance` | `blockscout` only, required: the instance's host, such as `eth-sepolia.blockscout.com` |

The table also has `schemaVersion`, 2, and `checked`, the date its rows were last checked.
`routingTableDate()` returns that date, and the CLI prints it with `explorer-verify --version --json`.

The library derives every URL from the entry:

| Backend        | API base                                                                     | Contract page                                                           |
| -------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `sourcify`     | `https://sourcify.dev/server`                                                | `https://repo.sourcify.dev/<chain id>/<address>`                        |
| `etherscan-v2` | `https://api.etherscan.io/v2/api`                                            | `https://<explorer>/address/<address>#code`, or none without `explorer` |
| `routescan`    | `https://api.routescan.io/v2/network/<network>/evm/<chain id>/etherscan/api` | None yet                                                                |
| `blockscout`   | `https://<instance>/api`                                                     | `https://<instance>/address/<address>?tab=contract`                     |

A chain without a row that goes to Sourcify through `allowSourcifyFallback` gets the same Sourcify
page. `<address>` is the address in lower case, as `verify()` uses it (see
[verify](verify.md)), and percent-encoded. The EIP-55 checksum is not checked.

The unit tests check every row: the fields of each backend, the backend names, the date, and the
API host and path of each derived URL. The table decides which hosts receive a key, so a malformed
row fails CI.

### Etherscan rows and paid plans

Each Etherscan entry names the explorer host the chainlist gives for the chain, so an Etherscan
result has an `explorerUrl`, such as `https://sepolia.etherscan.io/address/<address>#code`.

Etherscan's free tier covers 45 of the 55 chains. On those, Etherscan v2 comes first: a call with
`apiKeys["etherscan-v2"]` goes to `api.etherscan.io` with the key, and a call without it goes to
Sourcify and sends no key.

The other 10 chains need a paid Etherscan plan: 10 (OP Mainnet), 56 (BNB Smart Chain Mainnet), 97
(BNB Smart Chain Testnet), 100 (Gnosis), 4663 (Robinhood Chain), 5042 (Arc Mainnet), 8453 (Base
Mainnet), 43114 (Avalanche C-Chain), 84532 (Base Sepolia) and 11155420 (OP Sepolia). On those, Sourcify comes first, so a free-plan key does not turn a call that Sourcify
serves into an Etherscan refusal. With a paid plan, set `route: { backend: "etherscan-v2" }` and
pass the key in `apiKeys`; from the CLI, pass `--backend etherscan-v2`. The plan rule of
[API keys](api-keys.md#etherscan-plan-rule) is separate from this list and applies to every chain:
a public dapp, or any use by a business, protocol, foundation or DAO, needs an Advanced plan or
higher.

## Request URLs

- Etherscan v2 serves every chain from one URL. The route adds `chainid=<chain id>` to the query
  of every Etherscan v2 request, in one place. A `chainid` in the query of your `route.apiUrl`, in
  any letter case, is dropped, so a request never goes to another chain than the call's.
- Routescan URLs hold the network and the chain id in the path, so the route adds no query.
- A standalone Etherscan-compatible explorer serves one chain, so the route adds no `chainid`. A
  query in your `route.apiUrl` is kept as you wrote it ([Etherscan-compatible](etherscan-compatible.md)).
- A Blockscout instance serves one chain at `<origin>/api`. Its `route.apiUrl` must end in `/api`
  once trailing slashes are removed, or the call throws `invalid-input` naming `route.apiUrl`. The
  client derives the lookup URL, `<apiUrl>/v2/smart-contracts/<address>`, from it, so a path
  before `/api`, as in `https://example.org/explorer/api`, is kept ([Blockscout](blockscout.md)).

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

- `backend` without `apiUrl` picks a backend from the chain's row. Every backend name has a
  client in this release, and one that the row does not list throws `unsupported-chain`.
  No row lists `etherscan-compatible`, so it needs `apiUrl` ([Etherscan-compatible](etherscan-compatible.md)).
- `apiUrl` sends the call to another server, such as a self-hosted Sourcify server or a local fake
  in tests. It must be `https:`, or `http:` on `localhost`, `127.0.0.1` or `[::1]`, with no user
  name, password or fragment. A query string is sent with every request and shown as `?REDACTED`
  in logs. Results have no `explorerUrl` unless `apiUrl` is the table's own URL for the backend
  and chain, such as `https://api.etherscan.io/v2/api` for a chain with an Etherscan row.
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

## Client chunks

Each backend's client is a module of its own. A call loads only the client of the backend its
route resolves to, with a dynamic `import()`, after the input and the options pass their checks.

Vite, Rollup and webpack put each client in a chunk of its own by default, so a page that only
verifies on Sourcify does not download the other clients. esbuild does the same with
`--splitting --format=esm`; without `--splitting`, every client is in the one output file.
[Bundle size](../guides/verify-from-a-browser.md#bundle-size) in the browser guide lists the size
of each client.

The load counts against `timeoutMs`: a client that has not loaded when the budget runs out throws
`timeout`. An abort of `signal` during the load rejects with `signal.reason`. A client that fails
to load, such as a chunk the page cannot fetch, rejects the call with the loader's error, before
any request to an explorer; the next call tries again. A client that loaded is kept, so later
calls on the same backend do not wait for it.

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
