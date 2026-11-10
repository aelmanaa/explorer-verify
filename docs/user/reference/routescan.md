# Routescan

<!-- docs-style: legacy -->

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who need to know what explorer-verify sends to Routescan and how it
reads each answer.

Routescan serves an Etherscan-compatible API for Avalanche and other chains. Each chain has its own
API URL, with the network (`mainnet` or `testnet`) and the chain id in the path:

```text
https://api.routescan.io/v2/network/<network>/evm/<chain id>/etherscan/api
```

The free tier needs no key and sends CORS headers, so a page in a browser can verify through it
directly. [verify()](verify.md) and [checkStatus()](check-status.md) use this client.

The routing table lists Routescan for the 38 chains whose API answered a keyless probe on
2026-11-05, and derives each chain's URL from its network ([Routing](routing.md#routescan-entries)).
Routescan comes last in a row:

- On a chain whose row lists only Routescan, such as Henesys (68414), a call goes to Routescan
  with no option.
- On a chain whose row also lists Sourcify or Etherscan v2, such as Avalanche Fuji (43113), pass
  `route: { backend: "routescan" }`. No `route.apiUrl` is needed.
- On any other chain, pass `route.backend` `routescan` with `route.apiUrl` set to the chain's URL.

A result from Routescan has no `explorerUrl`. This call resumes a job on Avalanche Fuji (43113)
that Routescan has since forgotten; the lookup that follows finds the contract verified:

```ts
import { checkStatus } from "explorer-verify";

const result = await checkStatus(
  "ev1:routescan:43113:0x636522c3785337399aa9105498d2bd95dc01d749:f111a4c8-368c-51d2-8163-c7ab477a1d91",
  { route: { backend: "routescan" } },
);
console.log(`${result.status} ${result.backend}`);
```

```text
verified routescan
```

`verify()` takes the same `route`. On a chain the table does not list for Routescan, add the URL:

<!-- no-run: a live submit to Routescan; the example above runs. -->

```ts no-run
import { verify } from "explorer-verify";

const result = await verify(input, {
  route: {
    backend: "routescan",
    apiUrl: "https://api.routescan.io/v2/network/mainnet/evm/<chain id>/etherscan/api",
  },
});
console.log(result.status);
```

## API key

A key is optional. It goes in the `apikey` request header, never in the URL or the body
([API keys](api-keys.md)). Where it may go depends on where you set it:

- `route.apiKey` is bound to the host of your `route.apiUrl`, whatever that host is. Set
  `apiUrl` to a Routescan URL to send the key to `api.routescan.io`.
- `apiKeys.routescan` goes only to `api.routescan.io`, and only on a route the routing table
  lists: a chain with a Routescan entry, without `route.apiUrl`. It does not move a call to
  Routescan on a row that lists Sourcify or Etherscan v2 first; pass `route.backend` for that.

Without a key, requests go out with no `apikey` header, on the keyless tier. Routescan documents 2
requests per second and 10,000 calls per day for that tier
([rate limits](https://docs.routescan.io/plans-and-limits/rate-limits), read 2026-11-03).

Routescan reads a key in the `apikey` header: on 2026-11-05 a keyed answer carried the
`x-ratelimit-*` headers of the registered free plan, 300 requests a minute and 100,000 a day, and a
keyless answer carried none. A key Routescan does not know is not refused: the answer is the keyless
one, so a wrong key goes unnoticed and the call runs on the keyless tier.

Keyed use from a browser works. The `apikey` header makes the browser send a CORS preflight first;
Routescan allows that header from any origin, and its answers, a 429 included, carry
`access-control-allow-origin: *`. On 2026-11-05 a `fetch()` with a key from a Chromium page was
answered. A key in a page is readable by everyone who loads the page, so keep a key you need to
protect on a server, or use the keyless tier from the browser.

## Requests

No request sends a `chainid` parameter: the chain is in the URL.

| Step   | Request                                                                              | Sends                                                     |
| ------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Lookup | `GET <api>?module=contract&action=getsourcecode&address=<address>&nocache=<n>`       | Nothing. Safe to repeat                                   |
| Submit | `POST <api>`, form-encoded: `module=contract`, `action=verifysourcecode`, the fields | The source. Outward and permanent: Routescan publishes it |
| Status | `GET <api>?module=contract&action=checkverifystatus&guid=<job id>&nocache=<n>`       | Nothing. Safe to repeat                                   |

The submit fields are the ones the [Etherscan](etherscan.md#requests) client sends.

`nocache` holds random characters, drawn again for every attempt, retries included. Routescan's CDN answers a repeated GET URL from its cache: on
2026-11-03 it served a cached `Pending in queue` 51 minutes after the job had passed. A lookup is a
GET because Routescan answers `getsourcecode` sent as a form POST with
`Invalid querystring request` (live, 2026-11-04).

## How answers are read

Routescan answers with HTTP 200 and the Etherscan fields `status`, `message` and `result`. The
client reads them as the [Etherscan](etherscan.md#how-answers-are-read) client does, with these
additions:

| Step   | Answer                                                                                | Outcome                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Any    | `message` `chain not supported`, `result` `null`                                      | [`unsupported-chain`](errors/unsupported-chain.md); never `failed`                                                              |
| Any    | HTTP 429, `code` `rate-limit`                                                         | Retried with backoff; [`rate-limited`](errors/rate-limited.md) once the retries stop. See [Rate limits](#rate-limits)           |
| Lookup | `SourceCode` not empty                                                                | Verified, `exact`. Routescan's lookup has no `SimilarMatch` field, so it never gives `partial`                                  |
| Status | `Verification not found`                                                              | [`job-not-found`](errors/job-not-found.md) from the client; `verify()` and `checkStatus()` then look the contract up, see below |
| Status | `Missing guid`                                                                        | [`unexpected-response`](errors/unexpected-response.md)                                                                          |
| Status | `Error: Compilation successful, but bytecode does not match with deployed bytecode …` | `failed`, with the text as `reason`; no lookup                                                                                  |

`Missing guid` means the status request was malformed. In `verify()` and `checkStatus()` it counts
as a failed poll, as any `unexpected-response` does: polling goes on, and after 3 failed polls in a
row one more lookup decides ([verify()](verify.md), steps 4 and 6).

Routescan gives the bytecode answer, with `status` `0` and `message` `NOTOK`, when the source
compiles but its bytecode differs from the deployed bytecode. The full text ends with
`for address <address>, please check your parameters`. It was recorded on Avalanche Fuji and on
Sepolia without a key on 2026-11-04. The client matches the text before the address. Any other
status text still gives [`unknown-state`](errors/unknown-state.md). The Etherscan client does not
map this text, because Etherscan has not been recorded giving it.

`chain not supported` also comes back for a chain Routescan serves when the URL names the wrong
network, such as `mainnet` for Fuji.

## Rate limits

Over its limit Routescan answers HTTP 429 with this body, with or without a key (live,
2026-11-05):

```json
{
  "statusCode": 429,
  "code": "rate-limit",
  "error": "Too Many Requests",
  "message": "You are reaching the maximum number of requests for this API. To avoid disruptions, please consider slowing down your requests. If you need a higher limit, consider requesting a personalized API key by visiting: https://rscan.link/api."
}
```

| Tier  | Limit seen on 2026-11-05     | Wait header on the 429                    | What the library does                                                                                                                 |
| ----- | ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| None  | About 120 requests a minute  | None                                      | Retries with backoff, at most 5 attempts, then throws `rate-limited`                                                                  |
| Keyed | 300 requests a minute (free) | `x-ratelimit-rpm-retry-after`, in seconds | Reads the wait as `Retry-After`. A wait above 30 s throws `rate-limited` at once with `details.retryAfterMs`; a shorter one is waited |

The keyed limit counts per minute: 300 requests sent within 2.6 s were all answered, and the next
ones got the 429 with a wait of 58 seconds. The 429 has no `Retry-After` header. In a browser the
page cannot read the `x-ratelimit-*` headers, because Routescan does not expose them to CORS, so
there a keyed 429 is retried with backoff, as a keyless one is.

The client also retries Etherscan's `Max calls per sec rate limit reached` text, as the Etherscan
client does. Any other answer throws an error and is never read as a result.

## Behaviour to know

- Routescan forgets a job. On 2026-11-03 a job answered `Pass - Verified`, then
  `Verification not found` 51 minutes after the submit, while the contract stayed verified. On
  `Verification not found`, `verify()` and `checkStatus()` look the contract up once: verified
  gives `verified`; otherwise the call throws `job-not-found` with the handle.
- When the time budget runs out while the status still says `Pending in queue`, one more lookup
  decides, as for every backend: a match gives `verified`.
- The job id is a UUID, such as `f111a4c8-368c-51d2-8163-c7ab477a1d91`.
- On 2026-11-04, a status request without a key confirmed the network of each of the 24 chains
  that Routescan's supported-chains page listed on 2026-11-03; see the
  [research note](../../contributor/research/2026-11-04-routescan-client.md#chains-confirmed-on-2026-11-04).
- Routescan's explorer lists name chains its API does not serve. On 2026-11-05, 7 of the 45
  chains they named answered `chain not supported`, among them OP Mainnet (10) and OP Sepolia
  (11155420), so the table has no Routescan entry for them; see the
  [research note](../../contributor/research/2026-11-05-routescan-rows.md).
