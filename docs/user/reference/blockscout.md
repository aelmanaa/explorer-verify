# Blockscout

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who need to know what explorer-verify sends to a Blockscout
explorer and how it reads each answer.

A Blockscout explorer serves one chain from its own host, with its API at `<origin>/api`, such as
`https://eth-sepolia.blockscout.com/api`. explorer-verify talks to one such instance at a time. It
sends no API key, and a Blockscout instance answers browsers directly. [verify()](verify.md) and
[checkStatus()](check-status.md) use this client. Blockscout's hosted API at
`api.blockscout.com` serves many chains and needs a key: it is the separate backend
`blockscout-hosted` ([The hosted API](#the-hosted-api)).

The routing table lists a Blockscout instance for 111 chains
([Blockscout rows](routing.md#blockscout-rows)). On those, `route: { backend: "blockscout" }`
reaches the instance with no `apiUrl`, and the result has the contract page
`https://<instance>/address/<address>?tab=contract`. Sourcify comes first in a row that has it, so
name the backend to verify on Blockscout. On another chain, or another instance, set `route.apiUrl`
to the instance's `/api` ([Routing](routing.md#route)):

```ts
import { verify } from "explorer-verify";

const result = await verify(input, {
  route: { backend: "blockscout", apiUrl: "https://eth-sepolia.blockscout.com/api" },
});
console.log(`${result.status} ${result.backend}`);
```

```text
already-verified blockscout
```

A `route.apiUrl` that does not end in `/api` throws [`invalid-input`](errors/invalid-input.md)
naming `route.apiUrl`. Trailing slashes are removed first, so `https://eth-sepolia.blockscout.com/api/`
is accepted. A path before `/api` is kept: with `https://example.org/explorer/api`, the lookup goes
to `https://example.org/explorer/api/v2/smart-contracts/<address>`. A key in `route.apiKey` or `apiKeys.blockscout` also throws `invalid-input`
([API keys](api-keys.md)). So does a `route.apiUrl` on `api.blockscout.com`: the hosted API is
`blockscout-hosted`. A result has no `explorerUrl` when `route.apiUrl` names an instance
other than the one the chain's row lists.

## ZKsync compiler input

On ZKsync Era (324) and ZKsync Sepolia (300), `kind: "zksolc"` sends the upstream long
`solcVersion` as `compilerversion=v<solcVersion>` and `version` as `zksolcVersion=v<version>`.
The Standard JSON input stays in `sourceCode`, and supplied constructor arguments are preserved.
`solcFork` describes the build and is not an extra form field. The library does not derive
constructor arguments from EraVM creation code. Other backend and chain pairs refuse this kind
before requests; the hosted API is not enabled for it.

The lookup can include `zk_compiler_version`. Verification is still decided by `is_verified`,
`is_fully_verified` and `is_partially_verified`, as for solc. A compiler version alone does not
prove verification. Recorded lookups cover both instances. A live zksolc submission remains
unmeasured; see [issue #208](https://github.com/aelmanaa/explorer-verify/issues/208).

## The hosted API

Blockscout's docs say the per-instance API "has been deprecated", with no removal date, and point
to the hosted API instead ([Blockscout APIs](https://docs.blockscout.com/devs/apis), read
2026-11-05). The hosted API serves each chain it indexes at
`https://api.blockscout.com/<chainId>/api`, with the same requests and the same answers as an
instance. It needs a key on every plan, the free one included; get one at
[dev.blockscout.com](https://dev.blockscout.com/).

explorer-verify reaches it as the backend `blockscout-hosted`. Name it in `route.backend`, and
pass the key as `apiKeys["blockscout-hosted"]`:

```ts
import { verify } from "explorer-verify";

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

- The routing table never picks `blockscout-hosted`: a call reaches it only when `route.backend`
  or a `verifyEach()` entry names it. `backends: "all"` leaves it out, even with its key, because
  a contract verified there shows on the chain's instance too.
- The chain needs no row. A chain the hosted API does not serve answers HTTP 404
  `Network not supported`, which throws [`unsupported-chain`](errors/unsupported-chain.md).
- The result's `explorerUrl` is the contract page of the instance that the chain's row lists, when
  it lists one. On 2026-11-05 a contract verified through the hosted API showed as verified on
  `eth-sepolia.blockscout.com` right after.
- The key goes in the `authorization` request header, as `Bearer <key>`, on every request, never
  in a URL. It goes only to `api.blockscout.com` ([API keys](api-keys.md#apikeys)). The
  `blockscout` backend, an instance, never gets it.
- A handle is `ev1:blockscout-hosted:<chainId>:<address>:<jobId>`, so
  [checkStatus()](check-status.md) and the CLI's `status` resume on the hosted API.
- `linkProxy()` sends the instance's proxy-link requests with the key. They were not run against
  the hosted API.
- From the CLI: `--backend blockscout-hosted`, with the key in `BLOCKSCOUT_API_KEY`, a key file or
  stdin ([CLI](cli.md#api-keys-and-route-options)).

Not from a browser: the hosted API sends no CORS headers, so a browser cannot read its answers,
and the [server handler](server-handler.md) forwards only Etherscan. In a browser, use the
`blockscout` backend, which needs no key.

### Key answers

Without a key and without `fetch`, the call throws [`missing-api-key`](errors/missing-api-key.md)
before any request. With `fetch` set, the request goes out, and the answer decides. The key errors
exit with code 3, `unsupported-chain` with code 2, and none is retryable. No error holds the key or
the explorer's text.

| Answer                                                                           | Error                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------------- |
| HTTP 401 `Unauthorized`, a key the API does not know                             | [`api-key-rejected`](errors/api-key-rejected.md)   |
| HTTP 402 to a request that carried a key                                         | [`api-key-rejected`](errors/api-key-rejected.md)   |
| HTTP 402 `Featured chain <id> requires one of the following plans: ...`          | [`api-key-rejected`](errors/api-key-rejected.md)   |
| Any other HTTP 402, as `Proceed with API key or make a X402 payment to continue` | [`missing-api-key`](errors/missing-api-key.md)     |
| HTTP 404 `Network not supported`                                                 | [`unsupported-chain`](errors/unsupported-chain.md) |

A free-plan key was refused for Base Sepolia (84532) with the `Featured chain` answer, and accepted
for Sepolia (11155111). Blockscout's docs say a free plan is refused once its daily credits are
spent, without the answer's text; such a 402 to a keyed request reads as `api-key-rejected`. The
hint of that error names the `blockscout` backend, which needs no key.

### Hosted rate limits

The free plan allows 5 requests per second and 100,000 credits a day; a request costs 20 credits
by default ([API general info, pricing, and routes](https://docs.blockscout.com/devs/pro-api-routes),
read 2026-11-05). Each answer carries `x-ratelimit-limit`, `x-ratelimit-remaining`,
`x-ratelimit-reset` (milliseconds) and `x-credits-remaining`. Over the limit, the hosted API
answers HTTP 429 `{"error":"Too Many Requests"}` with no `Retry-After`; explorer-verify retries it
with backoff, as for an instance. On 2026-11-05, 12 requests sent at once got 5 answers and 7
HTTP 429.

## Requests

The lookup goes to the instance's REST API, which tells a full match from a partial one. The submit
and the status request go to its Etherscan-compatible API, as a POST with a form-encoded body
(`application/x-www-form-urlencoded`) that holds `module=contract`, the action and its fields. All
three are built from the instance's `/api` URL, `<api>` below, and none carries a key.
`blockscout-hosted` sends the same requests to `https://api.blockscout.com/<chainId>/api`, each
with the key in the `authorization` header.

| Step   | Request                                                       | Sends                                                      |
| ------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| Lookup | `GET <api>/v2/smart-contracts/{address}`                      | Nothing. Safe to repeat                                    |
| Submit | `POST <api>`, `action=verifysourcecode`                       | The source. Outward and permanent: Blockscout publishes it |
| Status | `POST <api>`, `action=checkverifystatus`, `guid` (the job id) | Nothing. Safe to repeat                                    |

The submit fields:

- `codeformat`: `solidity-standard-json-input`.
- `sourceCode`: the JSON text of `compiler.input` with only `language`, `sources` and `settings`.
- `contractaddress`: `address`.
- `contractname`: `contractName`, as `contracts/Greeter.sol:Greeter`.
- `compilerversion`: `compiler.version` with one leading `v`, as `v0.8.24+commit.e11b9ed9`.
- `constructorArguments`: `constructorArgs` with a `0x` prefix. Left out when the input has none.

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
| Lookup | 200, `is_verified` `true`, `is_fully_verified` `true`     | Verified, `exact`                                                                                                                                |
| Lookup | 200, `is_verified` `true`, `is_partially_verified` `true` | Verified, `partial`                                                                                                                              |
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
metadata hash, so Blockscout can only reach a partial match for it. On 2026-11-04, such a build
answered `Pass - Verified`, and the lookup then gave `is_partially_verified` `true`. explorer-verify
reports `verified` with `partial`. For that build, it is the best outcome, not a failure
([Match types](../explanation/match-types.md)).

Blockscout's bytecode database can also verify a contract on its own when its code, without the
metadata part, matches a contract verified before. On 2026-11-04, a contract with the same code as
one verified a minute earlier showed a partial match after its first lookup, with
`is_verified_via_eth_bytecode_db` `true`. `verify()` then returns `already-verified` with `partial`
and sends no submit.

Blockscout answers `Smart-contract already verified.` only for a full match. A contract with a
partial match takes a new submit, but `verify()` does not send one: its first lookup returns
`already-verified` with `partial`.

## The empty answer right after a deployment

Right after a deployment, an instance can answer a submit with `status` `"1"`, `message` `OK` and
an empty `result`, with no job id. Polling cannot help, because there is no job; a new submit a few
seconds later succeeds. explorer-verify reads any 200 answer with `status` `"1"` and an empty,
`null` or absent `result` this way; it does not check `message`. It then:

1. logs at `warn` and emits `verify.retry` with `reason` `empty-submit`
   ([Logging and events](logging-and-events.md));
2. waits `pollIntervalMs`, 3000 ms by default, but never past 30 seconds after the first submit;
3. looks the contract up, since the empty answer may hide a submit Blockscout accepted. A match ends
   the submit as `already-verified` with that match. If the lookup fails, the call throws its error,
   and the message says the submit may already have been accepted;
4. otherwise submits again.

It sends at most 4 submits, the first included, all within 30 seconds of the first. The cap is low
because an instance's `/api` allowed only 10 requests in about 22 minutes on 2026-11-04 (see
[Rate limits](#rate-limits)). With a `pollIntervalMs` of 30 seconds or more, it waits until the 30
seconds are up, submits once more, and stops. When it stops, it throws
[`unexpected-response`](errors/unexpected-response.md); when the next submit would pass the time
budget, [`timeout`](errors/timeout.md). The hint of both says to call `verify()` again later.

## A submit without a clear answer

A submit may reach Blockscout without explorer-verify learning the job id: no response, a 500, 502
or 504, or a 200 whose body failed, stalled or is not JSON. explorer-verify does not send such a
submit again blindly. It looks the contract up first: a match ends the submit as
`already-verified`; no match sends it once more. If the second submit also gets no clear answer,
the call throws that error.

## Rate limits

On 2026-11-04, `base-sepolia.blockscout.com` allowed 10 requests to its `/api` and 150 to its REST
API per window and IP address, reported in the `x-ratelimit-limit`, `x-ratelimit-remaining` and
`x-ratelimit-reset` headers. Over the limit it answered HTTP 429. One `verify()` call sends one
submit and one status request per `pollIntervalMs` to `/api`; its lookups go to the REST API. A few
calls in a row can reach the `/api` limit. The reset came after about 22 minutes, longer than a
call's time budget, so the call then ends with [`rate-limited`](errors/rate-limited.md). Requests
refused in the meantime seemed to move the reset later, so wait for it before you call `verify()`
again. Each instance sets its own limits.

## Behaviour to know

- On Base Sepolia on 2026-11-04, most jobs had passed by their first status request, a few seconds
  after the submit. One was still pending after 12 seconds.
- A form-encoded and a multipart submit both worked on 2026-11-04. explorer-verify sends the
  form-encoded one.
- The job id is the address without `0x`, followed by 8 more hex digits.
