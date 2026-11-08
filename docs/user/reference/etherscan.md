# Etherscan

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who need to know what explorer-verify sends to Etherscan and how it
reads each answer.

explorer-verify talks to Etherscan through its API v2 at `https://api.etherscan.io/v2/api`, or at
the server that the `route` option names, such as your own
[server handler](server-handler.md). One API serves every chain Etherscan covers; the chain goes in
the query as `chainid`. Etherscan needs an API key ([API keys](api-keys.md)).
[verify()](verify.md) and [checkStatus()](check-status.md) use this client.

The routing table lists Etherscan v2 for the 55 chains of the Etherscan chainlist, each with its
explorer host ([Routing](routing.md#etherscan-rows-and-paid-plans)). Pass the key in `apiKeys`:

```ts
import { verify } from "explorer-verify";

const result = await verify(input, { apiKeys: { "etherscan-v2": etherscanKey } });
console.log(`${result.status} ${result.backend}`);
if (result.status !== "failed") {
  console.log(result.explorerUrl);
}
```

```text
already-verified etherscan-v2
https://sepolia.etherscan.io/address/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc#code
```

The result's `explorerUrl` is the contract's page on the chain's explorer. Without a key, the
call goes to Sourcify. On the 10 chains that need a paid Etherscan plan, Sourcify comes first: add
`route: { backend: "etherscan-v2" }` to use Etherscan there.

From a browser, pass `route: { backend: "etherscan-v2" }` and a `fetch` that sends the requests to
your [server handler](server-handler.md#point-the-client-at-it), which adds the key.

## Requests

Every request is `POST <api>?chainid=<id>` with a form-encoded body (`application/x-www-form-urlencoded`):
`module=contract`, the action, its fields and `apikey`. The key goes in the body and never in the
URL, so it is never in a logged URL.

| Step   | `action`            | Fields                             | Sends                                                     |
| ------ | ------------------- | ---------------------------------- | --------------------------------------------------------- |
| Lookup | `getsourcecode`     | `address`                          | Nothing. Safe to repeat                                   |
| Submit | `verifysourcecode`  | see below                          | The source. Outward and permanent: Etherscan publishes it |
| Status | `checkverifystatus` | `guid`, the job id from the submit | Nothing. Safe to repeat                                   |

The submit fields:

- `codeformat`: `solidity-standard-json-input`.
- `sourceCode`: the JSON text of `compiler.input` with only `language`, `sources` and `settings`.
- `contractaddress`: `address`.
- `contractname`: `contractName`, as `contracts/Greeter.sol:Greeter`.
- `compilerversion`: `compiler.version` with one leading `v`, as `v0.8.24+commit.e11b9ed9`.
- `constructorArguments` and `constructorArguements`: `constructorArgs` without `0x`, both with the
  same value. Both are left out when the contract takes no arguments.

## How answers are read

Etherscan answers almost everything with HTTP 200 and puts the meaning in the `result` text. The
client matches the start of that text. An answer that this table does not list throws an error. It
never reads as "not verified", as `failed` or as success.

| Step   | Answer                                                        | Outcome                                                                                                                                                          |
| ------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any    | `Max calls per sec rate limit reached`                        | Retried with backoff; [`rate-limited`](errors/rate-limited.md) once the retries stop                                                                             |
| Any    | `Max daily rate limit reached` or `Daily limit of …`          | [`quota-exceeded`](errors/quota-exceeded.md), at once                                                                                                            |
| Any    | `Missing/Invalid API Key`                                     | [`missing-api-key`](errors/missing-api-key.md)                                                                                                                   |
| Any    | `Invalid API Key …`                                           | [`api-key-rejected`](errors/api-key-rejected.md)                                                                                                                 |
| Any    | `Free API access is not supported for this chain …`           | [`api-key-rejected`](errors/api-key-rejected.md), with a hint to use a paid plan or Sourcify: the key's plan does not cover the chain                            |
| Any    | `Missing or unsupported chainid parameter …`                  | [`unsupported-chain`](errors/unsupported-chain.md)                                                                                                               |
| Any    | `You are using a deprecated V1 endpoint …`                    | [`unexpected-response`](errors/unexpected-response.md): the route points at a retired Etherscan host; the hint says to use `etherscan-v2` without `route.apiUrl` |
| Lookup | `SourceCode` not empty, `SimilarMatch` empty or absent        | Verified, `exact`                                                                                                                                                |
| Lookup | `SourceCode` not empty, `SimilarMatch` names a contract       | Verified, `partial`                                                                                                                                              |
| Lookup | `SimilarMatch` present but not text                           | [`unexpected-response`](errors/unexpected-response.md)                                                                                                           |
| Lookup | `SourceCode` empty                                            | Not verified                                                                                                                                                     |
| Lookup | Anything else, a `result` that is not an array included       | [`unexpected-response`](errors/unexpected-response.md)                                                                                                           |
| Submit | `status` `"1"` and a job id                                   | A job to poll                                                                                                                                                    |
| Submit | `Contract source code already verified` or `Already Verified` | `already-verified`, with the match a lookup reads; [`unexpected-response`](errors/unexpected-response.md) when that lookup finds it not verified                 |
| Submit | `Unable to locate ContractCode at …`                          | Sent again every `pollIntervalMs`, at most 10 submits; see below                                                                                                 |
| Submit | Anything else                                                 | [`unexpected-response`](errors/unexpected-response.md)                                                                                                           |
| Status | `Pending in queue`                                            | Still pending                                                                                                                                                    |
| Status | `Pass - Verified`                                             | `verified`, `exact`                                                                                                                                              |
| Status | `Contract source code already verified` or `Already Verified` | `already-verified`; a lookup reads the match                                                                                                                     |
| Status | `Fail - Unable to verify …`                                   | One lookup: `exact` gives `verified`; `partial` gives `already-verified`; none gives `failed`, with the text as `reason`                                         |
| Status | `Unable to locate guid` or `Invalid GUID length`              | [`job-not-found`](errors/job-not-found.md)                                                                                                                       |
| Status | Any other text                                                | [`unknown-state`](errors/unknown-state.md)                                                                                                                       |

The rate-limit answer comes with HTTP 200, not 429. It is retried as a 429 is: the same backoff,
attempt limit and time budget, and a `verify.retry` event with `reason` `rate-limited`
([Logging and events](logging-and-events.md)).

A `failed` reason is redacted with the call's keys and cut to 300 characters.

`Unable to locate ContractCode at …` means Etherscan finds no contract code at the address on that
chain. Right after a deployment, Etherscan may not have indexed the contract yet, so the submit is
sent again every `pollIntervalMs`, with a `verify.retry` event whose `reason` is `not-indexed`
before each wait. After 10 submits the call throws
[`unexpected-response`](errors/unexpected-response.md); when the next submit would pass the time
budget, [`timeout`](errors/timeout.md). The hint of both says to check that `chainId` and `address`
name a contract deployed on that chain: a wrong chain id or address gives the same answer.

## A submit without a clear answer

A submit may reach Etherscan without explorer-verify learning the job id: no response, a 500, 502
or 504, or a 200 whose body failed, stalled or is not JSON. explorer-verify does not send such a
submit again blindly. It looks the contract up first: a match ends the submit as
`already-verified`; no match sends it once more. If the second submit also gets no clear answer,
the call throws that error.

## Behaviour to know

- Similar Match: Etherscan verifies a contract on its own when its creation code matches one already
  verified. Its lookup then names the matched contract in `SimilarMatch`. explorer-verify reports
  `partial`, because the stored source is another contract's, not one submitted for this address,
  although the explorer page can show `Exact Match` next to it
  ([Match types](../explanation/match-types.md)).
- `Fail - Unable to verify` was once answered for a contract that a lookup showed verified moments
  later, right after a deployment. So explorer-verify checks with one lookup before it reports
  `failed`. An exact match means the job did verify the source: `verified`. A partial match is
  Etherscan's own match from another contract, while the submitted source was rejected:
  `already-verified`. If that lookup fails, the status poll counts as failed and polling goes on, as
  for any failed poll. When polls keep failing, or the budget runs out, the call ends with
  [`not-confirmed`](errors/not-confirmed.md) and the handle; it never reports `failed` from a
  verdict it could not check.
- On 2026-11-03, Etherscan gave an exact match for two contracts submitted without constructor
  arguments, and with wrong ones, and recorded the arguments from the chain
  ([live probes](../../contributor/research/2026-11-03-m2-live-probes.md#a-etherscan-with-constructor-arguments-omitted-or-wrong)).
  This was one chain and two contracts.
- Paid-plan chains: on 2026-11-04, a free-plan key on the 11 chains marked "Paid Plan required"
  got normal answers to `getsourcecode` and `checkverifystatus`. The same key got
  `Free API access is not supported for this chain …` for `account` `balance` on 8 of those chains
  ([research note](../../contributor/research/2026-11-04-etherscan-rows.md#a-free-plan-key-on-the-paid-plan-chains)).
  The answer to a submit with a free-plan key was not recorded. If Etherscan gives that text to any
  request, the call throws [`api-key-rejected`](errors/api-key-rejected.md) with a hint to use a
  key on a paid plan, or to verify on Sourcify with `route: { backend: "sourcify" }`.
- Etherscan's plan rules apply to how you use your key
  ([Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md)).
