# Blockscout

Version: explorer-verify 0.2.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who need to know what explorer-verify sends to a Blockscout
explorer and how it reads each answer.

A Blockscout explorer serves one chain from its own host, with its API at `<origin>/api`.
explorer-verify talks to one such instance at a time. [verify()](verify.md) and
[checkStatus()](check-status.md) use this client.

| Fact         | Value                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| Server       | An instance's `/api`, such as `https://eth-sepolia.blockscout.com/api`   |
| API key      | None; a key throws `invalid-input`                                       |
| Browsers     | An instance answers them directly                                        |
| Chains       | 111 in the routing table ([Blockscout rows](routing.md#blockscout-rows)) |
| Explorer URL | `https://<instance>/address/<address>?tab=contract`                      |
| Match type   | [`exact` or `partial`](../explanation/match-types.md)                    |

Blockscout's hosted API at `api.blockscout.com` serves many chains and needs a key. It is the
separate backend `blockscout-hosted` ([The hosted API](#the-hosted-api)).

## When the call goes to Blockscout

Sourcify comes first in a row that has it, so name the backend to verify on Blockscout:

| Chain                              | What to pass                                                    |
| ---------------------------------- | --------------------------------------------------------------- |
| Its row lists an instance          | `route: { backend: "blockscout" }`                              |
| Another chain, or another instance | `route.backend` and `route.apiUrl` set to the instance's `/api` |

[Routing](routing.md#route) describes `route`.

## A minimal call

This script verifies the sample request, [greeter-sepolia.json](../start/greeter-sepolia.json), on
the Sepolia instance. The Greeter is already verified there:

```ts [blockscout.ts]
import { readFile } from "node:fs/promises";

import { validateInput, verify } from "explorer-verify";

const text = await readFile("greeter-sepolia.json", "utf8");
const input = validateInput(JSON.parse(text));
const result = await verify(input, {
  route: {
    backend: "blockscout",
    apiUrl: "https://eth-sepolia.blockscout.com/api",
  },
});
console.log(`${result.status} ${result.backend}`);
```

```text
already-verified blockscout
```

## The `route.apiUrl` rules

- It must end in `/api`, or the call throws [`invalid-input`](errors/invalid-input.md) naming
  `route.apiUrl`. Trailing slashes are removed first, so `.../api/` is accepted.
- A path before `/api` is kept. With `https://example.org/explorer/api`, the lookup goes to
  `https://example.org/explorer/api/v2/smart-contracts/<address>`.
- A URL on `api.blockscout.com` throws `invalid-input`: the hosted API is `blockscout-hosted`.
- A key in `route.apiKey` or `apiKeys.blockscout` throws `invalid-input`
  ([API keys](api-keys.md)).
- A result has no `explorerUrl` when `route.apiUrl` names an instance other than the one the
  chain's row lists.

## Requests

The lookup goes to the instance's REST API, which tells a full match from a partial one. The
submit and the status request go to its Etherscan-compatible API, as a form-encoded POST that
holds `module=contract`, the action and its fields.

All three are built from the instance's `/api` URL, `<api>` below, and none carries a key:

| Step   | Request                                                       | Sends                                                      |
| ------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| Lookup | `GET <api>/v2/smart-contracts/{address}`                      | Nothing. Safe to repeat                                    |
| Submit | `POST <api>`, `action=verifysourcecode`                       | The source. Outward and permanent: Blockscout publishes it |
| Status | `POST <api>`, `action=checkverifystatus`, `guid` (the job id) | Nothing. Safe to repeat                                    |

The submit fields:

| Field                  | Value                                                                |
| ---------------------- | -------------------------------------------------------------------- |
| `codeformat`           | `solidity-standard-json-input`                                       |
| `sourceCode`           | The JSON text of `compiler.input`: `language`, `sources`, `settings` |
| `contractaddress`      | `address`                                                            |
| `contractname`         | `contractName`, as `contracts/Greeter.sol:Greeter`                   |
| `compilerversion`      | `compiler.version` with one leading `v`                              |
| `constructorArguments` | `constructorArgs` with a `0x` prefix; absent when the input has none |

Library addresses are not sent as fields: for Standard JSON input, Blockscout reads them from
`settings.libraries` only. To send them there, call `linkLibraries` first
([Linked libraries](verify.md#linked-libraries)).

## How answers are read

An answer that this table does not list throws an error. It never reads as "not verified", as
`failed` or as success. `status` `"1"` alone never means success: Blockscout also sends it for a
job it does not know.

| Step   | Answer                                                    | Outcome                                                                                                                                          |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Any    | HTTP 429                                                  | Retried with backoff; [`rate-limited`](errors/rate-limited.md) once the retries stop                                                             |
| Lookup | 200, `is_verified` `true`, `is_fully_verified` `true`     | Verified, `exact`. `name` and `compiler_version` name the stored contract                                                                        |
| Lookup | 200, `is_verified` `true`, `is_partially_verified` `true` | Verified, `partial`. `name` and `compiler_version` name the stored contract                                                                      |
| Lookup | 200, `is_verified` `true` and neither flag `true`         | [`unexpected-response`](errors/unexpected-response.md)                                                                                           |
| Lookup | 200, `is_verified` `false`                                | Not verified                                                                                                                                     |
| Lookup | 200 with the contract's code and no verification fields   | Not verified                                                                                                                                     |
| Lookup | 404 `Not found`                                           | Not verified                                                                                                                                     |
| Lookup | Anything else                                             | [`unexpected-response`](errors/unexpected-response.md)                                                                                           |
| Submit | `status` `"1"` and a job id                               | A job to poll                                                                                                                                    |
| Submit | 200, `status` `"1"`, `result` empty, `null` or absent     | A lookup, a wait and a new submit; see below                                                                                                     |
| Submit | `Smart-contract already verified.`                        | `already-verified`, with the match a lookup reads; [`unexpected-response`](errors/unexpected-response.md) when that lookup finds it not verified |
| Submit | `Address is not a smart-contract`                         | [`invalid-input`](errors/invalid-input.md) naming `address`                                                                                      |
| Submit | Anything else                                             | [`unexpected-response`](errors/unexpected-response.md)                                                                                           |
| Status | `Pending in queue`                                        | Still pending                                                                                                                                    |
| Status | `Pass - Verified`                                         | `verified`, with the match a lookup reads; [`unknown-state`](errors/unknown-state.md) when that lookup finds it not verified                     |
| Status | `Fail - Unable to verify`                                 | `failed`, with the text as `reason`                                                                                                              |
| Status | `Unknown UID`                                             | [`job-not-found`](errors/job-not-found.md); `verify()` looks the contract up once first                                                          |
| Status | Any other text                                            | [`unknown-state`](errors/unknown-state.md)                                                                                                       |

A `failed` reason is redacted with the call's keys and cut to 300 characters. An excerpt in an
error is redacted and cut the same way.

## Partial matches

A build compiled with `bytecodeHash` `"none"` (Foundry's `bytecode_hash = "none"`) carries no
metadata hash, so Blockscout can only reach a partial match for it. Such a build answers
`Pass - Verified`, and the lookup then gives `is_partially_verified` `true`. explorer-verify
reports `verified` with `partial`: for that build, the best outcome, not a failure.

Blockscout's bytecode database can also verify a contract on its own when its code, without the
metadata part, matches a contract verified before. The lookup then shows a partial match with
`is_verified_via_eth_bytecode_db` `true`.

Such a match can hold another project's source. On Ethereum Sepolia, the lookup of a contract
deployed as `EvProxy` showed a partial match from the bytecode database named `AuctionProxy`, with
the file path `project/contracts/AuctionProxy.sol`. The lookup reads `name` and
`compiler_version`, and `verify()` compares them with the input
([Match types](../explanation/match-types.md)):

- `name` with the part of `contractName` after its last `:`;
- `compiler_version` with `compiler.version`.

The file path is not compared, because a source from the bytecode database carries a path of its
own.

- The match is of this source: `verify()` returns `already-verified` with that match and sends no
  submit.
- The match is another contract's: `verify()` submits. Blockscout accepts a submit over a partial
  match. When it answers `Smart-contract already verified.` instead, the result is
  `already-verified` with `partial` and `storedContract`.

Blockscout answers `Smart-contract already verified.` only for a full match. A contract with a
partial match of its own source takes a new submit. By default `verify()` does not send one: its
first lookup returns `already-verified` with `partial`. With `submitOverPartial`, it submits.

On Ethereum Sepolia on 2026-11-11, the exact source over a partial match passed and the lookup then
gave `is_fully_verified`: `verified`, `exact`. The same partial source again ended with
`Fail - Unable to verify`, which gives `already-verified` with `partial`, not `failed`
([Submit over a partial match](verify.md#submit-over-a-partial-match)).

## The empty answer right after a deployment

Right after a deployment, an instance can answer a submit with `status` `"1"` but an empty
`result` and no job id. Polling cannot help, because there is no job; a new submit a
few seconds later succeeds.

explorer-verify reads any 200 answer with `status` `"1"` and no `result` this way: empty, `null`
or absent. It does not check `message`. It then:

1. logs at `warn` and emits `verify.retry` with `reason` `empty-submit`
   ([Logging and events](logging-and-events.md));
2. waits `pollIntervalMs`, 3000 ms by default, but never past 30 seconds after the first submit;
3. looks the contract up, since the empty answer may hide a submit Blockscout accepted. A match
   ends the submit as `already-verified`. A failed lookup throws its error, whose message says the
   submit may already have been accepted;
4. otherwise submits again.

It sends at most 4 submits, the first included, all within 30 seconds of the first. The cap is low
because an instance's `/api` allows few requests ([Rate limits](#rate-limits)). With a
`pollIntervalMs` of 30 seconds or more, it waits until the 30 seconds are up, submits once more,
and stops.

| When it stops                              | The call throws                                        |
| ------------------------------------------ | ------------------------------------------------------ |
| After the last submit                      | [`unexpected-response`](errors/unexpected-response.md) |
| The next submit would pass the time budget | [`timeout`](errors/timeout.md)                         |

Both hints say to try again later.

The `unexpected-response` holds the number of submits sent in `details.attempts`. The `timeout`
holds `details.reason` `empty-submit`. For either one, `hintFor(error, "user")` gives a tool's users
their own hint. It says the explorer did not start the verification, and asks them to check the
contract's page on the explorer, then to try again in a minute.

## A submit without a clear answer

A submit may reach Blockscout without explorer-verify learning the job id: no response, a 500, 502
or 504, or a 200 whose body failed, stalled or is not JSON. explorer-verify does not send such a
submit again blindly. It looks the contract up first: a match ends the submit as
`already-verified`; no match sends it once more. If the second submit also gets no clear answer,
the call throws that error.

## Rate limits

Each instance sets its own limits, per window and IP address. One measured instance allowed:

| API      | Requests per window | Window           |
| -------- | ------------------- | ---------------- |
| `/api`   | 10                  | About 22 minutes |
| REST API | 150                 | The same window  |

The headers `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset` report them. Over
the limit the instance answers HTTP 429.

One `verify()` call sends one submit and one status request per `pollIntervalMs` to `/api`; its
lookups go to the REST API. A few calls in a row can reach the `/api` limit. The reset comes later
than a call's time budget, so the call then ends with [`rate-limited`](errors/rate-limited.md).

Requests refused in the meantime seemed to move the reset later. Wait for it before you call
`verify()` again.

## ZKsync compiler input

On ZKsync Era (324) and ZKsync Sepolia (300), `kind: "zksolc"` sends two compiler fields:

| Field             | Value                                    |
| ----------------- | ---------------------------------------- |
| `compilerversion` | `v<solcVersion>`, the upstream long form |
| `zksolcVersion`   | `v<version>`                             |

The Standard JSON input stays in `sourceCode`, and supplied constructor arguments are kept.
`solcFork` describes the build and is not a form field. The library does not derive constructor
arguments from EraVM creation code. Other backend and chain pairs refuse this kind before any
request; the hosted API is not enabled for it.

The lookup can include `zk_compiler_version`. Verification is still decided by `is_verified`,
`is_fully_verified` and `is_partially_verified`, as for solc. Recorded lookups cover both
instances. A live zksolc submission remains unmeasured; see
[issue #208](https://github.com/aelmanaa/explorer-verify/issues/208).

## The hosted API

Blockscout's docs call the per-instance API deprecated, with no removal date, and point to the
hosted API instead. The hosted API serves each chain it indexes at
`https://api.blockscout.com/<chainId>/api`, with the same requests and answers as an instance.

It needs a key on every plan, the free one included; get one at
[dev.blockscout.com](https://dev.blockscout.com/). explorer-verify reaches it as the backend
`blockscout-hosted`. Name it in `route.backend`, and pass the key as
`apiKeys["blockscout-hosted"]`:

```ts [blockscout-hosted.ts]
import { readFile } from "node:fs/promises";

import { validateInput, verify } from "explorer-verify";

const text = await readFile("greeter-sepolia.json", "utf8");
const input = validateInput(JSON.parse(text));
// On a server: the hosted API cannot be used from a browser.
const result = await verify(input, {
  route: { backend: "blockscout-hosted" },
  apiKeys: { "blockscout-hosted": blockscoutKey },
});
console.log(`${result.status} ${result.backend}`);
```

```text
already-verified blockscout-hosted
```

> [!IMPORTANT]
> The key goes in the `authorization` header, as `Bearer <key>`, on every request, never in a
> URL. It goes only to `api.blockscout.com` ([API keys](api-keys.md#apikeys)). The hosted API
> sends no CORS headers, so a browser cannot use it.

- The routing table never picks `blockscout-hosted`. A call reaches it only when `route.backend`
  or a `verifyEach()` entry names it.
- `backends: "all"` leaves it out, even with its key, because a contract verified there shows on
  the chain's instance too.
- The chain needs no row. A chain the hosted API does not serve answers HTTP 404
  `Network not supported`, which throws [`unsupported-chain`](errors/unsupported-chain.md).
- The result's `explorerUrl` is the contract page of the instance that the chain's row lists,
  when it lists one.
- A handle is `ev1:blockscout-hosted:<chainId>:<address>:<jobId>`, so
  [checkStatus()](check-status.md) and the CLI's `status` resume on the hosted API.
- `linkProxy()` sends the instance's proxy-link requests with the key. They were not run against
  the hosted API.
- From the CLI: `--backend blockscout-hosted`, with the key in `BLOCKSCOUT_API_KEY`, a key file
  or stdin ([CLI](cli.md#api-keys-and-route-options)).
- The [server handler](server-handler.md) forwards only Etherscan. In a browser, use the
  `blockscout` backend, which needs no key.

### Key answers

Without a key and without `fetch`, the call throws [`missing-api-key`](errors/missing-api-key.md)
before any request. With `fetch` set, the request goes out, and the answer decides:

| Answer                                                                           | Error                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------------- |
| HTTP 401 `Unauthorized`, a key the API does not know                             | [`api-key-rejected`](errors/api-key-rejected.md)   |
| HTTP 402 to a request that carried a key                                         | [`api-key-rejected`](errors/api-key-rejected.md)   |
| HTTP 402 `Featured chain <id> requires one of the following plans: ...`          | [`api-key-rejected`](errors/api-key-rejected.md)   |
| Any other HTTP 402, as `Proceed with API key or make a X402 payment to continue` | [`missing-api-key`](errors/missing-api-key.md)     |
| HTTP 404 `Network not supported`                                                 | [`unsupported-chain`](errors/unsupported-chain.md) |

The key errors exit with code 3 and `unsupported-chain` with code 2. None is retryable, and no
error holds the key or the explorer's text.

A free-plan key was refused for Base Sepolia (84532) with the `Featured chain` answer, and
accepted for Sepolia (11155111). A free plan is also refused once its daily credits are spent;
such a 402 to a keyed request reads as `api-key-rejected`. The hint of that error names the
`blockscout` backend, which needs no key.

### Hosted rate limits

| Free plan           | Value         |
| ------------------- | ------------- |
| Requests per second | 5             |
| Credits per day     | 100,000       |
| Credits per request | 20 by default |

Each answer carries `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` and
`x-credits-remaining`. The reset is in milliseconds.

Over the limit, the hosted API answers HTTP 429 `{"error":"Too Many Requests"}` with no
`Retry-After`. explorer-verify retries it with backoff, as for an instance. Of 12 requests sent at
once, 5 got answers and 7 got HTTP 429.

## Behaviour to know

- Most jobs pass by their first status request, a few seconds after the submit. One was still
  pending after 12 seconds.
- A form-encoded and a multipart submit both work. explorer-verify sends the form-encoded one.
- The job id is the address without `0x`, followed by 8 more hex digits.

## Sources

- The per-instance API deprecated, and the hosted API's address:
  [Blockscout APIs](https://docs.blockscout.com/devs/apis), read 2026-11-05.
- Hosted plan limits and credits:
  [API general info, pricing, and routes](https://docs.blockscout.com/devs/pro-api-routes), read
  2026-11-05.
- The hosted API's 429 on 12 parallel requests, and a contract verified there showing on
  `eth-sepolia.blockscout.com` right after: live runs on 2026-11-05.
- `bytecodeHash` `"none"` builds, the bytecode database match, the empty submit answer, the rate
  limits of `base-sepolia.blockscout.com`, job timing on Base Sepolia, and form-encoded and
  multipart submits: live runs on 2026-11-04.
- A bytecode database match that held another project's source, `AuctionProxy` for a contract
  deployed as `EvProxy` on Ethereum Sepolia: live run on 2026-11-10.
