# 2026-11-04: Blockscout answers the client maps

Audience: whoever changes the Blockscout client (`packages/explorer-verify/src/backends/blockscout.ts`).
Assumes [explorer APIs](2026-11-02-explorer-apis.md) and the [Etherscan client note](2026-11-04-etherscan-client.md).

This note records which Blockscout API the client uses for a single-chain instance, and every
answer it maps, with where it was seen. Answers recorded on 2026-11-04 were sent with the `fetch`
of Node.js 24.21.0 to `https://base-sepolia.blockscout.com`, the Blockscout instance of Base
Sepolia (chain 84532), with no key. Each is saved under
`packages/explorer-verify/test/fixtures/blockscout/2026-11-04-<call>.json`; the Standard JSON input
in a recorded request is replaced by its length. A fixture named
`2026-11-04-documented-<call>.json` is not a recorded response; its `source` field says which text
it follows.

## Which API

A Blockscout instance serves two verification APIs on its own host, with no key:

- the Etherscan-compatible RPC API at `<origin>/api`, with `module=contract` and the actions
  `verifysourcecode` and `checkverifystatus`
  ([RPC contract module](https://docs.blockscout.com/devs/apis/rpc/contract), read 2026-11-04);
- the REST API under `<origin>/api/v2/`, with a standard-input submit route
  ([explorer APIs](2026-11-02-explorer-apis.md#blockscout)).

The client submits and polls through the RPC API, and looks up through the REST API:

- The RPC submit returns a job id, and `checkverifystatus` returns `Pass - Verified` or
  `Fail - Unable to verify` for it. That gives the flow a handle to resume (R-FLOW-5) and a verdict
  for `failed` (R-FLOW-4). Issue #92 records that the REST standard-input route returns no job id
  and no failure verdict, so a rejected source could not be told from a slow one.
- The RPC answers do not say whether a match is full or partial. The REST lookup
  `GET /api/v2/smart-contracts/{address}` does, with `is_fully_verified` and
  `is_partially_verified` (live, below).
- Both share the instance's origin, so one routing entry serves both and no request leaves that
  host (R-SEC-2).

The hosted multichain API at `https://api.blockscout.com/v2/api?chain_id=<id>` takes the same RPC
actions but needs a key
([verification API](https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api),
read 2026-11-04). It is out of scope here.

## What the RPC submit reads

From `contract_controller.ex` at Blockscout commit
[`6e271311`](https://github.com/blockscout/blockscout/blob/6e271311b0941decdbed04305b0259eca1722ee3/apps/block_scout_web/lib/block_scout_web/controllers/api/rpc/contract_controller.ex)
(the `master` head on 2026-11-04; the latest release then was v12.0.4, published 2026-11-02):

- `verifysourcecode` with `codeformat=solidity-standard-json-input` needs `contractaddress`,
  `sourceCode`, `contractname` and `compilerversion`, and reads `constructorArguments` and
  `licenseType` as optional fields. It reads no `autodetectConstructorArguments` field and no
  `libraryname<n>` or `libraryaddress<n>` fields: those are read only for
  `solidity-single-file`. So the client sends neither. Library addresses reach Blockscout only in
  `settings.libraries` of the input.
- It answers `Smart-contract already verified.` only when `verified_with_full_match?` is true for
  the address. A contract with a partial match accepts a new submit.
- It answers `Address is not a smart-contract` when it finds no code at the address.
- `checkverifystatus` maps the job state to `Pending in queue`, `Pass - Verified`,
  `Fail - Unable to verify` or `Unknown UID`, each through the same success view, so each comes
  with `status` `"1"`.

## Contracts

Each contract is the two-file `Greeter` (`contracts/Greeter.sol` importing `contracts/Base.sol`),
compiled with solc 0.8.24+commit.e11b9ed9, optimizer on with 200 runs, `evmVersion` `cancun`, and
deployed on Base Sepolia on 2026-11-04 from a funded test key with Foundry's `forge` 1.x. A comment
naming the contract makes each metadata hash unique; the last three also add a constant, so their
code differs without the metadata too.

| Name           | `bytecodeHash` | Address                                      | Block    | Used for                                   |
| -------------- | -------------- | -------------------------------------------- | -------- | ------------------------------------------ |
| form           | `ipfs`         | `0x0d7ba9133629d6732a3ef5a3f5f09c68dac4be65` | 54297166 | Form-encoded submit, already verified      |
| multipart      | `ipfs`         | `0x2e2ce1bd7adf2d0f95a3ce6aaed034032a1cc299` | 54297394 | Multipart submit                           |
| no hash        | `none`         | `0x24803723e8ddd55e6f022f2e021c241b90d701f9` | 54297482 | Partial match                              |
| unverified     | `ipfs`         | `0x78f30137d81525fb79c4e85bbb6f681d1264a6ed` | 54297618 | Unverified lookup, bytecode database match |
| fail           | `ipfs`         | `0x5515a76d17ab1ddee652374f49cdba9c84cbc6e8` | 54298174 | `Fail - Unable to verify`                  |
| client exact   | `ipfs`         | `0x76469a3b3df7a367a5d5c1630857cf23e68831c7` | 54298210 | `verify()` run, exact                      |
| client partial | `none`         | `0x1611d9d4dba0b3b8cf9a8605b082e52ab75a051c` | 54298246 | `verify()` run, partial                    |

## Answers

RPC answers came with HTTP 200 unless the row says otherwise.

| Request                                     | Answer                                                                                                                                                         | Fixture                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Submit, form-encoded, right after deploying | `status` `"1"`, `message` `OK`, `result` a 48-digit hex job id                                                                                                 | `verifysourcecode-form`             |
| Submit, multipart                           | The same                                                                                                                                                       | `verifysourcecode-multipart`        |
| Submit, `bytecodeHash` `none`               | The same                                                                                                                                                       | `verifysourcecode-no-metadata-hash` |
| Submit again after a full match             | `status` `"0"`, `message` and `result` `Smart-contract already verified.`                                                                                      | `verifysourcecode-already-verified` |
| Submit for an address with no code          | `status` `"0"`, `message` and `result` `Address is not a smart-contract`                                                                                       | `verifysourcecode-not-a-contract`   |
| Submit after 10 RPC requests                | HTTP 429, `message` `Too many requests. Increase limits now at https://dev.blockscout.com`, `result` `null`                                                    | `verifysourcecode-rate-limit`       |
| Status of each job above                    | `status` `"1"`, `result` `Pass - Verified`, at the first request                                                                                               | `checkverifystatus-pass`            |
| Status of a job with wrong optimizer runs   | `status` `"1"`, `result` `Fail - Unable to verify`                                                                                                             | `checkverifystatus-fail`            |
| Status of a made-up job id                  | `status` `"1"`, `result` `Unknown UID`                                                                                                                         | `checkverifystatus-unknown-uid`     |
| Lookup of a full match                      | 200, `is_verified` `true`, `is_fully_verified` `true`, `is_partially_verified` `false`                                                                         | `lookup-full`                       |
| Lookup of the `bytecodeHash` `none` build   | 200, `is_verified` `true`, `is_fully_verified` `false`, `is_partially_verified` `true`                                                                         | `lookup-partial-no-metadata-hash`   |
| Lookup of an unverified contract            | 200 with only `creation_bytecode`, `deployed_bytecode`, `creation_status`, `implementations`, `proxy_type` and `conflicting_implementations`: no `is_verified` | `lookup-unverified`                 |
| Lookup of an address with no code           | 404, `{"message":"Not found"}`                                                                                                                                 | `lookup-not-found`                  |
| Lookup of a malformed address               | 422, an `errors` list                                                                                                                                          | `lookup-invalid-address`            |

Both the form-encoded and the multipart submit worked, so the client sends the form-encoded one,
as the Etherscan client does. `checkverifystatus` also answered a form-encoded POST, so the client
sends every RPC request as a POST and never puts a field in the URL.

The job id was the address without `0x`, followed by 8 hex digits that grew with time
(`…6aeaee3f`, `…6aeaee67`, `…6aeaf43e`).

Issue #92 expected `is_verified` `false` for an unverified contract. The live answer had no
`is_verified` field at all. The client reads both as not verified, and reads a 200 that has
neither `is_verified` nor the contract's code as unexpected.

`Pending in queue` did not come in the direct probes: every job had passed by its first status
request, a few seconds after the submit. It came in the `verify()` run below, four times in a row.
The documented fixture follows the RPC reference's example.

The empty submit answer of issue #92 and the prior art (`status` `"1"`, `message` `OK`, an empty
`result`) did not come on 2026-11-04, although three submits were sent right after their deployment was mined. Its fixture is documented, not recorded.

A submit with `constructorArguments` as bare hex, without `0x`, was accepted with a job id; a
lookup 5 seconds later still found the contract unverified. Whether the job failed was not checked,
to stay under the rate limit. The client always sends the `0x` prefix.

## The bytecode database

The contract named "unverified" has the same code as "form" apart from the metadata hash. Its first
lookup, at 08:36:44 UTC, found it unverified. A lookup at 08:37:48 found it verified with a partial
match, `is_verified_via_eth_bytecode_db` `true` and `verified_at` 08:36:46, two seconds after the
first lookup: Blockscout had matched it against "form", verified at 08:35:16, without a submit (fixture
`lookup-partial-bytecode-database`). Blockscout's docs say its bytecode database matches on the
functionally significant parts of the code
([bytecode database](https://docs.blockscout.com/about/features/ethereum-bytecode-database-microservice),
read 2026-11-02). So `verify()` on such a contract returns `already-verified` with `partial` after
its first lookup.

## Rate limits

Every answer of `base-sepolia.blockscout.com` carried `x-ratelimit-limit`, `x-ratelimit-remaining`
and `x-ratelimit-reset`. The RPC API reported a limit of 10 and the REST API a limit of 150. The
11th RPC request, sent at 08:37:09 UTC, about 5 minutes after the first, got the 429 above, with
`x-ratelimit-reset` `1357421`. The next RPC request, at 09:00:44, succeeded. REST lookups kept working
while the RPC API was refused. The 429 carried no `Retry-After`, so the HTTP layer retries it with
its own backoff and ends with `rate-limited` when its retries run out.

Refused requests seem to move the reset later. The first `verify()` run below sent 12 refused RPC
requests from 09:02 UTC. At 09:26, the RPC API still refused, with `x-ratelimit-reset` `2009836`;
13.7 seconds later it answered `2023506`, about 27 seconds later in absolute time. With no refused
requests between 08:37 and 09:00, the reset came when the first 429 said it would. This is two
observations on one instance, not a documented rule.

## `verify()` runs

The built package from this branch, with
`route: { backend: "blockscout", apiUrl: "https://base-sepolia.blockscout.com/api" }` and
`pollIntervalMs` 3000:

| Contract       | Started (UTC)       | Result                                   | Events                                                                                                                                                   |
| -------------- | ------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| client exact   | 2026-11-04 09:02:14 | `verified`, `exact`, after 55 s          | lookup `none`, submitted, 4 polls `pending`, then 12 `verify.retry` `rate-limited`: the RPC limit was spent. The flow's last lookup found the full match |
| client exact   | 2026-11-04 09:03:20 | `already-verified`, `exact`, after 1.5 s | lookup `exact`; no submit                                                                                                                                |
| client partial | 2026-11-04 09:26:13 | `rate-limited`, after 15 s               | lookup `none`, then the submit got a 429 five times, with 4 `verify.retry` `rate-limited`. No job was started                                            |

The partial path was not run through `verify()` again, so as not to extend the window further. The
direct probe of the "no hash" contract covers it: `Pass - Verified`, then a lookup with
`is_partially_verified` `true`, the two answers the client reads.

## What follows for the client

- The empty-answer loop sends at most 4 submits, within 30 seconds of the first. With 10 RPC
  requests per window, a loop of 10 submits, as the Etherscan client allows for `not-indexed`,
  would spend the whole window and leave none for the status requests.
- Refused requests seem to extend the window, so after a 429 the call ends with `rate-limited`
  once the HTTP layer's retries run out, and does not wait for the reset.

## Routing-table rows

The research note on the [routing table](2026-11-03-routing-table.md) keeps five Blockscout API
URLs from the prior art. Added as `{ "backend": "blockscout", "instance": "<host>" }` entries after
Sourcify, on main 5faa6a6, they measured 581 bytes for the `routing table` size entry, over its
566-byte ceiling of that day, and 20,749 bytes for `verify with table` (esbuild 0.28.2, Node
24.21.0, 2026-11-04). Decision 0027 later reset that ceiling to 1,120 bytes for the Etherscan v2
rows. Their hosts were not checked live, so this change ships the `instance` field and its
templates, and no rows.

## Sources

- [Blockscout RPC API, contract module](https://docs.blockscout.com/devs/apis/rpc/contract), read 2026-11-04.
- [Blockscout smart contract verification API](https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api), read 2026-11-04.
- [`contract_controller.ex` at commit `6e271311`](https://github.com/blockscout/blockscout/blob/6e271311b0941decdbed04305b0259eca1722ee3/apps/block_scout_web/lib/block_scout_web/controllers/api/rpc/contract_controller.ex), read 2026-11-04 with `gh api`.
- [Blockscout releases](https://github.com/blockscout/blockscout/releases): v12.0.4, published 2026-11-02, read 2026-11-04.
- [Ethereum Bytecode Database](https://docs.blockscout.com/about/features/ethereum-bytecode-database-microservice), read 2026-11-02.
- Live requests to https://base-sepolia.blockscout.com, Node.js 24.21.0 `fetch`, 2026-11-04; the fixtures above.
- [Issue #92](https://github.com/aelmanaa/explorer-verify/issues/92), which lists the answers to map.
