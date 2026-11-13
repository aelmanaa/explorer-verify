# Server handler

Version: explorer-verify 0.3.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who run a dapp and want its users to verify contracts on Etherscan without
shipping an Etherscan key to the browser.

`createVerifyHandler` from `explorer-verify/server` lets a dapp's users verify on Etherscan
without an Etherscan key in the browser. You run the handler on your own server with your own key.

| Fact          | Value                                                                   |
| ------------- | ----------------------------------------------------------------------- |
| Import        | `explorer-verify/server`                                                |
| Shape         | `(request: Request) => Promise<Response>`                               |
| Runtimes      | Node, edge runtimes and serverless platforms: web-platform globals only |
| Forwards to   | `api.etherscan.io` only                                                 |
| Client option | `handlerUrl` in `verify()`, `checkStatus()`, `dryRun()`, `linkProxy()`  |

The browser sends its Etherscan requests to the handler. The handler checks each one, adds the key
and forwards it to Etherscan. It accepts the requests that the [Etherscan](etherscan.md) client of
`verify()` and `checkStatus()` sends, and this page describes them.

> [!IMPORTANT]
> Read the key from your server's secrets, never from the request. Mount the handler for your own
> application only, and limit who may use it ([Who may verify](#who-may-verify)).

## Create the handler

This handler serves three chains and forwards only contracts that your deployer created:

```ts [handler.ts]
import { createVerifyHandler } from "explorer-verify/server";

const handler = createVerifyHandler({
  // Read the key from your server's secrets, never from the request.
  apiKey: etherscanKey,
  chains: [1, 11155111, 421614], // Ethereum, Sepolia and Arbitrum Sepolia
  deployers: [deployerAddress], // the addresses your dapp deploys from
  logger: console,
});

// Any runtime with Request and Response:
const response = await handler(request);
console.log(response.status, await response.text());
```

`deployerAddress` stands for your own deployer address. For a status poll of a job that Etherscan
has verified, it prints the handler's `debug` line for the upstream request, then the answer:

```text
POST https://api.etherscan.io/v2/api?REDACTED: attempt 1 of 2 {
  backend: 'etherscan-v2',
  method: 'POST',
  url: 'https://api.etherscan.io/v2/api?REDACTED',
  attempt: 1
}
200 {"status":"1","message":"OK","result":"Pass - Verified"}
```

In Node, `console.debug` writes to stdout. To keep it quiet, pass a logger whose `debug` does
nothing.

Mount it on one route of your application, such as `POST /api/verify`.
[Run the server handler](../guides/run-the-server-handler.md) does this in a Next.js route and a
Cloudflare Worker.

## Options

| Option           | Required | What it does                                                                          |
| ---------------- | -------- | ------------------------------------------------------------------------------------- |
| `apiKey`         | Yes      | Your Etherscan key, under the [`apiKeys` value rules](api-keys.md#allowed-key-values) |
| `chains`         | Yes      | The chain ids it serves, 1 to 10,000. Another chain gets 403                          |
| `deployers`      | No       | Forward only contracts these addresses created ([Who may verify](#who-may-verify))    |
| `allowProxyLink` | No       | `true` forwards the proxy-link actions. Default `false`                               |
| `rateLimit`      | No       | `(request) => boolean \| Promise<boolean>`; `false` answers 429                       |
| `maxBodyBytes`   | No       | The largest request body, as received. Default 8 MiB (8,388,608)                      |
| `timeoutMs`      | No       | The limit for one handled request, body included. Default 20,000                      |
| `fetch`          | No       | The `fetch` that reaches Etherscan. Default `globalThis.fetch`                        |
| `logger`         | No       | `{ debug, info, warn, error }`, as `VerifyOptions.logger` takes it                    |

Details:

- `allowProxyLink` covers `verifyproxycontract` and `checkproxyverification`, which `linkProxy()`
  sends. With it off, both get 403 `action-not-allowed`.
- `rateLimit` is called for every POST before the body is read.
- `timeoutMs` runs from the request's arrival to the answer. The default is below the client's
  30-second limit per request, so the browser gets the handler's answer, such as a 504.
- `logger` gets each refusal at `info`, each upstream failure at `warn` and each internal failure
  at `error`, with the key redacted.

A bad option throws [`invalid-input`](errors/invalid-input.md) when the handler is created. The
issues name the option and never repeat its value.

An unknown option throws too, naming the option it may mean, such as `deployers` for `deployer`.
An optional field set to `undefined` counts as absent. The options are read once: later changes to
the object, or to its arrays, have no effect.

## Point the client at it

The browser keeps no key. It passes your handler's URL as `handlerUrl`. Each Etherscan request then
goes to the handler, with the same query, method and body and no key. Every other request goes to
its explorer unchanged.

The routing table chooses as it does with an Etherscan key, so a chain whose row lists Etherscan
first goes to the handler. No other code changes between direct and proxied use:

<!-- no-run: it sends the requests to your own server's /api/verify route, which an offline run does not have. -->

```ts no-run [verify-in-page.ts]
import { validateInput, verify } from "explorer-verify";

import greeter from "./greeter-sepolia.json" with { type: "json" };

const input = validateInput(greeter);
const result = await verify(input, { handlerUrl: "/api/verify" });
console.log(result.status);
```

`checkStatus()`, `dryRun()` and `linkProxy()` take the same option. An injected `fetch` alone
does not send an Etherscan request without its key; see
[API keys](api-keys.md#a-server-adds-the-key).

## Requests it accepts

The handler takes a `POST` with a form-encoded body and no `Content-Encoding`, as the client sends
it to `https://api.etherscan.io/v2/api?chainid=<id>`.

- Each field may be in the query or the body, once.
- A request holds at most 16 fields, query and body together.
- Any other field is refused, including a query parameter that your platform or a proxy adds.
  Mount the handler where the query reaches it unchanged.

Every request has `module=contract`, `action` and `chainid`. The other fields per action:

| `action`                 | Required                                 | Optional                                                       |
| ------------------------ | ---------------------------------------- | -------------------------------------------------------------- |
| `verifysourcecode`       | The five [submit fields](#submit-fields) | `constructorArguments`, `constructorArguements`, `licenseType` |
| `checkverifystatus`      | `guid`                                   | None                                                           |
| `getsourcecode`          | `address`, one address                   | None                                                           |
| `verifyproxycontract`    | `address`, the proxy                     | `expectedimplementation`, one address                          |
| `checkproxyverification` | `guid`                                   | None                                                           |

The last two need `allowProxyLink`.

### Submit fields

The five required fields of `verifysourcecode`:

- `contractaddress`
- `sourceCode`
- `contractname`
- `compilerversion`
- `codeformat`

### What it forwards

The handler rebuilds the body from these fields alone, adds `apikey` and sends it to
`https://api.etherscan.io/v2/api?chainid=<id>` as a form-encoded POST. It answers with Etherscan's
status and JSON body, with every copy of the key replaced by `[redacted]`.

A `getsourcecode` answer is reduced before it is returned. It keeps `status` and `message`, and
these fields of the first result only:

- `SourceCode`: a non-empty one becomes the fixed text
  `[source not relayed by explorer-verify/server]`, exported as `SOURCE_MARKER`;
- `SimilarMatch`, `ContractName` and `CompilerVersion`;
- `Implementation`, when it is an address. `linkProxy()` reads it after a mismatch.

A text `result`, such as a key error, is kept. It forwards nothing else: no other lookup, and no
other module or action.

With `allowProxyLink: true`, a browser can link a proxy through the handler as it verifies through
it. With `deployers` set, the deployer check runs on the proxy's address before
`verifyproxycontract`.

After Etherscan refuses a link for another implementation than expected, `linkProxy()` also sends
the forwarded `getsourcecode` for the proxy. It reads the implementation Etherscan holds. See
[Verify a proxy](../guides/verify-a-proxy.md).

## Refusals

A refusal has the shape of an Etherscan error, plus a stable `code`:

<!-- code-width: JSON strings do not break -->

```json
{
  "status": "0",
  "message": "NOTOK",
  "result": "Only module contract with the verifysourcecode, checkverifystatus or getsourcecode action is forwarded.",
  "code": "action-not-allowed"
}
```

The `result` sentence may change in any release; the `code` does not. A body without `code` is
Etherscan's own answer, passed on. No refusal repeats a value from the request or from Etherscan.

The checks run in this order:

| Status | `code`                   | When                                                           |
| ------ | ------------------------ | -------------------------------------------------------------- |
| 405    | `method-not-allowed`     | The method is not `POST`. The response has `Allow: POST`       |
| 429    | `rate-limited`           | `rateLimit` returned `false`                                   |
| 415    | `unsupported-media-type` | The body is not form-encoded, or is compressed                 |
| 413    | `body-too-large`         | The body is above `maxBodyBytes`. It is never parsed           |
| 408    | `request-timeout`        | The body did not arrive within `timeoutMs`                     |
| 400    | `bad-request`            | The body cannot be read, or holds more than 16 fields          |
| 400    | `forbidden-field`        | A field names a key, a route, a URL or a host                  |
| 400    | `bad-request`            | A field is given twice                                         |
| 403    | `action-not-allowed`     | Another module or action                                       |
| 400    | `bad-request`            | `chainid` is missing or malformed                              |
| 403    | `chain-not-allowed`      | The chain is not in `chains`                                   |
| 400    | `bad-request`            | An extra field, a missing field, or a value of the wrong form  |
| 403    | `address-not-allowed`    | `deployers` is set, and none of them created the contract      |
| 503    | `address-not-indexed`    | `deployers` is set, and Etherscan has no creation record yet   |
| 429    | `upstream-rate-limited`  | Etherscan answered 429 or reported a rate or daily limit       |
| 504    | `upstream-timeout`       | Etherscan did not answer within what is left of `timeoutMs`    |
| 502    | `upstream-error`         | Etherscan failed; see below                                    |
| 500    | `internal-error`         | `rateLimit` threw, the client went away, or the handler failed |

Details of some rows:

- `unsupported-media-type`: a `Content-Encoding` other than `identity` counts as compressed.
- `body-too-large`: by its `Content-Length` or as the body arrives.
- `bad-request` for more than 16 fields: they are counted before parsing.
- `forbidden-field`: in any case, such as `apikey`, `apiUrl` or `backend`.
- `action-not-allowed`: the proxy-link actions are allowed only with `allowProxyLink`.
- `bad-request` for `chainid`: it must be a positive integer without leading zeros.
- `bad-request` for an extra field: the field is counted, never named.
- `address-not-indexed`: the response has `Retry-After: 5`.
- `upstream-rate-limited`: Etherscan's `Retry-After` is passed on.
- `internal-error`: with `logger` set, the reason goes to `logger.error`.

`upstream-error` covers these cases:

- Etherscan could not be reached, or redirected the request.
- Etherscan sent an answer that is not a JSON object.
- Etherscan still answered 502, 503 or 504 after the retries; for a submit, 503 only.
- Etherscan answered the creation check's lookup with a 4xx or 5xx.

Any other Etherscan answer with a JSON body, a 500 included, is passed on with its status and no
`code`.

### How the client reads a refusal

A client that sets `handlerUrl` reads the `code` of each refusal. It throws one error for it when
the answer has the status the table above lists for that code. A code with another status, such as
`chain-not-allowed` on a 502, maps to nothing.

| `code`                   | Client error                                           | Retryable |
| ------------------------ | ------------------------------------------------------ | --------- |
| `chain-not-allowed`      | [`handler-refused`](errors/handler-refused.md)         | No        |
| `address-not-allowed`    | [`handler-refused`](errors/handler-refused.md)         | No        |
| `action-not-allowed`     | [`handler-refused`](errors/handler-refused.md)         | No        |
| `forbidden-field`        | [`handler-refused`](errors/handler-refused.md)         | No        |
| `body-too-large`         | [`handler-refused`](errors/handler-refused.md)         | No        |
| `bad-request`            | [`handler-refused`](errors/handler-refused.md)         | No        |
| `method-not-allowed`     | [`handler-refused`](errors/handler-refused.md)         | No        |
| `unsupported-media-type` | [`handler-refused`](errors/handler-refused.md)         | No        |
| `rate-limited`           | [`rate-limited`](errors/rate-limited.md)               | Yes       |
| `upstream-rate-limited`  | [`rate-limited`](errors/rate-limited.md)               | Yes       |
| `request-timeout`        | [`network`](errors/network.md)                         | Yes       |
| `upstream-timeout`       | [`network`](errors/network.md)                         | Yes       |
| `upstream-error`         | [`network`](errors/network.md)                         | Yes       |
| `address-not-indexed`    | [`not-indexed`](errors/not-indexed.md)                 | Yes       |
| `internal-error`         | [`unexpected-response`](errors/unexpected-response.md) | Yes       |

`handler-refused` carries the code in `details.handlerCode`. A `network` error has the code only
in its message.

The client retries a 429, 502, 503 and 504 before it reads the code, as it does any answer
([retries](errors/index.md#retries)). A 429 then throws `rate-limited` whatever its code. A 502 or
504 to a submit is not sent again blindly: the client looks the contract up first.

For `address-not-indexed`, `not-indexed` counts HTTP attempts in `details.submits`, unlike a
direct call, which counts answers: the attempts of the refused request when it was the submit, `0`
when it was the lookup or another request. `details.elapsedMs` runs from the first attempt of the
refused request to its last answer.

An answer with no `code`, an unknown code or a code with another status throws
`unexpected-response`, and its message does not repeat the code. A 4xx other than 408 and 429 is
then not retryable, and its hint says to check `handlerUrl` and the handler's options.

## Who may verify

CORS is not access control. A form-encoded POST needs no preflight, so any web page can make its
visitors' browsers send requests to your handler, even when it sends no CORS header. Limit who can
use it:

- Set `deployers`, so the handler forwards only contracts your own addresses created.
- Leave `allowProxyLink` off unless your application links proxies. With it on, whoever can reach
  the handler can change which implementation a proxy's page on Etherscan shows, under your key.
  A proxy link request needs no verified source. Turn it on together with `deployers`.
- Add your application's own authentication in front of the handler when users sign in.
- Check the caller in `rateLimit`, which sees the headers before the body is read.

This `rateLimit` hook refuses requests from other sites:

```ts [rate-limit.ts]
import type { RateLimit } from "explorer-verify/server";

const rateLimit: RateLimit = (request) => {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  return (
    site !== "cross-site" &&
    (origin === null || origin === "https://your-dapp.example")
  );
};
```

### How `deployers` decides

With `deployers` set, the handler sends Etherscan's `getcontractcreation` for the address first. It
checks a submit, a lookup and a proxy link request (`verifyproxycontract`, for the proxy's
`address`). It forwards only when the record names one of `deployers` as the `contractCreator` or
the `contractFactory`.

- Status polls and `checkproxyverification` are not checked.
- `expectedimplementation` is not checked against `deployers`. A proxy your addresses created may
  be linked to any implementation the request names; Etherscan links it only when the proxy
  points there.
- `contractCreator` is the sender of the transaction that created the contract, also when a
  factory created it. Listing a wallet admits every contract it deployed, directly or through any
  factory.
- A transient answer, such as a rate limit or a record not indexed yet, is never a 403. A key
  error is passed on as Etherscan's own answer.
- The form-body placement of the key is confirmed live for `getsourcecode`, `checkverifystatus`
  and `verifysourcecode`. For `getcontractcreation` it is not confirmed live yet.

> [!WARNING]
> Listing a factory admits every contract that factory created for anyone. Never list a public
> factory, such as the common CREATE2 deployer: anyone could deploy through it and use your key.

## Etherscan's terms

Read [Etherscan's API terms](https://etherscan.io/apiterms) before you run the handler. In this
project's reading:

- You use your own key, on your own server.
- The handler is part of your application. Do not offer it as a relay to other applications.
- The terms forbid exposing a key in client code. They also forbid operating "an API proxy,
  gateway, relay or data feed that passes API Data through to third parties".
- A public dapp, or any use by a business, protocol, foundation or DAO, needs an Advanced plan or
  higher. When it displays Etherscan data, it must show "Powered by Etherscan.io APIs". See
  [API keys](api-keys.md#etherscan-plan-rule).

The handler forwards only these actions:

| Action                   | What it is                                   |
| ------------------------ | -------------------------------------------- |
| `verifysourcecode`       | The verify submit                            |
| `checkverifystatus`      | The status poll                              |
| `getsourcecode`          | A lookup, reduced: no source code and no ABI |
| `verifyproxycontract`    | A proxy link, with `allowProxyLink`          |
| `checkproxyverification` | A proxy link's status, with `allowProxyLink` |

Whether a handler limited to these counts as such a proxy is this project's reading, not legal
advice. Confirm with Etherscan.

## What the handler never does

- It never takes a host from the request. Every upstream request goes to `api.etherscan.io`, so a
  request cannot point the handler at your own network or at another host. No option changes the
  host either.
- It never follows a redirect. Every upstream request sets `redirect: "manual"`, and a redirect
  answer is refused with 502, because a redirect could carry the key to another host. Without a
  `fetch` option, an answer whose URL has another origin than `api.etherscan.io` is refused too.
- It never forwards a header of the client's request. The upstream request carries only
  `content-type`.
- It never puts the key in a URL. The key goes in the form body, where Etherscan reads it.
- It never returns the key. Refusals are fixed sentences, and every string in Etherscan's answer is
  redacted after the answer is parsed, so an escaped copy is caught too.
- It adds no CORS header. A dapp served from the same origin needs none. If your dapp runs on
  another origin, allow only that origin in your framework, and answer the `OPTIONS` preflight
  there: the handler answers it with 405.

## Limits and retries

- One deadline, `timeoutMs`, covers the whole request: the body read, the creation lookup and the
  forwarded request.
- The body limit applies before parsing. A Standard JSON input grows when it is form-encoded, so
  raise `maxBodyBytes` if your largest contracts need it.
- Each upstream request is retried at most once, within the deadline; the client backs off and
  retries on its own. A status poll, a lookup and a creation lookup are retried after a network
  error, a 429, a 502, a 503 or a 504. A submit is retried only after a 429 or a 503, because
  Etherscan may have received it. A `Retry-After` above 30 seconds ends the retries.
- An Etherscan answer above 1 MiB is refused with 502, except a `getsourcecode` answer, which is
  read up to 16 MiB and then reduced.

## Sources

- [Etherscan's API terms](https://etherscan.io/apiterms), read 2026-11-02; the page said "Last
  updated: 1 October 2026".
- Etherscan linking a proxy whose source it had not verified: live run on 2026-11-04.
