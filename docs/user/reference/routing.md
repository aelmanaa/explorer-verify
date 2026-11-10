# Routing

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who need to know which explorer a call goes to, and how to change
it.

Before it sends anything, every `verify()` and `checkStatus()` call resolves a route: the backend,
its API URL and the contract's public page. The route comes from the routing table shipped with
the package and from the call's options, never from a handle or an explorer's answer.

## How a chain resolves

Without `route.apiUrl`, the first rule that applies picks the backend. The `verify.routed` event's
`routedBy` names it:

1. `caller`: `route.backend` is set and the chain's row lists it. A backend the row does not list
   throws `unsupported-chain`.
2. `table`: the row's first backend that works with the keys you passed. A backend that needs a
   key is skipped when `apiKeys` has none for it, and the event's `skipped` lists it.
3. `fallback`: the chain has no row and `allowSourcifyFallback` is `true`, so the call goes to the
   public Sourcify API. Without the option, the call throws `unsupported-chain`.

With `route.apiUrl` (`routedBy: "api-url"`), the call goes to that URL for any chain. The backend
is `route.backend`, or `sourcify` when you leave it out.

Only `etherscan-v2` needs a key, and a standalone Etherscan-compatible entry when its row says so.
When no backend in the row works without a key, the call takes the first one and throws
`missing-api-key` before any request.

> [!NOTE]
> The CLI's `verify` submits only to a backend you name: `--backend <name>`, or `--backend auto`
> for rule 2's pick ([CLI: where verify submits](cli.md#where-verify-submits)).

## `routesFor()`

`routesFor(chainId, { apiKeys, allowSourcifyFallback })` tells where a call without `route` would
go. It reads the table and sends no request. Only whether `apiKeys` holds a key counts. It is
`@experimental`. This script prints Sepolia's backends and the pick without a key:

```ts [routes.ts]
import { routesFor } from "explorer-verify";

const { listed, pick } = await routesFor(11155111);
console.log(listed.join(", "));
if (pick instanceof Error) {
  console.log(pick.message);
} else {
  const skipped = pick.skipped.join(", ") || "none";
  console.log(`${pick.backend} (${pick.routedBy}), skipped: ${skipped}`);
}
```

```text
etherscan-v2, sourcify, blockscout, routescan
sourcify (table), skipped: etherscan-v2
```

`listed` is the row's backends in order, empty without a row. `pick` holds the backend, the rule
and the skipped backends. Its `keyMissing` is true when `verify()` would throw `missing-api-key`. For a
chain without a row and no fallback, `pick` is the `unsupported-chain` error. A chain id that is
not a positive safe integer, or an unknown options key, throws `invalid-input`.

## `allowSourcifyFallback`

`VerifyOptions.allowSourcifyFallback: true` sends a chain the table does not list to the public
Sourcify API. It defaults to `false` and has no effect on a listed chain. From the CLI, pass
`--allow-sourcify-fallback` ([CLI](cli.md#chains-the-routing-table-does-not-list)).

## `route`

`VerifyOptions.route` is `{ backend?, apiUrl?, apiKey? }`:

- `backend` without `apiUrl` picks a backend from the chain's row.
- `apiUrl` sends the call to another server, such as a self-hosted Sourcify or a local fake. It
  must be `https:`. On `localhost`, `127.0.0.1` or `[::1]`, it may be `http:`. It may not hold a user
  name, password or fragment.
- `apiKey` is the key for the server at `apiUrl`, and needs `apiUrl` next to it. The exception is a
  [standalone entry with `needsKey`](#standalone-etherscan-compatible-entries).

A query in `apiUrl` is sent with every request and logged as `?REDACTED`. A result has no
`explorerUrl` unless `apiUrl` is the row's own API URL, such as `https://api.etherscan.io/v2/api`.

`route: { backend: "blockscout-hosted" }` is the one backend no row lists. It goes to
`https://api.blockscout.com/<chainId>/api` for any chain, with `apiKeys["blockscout-hosted"]`
([The hosted API](blockscout.md#the-hosted-api)).

A key from `apiKeys` goes only to the host the table lists for the route, over `https:`. A route
with your own `apiUrl` gets no key from `apiKeys`, except Etherscan's own API: pass `route.apiKey`
([API keys](api-keys.md#etherscans-own-api-as-routeapiurl)).

## Resuming

`checkStatus()` resolves the route again from the handle's chain id and its options; a handle never
names a host. Pass the same `route`, `apiKeys` and `allowSourcifyFallback` as the submission. A
route to another backend than the handle's throws `invalid-input` and sends nothing.

## Request URLs

- **Etherscan v2** serves every chain from one URL. The route adds `chainid=<chain id>` to each
  request and drops any `chainid` in your `route.apiUrl`.
- **Routescan** holds the network and chain id in the path, so the route adds no query.
- **A standalone Etherscan-compatible explorer** serves one chain. The route adds no `chainid` and
  keeps your query ([Etherscan-compatible](etherscan-compatible.md)).
- **Blockscout** serves one chain at `<origin>/api`. A `route.apiUrl` that does not end in `/api`
  throws `invalid-input`. The lookup goes to `<apiUrl>/v2/smart-contracts/<address>`
  ([Blockscout](blockscout.md)).

## Errors

Each is thrown before any request, except the explorer's own answer:

| Code                | When                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `unsupported-chain` | No row and no `allowSourcifyFallback`, or `route.backend` not in the row |
| `unsupported-chain` | The explorer answered that it does not serve the chain                   |
| `invalid-input`     | A `route` field or `allowSourcifyFallback` is invalid                    |
| `missing-api-key`   | The route needs a key, none is bound to its host, and no `fetch` is set  |

`details.backend` names the backend ([unsupported-chain](errors/unsupported-chain.md)).

## The routing table

The table is `src/routing/table.json` in the package. Its `chains` key holds one row per chain. A
row lists the chain's backends in order of preference, and each entry holds only what varies per
chain:

```json
{
  "chainId": 11155111,
  "backends": [
    { "backend": "etherscan-v2", "explorer": "sepolia.etherscan.io" },
    { "backend": "sourcify" }
  ]
}
```

A row holds only the backends that serve the chain, in this order: Etherscan v2 on a free-tier
chain, Sourcify, Blockscout, Etherscan v2 on a paid-plan chain, a standalone Etherscan-compatible
explorer, then Routescan. Every chain Sourcify serves has Sourcify in its row.

To see whether a chain has a row, call [`routesFor()`](#routesfor) or search `table.json` for its
id. `await routingTableDate()` returns the date the rows were checked, and
`npx @explorer-verify/cli --version --json` prints it. An entry may hold these fields:

| Field      | Backend                  | Value                               |
| ---------- | ------------------------ | ----------------------------------- |
| `network`  | `routescan`              | `mainnet` or `testnet`, required    |
| `explorer` | Etherscan v2, compatible | The explorer's host, optional       |
| `instance` | `blockscout`             | The instance's host, required       |
| `api`      | Etherscan-compatible     | The API's host and path, required   |
| `needsKey` | Etherscan-compatible     | `true` if keyless calls are refused |

### URLs derived from an entry

`<address>` is the address in lower case and percent-encoded:

- **`sourcify`**: API `https://sourcify.dev/server`; page
  `https://repo.sourcify.dev/<chain id>/<address>`.
- **`etherscan-v2`**: API `https://api.etherscan.io/v2/api`; page
  `https://<explorer>/address/<address>#code`.
- **`routescan`**: API
  `https://api.routescan.io/v2/network/<network>/evm/<chain id>/etherscan/api`; no page.
- **`blockscout`**: API `https://<instance>/api`; page
  `https://<instance>/address/<address>?tab=contract`.
- **`etherscan-compatible`**: API `https://<api>`; page
  `https://<explorer>/address/<address>#code`.

An entry without `explorer` gives no page. The unit tests check every row and derived URL, so a
malformed row fails CI.

### Etherscan rows and paid plans

On a chain of Etherscan's free tier, Etherscan v2 comes first: a call with
`apiKeys["etherscan-v2"]` goes to Etherscan, and a call without it goes to Sourcify.

These 10 chains need a paid Etherscan plan, so Sourcify comes first:

| Chain id | Chain                   | Chain id | Chain             |
| -------- | ----------------------- | -------- | ----------------- |
| 10       | OP Mainnet              | 5042     | Arc Mainnet       |
| 56       | BNB Smart Chain Mainnet | 8453     | Base Mainnet      |
| 97       | BNB Smart Chain Testnet | 43114    | Avalanche C-Chain |
| 100      | Gnosis                  | 84532    | Base Sepolia      |
| 4663     | Robinhood Chain         | 11155420 | OP Sepolia        |

With a paid plan, set `route: { backend: "etherscan-v2" }`, or `--backend etherscan-v2` in the
CLI. The [plan rule](api-keys.md#etherscan-plan-rule) applies to every chain.

### Routescan entries

Routescan comes last in a row. On a chain with Routescan alone, such as Henesys (68414), a call
with no option goes there. Elsewhere, such as on Sepolia, a Routescan key does not change the pick:
pass `route: { backend: "routescan" }` or `--backend routescan`. A key in `apiKeys.routescan` goes
to `api.routescan.io` ([Routescan](routescan.md#api-key)).

### Blockscout rows

An entry holds the instance host that answered the API without a redirect, such as
`explorer.optimism.io` for OP Mainnet (10). Blockscout comes after Sourcify, so name it to use it.
On a chain with Blockscout alone, such as Derive Mainnet (957), a call goes there by default. This
script verifies the sample Greeter on Blockscout, as `--backend blockscout` does in the CLI:

```ts [blockscout.ts]
import { readFile } from "node:fs/promises";

import { validateInput, verify } from "explorer-verify";

const text = await readFile("greeter-sepolia.json", "utf8");
const input = validateInput(JSON.parse(text));

const result = await verify(input, { route: { backend: "blockscout" } });
if (result.status !== "failed") {
  console.log(result.explorerUrl);
}
```

```text
https://eth-sepolia.blockscout.com/address/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc?tab=contract
```

Reach an instance without an entry with `route.apiUrl` ([Blockscout](blockscout.md)).

### Standalone Etherscan-compatible entries

One chain has one: Bitlayer (200901), with `api` `api.btrscan.com/scan/api` and `explorer`
`www.btrscan.com`. A call on 200901 goes there with no route option.

An entry with `needsKey: true` is skipped by a keyless call when the row lists another backend.
Reached without a key, it throws `missing-api-key`. Pass the key as
`route: { backend: "etherscan-compatible", apiKey }`; it goes only to the entry's host
([API keys](api-keys.md#routeapikey)). `linkProxy()` refuses a standalone entry.

## Client chunks

Each backend's client is a module of its own. A call loads only the client its route needs, with a
dynamic `import()`, after the input and options pass their checks. Bundlers that split code put
each client in its own chunk ([Bundle size](../advanced/bundle-size.md)). For a one-file bundle,
use the [core entry](core.md).

The load counts against `timeoutMs` and stops on an abort. A client that fails to load rejects
with [`network`](errors/network.md#a-module-that-fails-to-load) before any request, and the next
call tries again. A loaded client is kept.

## Table chunk

The rows are a chunk too, loaded the same way. A call without `route.apiUrl` loads them. A call
with one loads them only when the URL may be a row's own API URL: Etherscan's API, or an `https`
URL for `blockscout` or `etherscan-compatible`. A local server or proxy URL loads nothing.

A table that does not load in time throws `timeout`. One that fails to load rejects with
`network`, as a client does.

## Sources

The rows were checked on 2026-11-05. The release lists 326 chains: 288 with Sourcify, 55 with
Etherscan v2 (45 free-tier), 111 with Blockscout, 38 with Routescan and 1 standalone explorer.

- [Sourcify's chain list](https://sourcify.dev/server/chains) and
  [Etherscan's chainlist](https://api.etherscan.io/v2/chainlist), read 2026-11-05.
- [Routescan rows](../../contributor/research/2026-11-05-routescan-rows.md), probed 2026-11-05.
- [Blockscout instances](../../contributor/research/2026-11-05-blockscout-instances.md), probed
  2026-11-05, with the instances left out and why.
- [Etherscan-compatible hosts](../../contributor/research/2026-11-05-etherscan-compatible-hosts.md),
  probed 2026-11-05.
