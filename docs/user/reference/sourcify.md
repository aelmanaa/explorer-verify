# Sourcify

Version: explorer-verify 0.3.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who need to know what explorer-verify sends to Sourcify and how it
reads each answer.

explorer-verify talks to Sourcify through its API v2. [verify()](verify.md) and
[checkStatus()](check-status.md) use this client.

| Fact       | Value                                                   |
| ---------- | ------------------------------------------------------- |
| Server     | `https://sourcify.dev/server`, or the one `route` names |
| API key    | None                                                    |
| Browsers   | Answers them directly                                   |
| API        | v2 only; the v1 API is switched off                     |
| Match type | [`exact` or `partial`](../explanation/match-types.md)   |

> [!IMPORTANT]
> A submit sends your source to Sourcify, which publishes it. It cannot be undone.

## Requests

| Step   | Request                                                   | Sends                                                    |
| ------ | --------------------------------------------------------- | -------------------------------------------------------- |
| Lookup | `GET /v2/contract/{chainId}/{address}?fields=compilation` | Nothing. Safe to repeat                                  |
| Submit | `POST /v2/verify/{chainId}/{address}`                     | The source. Outward and permanent: Sourcify publishes it |
| Status | `GET /v2/verify/{verificationId}`                         | Nothing. Safe to repeat                                  |

The submit body is JSON. Each field comes from the [verify input](verify.md):

| Field                     | Value                                                         |
| ------------------------- | ------------------------------------------------------------- |
| `stdJsonInput`            | `compiler.input`, with only `language`, `sources`, `settings` |
| `compilerVersion`         | `compiler.version`, without a leading `v`                     |
| `contractIdentifier`      | `contractName`, as `contracts/Greeter.sol:Greeter`            |
| `creationTransactionHash` | `creationTxHash`, when the input has it                       |

Constructor arguments are never sent: Sourcify reads them from the creation code.

## How answers are read

An answer that this table does not list throws an error. It never reads as "not verified" or as
success.

| Step   | Answer                                          | Outcome                                                              |
| ------ | ----------------------------------------------- | -------------------------------------------------------------------- |
| Lookup | 200 with `match` `exact_match` or `match`       | Verified, `exact` or `partial`, with the stored contract (see below) |
| Lookup | 404 with `match` `null`                         | Not verified                                                         |
| Lookup | 400 `unsupported_chain`                         | [`unsupported-chain`](errors/unsupported-chain.md)                   |
| Lookup | Anything else, a 500 included                   | [`unexpected-response`](errors/unexpected-response.md)               |
| Submit | 202 with a `verificationId`                     | A job to poll                                                        |
| Submit | 409 `already_verified`                          | `already-verified`, `exact`                                          |
| Submit | 400 `unsupported_chain`                         | [`unsupported-chain`](errors/unsupported-chain.md)                   |
| Submit | 429 `duplicate_verification_request`            | [`in-progress`](errors/in-progress.md)                               |
| Submit | Anything else, 400 `invalid_parameter` included | [`unexpected-response`](errors/unexpected-response.md)               |
| Status | `isJobCompleted` `false`                        | Still pending                                                        |
| Status | Completed with `match` `exact_match` or `match` | `verified`, `exact` or `partial`                                     |
| Status | Completed with error `already_verified`         | `already-verified`                                                   |
| Status | Completed with an error that rejects the source | `failed`, with `reason` `<code>: <message>`                          |
| Status | Completed with an error that may clear up later | [`verification-inconclusive`](errors/verification-inconclusive.md)   |
| Status | Completed with any other error, or with neither | [`unknown-state`](errors/unknown-state.md)                           |
| Status | 404 `job_not_found`                             | [`job-not-found`](errors/job-not-found.md)                           |

`exact` means the metadata hash matches too; `partial` means everything but the metadata hash
matches. An answer whose `chainId` or `address` names another contract throws
`unexpected-response`.

## Job error codes

A completed job's error code decides between `failed` and `verification-inconclusive`, and gives a
`failed` result its `reasonCode` ([Why a submission failed](verify.md#why-a-submission-failed)).
`extra_file_input_bug` means the deployed build compiled more files than the input holds, so it
reads as `missing-source`.

| Error code                                      | Outcome                     | `reasonCode`                                                              |
| ----------------------------------------------- | --------------------------- | ------------------------------------------------------------------------- |
| `no_match`                                      | `failed`                    | `bytecode-mismatch`                                                       |
| `bytecode_length_mismatch`                      | `failed`                    | `bytecode-mismatch`                                                       |
| `compiler_error`                                | `failed`                    | `compiler`; `missing-source` when the message says `Source "…" not found` |
| `missing_source`                                | `failed`                    | `missing-source`                                                          |
| `missing_or_invalid_source`                     | `failed`                    | `missing-source`                                                          |
| `invalid_compilation_target`                    | `failed`                    | `contract-name`                                                           |
| `contract_not_found_in_compiler_output`         | `failed`                    | `contract-name`                                                           |
| `runtime_bytecode_not_found_in_compiler_output` | `failed`                    | `contract-name`                                                           |
| `invalid_compiler_version`                      | `failed`                    | `compiler`                                                                |
| `unsupported_compiler_version`                  | `failed`                    | `compiler`                                                                |
| `invalid_language`                              | `failed`                    | `compiler`                                                                |
| `unsupported_language`                          | `failed`                    | `compiler`                                                                |
| `compiled_bytecode_is_zero`                     | `failed`                    | `contract-name`                                                           |
| `onchain_bytecode_is_zero`                      | `failed`                    | `unknown`                                                                 |
| `extra_file_input_bug`                          | `failed`                    | `missing-source`                                                          |
| `internal_error`                                | `verification-inconclusive` |                                                                           |
| `job_abandoned`                                 | `verification-inconclusive` |                                                                           |
| `compiler_timeout`                              | `verification-inconclusive` |                                                                           |
| `compiler_out_of_memory`                        | `verification-inconclusive` |                                                                           |
| `no_compiler_output`                            | `verification-inconclusive` |                                                                           |
| `cannot_fetch_bytecode`                         | `verification-inconclusive` |                                                                           |
| `onchain_runtime_bytecode_not_available`        | `verification-inconclusive` |                                                                           |
| `onchain_creation_bytecode_not_available`       | `verification-inconclusive` |                                                                           |
| `contract_not_deployed`                         | `verification-inconclusive` |                                                                           |

`contract_not_deployed` can appear right after a deployment, before Sourcify's node sees the
contract.

## A submit without a clear answer

A submit may reach Sourcify without explorer-verify learning the job id: no response, a 500, 502
or 504, a success status whose body failed or stalled, or a 202 whose body is not JSON.
explorer-verify does not send such a submit again blindly. It looks the contract up first:

- If the lookup finds the contract verified from this source, the submit ends as
  `already-verified` with that match. The verification may be the one this call started.
- If not, or if the match is another contract's source, it submits once more. If Sourcify answers that a job for the contract is already
  running, the call throws `in-progress`, without a job id.
- If the second submit also gets no clear answer, the call throws that error.
- If the lookup fails, the call throws the lookup's error, and its message says the submit may
  already have been accepted.

A redirect, a body above the size limit, or a 503 that is still refused after the retries throws
at once, with no lookup.

## Behaviour to know

- A 200 lookup can be up to an hour old. Sourcify sends `cache-control: public,max-age=3600`, and a
  shared cache in front of the server keeps the answer. On 2026-11-11 a lookup still answered
  `match` 44 minutes after a submit upgraded the contract to `exact_match`, while the same lookup
  without the query answered `exact_match`. No request header reaches that cache. A "not verified"
  answer is not cached.
- After a submit, the job's answer is newer than a lookup and wins over it. A `partial` from the
  lookup, in a `verify()` result or a `dryRun()` `lookup`, can be an hour behind; check the
  contract's page after that hour.
- Through the platform's `fetch`, the lookup goes with `cache: "no-store"`, so a browser's own
  cache adds no second hour. A runtime whose `Request` refuses the field, as Cloudflare Workers
  before compatibility date 2024-11-11 do, sends the lookup without it. An injected `fetch` never
  gets the field: your `fetch` handles caching, and the lookup can be up to an hour old, or more if
  your `fetch` caches it too. [The cache probes](../../contributor/research/2026-11-11-sourcify-lookup-cache.md)
  record each request tried and its answer.
- With `cache: "no-store"`, the runtime adds `Pragma: no-cache` and `Cache-Control: no-cache` to
  the lookup, as the Fetch Standard says. A page does not set them, so they need no CORS preflight.
- The lookup names the stored contract from `compilation`: `fullyQualifiedName`, else `name`, and
  `compilerVersion`.
- Sourcify can hold another contract's source for an address. On Ethereum Sepolia, within two
  minutes of a deployment, it held a `match` from `simplestorage2.sol:SimpleStorage` compiled with
  `0.8.33`. The caller had deployed `EvBox`, compiled with `0.8.34`. `verify()` compares the
  stored contract with the input, and submits when either part differs
  ([Match types](../explanation/match-types.md)):
  - `fullyQualifiedName` with the whole `contractName`;
  - `compilerVersion` with `compiler.version`.
- Two Sourcify answers name no contract: the `409` to a submit, and the lookup of a server that
  ignores `fields=compilation`. `verify()` then takes the match as your source, and logs at `info`
  that the answer names no contract. After a `409` that follows another contract's match, the
  result keeps that contract in `storedContract`, with `match` `partial`. That contract comes from
  a lookup up to an hour old, so it may be out of date; `verify()` logs this at `warn`.
- A submit can verify the contract on other explorers too. Completed jobs carry
  `externalVerifications`, one entry per explorer: a job id, an "already verified" answer or an
  error such as a daily limit. A later Etherscan submit can then answer that the contract is
  already verified. explorer-verify does not report these entries yet.
- A submit with exact sources for a contract that has only a partial match upgrades it to an exact
  match. `verify()` sends it only with `submitOverPartial`. On Ethereum Sepolia on 2026-11-11, the
  job ended with `exact_match`. The same partial sources again started a job that ended with the
  code `already_verified` ([Submit over a partial match](verify.md#submit-over-a-partial-match)).
- Linked libraries: for a contract linked to a library after compiling, as Foundry and Hardhat do,
  submit `settings.libraries` as it was at compile time. Adding the library addresses gives only
  a partial match, because the addresses change the metadata hash. `verify()` sends the input
  unchanged; see [Linked libraries](verify.md#linked-libraries).
- Jobs on testnets finish in about one second.

## Sources

- Sourcify API v1 shutdown on 2026-07-07: the Sourcify API v2 documentation.
- The headers that `cache: "no-store"` adds: the WHATWG Fetch Standard,
  [HTTP-network-or-cache fetch](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch), last
  updated 2026-10-19, read 2026-11-11.
- `externalVerifications` entries for Etherscan, Blockscout and Routescan, and an Etherscan
  verification on Polygon Amoy after a Sourcify submit alone: live runs on 2026-11-02.
- Testnet jobs finishing in about one second: live runs on 2026-11-02.
- A partial match after adding library addresses to `settings.libraries`: live run on 2026-11-03.
- Another contract's source held for a new contract on Ethereum Sepolia: live run on 2026-11-10.
