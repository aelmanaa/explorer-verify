# API keys

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who pass an explorer API key to `verify()` or `checkStatus()`.

In this release the routing table sends every chain it lists to Sourcify, which needs no key. The Etherscan v2, Routescan and
standalone clients come next. The key options below are already checked, and a bad value throws
`invalid-input` today. Where a section below says "from the clients on", the rule takes effect with
those clients ([#61](https://github.com/aelmanaa/explorer-verify/issues/61),
[#62](https://github.com/aelmanaa/explorer-verify/issues/62),
[#63](https://github.com/aelmanaa/explorer-verify/issues/63)).

## `apiKeys`

`VerifyOptions.apiKeys` holds one key per backend name. From the clients on, each key goes where
this table says:

```ts
import { verify } from "explorer-verify";

// On a server. Never ship an Etherscan key to a browser.
const result = await verify(input, { apiKeys: { "etherscan-v2": etherscanKey } });
```

| Backend                | Host the key goes to                  | Where in the request                           | Needed                       |
| ---------------------- | ------------------------------------- | ---------------------------------------------- | ---------------------------- |
| `etherscan-v2`         | `api.etherscan.io`                    | The `apikey` field of a form-encoded POST body | Yes, for every request       |
| `routescan`            | `api.routescan.io`                    | The `apikey` request header (see below)        | No: the free tier is keyless |
| `etherscan-compatible` | Not accepted here; use `route.apiKey` | The `apikey` field of a form-encoded POST body | Depends on the explorer      |
| `sourcify`             | Not accepted                          | None                                           | No                           |
| `blockscout`           | Not accepted in this release          | None                                           | No                           |

The key never goes in a URL. Etherscan ignores a key in a request header and answers as if no key
was sent, so the library puts it in the form body, with `chainid` in the query. Routescan's docs
show the `apikey` header, but a live test could not confirm that Routescan reads it: Routescan
answered a made-up key there without refusing it. The form-body placement for standalone explorers
is also not confirmed live.

A key goes with a request only when all of these hold:

- The call's route resolves to that backend. For `checkStatus()`, the handle's backend must also be
  the route's backend; otherwise the call throws `invalid-input` and sends nothing.
- The request goes to `https://` and the backend's host in the table above, on the default port.
  A `route.apiUrl` on another host gets no key from `apiKeys`, so configuration that moves the API
  to another server cannot take the key with it.

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
bind its key to one host. From the clients on, pass that key as `route.apiKey`, next to the
explorer's `apiUrl`:

```ts
const options = {
  route: {
    backend: "etherscan-compatible",
    apiUrl: "https://explorer.example.org/api",
    apiKey: explorerKey,
  },
};
```

`route.apiKey` goes only to the route's host, and only with requests of the route's backend. It
wins over `apiKeys` for that backend. It needs `route.apiUrl` in the same override: without it, the
call throws `invalid-input` naming `route.apiKey`, so a key meant for one explorer never reaches the
routing table's host for the chain. The same value rules apply. A backend that takes no key, such
as `sourcify`, throws `invalid-input` naming `route.apiKey`. In this release `sourcify` is the only
backend with a client, so this example throws `invalid-input` naming `route.backend` today; the
field is for the clients that come next.

## A missing key

This section applies from the clients on. When the route's backend needs a key (`etherscan-v2`)
and no key is bound to its host, the call throws [`missing-api-key`](errors/missing-api-key.md)
before any request.

With `fetch` set, the check is skipped: an injected `fetch` may lead to your own server, which adds
the key, as the planned server handler does. The request goes out without a key. If the explorer
answers that the key is missing, the call throws `missing-api-key`. Reach a proxy that adds keys
through an injected `fetch`, not through `route.apiUrl`: a key from `apiKeys` never follows an
`apiUrl` to another host, so the check would fire.

| Explorer answer                                         | Error                                            |
| ------------------------------------------------------- | ------------------------------------------------ |
| `Missing/Invalid API Key`                               | [`missing-api-key`](errors/missing-api-key.md)   |
| `Invalid API Key (#err2)`                               | [`api-key-rejected`](errors/api-key-rejected.md) |
| `Max daily rate limit reached`, or a daily submit limit | [`quota-exceeded`](errors/quota-exceeded.md)     |

All three exit with code 3 and are not retryable. `details.backend` names the backend; no error
holds the key.

## Keys in logs, events, errors and results

Every value in `apiKeys`, valid or not, and `route.apiKey` are removed from every log line, event,
error and result, as `[redacted]`, even when an explorer repeats them in an answer. See
[API keys in errors](errors/index.md#api-keys-in-errors).

## Environment variables

The CLI, planned for a later release, will read keys from these variables and never from a flag
value:

| Variable            | Backend        |
| ------------------- | -------------- |
| `ETHERSCAN_API_KEY` | `etherscan-v2` |
| `ROUTESCAN_API_KEY` | `routescan`    |

The library itself reads no environment variable: pass the key in `apiKeys`.

## Etherscan plan rule

A public dapp, or any use by a business, protocol, foundation or DAO, needs an Etherscan Advanced
plan or higher and its own key. When it displays Etherscan data, it must show "Powered by
Etherscan.io APIs". Etherscan's Free, Lite and Standard plans cover personal and research use only,
such as a developer verifying their own testnet deployments. Etherscan's terms also forbid exposing
a key in client code. This is a reading of the terms at <https://etherscan.io/apiterms>
(1 October 2026), not legal advice.
