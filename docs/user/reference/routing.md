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
   Only `etherscan-v2` needs a key; Routescan, Blockscout and Sourcify do not. When no backend in the row works
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

The table is `src/routing/table.json` in the package. In this release it lists 325 chains. 288
rows have Sourcify, the 55 chains of the Etherscan chainlist also have Etherscan v2, 111 rows have
a Blockscout instance, 11 of them alone, and 38 rows have Routescan, 25 of them alone. The
Etherscan-compatible client has no rows yet; reach it with `route.backend` and `route.apiUrl`, as
[Etherscan-compatible](etherscan-compatible.md) shows. A chain has a row when
[Sourcify's chain list](https://sourcify.dev/server/chains) marks it as supported, when it is in
the [Etherscan chainlist](https://api.etherscan.io/v2/chainlist), when its Blockscout instance
answered the API, or when Routescan's API serves it. The row has Sourcify when Sourcify supports
the chain, so every chain that Sourcify serves resolves without `allowSourcifyFallback`. A
chainlist chain also has Etherscan v2, and one that Sourcify does not support has Etherscan v2
alone; in this release there is none. Both lists were read on 2026-11-05.

A row lists its backends in this order: Etherscan v2 on a free-tier chain, Sourcify, Blockscout,
Etherscan v2 on a paid-plan chain, then Routescan. A row holds only the backends that serve the
chain.

The rows include Ethereum Mainnet (1), Ethereum Sepolia (11155111), Avalanche Fuji (43113) and
C-Chain (43114), Polygon Amoy (80002), Base Sepolia (84532), Arbitrum Sepolia (421614), ZKsync Era
(324), Scroll (534352), Rootstock (30), Zora (7777777) and Henesys (68414). To see
whether a chain has a row, search `table.json` for its chain id. Verify on a chain without a row
with `allowSourcifyFallback: true`.

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

### Routescan entries

A chain has a Routescan entry when Routescan's API answered for it on 2026-11-05. Routescan's
explorer lists name more chains than its API serves, so each chain they named was sent one keyless
request; 38 answered. The entry holds the network the request used, `mainnet` or `testnet`, and
the API URL is derived from it:

```json
{
  "chainId": 68414,
  "backends": [{ "backend": "routescan", "network": "mainnet" }]
}
```

Routescan comes last in each row, after Sourcify, Blockscout and Etherscan v2:

- On the 25 chains whose row lists only Routescan, such as Henesys (68414), Beam (4337) and Chiliz
  (88888), a call with no option goes to Routescan. Numine (8021) lists Blockscout, then
  Routescan, so a call goes to Blockscout.
- On the other 12, such as Ethereum (1), Sepolia (11155111), Avalanche Fuji (43113) and C-Chain
  (43114), Metis (1088) and Hemi (43111), a call goes to Sourcify, or to Etherscan v2 with an
  Etherscan key where the row lists it first. A Routescan key in `apiKeys` does not change that.
  Pass `route: { backend: "routescan" }`, or `--backend routescan` from the CLI, to use Routescan.

On a chain with a Routescan entry, `route.backend` `routescan` needs no `route.apiUrl`, and a key
in `apiKeys.routescan` goes to `api.routescan.io` ([Routescan](routescan.md#api-key)). A result
from Routescan has no `explorerUrl`.

### Blockscout rows

A chain has a Blockscout entry when its instance answered the API on 2026-11-05, without a key
and without a redirect. The instances come from
[Blockscout's chain registry](https://chains.blockscout.com/api/chains), the list Hardhat's
verify plugin reads, and from Hardhat's built-in chain list. The entry holds the host that
answered: some registry hosts redirect, and the library never follows a redirect, so OP Mainnet
(10) lists `explorer.optimism.io` and Gnosis (100) lists `gnosisscan.io`.

In a row, Blockscout comes after Sourcify, after Etherscan v2 on a free-tier chain, and before
Etherscan v2 on a paid-plan chain and before Routescan. So a call without `route.backend` still goes to Sourcify, or
to Etherscan v2 with a key on a free-tier chain. To verify on Blockscout, name it:

```ts
import { verify } from "explorer-verify";

const result = await verify(input, { route: { backend: "blockscout" } });
if (result.status !== "failed") {
  console.log(result.explorerUrl);
}
```

```text
https://eth-sepolia.blockscout.com/address/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc?tab=contract
```

From the CLI, pass `--backend blockscout`. On the 11 chains where Blockscout is the only backend,
such as Derive Mainnet (957) and Harmony Testnet (1666700000), a call goes to Blockscout by
default.

These listed instances have no entry, from what they answered on 2026-11-05:

- Polygon PoS (137), Robinhood Chain (4663), Arc Mainnet (5042), Base (8453), Immutable zkEVM
  (13371) and its testnet (13473), Arbitrum One (42161) and Arbitrum Sepolia (421614) sent a
  bot-check page (HTTP 403) to Node.js `fetch`.
- KiteAI Mainnet (2366) answered the API request with HTTP 400, Orderly Testnet (4460) with HTTP
  500 and Aurora Testnet (1313161555) with HTTP 404.
- The hosts Hardhat lists for Polygon zkEVM (1101) answered HTTP 404, and those for Linea (59144)
  and Linea Sepolia (59141) redirect to `lineascan.build` and `sepolia.lineascan.build`.

Reach a Blockscout instance without an entry with `route.apiUrl`, as [Blockscout](blockscout.md)
shows.

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

The CLI sets it with `--allow-sourcify-fallback` ([CLI](cli.md#chains-the-routing-table-does-not-list)).

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
