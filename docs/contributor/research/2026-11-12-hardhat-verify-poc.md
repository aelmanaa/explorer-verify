# 2026-11-12: hardhat-verify on explorer-verify, a proof of concept

Audience: whoever plans a Hardhat integration, or changes an API it relies on. Assumes
[the integration guide](../../user/guides/wrap-explorer-verify-in-your-tool.md) and
[decision 0067](../decisions/0067-submit-over-a-partial-match.md).

A local proof of concept based on Hardhat main `d7a45add` / hardhat-verify 3.1.5 replaced the
plugin's explorer clients with explorer-verify 0.2.1 from npm. The published hardhat-verify 3.1.5
`src/` is identical to `packages/hardhat-verify/src` at `d7a45add` (`diff -rq`, 2026-11-12). The
proof-of-concept branch started from a later main commit, `0edb1e0f2`, with hardhat-verify 3.1.5 and
hardhat 3.22.0, and ran on Node 24.21.0. Nothing was pushed or proposed upstream. The goal was to
keep the `verify` task, its options, the config, the console messages, the HHE errors and
`verifyContract(args, hre)`, and let explorer-verify send every request to the explorers.

## Mapping

| hardhat-verify 3.1.5                                                                                    | After the change                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Tasks `verify`, `verify etherscan`, `verify blockscout`, `verify sourcify`, flags, `--force`, exit code | Unchanged, in Hardhat. A new `verify resume <handle>` task calls `checkStatus()`                                            |
| `verify` config, `chainDescriptors`, `--build-profile`                                                  | Unchanged, in Hardhat. A descriptor becomes a `route` (`backend`, `apiUrl`, `apiKey`)                                       |
| Chains without a descriptor: Etherscan's and Blockscout's live chain lists                              | explorer-verify's routing table                                                                                             |
| Local-network rejection, contract identification from bytecode, solc inference                          | Unchanged, in Hardhat                                                                                                       |
| Minimal and full Standard JSON input, constructor argument encoding, library detection                  | Unchanged, in Hardhat. The minimal-then-full retry is two `verify()` calls                                                  |
| Already-verified check                                                                                  | `verify()`: it looks the contract up first and compares the stored contract name and compiler version                       |
| Etherscan v2, Blockscout and Sourcify request building and parsing                                      | explorer-verify's clients                                                                                                   |
| Polling every 3 s with no overall limit                                                                 | `verify()` polling; the adapter passes `timeoutMs: Infinity` by default, and `--verification-timeout` sets a budget         |
| No request retries                                                                                      | Up to 5 attempts with backoff on 429 and 5xx                                                                                |
| `Unable to locate ContractCode` threw HHE80021 at once                                                  | Resubmitted up to 10 times, or for `--index-wait`, then `not-indexed`                                                       |
| `--force` skipped the already-verified check                                                            | `submitOverPartial: true`. An exact match is not resubmitted                                                                |
| Console messages                                                                                        | The same text. The "Submitted" line comes from the `verify.submitted` event                                                 |
| HHE error codes                                                                                         | Each `ExplorerVerifyError` code maps onto an existing HHE code, plus one new code, HHE80030, that carries the resume handle |
| HTTP through Hardhat's request layer: `User-Agent: Hardhat`, `HTTP(S)_PROXY`                            | A `fetch` option built on that layer's dispatcher, which keeps both                                                         |
| `connection.verification.etherscan`, with `customApiCall`                                               | Unchanged: the `Etherscan` class stays for this public helper                                                               |
| Ignition (`ignition verify`, `ignition deploy --verify`)                                                | Unchanged: it calls `verifyContract`, which now goes through explorer-verify                                                |

## Lines removed

`git diff --stat` on `packages/hardhat-verify/src`: 20 files, 858 lines added and 1,362 deleted, net
−504.

| Deleted                                        | Lines |
| ---------------------------------------------- | ----- |
| `internal/blockscout.ts`                       | 566   |
| `internal/sourcify.ts`                         | 459   |
| `internal/blockscout.types.ts`                 | 61    |
| `internal/sourcify.types.ts`                   | 36    |
| `internal/verification-providers.ts`           | 15    |
| Unused interfaces in `internal/types.ts` (net) | 43    |

| Added                                                   | Lines     |
| ------------------------------------------------------- | --------- |
| `explorers.ts`: routing, explorer names, page URLs      | 188       |
| `explorer-errors.ts`: error code to HHE code            | 132       |
| `tasks/verify/resume/*`: the new resume task            | 145       |
| `hardhat-fetch.ts`: the `fetch` on Hardhat's HTTP layer | 56        |
| `constants.ts`                                          | 13        |
| `verification.ts`, rewritten around `verify()` (net)    | about +31 |

The explorer clients and the provider factory account for 1,137 of the deleted lines. Another 997
lines, `etherscan.ts` (739) and `etherscan.types.ts` (258), left the verify path but stay for
`connection.verification.etherscan`. Outside the plugin, `hardhat-errors` gained HHE80030.

## Tests

`pnpm test` in `packages/hardhat-verify` (`node:test`, Node 24.21.0):

| Run                   | Passing | Failing | Todo |
| --------------------- | ------- | ------- | ---- |
| Before (Hardhat main) | 267     | 0       | 14   |
| After                 | 214     | 0       | 14   |

| Change                                                       | Tests | Why                                                                                                                            |
| ------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| `test/blockscout.ts` and `test/sourcify.ts` deleted          | −68   | They tested the deleted clients (46 and 22 tests); explorer-verify tests that code                                             |
| "Provider Factory Pattern" in `test/verification.ts` deleted | −4    | The factory is gone                                                                                                            |
| Mocks adapted in `test/verification.ts`                      | 7     | explorer-verify sends each Etherscan request as a form POST to `/v2/api?chainid=…`, and checks a `Fail` status with one lookup |
| `VERIFICATION_PROVIDER_NAMES` test added                     | +1    | Replaces the factory tests                                                                                                     |
| `test/explorers.ts` added                                    | +15   | Routing per provider, error mapping for six codes, `User-Agent: Hardhat` through the injected dispatcher                       |
| `test/explorer-verify-flow.ts` added                         | +3    | Already verified, another contract's source, and a timeout that resumes from its handle                                        |

72 tests went with the deleted clients and factory, 7 were adapted and 19 were added. `test/etherscan.ts`
(45 tests) still passes, since the `Etherscan` class stays. `hardhat-errors` (38 tests) and Ignition's
`test/tasks/verify.ts` (6 tests) pass.

## Live results on Sepolia

Run on 2026-11-12 between 17:35 and 18:41 UTC. Two contracts were deployed with Ignition: `Vault`
with constructor arguments, and `VaultCopy`, the same code under another name.

| Contract                              | Address                                      | Explorer pages                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Vault("explorer-verify demo", 1000)` | `0xEF355DB8A94b079c5ab7791f8F882a17a599Db9D` | [Etherscan](https://sepolia.etherscan.io/address/0xEF355DB8A94b079c5ab7791f8F882a17a599Db9D#code), [Blockscout](https://eth-sepolia.blockscout.com/address/0xEF355DB8A94b079c5ab7791f8F882a17a599Db9D#code), [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0xEF355DB8A94b079c5ab7791f8F882a17a599Db9D) |
| `VaultCopy`                           | `0x90002B90cc39f968ef59C61F0e841Ba47F1c8db7` | [Etherscan](https://sepolia.etherscan.io/address/0x90002B90cc39f968ef59C61F0e841Ba47F1c8db7#code), [Blockscout](https://eth-sepolia.blockscout.com/address/0x90002B90cc39f968ef59C61F0e841Ba47F1c8db7#code), [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0x90002B90cc39f968ef59C61F0e841Ba47F1c8db7) |

| Step                                                    | Result                                                                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify` on `Vault` without `--contract`                | HHE80010: `Vault` and `VaultCopy` have the same bytecode apart from metadata. The same as 3.1.5                                                                                     |
| `verify` on `Vault` with `--contract` and a 90 s budget | Blockscout verified it. Sourcify already held it, because Blockscout had passed the source on. Etherscan accepted the submit; its job was still pending, so HHE80030 gave a handle  |
| `verify` on `Vault` again, Blockscout and Sourcify      | "has already been verified", the same text as 3.1.5, byte for byte                                                                                                                  |
| `verify resume <handle>`                                | Polled the same Etherscan job, with no new submit                                                                                                                                   |
| `verify` on `VaultCopy`, Blockscout                     | Blockscout held `Vault`'s source for `VaultCopy`. 3.1.5 printed "has already been verified"; the new path said so, submitted, and Blockscout verified `VaultCopy` as an exact match |
| `ignition verify chain-11155111`                        | Both contracts reported per provider, through `verifyContract`. Run with Etherscan disabled                                                                                         |

During the whole run, every Etherscan Sepolia job stayed `Pending in queue`, for the published
3.1.5 and for the proof of concept alike. Each submit returned a job id, so the request was
accepted. A Sourcify lookup with a mixed-case address returned an older cached answer, while the
lower-case lookup explorer-verify sends returned the fresh one
([Sourcify lookup cache](2026-11-11-sourcify-lookup-cache.md)).

## Behaviour changes

Existing cases print the same text. These change:

- The contract is identified before the already-verified check, because `verify()` compares the
  stored contract name and compiler version. A contract that is verified but cannot be identified
  locally now fails with the local HHE error instead of printing "already verified".
- An explorer that holds another contract's source no longer reads as "already verified": the
  source is submitted. An `ℹ️` line says so.
- A partial match is reported (`Match: partial`), and `--force` submits over it. An exact match is
  never resubmitted.
- Sourcify gets the input without `settings.libraries`, which gives an exact match for linked
  contracts.
- A contract the explorer has not indexed yet is resubmitted, up to 10 times, instead of failing at
  once with HHE80021.
- Chains without a descriptor resolve through explorer-verify's routing table, not the live chain
  lists.
- With `--verification-timeout`, a spent budget throws HHE80030 with a handle that
  `verify resume` finishes. Without it, the task waits as 3.1.5 does.

## Gaps in explorer-verify

| Gap                                                     | What the proof of concept did                                         | Issue                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| No explorer page for a custom route                     | Built page URLs from Hardhat's chain descriptors                      | [#389](https://github.com/aelmanaa/explorer-verify/issues/389) |
| `failed` has only `reason` text                         | Read the reason text to decide on the full-input retry, as 3.1.5 does | [#390](https://github.com/aelmanaa/explorer-verify/issues/390) |
| Another contract's source shows only in a log line      | Matched the log text to print its own line                            | [#391](https://github.com/aelmanaa/explorer-verify/issues/391) |
| Messages name the backend ID, such as `etherscan-v2`    | Replaced the ID with the explorer's name                              | [#392](https://github.com/aelmanaa/explorer-verify/issues/392) |
| `engines.node` was `>=22.18.0`; Hardhat 3 needs 22.13.0 | Ran on Node 24                                                        | [#393](https://github.com/aelmanaa/explorer-verify/issues/393) |
| No documented `fetch` for a `User-Agent` and a proxy    | Passed Hardhat's dispatcher to Node's `fetch`                         | [#394](https://github.com/aelmanaa/explorer-verify/issues/394) |
| An Etherscan `Fail` sends one more lookup, undocumented | The test mocks answer that lookup                                     | [#394](https://github.com/aelmanaa/explorer-verify/issues/394) |

## Sources

- hardhat-verify 3.1.5 on npm: https://www.npmjs.com/package/@nomicfoundation/hardhat-verify
  (`npm pack`, 2026-11-12)
- Hardhat repository, main at `d7a45add`: https://github.com/NomicFoundation/hardhat/tree/d7a45add1938
- Hardhat 3 prerequisites, Node.js 22.13.0 or later: https://hardhat.org/docs/getting-started (read
  2026-11-12)
- explorer-verify 0.2.1 on npm: https://www.npmjs.com/package/explorer-verify
- Sepolia explorer pages of the two contracts, linked in the table above (2026-11-12)
- Test counts, line counts and the live run: the proof of concept, run on 2026-11-12 with Node
  24.21.0 and pnpm 12.17.0
