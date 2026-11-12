# Etherscan

Version: explorer-verify 0.2.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who need to know what explorer-verify sends to Etherscan and how it
reads each answer.

explorer-verify talks to Etherscan through its API v2. One API serves every chain Etherscan
covers. [verify()](verify.md) and [checkStatus()](check-status.md) use this client.

| Fact       | Value                                                                                   |
| ---------- | --------------------------------------------------------------------------------------- |
| Server     | `https://api.etherscan.io/v2/api`, or the one `route` names                             |
| Chain      | In the query, as `chainid`                                                              |
| API key    | Required ([API keys](api-keys.md))                                                      |
| Chains     | The 55 of the Etherscan chainlist ([Routing](routing.md#etherscan-rows-and-paid-plans)) |
| Browsers   | Through your [server handler](server-handler.md), which adds the key                    |
| Match type | [`exact` or `partial`](../explanation/match-types.md)                                   |

> [!IMPORTANT]
> A submit sends your source to Etherscan, which publishes it. Keep the key off the client: in a
> browser, send the requests through your [server handler](server-handler.md).

## A minimal call

Pass the key in `apiKeys`. This script verifies the sample request,
[greeter-sepolia.json](../start/greeter-sepolia.json), a Greeter already verified on Sepolia:

```ts [etherscan.ts]
import { readFile } from "node:fs/promises";

import { validateInput, verify } from "explorer-verify";

const text = await readFile("greeter-sepolia.json", "utf8");
const input = validateInput(JSON.parse(text));
const result = await verify(input, {
  apiKeys: { "etherscan-v2": etherscanKey },
});
console.log(`${result.status} ${result.backend}`);
if (result.status !== "failed") {
  console.log(result.explorerUrl);
}
```

```text
already-verified etherscan-v2
https://sepolia.etherscan.io/address/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc#code
```

The result's `explorerUrl` is the contract's page on the chain's explorer.

## When the call goes to Etherscan

| Situation                      | Backend                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| An Etherscan key in `apiKeys`  | Etherscan                                                                                                      |
| No key                         | Sourcify                                                                                                       |
| One of the 10 paid-plan chains | Sourcify first; `route: { backend: "etherscan-v2" }` for Etherscan                                             |
| A browser                      | `route: { backend: "etherscan-v2" }` and a `fetch` to [your handler](server-handler.md#point-the-client-at-it) |

## Requests

Every request is `POST <api>?chainid=<id>` with a form-encoded body. The body holds
`module=contract`, the action, its fields and `apikey`. The key goes in the body and never in the
URL, so it is never in a logged URL.

| Step   | `action`            | Fields                             | Sends                                                     |
| ------ | ------------------- | ---------------------------------- | --------------------------------------------------------- |
| Lookup | `getsourcecode`     | `address`                          | Nothing. Safe to repeat                                   |
| Submit | `verifysourcecode`  | see below                          | The source. Outward and permanent: Etherscan publishes it |
| Status | `checkverifystatus` | `guid`, the job id from the submit | Nothing. Safe to repeat                                   |

The submit fields:

| Field                   | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| `codeformat`            | `solidity-standard-json-input`                                       |
| `sourceCode`            | The JSON text of `compiler.input`: `language`, `sources`, `settings` |
| `contractaddress`       | `address`                                                            |
| `contractname`          | `contractName`, as `contracts/Greeter.sol:Greeter`                   |
| `compilerversion`       | `compiler.version` with one leading `v`                              |
| `constructorArguments`  | `constructorArgs` without `0x`; absent with no arguments             |
| `constructorArguements` | The same value; Etherscan reads this misspelled name too             |

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
| Submit | `Unable to locate ContractCode at …`                          | Sent again every `pollIntervalMs` for `indexWaitMs`, or at most 10 submits; then [`not-indexed`](errors/not-indexed.md); see below                               |
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

## A contract Etherscan has not indexed

`Unable to locate ContractCode at …` means Etherscan finds no contract code at the address on that
chain. Right after a deployment, Etherscan may not have indexed the contract yet. So the submit is
sent again every `pollIntervalMs`, for as long as the `indexWaitMs` option allows. Before each
wait, a `verify.retry` event gives `reason` `not-indexed`:

- Without `indexWaitMs`, the call sends at most 10 submits, about 27 seconds with the default
  `pollIntervalMs`.
- With `indexWaitMs`, it sends the submit again while a whole `pollIntervalMs` still fits in the
  `indexWaitMs` milliseconds since the first submit. It never cuts a wait short, so no two submits
  go out less than `pollIntervalMs` apart.

The call also stops when the next submit would pass `timeoutMs`. When it stops, it throws
[`not-indexed`](errors/not-indexed.md), which is retryable, with the number of submits and the time
since the first one in `details`. A wrong chain id or address gives the same answer, so the hint
says to check both first.

Right after a deployment, pass a longer wait and a budget that holds it:

<!-- no-run: it posts to /api/verify on the page's own origin, which a test run does not serve. -->

```ts no-run [wait-for-indexing.ts]
import { validateInput, verify } from "explorer-verify";

import greeter from "./greeter-sepolia.json" with { type: "json" };

const input = validateInput(greeter);
const result = await verify(input, {
  handlerUrl: "/api/verify",
  indexWaitMs: 120_000,
  timeoutMs: 300_000,
});
console.log(result.status);
```

Routescan and standalone Etherscan-compatible explorers that give the same answer get the same
loop. A server handler whose `deployers` option is set answers the lookup with 503
`address-not-indexed` before any submit. The client retries it as `Retry-After` asks, then throws
[`not-indexed`](errors/not-indexed.md) with `details.submits` `0`. `indexWaitMs` has no effect
there.

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
  Etherscan's own match from another contract: `already-verified`.
- If that lookup fails, the poll counts as failed and polling goes on. When polls keep failing, or
  the budget runs out, the call ends with [`not-confirmed`](errors/not-confirmed.md) and the
  handle. It never reports `failed` from a verdict it could not check.
- Etherscan gave an exact match for two contracts submitted without constructor arguments, and
  with wrong ones, and recorded the arguments from the chain. This was one chain and two
  contracts.
- Paid-plan chains: a free-plan key on the chains marked "Paid Plan required" got normal answers
  to `getsourcecode` and `checkverifystatus`. Other requests got
  `Free API access is not supported for this chain …`. The answer to a submit was not recorded.
- If Etherscan gives that text to any request, the call throws
  [`api-key-rejected`](errors/api-key-rejected.md). The hint says to use a key on a paid plan, or
  to verify on Sourcify with `route: { backend: "sourcify" }`.
- Etherscan's plan rules apply to how you use your key
  ([Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md)).

## Sources

- Constructor arguments omitted or wrong: live run on 2026-11-03,
  [live probes](../../contributor/research/2026-11-03-m2-live-probes.md#a-etherscan-with-constructor-arguments-omitted-or-wrong).
- A free-plan key on the 11 paid-plan chains, with `account` `balance` refused on 8 of them: live
  run on 2026-11-04,
  [research note](../../contributor/research/2026-11-04-etherscan-rows.md#a-free-plan-key-on-the-paid-plan-chains).
