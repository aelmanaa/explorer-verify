# Routescan

Version: explorer-verify 0.2.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who need to know what explorer-verify sends to Routescan and how it
reads each answer.

Routescan serves an Etherscan-compatible API for Avalanche and other chains.
[verify()](verify.md) and [checkStatus()](check-status.md) use this client.

| Fact         | Value                                                             |
| ------------ | ----------------------------------------------------------------- |
| Server       | One URL per chain, with the network and the chain id in the path  |
| API key      | Optional ([API keys](api-keys.md))                                |
| Browsers     | Answers them directly, with or without a key                      |
| Chains       | 38 in the routing table ([Routing](routing.md#routescan-entries)) |
| Explorer URL | None in the result                                                |

Each chain's API URL has this shape, where the network is `mainnet` or `testnet`:

```text
https://api.routescan.io/v2/network/<network>/evm/<chain id>/etherscan/api
```

## When the call goes to Routescan

Routescan comes last in a row of the routing table. The table derives each chain's URL from its
network.

| Chain                                                                       | What to pass                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------- |
| Its row lists only Routescan, such as Henesys (68414)                       | Nothing                                        |
| Its row also lists Sourcify or Etherscan v2, such as Avalanche Fuji (43113) | `route: { backend: "routescan" }`              |
| Any other chain                                                             | `route.backend` `routescan` and `route.apiUrl` |

## A minimal call

This call resumes a job on Avalanche Fuji (43113) that Routescan has since forgotten. The lookup
that follows finds the contract verified:

```ts [resume.ts]
import { checkStatus } from "explorer-verify";

const handle =
  "ev1:routescan:43113:0x636522c3785337399aa9105498d2bd95dc01d749:" +
  "f111a4c8-368c-51d2-8163-c7ab477a1d91";
const result = await checkStatus(handle, {
  route: { backend: "routescan" },
});
console.log(`${result.status} ${result.backend}`);
```

```text
verified routescan
```

`verify()` takes the same `route`. On a chain the table does not list for Routescan, add the URL.
Replace `43114` with your chain's id:

<!-- no-run: a live submit to Routescan; the example above runs. -->

```ts no-run [verify-routescan.ts]
import { readFile } from "node:fs/promises";

import { validateInput, verify } from "explorer-verify";

const text = await readFile("verify-input.json", "utf8");
const input = validateInput(JSON.parse(text));
const result = await verify(input, {
  route: {
    backend: "routescan",
    apiUrl:
      "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api",
  },
});
console.log(result.status);
```

## API key

A key is optional. It goes in the `apikey` request header, never in the URL or the body. Where it
may go depends on where you set it:

| Option              | Sent to                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| `route.apiKey`      | The host of your `route.apiUrl`, whatever that host is                             |
| `apiKeys.routescan` | `api.routescan.io`, only on a chain with a Routescan entry, without `route.apiUrl` |

`apiKeys.routescan` does not move a call to Routescan on a row that lists Sourcify or Etherscan v2
first. Pass `route.backend` for that.

| Tier    | Limits                                  | How Routescan reads it                 |
| ------- | --------------------------------------- | -------------------------------------- |
| Keyless | 2 requests a second, 10,000 calls a day | No `apikey` header                     |
| Free    | 300 requests a minute, 100,000 a day    | A key it knows, in the `apikey` header |

A key Routescan does not know is not refused. The answer is the keyless one, so a wrong key goes
unnoticed and the call runs on the keyless tier.

> [!IMPORTANT]
> A keyed call from a browser works: Routescan allows the `apikey` header from any origin. But a
> key in a page is readable by everyone who loads it. Keep a key you need to protect on a server,
> or use the keyless tier from the browser.

## Requests

No request sends a `chainid` parameter: the chain is in the URL.

| Step   | Request                                                                              | Sends                                                     |
| ------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Lookup | `GET <api>?module=contract&action=getsourcecode&address=<address>&nocache=<n>`       | Nothing. Safe to repeat                                   |
| Submit | `POST <api>`, form-encoded: `module=contract`, `action=verifysourcecode`, the fields | The source. Outward and permanent: Routescan publishes it |
| Status | `GET <api>?module=contract&action=checkverifystatus&guid=<job id>&nocache=<n>`       | Nothing. Safe to repeat                                   |

The submit fields are the ones the [Etherscan](etherscan.md#requests) client sends.

`nocache` holds random characters, drawn again for every attempt, retries included. Routescan's
CDN answers a repeated GET URL from its cache, and once served a cached `Pending in queue` 51
minutes after the job had passed.

A lookup is a GET because Routescan answers `getsourcecode` sent as a form POST with
`Invalid querystring request`.

## How answers are read

Routescan answers with HTTP 200 and the Etherscan fields `status`, `message` and `result`. The
client reads them as the [Etherscan](etherscan.md#how-answers-are-read) client does, with these
additions:

| Step   | Answer                                                                                | Outcome                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Any    | `message` `chain not supported`, `result` `null`                                      | [`unsupported-chain`](errors/unsupported-chain.md); never `failed`                                                                |
| Any    | HTTP 429, `code` `rate-limit`                                                         | Retried with backoff; [`rate-limited`](errors/rate-limited.md) once the retries stop. See [Rate limits](#rate-limits)             |
| Lookup | `SourceCode` not empty                                                                | Verified, `partial`: no field shows that the metadata hash matched. `ContractName` and `CompilerVersion` name the stored contract |
| Status | `Pass - Verified`                                                                     | `verified`, `partial`: Routescan states no grade                                                                                  |
| Status | `Verification not found`                                                              | [`job-not-found`](errors/job-not-found.md) from the client; `verify()` and `checkStatus()` then look the contract up, see below   |
| Status | `Missing guid`                                                                        | [`unexpected-response`](errors/unexpected-response.md)                                                                            |
| Status | `Error: Compilation successful, but bytecode does not match with deployed bytecode …` | `failed`, with the text as `reason`; no lookup                                                                                    |

`Missing guid` means the status request was malformed. In `verify()` and `checkStatus()` it counts
as a failed poll, as any `unexpected-response` does. Polling goes on, and after 3 failed polls in
a row one more lookup decides ([verify()](verify.md), steps 4 and 6).

Routescan gives the bytecode answer, with `status` `0` and `message` `NOTOK`, when the source
compiles but its bytecode differs from the deployed bytecode. The full text ends with
`for address <address>, please check your parameters`. The client matches the text before the
address.

Any other status text still gives [`unknown-state`](errors/unknown-state.md). The Etherscan client
does not map the bytecode text, because Etherscan has not been recorded giving it.

`chain not supported` also comes back for a chain Routescan serves when the URL names the wrong
network, such as `mainnet` for Fuji.

## Rate limits

Over its limit Routescan answers HTTP 429 with this body, with or without a key:

<!-- code-width: JSON strings do not break -->

```json
{
  "statusCode": 429,
  "code": "rate-limit",
  "error": "Too Many Requests",
  "message": "You are reaching the maximum number of requests for this API. To avoid disruptions, please consider slowing down your requests. If you need a higher limit, consider requesting a personalized API key by visiting: https://rscan.link/api."
}
```

| Tier    | Limit seen                  | What the library does                                         |
| ------- | --------------------------- | ------------------------------------------------------------- |
| Keyless | About 120 requests a minute | Retries with backoff, at most 5 attempts, then `rate-limited` |
| Keyed   | 300 requests a minute       | Reads `x-ratelimit-rpm-retry-after` as `Retry-After`          |

A keyed 429 has no `Retry-After` header; its wait is in `x-ratelimit-rpm-retry-after`, in
seconds. A wait above 30 s throws `rate-limited` at once with `details.retryAfterMs`. A shorter
one is waited.

The keyed limit counts per minute: 300 requests sent within 2.6 s were all answered, and the next
ones got the 429 with a wait of 58 seconds.

In a browser the page cannot read the `x-ratelimit-*` headers, because Routescan does not expose
them to CORS. There a keyed 429 is retried with backoff, as a keyless one is.

The client also retries Etherscan's `Max calls per sec rate limit reached` text, as the Etherscan
client does. Any other answer throws an error and is never read as a result.

## Behaviour to know

- Routescan forgets a job. A job answered `Pass - Verified`, then `Verification not found` 51
  minutes after the submit, while the contract stayed verified.
- On `Verification not found`, `verify()` and `checkStatus()` look the contract up once. Verified
  gives `verified`; otherwise the call throws `job-not-found` with the handle.
- When the time budget runs out while the status still says `Pending in queue`, one more lookup
  decides, as for every backend: a match gives `verified`.
- Routescan can hold another contract's source for an address. On Ethereum Sepolia, it held
  `SimpleStorage` compiled with `v0.8.33` for a contract deployed as `EvBox` with `v0.8.34`,
  within two minutes of the deployment. `verify()` compares the stored contract with the input,
  and submits when either part differs ([Match types](../explanation/match-types.md)):
  - `ContractName` with the part of `contractName` after its last `:`;
  - `CompilerVersion` with `compiler.version`.
- Routescan states no grade, so every match is `partial`, from a lookup or from `Pass - Verified`.
  It answered `Pass - Verified` for a build without a metadata hash, which Sourcify and Blockscout
  graded partial. It also held copies of Sourcify and Blockscout submits seconds after them.
- With `submitOverPartial`, `verify()` submits over every Routescan match, since each is
  `partial`. On Ethereum Sepolia on 2026-11-11, Routescan accepted the exact source over a
  partial source it held, answered `Pass - Verified`, and its `getsourcecode` then returned the
  exact source ([Submit over a partial match](verify.md#submit-over-a-partial-match)).
- Routescan replaces the stored source on a resubmit, so a build that differs only in its
  metadata can replace an exact source with a partial one. A forgotten job of such a call always
  ends with `job-not-found`: its lookup finds a `partial` match, which does not confirm the job.
- `Fail - Unable to verify` followed by a lookup that finds the source, even your own, now gives
  `already-verified` with `partial`. 0.1.0 gave `verified` with `exact` there. The lookup's grade
  is `partial`, and a `partial` lookup after a failed job reads as a match that was there before.
- The job id is a UUID, such as `f111a4c8-368c-51d2-8163-c7ab477a1d91`.
- Routescan's explorer lists name chains its API does not serve, among them OP Mainnet (10) and
  OP Sepolia (11155420). The table has no Routescan entry for them.

## Sources

- The 38 chains whose API answered a keyless probe: live run on 2026-11-05.
- Keyless limits:
  [Routescan rate limits](https://docs.routescan.io/plans-and-limits/rate-limits), read
  2026-11-03.
- The free plan's `x-ratelimit-*` headers, the CORS preflight from a Chromium page, the 429 body
  and the limits seen: live runs on 2026-11-05.
- The cached `Pending in queue` and the forgotten job: live run on 2026-11-03.
- `getsourcecode` as a form POST, and the bytecode answer on Avalanche Fuji and Sepolia: live runs
  on 2026-11-04.
- The network of each of the 24 chains on Routescan's supported-chains page: live run on
  2026-11-04,
  [research note](../../contributor/research/2026-11-04-routescan-client.md#chains-confirmed-on-2026-11-04).
- 7 of 45 chains named in the explorer lists answering `chain not supported`: live run on
  2026-11-05, [research note](../../contributor/research/2026-11-05-routescan-rows.md).
- Another contract's source held for a new contract, `Pass - Verified` for a build without a
  metadata hash, and copies of Sourcify and Blockscout submits: live runs on Ethereum Sepolia on
  2026-11-10,
  [research note](../../contributor/research/2026-11-10-no-metadata-hash-grades.md#results).
