# API keys

Version: explorer-verify 0.2.1

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who pass an explorer API key to `verify()` or `checkStatus()`.

explorer-verify takes explorer API keys as call options, never from the environment. This page
says which option holds each key, which host it goes to, and what happens without one.

| Backend                | Option                         | Needed           |
| ---------------------- | ------------------------------ | ---------------- |
| `etherscan-v2`         | `apiKeys["etherscan-v2"]`      | Yes              |
| `routescan`            | `apiKeys.routescan`            | No: keyless tier |
| `blockscout-hosted`    | `apiKeys["blockscout-hosted"]` | Yes              |
| `etherscan-compatible` | `route.apiKey`                 | Per explorer     |
| `sourcify`             | None                           | No               |
| `blockscout`           | None                           | No               |

> [!IMPORTANT]
> Never ship an Etherscan key to a browser. In a browser, set `handlerUrl` to your
> [server handler](server-handler.md#point-the-client-at-it), which holds the key
> ([A server adds the key](#a-server-adds-the-key)).

## Get an Etherscan key

1. Create a free account at <https://etherscan.io/register>.
2. Open the API dashboard at <https://etherscan.io/apidashboard> and select **Add**.
3. Copy the key into a secret store or an environment variable on your server.

One key covers every chain of Etherscan API v2. Free plans reach most chains; the
[Etherscan plan rule](#etherscan-plan-rule) says which plan a use needs.

## A minimal call

The routing table lists Etherscan v2 for the 55 chains of the Etherscan chainlist
([Routing](routing.md#etherscan-rows-and-paid-plans)). This server script passes the Etherscan key
for the sample request, [greeter-sepolia.json](../start/greeter-sepolia.json):

```ts [with-key.ts]
import { readFile } from "node:fs/promises";

import { validateInput, verify } from "explorer-verify";

const text = await readFile("greeter-sepolia.json", "utf8");
const input = validateInput(JSON.parse(text));
const result = await verify(input, {
  apiKeys: { "etherscan-v2": etherscanKey },
});
console.log(`${result.status} ${result.backend}`);
```

```text
already-verified etherscan-v2
```

Without the key, the same call goes to Sourcify and sends no key. On the 10 chains that need a
paid Etherscan plan, Sourcify comes first even with a key. With a paid plan, add
`route: { backend: "etherscan-v2" }`.

A key in `apiKeys` takes effect where the routing table lists its backend for the chain. The table
lists Routescan for 38 chains ([Routing](routing.md#routescan-entries)). A standalone explorer's
key never comes from `apiKeys`.

## `apiKeys`

`VerifyOptions.apiKeys` holds one key per backend name. Its type, exported as `KeyedBackendName`,
accepts only `etherscan-v2`, `routescan` and `blockscout-hosted`. So
`apiKeys: { sourcify: "..." }` does not compile, and from JavaScript it throws `invalid-input`.

Each key goes to one host, never in a URL:

| Backend             | Host                 | Where in the request                   |
| ------------------- | -------------------- | -------------------------------------- |
| `etherscan-v2`      | `api.etherscan.io`   | `apikey` field of a form-encoded POST  |
| `routescan`         | `api.routescan.io`   | `apikey` request header                |
| `blockscout-hosted` | `api.blockscout.com` | `authorization` header, `Bearer <key>` |

Why each placement:

- Etherscan ignores a key in a request header and answers as if no key was sent. So the library
  puts it in the form body, with `chainid` in the query.
- Routescan reads a key in the `apikey` header. It does not refuse a key it does not know, but
  answers on the keyless tier ([Routescan](routescan.md#api-key)).
- Blockscout's hosted API reads a key from the header, a form field or the query. The lookup is a
  GET, which has no body, and a query would put the key in a URL
  ([The hosted API](blockscout.md#the-hosted-api)).

## When a key goes with a request

A key goes with a request only when all of these hold:

- The call's route resolves to that backend. For `checkStatus()`, the handle's backend must also
  be the route's backend; otherwise the call throws `invalid-input` and sends nothing.
- The request goes to `https://` and the backend's host in the table above, on the default port.
- The chain's routing table row lists that backend, and no `route.apiUrl` is set. The one
  exception is [Etherscan's own API as `route.apiUrl`](#etherscans-own-api-as-routeapiurl).

So configuration that moves the API to another server cannot take the key with it.

### Etherscan's own API as `route.apiUrl`

A route with `backend: "etherscan-v2"` and an `apiUrl` on Etherscan's own API takes
`apiKeys["etherscan-v2"]`, as a route from the routing table does. The key still goes only to
`api.etherscan.io`. The library compares the origin of `apiUrl` with `https://api.etherscan.io`
after it lower-cases the host and removes a trailing dot on the host and the default port `:443`.
Trailing slashes on the path are removed too. These values all take the key:

```text
https://api.etherscan.io/v2/api
https://api.etherscan.io/v2/api/
https://API.ETHERSCAN.IO/v2/api
https://api.etherscan.io:443/v2/api
```

Any other host gets no key from `apiKeys`:

| `route.apiUrl`                                | Key from `apiKeys` |
| --------------------------------------------- | ------------------ |
| `https://api.etherscan.io.example.org/v2/api` | No                 |
| `https://api.etherscan.io:8443/v2/api`        | No                 |
| A `routescan` route on `api.routescan.io`     | No                 |
| A `blockscout-hosted` route on its own host   | No                 |

Without `route.apiKey`, such an Etherscan call throws
[`missing-api-key`](errors/missing-api-key.md) before any request. For `routescan` and
`blockscout-hosted` routes with `apiUrl`, pass `route.apiKey`.

With `handlerUrl`, a route on Etherscan's own API goes to your server handler. A key in `apiKeys`
or `route.apiKey` for it then throws `invalid-input`
([A server adds the key](#a-server-adds-the-key)).

## Allowed key values

A key is a string of 8 to 1024 characters. Each character is a letter, a digit, `.`, `_`, `~` or
`-`. Etherscan keys and UUID-style keys fit. For a test or an example, any made-up value works,
such as `dummy-key-0001`.

These values throw `invalid-input` naming `apiKeys.<backend>`, without the value:

- Other characters, such as `&`, `<`, `"`, `/` or a non-ASCII letter. An explorer could send
  them back escaped, in a form that redaction does not match.
- A value that is all digits.
- A value found in the contract address or in the handle's `ev1:<backend>:<chainId>:<address>`
  part. Removing it would corrupt that text.

An `undefined` value counts as absent.

A field that is not a backend name is counted in an `apiKeys` issue and never named, because the
name could be a key. Only the object's own enumerable string-keyed properties are read, each once.
A non-enumerable property or a Symbol key is ignored. The object must be a plain object.

## `route.apiKey`

A standalone Etherscan-compatible explorer has its own host and its own key, so `apiKeys` cannot
bind its key to one host. Pass that key as `route.apiKey`, next to the explorer's `apiUrl`
([Etherscan-compatible](etherscan-compatible.md)):

```ts [options.ts]
import type { VerifyOptions } from "explorer-verify";

export const options: VerifyOptions = {
  route: {
    backend: "etherscan-compatible",
    apiUrl: "https://explorer.example.org/api",
    apiKey: explorerKey,
  },
};
```

When a chain's routing-table row lists a standalone explorer with `needsKey: true`, name the
backend and leave out `apiUrl`. The key is then bound to the host the row lists:

```ts [options.ts]
import type { VerifyOptions } from "explorer-verify";

export const options: VerifyOptions = {
  route: { backend: "etherscan-compatible", apiKey: explorerKey },
};
```

No entry in this release has `needsKey`. Without `apiUrl`, the call throws before any request:

| The chain's row                                        | Error                                              |
| ------------------------------------------------------ | -------------------------------------------------- |
| A standalone explorer that takes no key, as Bitlayer's | [`invalid-input`](errors/invalid-input.md)         |
| No standalone explorer                                 | [`unsupported-chain`](errors/unsupported-chain.md) |

The rules for `route.apiKey`:

- It goes only to the route's host, and only with requests of the route's backend.
- It wins over `apiKeys` for that backend.
- For `etherscan-v2` and `routescan`, it needs `route.apiUrl` in the same override. Without it,
  the call throws `invalid-input` naming `route.apiKey`. So a key meant for one server never
  reaches the routing table's host for the chain.
- A backend that takes no key, such as `sourcify`, throws `invalid-input` naming `route.apiKey`.
- The [allowed key values](#allowed-key-values) apply.
- For `etherscan-compatible` and `etherscan-v2`, the key goes in the `apikey` field of the form
  body. For Routescan it goes in the `apikey` header.

## A missing key

The call throws [`missing-api-key`](errors/missing-api-key.md) before any request when no key is
bound to the route's host and its backend needs one:

- `etherscan-v2` and `blockscout-hosted` always need one.
- A standalone explorer needs one when its routing-table entry says so. No entry in this release
  does.

The routing table skips Etherscan for a call without its key. So this happens when
`route.backend` names `etherscan-v2`, or when `route.apiUrl` points it at another server without
`route.apiKey`.

The message says which option to set. For an `apiUrl` on another host, it says that
`apiKeys.etherscan-v2` goes only to Etherscan's own API, and asks for `route.apiKey`.

An injected `fetch` does not change this. A `fetch` for logging, retries, tests or a proxy still
gets `missing-api-key` before any request. Only `handlerUrl` sends an Etherscan request without a
key ([A server adds the key](#a-server-adds-the-key)).

Explorers answer a key problem with these texts:

| Explorer answer                                         | Error                                            |
| ------------------------------------------------------- | ------------------------------------------------ |
| `Missing/Invalid API Key`                               | [`missing-api-key`](errors/missing-api-key.md)   |
| `Invalid API Key (#err2)`                               | [`api-key-rejected`](errors/api-key-rejected.md) |
| `Max daily rate limit reached`, or a daily submit limit | [`quota-exceeded`](errors/quota-exceeded.md)     |

All three exit with code 3 and are not retryable. `details.backend` names the backend; no error
holds the key. Blockscout's hosted API answers with HTTP 401 and 402 instead; see
[Key answers](blockscout.md#key-answers).

## A server adds the key

In a browser, set `handlerUrl` to your [server handler](server-handler.md), which holds the
Etherscan key and adds it:

<!-- no-run: it posts to /api/verify on the page's own origin, which a test run does not serve. -->

```ts no-run [verify-in-page.ts]
import { validateInput, verify } from "explorer-verify";

import greeter from "./greeter-sepolia.json" with { type: "json" };

const input = validateInput(greeter);
const result = await verify(input, { handlerUrl: "/api/verify" });
console.log(result.status);
```

### Routing with `handlerUrl`

- Each request to Etherscan's v2 API goes to `handlerUrl` instead, with its query, method,
  headers and body, and no key.
- Requests to Sourcify, Blockscout and Routescan go to them directly.
- The routing table chooses as it does with `apiKeys["etherscan-v2"]`. A chain whose row lists
  Etherscan first goes to the handler. A paid-plan chain, or one with no Etherscan entry, goes
  where it would with a key.
- `verifyEach()` with `backends: "all"` keeps `etherscan-v2`.
- Set `route.backend: "etherscan-v2"` to use the handler on any chain with an Etherscan entry.
- A route whose `apiUrl` is on another host keeps that host and its own key rules.
- Requests go through `fetch` when you set it.

### Keys with `handlerUrl`

The call needs no Etherscan key: the handler adds its own. In every function, a dry run included,
these throw `invalid-input`:

- `apiKeys["etherscan-v2"]`;
- a `route.apiKey` for Etherscan's API.

### Refusals from the handler

A refusal from the handler maps to an error code by its `code` and status, as
[the server handler reference](server-handler.md#how-the-client-reads-a-refusal) lists.

- A refusal such as `chain-not-allowed` throws `handler-refused`. It is not retryable, and its
  hint names the `createVerifyHandler` option to change.
- Any other 4xx answer but a 408 or a 429 is not retryable either.
- A 5xx answer stays retryable.

### Allowed `handlerUrl` values

A path such as `/api/verify` resolves against the page, scheme included, so it works only in a
browser page. In Node, a path throws `invalid-input` naming `handlerUrl`. Elsewhere, pass an
absolute URL:

- an `https://` URL;
- an `http://` URL on `localhost`, `127.0.0.1` or `[::1]`;
- no user name, password, query, fragment, whitespace, control character or backslash;
- not on Etherscan's API host;
- at most 2048 characters.

Any other value throws `invalid-input` naming `handlerUrl`.

Log lines, the `verify.routed` event, a dry run's `apiHost` and errors name the handler for the
requests it serves. The handler URL is shown with its path, and it is not redacted. Keep secrets
out of it.

The code that checks `handlerUrl` loads on demand, in a chunk of its own, when a call that sets
it starts. A caller who never sets it never downloads that code.

## Keys in logs, events, errors and results

Every value in `apiKeys`, valid or not, and `route.apiKey` are removed from every log line, event,
error and result, as `[redacted]`, even when an explorer repeats them in an answer. See
[API keys in errors](errors/index.md#api-keys-in-errors).

## From the CLI

The `explorer-verify` command reads keys from these variables, from `--api-key-file <path>` or from
`--api-key-stdin`, and never from a flag value:

| Variable             | Fills                          |
| -------------------- | ------------------------------ |
| `ETHERSCAN_API_KEY`  | `apiKeys["etherscan-v2"]`      |
| `ROUTESCAN_API_KEY`  | `apiKeys.routescan`            |
| `BLOCKSCOUT_API_KEY` | `apiKeys["blockscout-hosted"]` |

A key from `--api-key-file` or `--api-key-stdin` goes where the command line names:

| Flags                                                        | The key fills                                |
| ------------------------------------------------------------ | -------------------------------------------- |
| `--api-url` and a keyed `--backend`                          | `route.apiKey` for that host                 |
| `--backend etherscan-v2`, `routescan` or `blockscout-hosted` | That `apiKeys` entry                         |
| `--backend etherscan-compatible` alone                       | `route.apiKey` for the row's standalone host |

The keyed backends for `--api-url` are `etherscan-v2`, `routescan` and
`etherscan-compatible`.
With `--backend etherscan-compatible` alone, the row's host must have `needsKey`; otherwise the
command exits 2. The rules above then decide which request carries the key. See
[the CLI reference](cli.md#api-keys-and-route-options).

A JSON-RPC endpoint URL often holds a provider key too. The CLI takes it from `--rpc-url-file` or
`--rpc-url-stdin`, and takes `--rpc-url` only for a URL with no part that can hold a key. See
[RPC URL](cli.md#rpc-url).

The library itself reads no environment variable: pass the key in `apiKeys`.

## Etherscan plan rule

| Use                                                        | Plan                        |
| ---------------------------------------------------------- | --------------------------- |
| Personal or research use, such as your own testnet deploys | Free, Lite or Standard      |
| A public dapp, or a business, protocol, foundation or DAO  | Advanced or higher, own key |

A use that displays Etherscan data must show "Powered by Etherscan.io APIs". Etherscan's terms
also forbid exposing a key in client code. This is a reading of the terms, not legal advice.
[Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md) explains the
rule.

Separately, the Etherscan chainlist marks 10 chains "Paid Plan required". The routing table puts
Sourcify first on those chains. A key goes to Etherscan there only when you set `route.backend` to
`etherscan-v2` ([Routing](routing.md#etherscan-rows-and-paid-plans)).

## Sources

- Routescan reading a real key in the `apikey` header, and the hosted Blockscout API reading a key
  from the header, a form field and the query: live runs on 2026-11-05.
- Etherscan's terms: <https://etherscan.io/apiterms>, version of 1 October 2026.
- Creating a key: [Set up your API key](https://docs.etherscan.io/set-up-your-api-key), read
  2026-11-11.
- The 10 chains marked "Paid Plan required":
  [Etherscan chainlist](https://api.etherscan.io/v2/chainlist), read 2026-11-05.
