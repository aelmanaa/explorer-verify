# API keys

<!-- docs-style: legacy -->

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who pass an explorer API key to `verify()` or `checkStatus()`.

The routing table lists Etherscan v2 for the 55 chains of the Etherscan chainlist
([Routing](routing.md#etherscan-rows-and-paid-plans)). Pass your Etherscan key in `apiKeys`:

```ts
import { verify } from "explorer-verify";

// On a server. Never ship an Etherscan key to a browser.
const result = await verify(input, { apiKeys: { "etherscan-v2": etherscanKey } });
console.log(`${result.status} ${result.backend}`);
```

```text
already-verified etherscan-v2
```

Without the key, the same call goes to Sourcify and sends no key. On the 10 chains that need a paid
Etherscan plan, Sourcify comes first even with a key; with a paid plan, add
`route: { backend: "etherscan-v2" }`.

From a browser, keep the key on your server and pass `handlerUrl`, the URL of your
[server handler](server-handler.md#point-the-client-at-it). See [A server adds the key](#a-server-adds-the-key).

The [Routescan](routescan.md) and [Etherscan-compatible](etherscan-compatible.md) clients send
`route.apiKey`. A key in `apiKeys` takes effect where the routing table lists its backend for the
chain: the table lists Routescan for 38 chains ([Routing](routing.md#routescan-entries)). A
standalone explorer's key never comes from `apiKeys`.

## `apiKeys`

`VerifyOptions.apiKeys` holds one key per backend name. Each key goes where this table says, for a
chain whose routing table row lists that backend. A chain whose row lists no Etherscan entry, or a
route whose `apiUrl` you set, gets no key from `apiKeys`, with one exception:
[Etherscan's own API as `route.apiUrl`](#etherscans-own-api-as-routeapiurl).

Its type accepts only `etherscan-v2`, `routescan` and `blockscout-hosted`, exported as
`KeyedBackendName`, so `apiKeys: { sourcify: "..." }` does not compile. From JavaScript, the other
names throw `invalid-input`, as the table says.

| Backend                | Host the key goes to                  | Where in the request                           | Needed                       |
| ---------------------- | ------------------------------------- | ---------------------------------------------- | ---------------------------- |
| `etherscan-v2`         | `api.etherscan.io`                    | The `apikey` field of a form-encoded POST body | Yes, for every request       |
| `routescan`            | `api.routescan.io`                    | The `apikey` request header (see below)        | No: the free tier is keyless |
| `etherscan-compatible` | Not accepted here; use `route.apiKey` | The `apikey` field of a form-encoded POST body | Depends on the explorer      |
| `sourcify`             | Not accepted                          | None                                           | No                           |
| `blockscout-hosted`    | `api.blockscout.com`                  | The `authorization` header, as `Bearer <key>`  | Yes, for every request       |
| `blockscout`           | Not accepted: an instance takes none  | None: no request carries a key                 | No                           |

The key never goes in a URL. Etherscan ignores a key in a request header and answers as if no key
was sent, so the library puts it in the form body, with `chainid` in the query. Routescan reads a
key in the `apikey` header, confirmed live with a real key on 2026-11-05; it does not refuse a key
it does not know, but answers on the keyless tier ([Routescan](routescan.md#api-key)). The
form-body placement for standalone explorers is not confirmed live.

Blockscout's hosted API, the backend `blockscout-hosted`, read a key from the `authorization`
header, from an `apikey` form field and from an `apikey` query parameter on 2026-11-05. The library
uses the header: the lookup is a GET, which has no body, and a query would put the key in a URL
([The hosted API](blockscout.md#the-hosted-api)).

A key goes with a request only when all of these hold:

- The call's route resolves to that backend. For `checkStatus()`, the handle's backend must also be
  the route's backend; otherwise the call throws `invalid-input` and sends nothing.
- The request goes to `https://` and the backend's host in the table above, on the default port.
  A `route.apiUrl` on another host gets no key from `apiKeys`, so configuration that moves the API
  to another server cannot take the key with it.

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

Any other host gets no key from `apiKeys`, such as `https://api.etherscan.io.example.org/v2/api`
or `https://api.etherscan.io:8443/v2/api`. Without `route.apiKey`, that call throws
[`missing-api-key`](errors/missing-api-key.md) before any request. `routescan` and
`blockscout-hosted` routes with `apiUrl` take no key from `apiKeys`, even on their own host: pass
`route.apiKey` for them. With `handlerUrl`, a route on Etherscan's own API goes to your server
handler, and a key in `apiKeys` or `route.apiKey` for it throws `invalid-input`
([A server adds the key](#a-server-adds-the-key)).

Each value must be a string of 8 to 1024 characters, each a letter, a digit, `.`, `_`, `~` or
`-`. Etherscan keys are letters and digits, and UUID-style keys fit. A value of other characters,
such as `&`, `<`, `"`, `/` or a non-ASCII letter, could come back from an explorer in an escaped
form that redaction does not match, so it is refused. A value that is all digits is refused too, and
so is a value found in the contract address or the handle's `ev1:<backend>:<chainId>:<address>`
part: removing it would corrupt that text. An `undefined` value counts as absent. Any other value
throws `invalid-input` naming `apiKeys.<backend>`, without the value.

For a test or an example, any made-up value of 8 or more allowed characters works as a placeholder,
such as `dummy-key-0001`.

A field that is not a backend name is counted in an `apiKeys` issue and never named, because the
name could be a key. Only the object's own enumerable string-keyed properties are read, each once;
a non-enumerable property or a Symbol key is ignored. The object must be a plain object.

## `route.apiKey`

A standalone Etherscan-compatible explorer has its own host and its own key, so `apiKeys` cannot
bind its key to one host. Pass that key as `route.apiKey`, next to the explorer's `apiUrl`
([Etherscan-compatible](etherscan-compatible.md)):

```ts
const options = {
  route: {
    backend: "etherscan-compatible",
    apiUrl: "https://explorer.example.org/api",
    apiKey: explorerKey,
  },
};
```

When a chain's routing-table row lists a standalone explorer with `needsKey: true`, name the
backend and leave out `apiUrl`. The key is then bound to the host the row lists:

```ts
const options = { route: { backend: "etherscan-compatible", apiKey: explorerKey } };
```

No entry in this release has `needsKey`. Without `apiUrl`, the call throws before any request:
[`invalid-input`](errors/invalid-input.md) naming `route.apiKey` when the row's standalone
explorer takes no key, as Bitlayer's (200901) does, and
[`unsupported-chain`](errors/unsupported-chain.md) when the row lists none.

`route.apiKey` goes only to the route's host, and only with requests of the route's backend. It
wins over `apiKeys` for that backend. For `etherscan-v2` and `routescan` it needs `route.apiUrl` in
the same override: without it, the call throws `invalid-input` naming `route.apiKey`, so a key
meant for one server never reaches the routing table's host for the chain. The same value rules
apply. A backend that takes no key, such
as `sourcify`, throws `invalid-input` naming `route.apiKey`. For `etherscan-compatible` and
`etherscan-v2` the key goes in the `apikey` field of the form body; for Routescan it goes in the
`apikey` header ([Routescan](routescan.md#api-key)).

## A missing key

When the route's backend needs a key (`etherscan-v2` or `blockscout-hosted`), or its routing-table entry says its
standalone explorer needs one, and no key is bound to its host, the call throws
[`missing-api-key`](errors/missing-api-key.md) before any request. No standalone entry in this
release needs a key. The routing table skips
Etherscan for a call without its key, so this happens when `route.backend` names `etherscan-v2`, or
when `route.apiUrl` points it at another server without `route.apiKey`. The message says which
option to set. For an `apiUrl` on another host it says that `apiKeys.etherscan-v2` goes only to
Etherscan's own API and asks for `route.apiKey`.

An injected `fetch` does not change this: a `fetch` for logging, retries, tests or a proxy still
gets `missing-api-key` before any request. Only `handlerUrl` sends an Etherscan request without a
key ([A server adds the key](#a-server-adds-the-key)). If the explorer answers that the key is
missing, the call throws `missing-api-key` too.

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

```ts no-run
import { verify } from "explorer-verify";

const result = await verify(input, { handlerUrl: "/api/verify" });
```

With `handlerUrl` set:

- Each request to Etherscan's v2 API goes to `handlerUrl` instead, with its query, method, headers
  and body, and no key. Requests to Sourcify, Blockscout and Routescan go to them directly. Log
  lines, the `verify.routed` event, a dry run's `apiHost` and errors name the handler for those
  requests.
- The routing table chooses as it does with `apiKeys["etherscan-v2"]`: a chain whose row lists
  Etherscan first goes to the handler, a chain that needs a paid Etherscan plan or has no Etherscan
  entry goes where it would with a key, and `verifyEach()` with `backends: "all"` keeps
  `etherscan-v2`. Set `route.backend: "etherscan-v2"` to use the handler on any chain with an
  Etherscan entry.
- The call needs no Etherscan key. `apiKeys["etherscan-v2"]` with it throws `invalid-input`, and so
  does a `route.apiKey` for Etherscan's API, in every function, a dry run included: the handler
  adds its own key.
- A route whose `apiUrl` is on another host keeps that host and its own key rules.
- Requests go through `fetch` when you set it.
- A refusal from the handler maps to an error code by its `code` and status, as
  [the server handler reference](server-handler.md#how-the-client-reads-a-refusal) lists. A
  refusal such as `chain-not-allowed` throws `handler-refused`, which is not retryable and whose
  hint names the `createVerifyHandler` option to change. Any other 4xx answer of the handler but a
  408 or a 429 is not retryable either; a 5xx answer stays retryable.
- A path such as `/api/verify` resolves against the page, so it works only in a browser page; in
  Node, a path throws `invalid-input` naming `handlerUrl`. Elsewhere, pass an absolute URL that
  starts with `https://`, or `http://` on `localhost`, `127.0.0.1` or `[::1]`. The value has no
  user name, password, query, fragment, whitespace, control character or backslash, is not on
  Etherscan's API host, and has at most 2048 characters; otherwise the call throws `invalid-input`
  naming `handlerUrl`.
- A path takes the page's origin, scheme included, so on a plain `http:` page it resolves to that
  same `http:` origin. An absolute `http://` URL, by contrast, must be on loopback.
- Log lines, events and errors show the handler URL, path included, and it is not redacted. Keep
  secrets out of it; your handler holds the key.
- The code that checks `handlerUrl` loads on demand, in a chunk of its own, when a call that sets
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

A key from `--api-key-file` or `--api-key-stdin` goes where the command line names. With
`--api-url` and `--backend` naming `etherscan-v2`, `routescan` or `etherscan-compatible`, it
becomes `route.apiKey` for that host. With `--backend etherscan-v2`, `--backend routescan` or
`--backend blockscout-hosted` alone, it fills that `apiKeys` entry. With `--backend etherscan-compatible` alone, it becomes
`route.apiKey` for the standalone host the routing table lists for the chain, which must have
`needsKey`; otherwise the command exits 2. The rules above then decide which
request carries it. See [the CLI reference](cli.md#api-keys-and-route-options).

A JSON-RPC endpoint URL often holds a provider key too. The CLI takes it from `--rpc-url-file` or
`--rpc-url-stdin`, and takes `--rpc-url` only for a URL with no part that can hold a key. See
[RPC URL](cli.md#rpc-url).

The library itself reads no environment variable: pass the key in `apiKeys`.

## Etherscan plan rule

A public dapp, or any use by a business, protocol, foundation or DAO, needs an Etherscan Advanced
plan or higher and its own key. When it displays Etherscan data, it must show "Powered by
Etherscan.io APIs". Etherscan's Free, Lite and Standard plans cover personal and research use only,
such as a developer verifying their own testnet deployments. Etherscan's terms also forbid exposing
a key in client code. This is a reading of the terms at <https://etherscan.io/apiterms>
(1 October 2026), not legal advice.
[Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md) explains the
rule.

Separately, the [Etherscan chainlist](https://api.etherscan.io/v2/chainlist) marks 10 chains "Paid
Plan required" (read 2026-11-05). The routing table puts Sourcify first on those chains, so a
key goes to Etherscan there only when you set `route.backend` to `etherscan-v2`
([Routing](routing.md#etherscan-rows-and-paid-plans)).
