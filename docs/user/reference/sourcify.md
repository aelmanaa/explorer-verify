# Sourcify

<!-- docs-style: legacy -->

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who need to know what explorer-verify sends to Sourcify and how it
reads each answer.

explorer-verify talks to Sourcify through its API v2 at `https://sourcify.dev/server`, or at the
server that the `route` option names. Sourcify needs no API key and answers browsers directly. The
v1 API was switched off on 2026-07-07; explorer-verify does not use it. [verify()](verify.md) and
[checkStatus()](check-status.md) use this client.

## Requests

| Step   | Request                                                   | Sends                                                    |
| ------ | --------------------------------------------------------- | -------------------------------------------------------- |
| Lookup | `GET /v2/contract/{chainId}/{address}?fields=compilation` | Nothing. Safe to repeat                                  |
| Submit | `POST /v2/verify/{chainId}/{address}`                     | The source. Outward and permanent: Sourcify publishes it |
| Status | `GET /v2/verify/{verificationId}`                         | Nothing. Safe to repeat                                  |

The submit body is JSON:

- `stdJsonInput`: an object with only `language`, `sources` and `settings` from
  `compiler.input`. Other top-level fields of the Standard JSON input are not sent.
- `compilerVersion`: `compiler.version`, without a leading `v`.
- `contractIdentifier`: `contractName`, as `contracts/Greeter.sol:Greeter`.
- `creationTransactionHash`: `creationTxHash`, when the input has it.

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

Error codes that reject the source, so `failed`: `no_match`, `bytecode_length_mismatch`,
`compiler_error`, `missing_source`, `missing_or_invalid_source`, `invalid_compilation_target`,
`contract_not_found_in_compiler_output`, `runtime_bytecode_not_found_in_compiler_output`,
`invalid_compiler_version`, `unsupported_compiler_version`, `invalid_language`,
`unsupported_language`, `compiled_bytecode_is_zero`, `onchain_bytecode_is_zero` and
`extra_file_input_bug`.

Error codes that may clear up later, so `verification-inconclusive`: `internal_error`, `job_abandoned`,
`compiler_timeout`, `compiler_out_of_memory`, `no_compiler_output`, `cannot_fetch_bytecode`,
`onchain_runtime_bytecode_not_available`, `onchain_creation_bytecode_not_available` and
`contract_not_deployed`. The last one can appear right after a deployment, before Sourcify's node
sees the contract.

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

- A 200 lookup can be up to an hour old: Sourcify sends `cache-control: public,max-age=3600`. A
  "not verified" answer is not cached. After a submit, the job's answer is newer than a lookup.
- The lookup names the stored contract from `compilation`: `fullyQualifiedName`, else `name`, and
  `compilerVersion`.
- Sourcify can hold another contract's source for an address. On 2026-11-10, on Ethereum Sepolia,
  it held `simplestorage2.sol:SimpleStorage` compiled with `0.8.33` as a `match` for a contract the
  caller deployed as `EvBox` with `0.8.34`, within two minutes of the deployment. `verify()` compares
  `fullyQualifiedName` with the whole `contractName` and `compilerVersion` with
  `compiler.version`, and submits when either differs; see
  [Match types](../explanation/match-types.md).
- Two Sourcify answers name no contract: the `409` to a submit, and the lookup of a server that
  ignores `fields=compilation`. `verify()` then takes the match as your source, and logs at `info`
  that the answer names no contract. After a `409` that follows another contract's match, the
  result keeps that contract in `storedContract`.
- A submit can verify the contract on other explorers too. On 2026-11-02, completed jobs carried
  `externalVerifications`, with an entry per explorer (Etherscan, Blockscout, Routescan): a job id,
  an "already verified" answer or an error such as a daily limit. On Polygon Amoy, Etherscan showed
  the contract verified after the Sourcify submit alone. A later Etherscan submit for the same
  contract can then answer that it is already verified. explorer-verify does not report these
  entries yet.
- A submit with exact sources for a contract that has only a partial match upgrades it to an exact
  match.
- Linked libraries: for a contract linked to a library after compiling, as Foundry and Hardhat do,
  submit `settings.libraries` as it was at compile time. On 2026-11-03, adding the library
  addresses to `settings.libraries` gave only a partial match, because the addresses change the
  metadata hash. `verify()` sends the input unchanged; see
  [Linked libraries](verify.md#linked-libraries).
- Jobs on testnets finished in about one second on 2026-11-02.
