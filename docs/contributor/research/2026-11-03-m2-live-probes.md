# 2026-11-03: live answers for the M2 clients

Audience: whoever implements the Etherscan family clients, the Routescan client (R-BE-5),
constructor argument derivation (R-IN-3) or library link addresses (R-IN-4). Assumes the facts in
[explorer APIs](2026-11-02-explorer-apis.md) and the
[Routescan and zkSync note](2026-11-03-routescan-zksync.md).

Five probes, run on 2026-11-03 against public testnets. Times are UTC. Each answer is quoted from a
recorded response. Two kinds of record back this note:

- Fixtures: the API responses saved under
  `packages/explorer-verify/test/fixtures/<backend>/2026-11-03-<call>.json`, with the Etherscan key
  replaced by `[redacted]`. Each fixture's `recordedAt` is the time its request was sent. Every API
  answer quoted below has a fixture, except where a line says otherwise.
- Observations with no saved artifact: the match badges on the explorer web pages, and Routescan
  polls 02 to 35 of probe B, whose bodies were printed while the probe ran but are not kept.

Every conclusion holds for what was tested: Arbitrum Sepolia (chain id 421614) or Avalanche Fuji
(43113), solc 0.8.24, and the contracts named in each probe. None is a general rule for the
explorer.

## Setup

- Contracts compiled and deployed with Foundry `forge` 1.8.1 and solc `0.8.24+commit.e11b9ed9`,
  optimizer on with 200 runs, `evmVersion` `cancun`, `bytecodeHash` `ipfs`. Each source file has a
  comment line naming its probe, so its metadata hash is unique and no explorer could match it
  from an earlier contract.
- The Standard JSON input of each contract came from
  `forge verify-contract --show-standard-json-input` (forge 1.8.1).
- Requests were sent with the `fetch` of Node.js 24.21.0. Explorer web pages were read in Chromium
  (Playwright build 1223), because curl 8.7.1 got HTTP 403 from the page.
- Deployer: `0x9d087fC03ae39b088326b67fA3C788236645b717`.
- Chains: Arbitrum Sepolia (421614) for the Etherscan and Sourcify probes, because its gas costs
  little; Avalanche Fuji (43113) for Routescan. Ethereum Sepolia was not needed.

### Deployments

| Probe | Chain  | Contract                                  | Address                                      | Creation transaction                                                 |
| ----- | ------ | ----------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| A1    | 421614 | `src/ProbeAOmitted.sol:ProbeAOmitted`     | `0xeb1F2bD33929682d3c3a208500e2DAa54E70Bf73` | `0xfcac60ebea19e05f9058d4103fe11d58e9448421083b49f276586c7944bb0879` |
| A2    | 421614 | `src/ProbeAWrong.sol:ProbeAWrong`         | `0xD4e46A67914f51771C17C590fc408B5E652820e5` | `0xea9311f796a7bbee651bf8d9be01d031d5970599fbef466a0e405c562bda1eff` |
| B     | 43113  | `src/ProbeBRoutescan.sol:ProbeBRoutescan` | `0x636522C3785337399Aa9105498d2Bd95Dc01D749` | `0x53ae33008bc2a820f5feb7b1c0b7f0cc0ee17433dc27afac240c2d7b6c628760` |
| D     | 421614 | `src/ProbeDFactory.sol:ProbeDFactory`     | `0x6355EF85c81f3545Ad9Cb404F3DeFB7f219810EC` | `0xa1f5a46f07d9ab3d1eb51daf6757c20c127ca7488fc0c109ba50503f8b1a1b0b` |
| D1    | 421614 | `src/ProbeDChild.sol:ProbeDChild`, `1`    | `0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5` | same as D (created by the factory)                                   |
| D2    | 421614 | `src/ProbeDChild.sol:ProbeDChild`, `2`    | `0xF20cfae8007a1e2df9A7CBa74bD54A375e1771c4` | same as D (created by the factory)                                   |
| E lib | 421614 | `src/ProbeELib.sol:ProbeELib`             | `0xd0B737fC4e4195144824eB07b2d1bb778525b86B` | `0xd0340eaec72a729ee3feb0d6413519c3e6d41e964654b0f5fd32d5db6b27bf6c` |
| E1    | 421614 | `src/ProbeELinked1.sol:ProbeELinked1`     | `0x986678514E9Fa9C09F4145b482C0fe95a65a4937` | `0x968b2df53461bb2667b53b382cd93e675116859fb26b48b461de1818092d3912` |
| E2    | 421614 | `src/ProbeELinked2.sol:ProbeELinked2`     | `0xcecf301f97d21103233E666b2C6B766195D2e5DC` | `0xa6d23db78a2838253c4cce4bd64cd48e7dce1343b529a7832be90b826b095c36` |

A1, A2 and B take `(address owner_, string greeting_)` and store `owner_` in an immutable. They were
deployed with `(0x9d087fC03ae39b088326b67fA3C788236645b717, "hello explorer-verify")`. D1 and D2
take `(uint256 value_)` into an immutable. E1 and E2 call `ProbeELib.triple`, an external library
function, so their bytecode holds the library address.

The library's creation transaction was sent to `0x4e59b44847b379578588920cA78FbF26c0B4956C`, a
CREATE2 deployer: that is the `to` of its receipt (cast 1.8.1, 2026-11-03), and the transaction
created no contract of its own.

Gas, from the transaction receipts (forge 1.8.1): eight transactions, 1,229,643 gas in all. On
Arbitrum Sepolia, six transactions cost 0.000018958182054731 ETH. On Fuji, two transactions (a
second copy of the library, which forge deployed there too, and B) cost 0.00000000004622592 AVAX.

## A: Etherscan with constructor arguments omitted or wrong

Request: `POST https://api.etherscan.io/v2/api?chainid=421614`, form-encoded, Standard JSON input.
A1 was sent without a `constructorArguements` field. A2 was sent with
`abi.encode(0x9d087fC03ae39b088326b67fA3C788236645b717, "wrong greeting")`, which differs from the
deployed arguments.

| Step                           | A1 (omitted)                                                                                                | A2 (wrong)                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Submit                         | 04:50:35.987, `{"status":"1","message":"OK","result":"yatwfd5yijmxufgkexd8ygesyexubjazunjnbgkemvwbm7vhrw"}` | 04:50:42.385, `{"status":"1","message":"OK","result":"qgiqphwbqsgbnzzdw6vu9zdzmcl4xrjg3guwqeydrbhjpbzv28"}` |
| Poll 1                         | 04:50:36.749, `{"status":"0","message":"NOTOK","result":"Pending in queue"}`                                | 04:50:42.550, `{"status":"0","message":"NOTOK","result":"Pending in queue"}`                                |
| Poll 2                         | 04:50:41.912, `{"status":"1","message":"OK","result":"Pass - Verified"}`                                    | 04:50:47.704, `{"status":"1","message":"OK","result":"Pass - Verified"}`                                    |
| `getsourcecode` `SimilarMatch` | `""`                                                                                                        | `""`                                                                                                        |
| Web page badge (observation)   | `Source Code Verified` `Exact Match`                                                                        | `Source Code Verified` `Exact Match`                                                                        |

For both contracts `getsourcecode` returned the true arguments, not the submitted ones:

```text
"ConstructorArguments":"0000000000000000000000009d087fc03ae39b088326b67fa3c788236645b7170000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000001568656c6c6f206578706c6f7265722d7665726966790000000000000000000000"
```

Answer: for these two directly deployed contracts on Arbitrum Sepolia, compiled with solc 0.8.24,
Etherscan v2 gave an exact match with the arguments omitted and with wrong ones, and recorded the
arguments from the chain. This is one chain and two contracts; it does not show that Etherscan
never needs the arguments. The badges were read from
`https://sepolia.arbiscan.io/address/<address>#code` at 05:27 and not saved.

## B: Routescan keyless submit as a form-encoded POST

Request at 05:23:02: `POST https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api`,
no query string, no key, `content-type: application/x-www-form-urlencoded`. Every field was in the
body: `module`, `action` (`verifysourcecode`), `contractaddress`, `sourceCode`, `codeformat`
(`solidity-standard-json-input`), `contractname`, `compilerversion` and `constructorArguements`.

- Submit answer, HTTP 200:
  `{"status":"1","message":"OK","result":"f111a4c8-368c-51d2-8163-c7ab477a1d91"}`. The GUID is a
  UUID (36 characters with hyphens), not the 50-character form of the example in Routescan's
  [contracts API](https://docs.routescan.io/api/etherscan/contracts) page (read 2026-11-03). It
  still matches the handle's `jobId` pattern `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`
  ([decision 0009](../decisions/0009-options-handle-and-errors.md)).
- Polls with `GET ...?module=contract&action=checkverifystatus&guid=<guid>`: 36 polls about 5 s
  apart, from 05:23:03.065 (poll 01) to 05:26:04.048 (poll 36), then three more at 05:27:12,
  05:28:57 and 05:30:02. Every answer was
  `{"status":"0","message":"NOTOK","result":"Pending in queue"}`, HTTP 200. Polls 01 and 36 and the
  three later ones are fixtures; polls 02 to 35 are not.
- `getsourcecode` at 05:26:09 returned the verified source, with
  `"ConstructorArguments":"0x0000…0000"` (the true arguments with a `0x` prefix). Its result has no
  `SimilarMatch`, `ContractFileName` or `CompilerType` field, which Etherscan's has.

The pending answers came from a cache. Poll 01 had `cf-cache-status: MISS` and
`last-modified: Tue, 03 Nov 2026 05:23:03 GMT`. Later polls of the same URL had
`cf-cache-status: HIT` and the same `last-modified`, with a growing `age`. Requests that bypassed
the cache:

| Time         | Request                                                | `cf-cache-status`  | Answer                                                               |
| ------------ | ------------------------------------------------------ | ------------------ | -------------------------------------------------------------------- |
| 05:30:31     | Poll URL plus a unique query parameter `nocache=<ms>`  | `MISS`             | `{"status":"1","message":"OK","result":"Pass - Verified"}`           |
| 05:30:31     | Poll URL with request header `cache-control: no-cache` | `HIT`, `age: 448`  | `{"status":"0","message":"NOTOK","result":"Pending in queue"}`       |
| 06:13:36.857 | Poll URL plus a unique query parameter `nocache=<ms>`  | `MISS`             | `{"status":"0","message":"NOTOK","result":"Verification not found"}` |
| 06:13:47.826 | Poll URL, unchanged                                    | `HIT`, `age: 3044` | `{"status":"0","message":"NOTOK","result":"Pending in queue"}`       |
| 06:13:48.696 | `getsourcecode` plus a unique query parameter          | `MISS`             | `status` `"1"`, the verified source of `ProbeBRoutescan`             |

Answers, for this one contract on Fuji:

- Routescan's keyless tier accepted `verifysourcecode` as a form-encoded POST with every field in
  the body, and verified the contract.
- A repeated poll URL was answered from the CDN cache. The first answer, `Pending in queue`, was
  still served at `age: 3044`, about 51 minutes after it was cached. A unique query parameter
  reached the API; a `cache-control` request header did not.
- Routescan forgot the GUID between 05:30:31, when it answered `Pass - Verified`, and 06:13:36,
  when it answered `Verification not found`. The contract stayed verified. A review of this change
  saw the same `Verification not found` answer at 06:11:29 (an observation, not a fixture).

## C: Routescan keyless burst

At 05:28:47.851, 20 concurrent keyless `GET` requests to the Fuji base, each `checkverifystatus`
with a different made-up GUID, so that none was served from the cache. Each GUID was
`probec<stamp>n<i>`, where `<stamp>` is the start time in milliseconds in base 36 and `<i>` the
request index; the stamp was not saved, and the fixture shows it as `<stamp>`.

All 20 answered within 1,061 ms: HTTP 200, `cf-cache-status: MISS`,
`{"status":"0","message":"NOTOK","result":"Verification not found"}`. No response was a rate-limit
answer, and none carried a rate-limit header; the headers were `access-control-allow-origin`,
`cf-cache-status`, `connection`, `content-encoding`, `content-type`, `last-modified`, `server`,
`speculation-rules`, `transfer-encoding` and `vary`.

A first burst of 20 `getsourcecode` requests for one address, at about 05:27, was answered from
the cache (`cf-cache-status: HIT`) and says nothing about the limit; it is not kept as a fixture.

Answer: the rate-limit answer was not reached. Routescan's documented keyless limit is 2 requests
per second ([rate limits](https://docs.routescan.io/plans-and-limits/rate-limits), read 2026-11-03), yet 20 uncached requests within about one second were all answered.
The shape of the rate-limit answer stays unknown.

## D: Similar Match and `getcontractcreation` for a factory deployment

The factory's constructor created D1 with `1` and D2 with `2` using CREATE, in one transaction. D1
and D2 have the same creation code and different immutables.

`getcontractcreation` for the factory, D1 and D2 at 04:50:21.605, before any verification:

| Address | `contractCreator`                            | `contractFactory`                            | `creationBytecode`                          |
| ------- | -------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| Factory | `0x9d087fc03ae39b088326b67fa3c788236645b717` | `""`                                         | equal to the transaction input (cast 1.8.1) |
| D1      | `0x9d087fc03ae39b088326b67fa3c788236645b717` | `0x6355ef85c81f3545ad9cb404f3defb7f219810ec` | 282 bytes, ending `…0000000000000001`       |
| D2      | `0x9d087fc03ae39b088326b67fa3c788236645b717` | `0x6355ef85c81f3545ad9cb404f3defb7f219810ec` | 282 bytes, ending `…0000000000000002`       |

For D1 and D2, `creationBytecode` is the inner init code, not the transaction input: the compiled
creation bytecode of `ProbeDChild` (250 bytes) is an exact prefix of it, and the remaining 32 bytes
are the ABI-encoded argument (compared with Python 3 on 2026-11-03). `txHash` is the factory's
transaction for all three, and `contractCreator` is the account that sent it.

D1 was then submitted with its argument at 04:51:08.826. Its polls answered `Pending in queue` at
04:51:09.746 and `Pass - Verified` at 04:51:14.907. D2 was never submitted. Its `getsourcecode`:

| Time         | `SourceCode`       | `ConstructorArguments` | `SimilarMatch`                                 |
| ------------ | ------------------ | ---------------------- | ---------------------------------------------- |
| 04:50:22.652 | `""`               | `""`                   | `""`                                           |
| 04:51:15.531 | D1's Standard JSON | `""`                   | `"0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5"` |
| 05:23:00.664 | D1's Standard JSON | `""`                   | `"0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5"` |

D1's own `getsourcecode`, sent at 04:51:15.377, already showed it verified with
`"ConstructorArguments":"0000…0001"`. D2's `SimilarMatch` was already set at 04:51:15.531: 0.15 s
after that lookup and 6.7 s after D1's submit. No D2 lookup was made between 04:50:22.652 and
04:51:15.531, so when inside that window it was set is not known.

Web pages at 05:27 (observations, not saved): D2's showed `Exact Match` with `Similar Match:` and a
link to D1; D1's showed `Source Code Verified` `Exact Match`.

Answers, for these two CREATE children of one factory on Arbitrum Sepolia:

- Similar Match covered a factory child whose immutables differ from the verified sibling's.
- `SimilarMatch` held the address of the matched contract; `ConstructorArguments` stayed empty for
  the similar-matched contract. Etherscan says Similar Match "does not take into account
  constructor arguments"
  ([types of contract verification](https://info.etherscan.com/types-of-contract-verification/),
  read 2026-11-03).
- `getcontractcreation` returned the inner init code with arguments for a factory child, and
  named the factory in `contractFactory`. So deriving arguments from Etherscan's
  `creationBytecode` worked for these children. Inference, not tested: from an RPC node alone, the
  transaction input is the factory's code, so finding a child's init code there would need a
  trace.

## E: a contract linked to an external library

E1 was submitted with the library in `settings.libraries`:
`{"src/ProbeELib.sol":{"ProbeELib":"0xd0B737fC4e4195144824eB07b2d1bb778525b86B"}}`. E2 was submitted
with `"libraries":{}`. Both inputs are otherwise what forge produced.

| Backend   | E1 (with libraries)                                           | E2 (without libraries)                                                    |
| --------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Etherscan | `Pass - Verified`; web page `Exact Match` (observation)       | `Pass - Verified`; web page `Exact Match` (observation)                   |
| Sourcify  | `"match":"match"`, `creationMatch` and `runtimeMatch` `match` | `"match":"exact_match"`, `creationMatch` and `runtimeMatch` `exact_match` |

On Etherscan, E1 was submitted at 04:51:21.708 and polled `Pending in queue` at 04:51:22.454 and
`Pass - Verified` at 04:51:27.613; E2 was submitted at 04:51:28.090 and polled `Pending in queue`
at 04:51:28.252 and `Pass - Verified` at 04:51:33.408. For both, `getsourcecode` returned
`"Library":""`, and the stored Standard JSON input had a `libraries` entry that the submission did
not have, keyed by the contract's own file:
`{"src/ProbeELinked1.sol":{"ProbeELib":"0xd0b737fc4e4195144824eb07b2d1bb778525b86b"}}` for E1 and
the same under `src/ProbeELinked2.sol` for E2.

Sourcify (`POST https://sourcify.dev/server/v2/verify/421614/<address>`, at 04:51:40 and 04:51:43)
answered HTTP 202 with a `verificationId`, and the job completed in about one second. Its job
result also listed `externalVerifications`: for `etherscan`,
`"verificationId":"VERIFIER_ALREADY_VERIFIED"`, and for `blockscout`, a submission id and status
URL.

Why E1 is only `match` on Sourcify: the Solidity metadata includes `settings.libraries`
([metadata](https://docs.soliditylang.org/en/v0.8.24/metadata.html), "Required for Solidity:
Addresses for libraries used", read 2026-11-03). Compiling E1's submitted input with solc 0.8.24
gave the metadata hash `63f7bbbd…`, while the deployed code has `f1ff9add…`, which forge compiled
with no libraries and linked afterwards. E2's input compiled to the deployed hash `50d8c121…`
(solc 0.8.24 and cast 1.8.1, 2026-11-03).

Answers, for these two contracts on Arbitrum Sepolia, compiled with solc 0.8.24 and linked after
compiling, as Foundry does here:

- Etherscan verified each as an exact match, one with `settings.libraries` and one without, and
  found the library address itself.
- Sourcify gave `exact_match` without `settings.libraries` and only `match` with it. Adding link
  addresses to the input lowered the grade on Sourcify in this case.

## Open questions

- What is Routescan's rate-limit answer? Not reached with 20 concurrent uncached requests.
- How long does Routescan keep a GUID, and how long does its CDN keep a poll answer? Seen here:
  the GUID was gone within 51 minutes of the submit, and a cached answer was served at an age of
  3044 s.
- Does Etherscan verify a linked contract that was compiled with `settings.libraries` set (so its
  metadata hash includes the addresses)? Not tested.
- Do the probe A and D answers hold on other chains, with other compiler versions, or for
  children created with CREATE2? Not tested.

## Sources

Read on 2026-11-03:

- Etherscan:
  [verifysourcecode](https://docs.etherscan.io/api-reference/endpoint/verifysourcecode),
  [checkverifystatus](https://docs.etherscan.io/api-reference/endpoint/checkverifystatus),
  [getsourcecode](https://docs.etherscan.io/api-reference/endpoint/getsourcecode),
  [getcontractcreation](https://docs.etherscan.io/api-reference/endpoint/getcontractcreation),
  [types of contract verification](https://info.etherscan.com/types-of-contract-verification/).
- Routescan: [contracts API](https://docs.routescan.io/api/etherscan/contracts),
  [rate limits](https://docs.routescan.io/plans-and-limits/rate-limits).
- Sourcify: [API](https://docs.sourcify.dev/docs/api/),
  [server API docs](https://sourcify.dev/server/api-docs/).
- Solidity: [contract metadata](https://docs.soliditylang.org/en/v0.8.24/metadata.html).

Explorer web pages, read in Chromium (Playwright build 1223) at 05:27 on 2026-11-03, not saved:
`https://sepolia.arbiscan.io/address/<address>#code` for A1, A2, D1, D2, E1 and E2.

Local runs on 2026-11-03: Foundry forge and cast 1.8.1 with solc 0.8.24 (deployments, Standard JSON
inputs, receipts, deployed code); Node.js 24.21.0 `fetch` (every API request in this note); Python 3
(the prefix comparison in probe D). The requests were sent to `https://api.etherscan.io/v2/api`,
`https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api` and
`https://sourcify.dev/server`.
