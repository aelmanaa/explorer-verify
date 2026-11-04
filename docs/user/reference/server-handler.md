# Server handler

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who run a dapp and want its users to verify contracts on Etherscan without
shipping an Etherscan key to the browser.

`createVerifyHandler` from `explorer-verify/server` returns a function that takes a `Request` and
returns a `Response`. You run it on your own server with your own Etherscan key. The browser sends
its Etherscan requests to it; the handler checks each one, adds the key and forwards it to
Etherscan. It imports no Node built-in and uses only web-platform globals, so it runs in Node, edge
runtimes and serverless platforms.

The handler accepts the requests that the Etherscan v2 client of `verify()` and `checkStatus()`
sends ([Etherscan](etherscan.md)), and this page describes them.

## Etherscan's terms

Read [Etherscan's API terms](https://etherscan.io/apiterms) before you run the handler. This
project read them on 2026-11-02 (the page said "Last updated: 1 October 2026"). In this project's
reading:

- You use your own key, on your own server.
- The handler is part of your application. Do not offer it as a relay to other applications.
- The terms forbid exposing a key in client code, and forbid operating "an API proxy, gateway,
  relay or data feed that passes API Data through to third parties".
- The handler forwards only the verify-submit action, `verifysourcecode`, the status action,
  `checkverifystatus`, and a read-only lookup, `getsourcecode`, whose answer it reduces so that no
  source code and no ABI is passed on. Whether a handler limited to these counts as such a proxy is
  this project's reading, not legal advice. Confirm with Etherscan.
- A public dapp, or any use by a business, protocol, foundation or DAO, needs an Advanced plan or
  higher. When it displays Etherscan data, it must show "Powered by Etherscan.io APIs". See
  [API keys](api-keys.md#etherscan-plan-rule).

## Create the handler

```ts
import { createVerifyHandler } from "explorer-verify/server";

const handler = createVerifyHandler({
  apiKey: etherscanKey, // read from your server's secrets, never from the request
  chains: [1, 11155111, 421614], // Ethereum, Sepolia and Arbitrum Sepolia
  deployers: [deployerAddress], // the addresses your dapp deploys from
  logger: console,
});

// Any runtime with Request and Response:
const response = await handler(request);
console.log(response.status, await response.text());
```

`deployerAddress` stands for your own deployer address. For a status poll of a job that Etherscan
has verified, it prints the handler's `debug` line for the upstream request, then the answer. In
Node, `console.debug` writes to stdout; to keep it quiet, pass a logger whose `debug` does
nothing.

```text
POST https://api.etherscan.io/v2/api?REDACTED: attempt 1 of 2 {
  backend: 'etherscan-v2',
  method: 'POST',
  url: 'https://api.etherscan.io/v2/api?REDACTED',
  attempt: 1
}
200 {"status":"1","message":"OK","result":"Pass - Verified"}
```

Mount it on one route of your application, such as `POST /api/verify`.
[Run the server handler](../guides/run-the-server-handler.md) does this in a Next.js route and a
Cloudflare Worker.

| Option         | Required | What it does                                                                                                                                                                                 |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`       | Yes      | Your Etherscan key. The same rules as `apiKeys` apply: 8 to 1024 letters, digits, `.`, `_`, `~` or `-`, not all digits                                                                       |
| `chains`       | Yes      | The chain ids the handler serves, 1 to 10,000 of them. A request for another chain gets 403                                                                                                  |
| `deployers`    | No       | Addresses. When set, a submit or a lookup is forwarded only for a contract one of them created. See [Who may verify](#who-may-verify)                                                        |
| `rateLimit`    | No       | `(request) => boolean \| Promise<boolean>`. Called for every POST before the body is read. `false` refuses the request with 429                                                              |
| `maxBodyBytes` | No       | The largest request body, in bytes as received. Default 8 MiB (8,388,608)                                                                                                                    |
| `timeoutMs`    | No       | The time limit for one handled request, from its arrival to the answer, body included. Default 20,000                                                                                        |
| `fetch`        | No       | The `fetch` used to reach Etherscan. Default `globalThis.fetch`                                                                                                                              |
| `logger`       | No       | `{ debug, info, warn, error }`, as `VerifyOptions.logger` takes it. Gets each refusal at `info`, each upstream failure at `warn` and each internal failure at `error`, with the key redacted |

A bad option throws [`invalid-input`](errors/invalid-input.md) when the handler is created. The
issues name the option and never repeat its value. The options are read once: later changes to the
object, or to the `chains` and `deployers` arrays, have no effect.

The default `timeoutMs` is below the client's 30-second limit per request, so the browser gets the
handler's answer, such as a 504, and not its own timeout.

## Point the client at it

The browser keeps no key. It passes a `fetch` that sends each Etherscan request to your handler,
with the same query, method and body, and leaves every other request alone. Pass it with a route
to Etherscan v2: the routing table lists no Etherscan rows yet, so name the backend and the API URL.
No other code changes between direct and proxied use.

<!-- no-run: it sends the requests to your own server's /api/verify route, which an offline run does not have. -->

```ts no-run
import { verify } from "explorer-verify";

const viaHandler: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.etherscan.io") {
    return await fetch(input, init);
  }
  return await fetch(`/api/verify${url.search}`, init);
};

const result = await verify(input, {
  fetch: viaHandler,
  route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" },
});
```

With `fetch` set, `verify()` sends the request without a key and leaves the key to the server; see
[API keys](api-keys.md#a-missing-key). `checkStatus()` takes the same two options.

## Requests it accepts

A `POST` with an `application/x-www-form-urlencoded` body and no `Content-Encoding`, as the client
sends it to `https://api.etherscan.io/v2/api?chainid=<id>`. Each field may be in the query or the
body, once. A request holds at most 16 fields, query and body together. Any other field is refused,
including a query parameter that your platform or a proxy in front of it adds: mount the handler
where the query reaches it unchanged.

| `action`            | Fields besides `module=contract`, `action` and `chainid`                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifysourcecode`  | Required: `contractaddress`, `sourceCode`, `contractname`, `compilerversion`, `codeformat`. Optional: `constructorArguments`, `constructorArguements`, `licenseType` |
| `checkverifystatus` | Required: `guid`                                                                                                                                                     |
| `getsourcecode`     | Required: `address`, one address                                                                                                                                     |

The handler rebuilds the body from these fields alone, adds `apikey` and sends it to
`https://api.etherscan.io/v2/api?chainid=<id>` as a form-encoded POST. It answers with Etherscan's
status and JSON body, with every copy of the key replaced by `[redacted]`.

A `getsourcecode` answer is reduced before it is returned. It keeps `status`, `message` and, of the
first result only, `SourceCode`, `SimilarMatch`, `ContractName` and `CompilerVersion`. A non-empty
`SourceCode` becomes the fixed text `[source not relayed by explorer-verify/server]`, exported as
`SOURCE_MARKER`; an empty one stays empty. A text `result`, such as a key error, is kept.

It forwards nothing else: no other lookup, no proxy verification (planned:
[#94](https://github.com/aelmanaa/explorer-verify/issues/94)), and no other module or action.

## Refusals

A refusal has the shape of an Etherscan error, plus a stable `code`:

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

| Status | `code`                   | When                                                                                                                                      |
| ------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 405    | `method-not-allowed`     | The method is not `POST`. The response has `Allow: POST`                                                                                  |
| 429    | `rate-limited`           | `rateLimit` returned `false`                                                                                                              |
| 415    | `unsupported-media-type` | The body is not `application/x-www-form-urlencoded`, or has a `Content-Encoding` other than `identity`                                    |
| 413    | `body-too-large`         | The body is above `maxBodyBytes`, by its `Content-Length` or as it arrives. It is never parsed                                            |
| 408    | `request-timeout`        | The body did not arrive within `timeoutMs`                                                                                                |
| 400    | `bad-request`            | The body cannot be read, or the request holds more than 16 fields, counted before parsing                                                 |
| 400    | `forbidden-field`        | A field names an API key, a route, an API URL, a backend, a URL or a host, in any case, such as `apikey` or `apiUrl`                      |
| 400    | `bad-request`            | A field is given twice                                                                                                                    |
| 403    | `action-not-allowed`     | `module` is not `contract`, or `action` is not one of the three above                                                                     |
| 400    | `bad-request`            | `chainid` is missing or not a positive integer without leading zeros                                                                      |
| 403    | `chain-not-allowed`      | The chain is not in `chains`                                                                                                              |
| 400    | `bad-request`            | A field the action does not take (counted, never named), a missing field, or a value of the wrong form                                    |
| 403    | `address-not-allowed`    | `deployers` is set, and Etherscan's creation record names none of them                                                                    |
| 503    | `address-not-indexed`    | `deployers` is set, and Etherscan has no creation record for the address yet. The response has `Retry-After: 5`                           |
| 429    | `upstream-rate-limited`  | Etherscan answered 429 or reported a rate or daily limit. Etherscan's `Retry-After` is passed on                                          |
| 504    | `upstream-timeout`       | Etherscan did not answer within what is left of `timeoutMs`                                                                               |
| 502    | `upstream-error`         | Etherscan could not be reached, answered with a redirect, still answered 5xx after the retry, or sent an answer that is not a JSON object |
| 500    | `internal-error`         | `rateLimit` threw, the client went away, or the handler failed. With `logger` set, the reason goes to `logger.error`                      |

## Who may verify

CORS is not access control. A form-encoded POST needs no preflight, so any web page can make its
visitors' browsers send requests to your handler, even when it sends no CORS header. Limit who can
use it:

- Set `deployers`, so the handler forwards only contracts your own addresses created.
- Check the caller in `rateLimit`, which sees the headers before the body is read. This hook refuses
  requests from other sites:

```ts
import type { RateLimit } from "explorer-verify/server";

const rateLimit: RateLimit = (request) => {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  return site !== "cross-site" && (origin === null || origin === "https://your-dapp.example");
};
```

- Add your application's own authentication in front of the handler when users sign in.

How `deployers` decides:

- With `deployers` set, the handler sends Etherscan's `getcontractcreation` for the address before
  it forwards a submit or a lookup. It forwards only when the record names one of `deployers` as
  the `contractCreator` or the `contractFactory`. Status polls are not checked.
- `contractCreator` is the sender of the transaction that created the contract, also when a factory
  created it. Listing a wallet admits every contract it deployed, directly or through any factory.
- Listing a factory admits every contract that factory created for anyone. Never list a public
  factory, such as the common CREATE2 deployer: anyone could deploy through it and use your key.
- A transient answer, such as a rate limit or a record not indexed yet, is never a 403. A key
  error is passed on as Etherscan's own answer.
- The form-body placement of the key is confirmed live for `getsourcecode`, `checkverifystatus` and
  `verifysourcecode`; for `getcontractcreation` it is not confirmed live yet.

## What the handler never does

- It never takes a host from the request. Every upstream request goes to `api.etherscan.io`, so a
  request cannot point the handler at your own network or at another host. No option changes the
  host either.
- It never follows a redirect. Every upstream request sets `redirect: "manual"`, and a redirect
  answer is refused with 502, because a redirect could carry the key to another host.
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
