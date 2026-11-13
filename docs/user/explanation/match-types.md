# Match types

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who read the `match` of a result and want to know what it says
about the deployed code.

A successful result carries `match`: `exact` or `partial`. This page explains what each means,
which one a build can reach, how explorers verify some contracts without a submit, and what
explorer-verify reports in each case.

| `match`   | What matches                                  | What it shows                            |
| --------- | --------------------------------------------- | ---------------------------------------- |
| `exact`   | The deployed bytecode, metadata hash included | The sources are the exact files compiled |
| `partial` | Everything but the metadata hash              | The sources compile to the deployed code |

## The metadata hash

The Solidity compiler appends CBOR-encoded data to the end of the bytecode. By default it holds a
hash of the contract's metadata file. The metadata holds a keccak256 hash of each source file. So
any change to a source file changes the metadata hash, a comment or a variable name included.

So two builds can differ only in that hash: the code runs the same, but the sources or settings
that produced it are not byte for byte the same.

## Exact and partial

explorer-verify uses Sourcify's terms:

- `exact`: the recompiled bytecode equals the deployed bytecode, metadata hash included.
- `partial`: everything but the metadata hash matches.

A partial match still shows that the published sources compile to the deployed code. It does not
show that they are the exact files the deployer compiled.

## Builds without a metadata hash

A build compiled with `bytecodeHash` set to `"none"` carries no metadata hash. Foundry sets it with
`bytecode_hash = "none"`; its default is `"ipfs"`. With no hash to compare, a match cannot show
that the sources are the exact files compiled.

Explorers grade such a build differently. One such contract per explorer was deployed on Ethereum
Sepolia and submitted for the first time with explorer-verify 0.1.0:

| Explorer                            | Its answer                                                       | `match` explorer-verify reports |
| ----------------------------------- | ---------------------------------------------------------------- | ------------------------------- |
| Etherscan v2                        | `Pass - Verified`; the lookup has an empty `SimilarMatch`        | `exact`                         |
| Sourcify                            | `match` for the creation and the runtime code, not `exact_match` | `partial`                       |
| Blockscout, instance and hosted API | `is_fully_verified` `false`, `is_partially_verified` `true`      | `partial`                       |
| Routescan                           | `Pass - Verified`; the lookup has no field that grades the match | `partial`                       |

The same contract built with the default `"ipfs"` hash got `exact` on Etherscan v2, Sourcify and
Blockscout. Blockscout gave the same partial grade on Base Sepolia ([Blockscout](../reference/blockscout.md#partial-matches)).

On Sourcify and Blockscout, partial is the best such a build can get; it is not a failure.
Etherscan's `exact` fits its own definition of an Exact Match, "the exact contract code that was
deployed", which does not depend on a metadata hash.

Routescan states no grade, so explorer-verify reports every Routescan match as `partial` (decision
0063): its verified state is not a checked grade.

## Linked libraries

Linked libraries can lower the grade too. Take a contract compiled without library addresses and
linked afterwards, as Foundry does:

| Submitted `settings.libraries` | Sourcify  | Etherscan |
| ------------------------------ | --------- | --------- |
| Empty, as at compile time      | `exact`   | `exact`   |
| With the library address added | `partial` | `exact`   |

The metadata includes the library addresses, so adding them changes the hash.

## Each explorer's terms

| Explorer   | Its terms                                                                               |
| ---------- | --------------------------------------------------------------------------------------- |
| Sourcify   | `exact_match` and `match` on the creation code, the runtime code and the whole contract |
| Etherscan  | Exact Match, Similar Match and Runtime Match badges on the explorer page                |
| Blockscout | Full and partial verification: `is_fully_verified` and `is_partially_verified`          |
| Routescan  | `getsourcecode` returns the source, with no `SimilarMatch` field                        |

Etherscan describes its badges this way:

- Exact Match: "the exact contract code that was deployed", constructor arguments included.
- Runtime Match: the runtime bytecode matches the source, but the creation code and constructor
  arguments are not checked.
- Similar Match: set automatically when a contract's creation bytecode matches a contract that is
  already verified. It "does not take into account constructor arguments".

Etherscan's page says there is no tool to turn a Similar Match into an Exact Match for now.
Re-verification of a Similar Match is enabled for allowlisted users.

## Verified without a submit

Explorers verify some contracts on their own:

- Etherscan Similar Match, described above. A factory child that was never submitted got a Similar
  Match within 6.7 seconds of its sibling's submit, although its immutable differed.
- Blockscout's Ethereum Bytecode Database compares the bytecode without the metadata part. Its
  docs show a contract verified on one chain being verified automatically on another.
- Sourcify similarity verification finds candidates by the first 75 bytes of the runtime bytecode,
  then recompiles with each candidate's sources and settings until one matches. Explorers can
  start it, and Sourcify's monitor schedules it after contract creation on the chains it watches.
- A Sourcify submit can verify the contract on other explorers too
  ([Sourcify](../reference/sourcify.md#behaviour-to-know)).

So a contract can be verified before anyone submits it. This is why `verify()` looks the contract
up first (R-FLOW-1): when the explorer already has a match of this source, it returns
`already-verified` with that match and sends no source.

The match can also come from another contract's source. On Ethereum Sepolia on 2026-11-10, Sourcify,
Blockscout and Routescan held a match for two new contracts 56 to 94 seconds after each deployment,
under other contract names and compiler versions. Such a match covers the bytecode, not the
caller's source. So `verify()` compares the contract name and the compiler version that the
explorer stores with the input, and submits when either differs (decision 0063):

- The name: a stored `path:Name`, as Sourcify gives it, is compared with the whole `contractName`.
  A stored `Name`, as Etherscan, Routescan and Blockscout give it, is compared with the part of
  `contractName` after its last `:`.
- The compiler version: compared without a leading `v` and in lower case. When one of the two has
  no `+commit.` part, only the release before the `+` is compared.
- An answer that names neither keeps the earlier rule: the match ends the call.

## What explorer-verify reports

| Case                                                          | Result                                               |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| The lookup finds an exact or partial match of this source     | `already-verified`, with that match                  |
| A partial match of this source, with `submitOverPartial`      | A submit, then one of the rows below                 |
| The lookup finds a match of another contract's source         | A submit, then one of the rows below                 |
| The submit or the job ends with a match                       | `verified`, with that match                          |
| The explorer answers that the contract is already verified    | `already-verified`                                   |
| The explorer refuses the submit over another contract's match | `already-verified`, `partial`, with `storedContract` |
| The explorer rejects the source                               | `failed`, with the explorer's reason                 |
| An answer explorer-verify cannot classify                     | A typed error; never `verified` or `failed`          |

A result of `verify()` never says `verified` or `exact` for a match whose stored name or compiler
version differs from the input. `dryRun()` reports such a match with `storedContract`, because
`verify()` would submit. `checkStatus()` has no input to compare, so a resumed handle can report
another contract's match ([checkStatus()](../reference/check-status.md)).

Each client maps the explorer's answer to `match` this way:

| Explorer   | `exact`             | `partial`                                |
| ---------- | ------------------- | ---------------------------------------- |
| Sourcify   | `exact_match`       | `match`                                  |
| Etherscan  | `Pass - Verified`   | A lookup with a non-empty `SimilarMatch` |
| Blockscout | `is_fully_verified` | `is_partially_verified`                  |
| Routescan  | Never               | Every match                              |

The client pages say how each answer is read: [Sourcify](../reference/sourcify.md#how-answers-are-read),
[Etherscan](../reference/etherscan.md#how-answers-are-read),
[Blockscout](../reference/blockscout.md#how-answers-are-read) and
[Routescan](../reference/routescan.md#how-answers-are-read).

On Etherscan, a `SimilarMatch` means Etherscan matched the contract from another contract's
verified source, not from a source submitted for this address. explorer-verify reports `partial`
even where the explorer page shows `Exact Match` next to it.

A partial match of this source found by the lookup is returned as `already-verified`, without a submit
([verify()](../reference/verify.md)), unless `submitOverPartial` is set. On Blockscout, a build without a metadata hash gives
`verified` with `partial`, never `failed`.

On Sourcify, a submit of exact sources for a contract with only a partial match upgrades it to an
exact match ([Sourcify](../reference/sourcify.md#behaviour-to-know)). To upgrade, set
`submitOverPartial`: `verify()` then submits over a partial match of this source. On Ethereum
Sepolia on 2026-11-11, Sourcify and Blockscout upgraded such matches to exact. When the explorer
rejects the submit, the partial match stays and the result is `already-verified`, `partial`, not
`failed` ([Submit over a partial match](../reference/verify.md#submit-over-a-partial-match)).

On Routescan, every match is `partial`, from a lookup or from `Pass - Verified`. Routescan states
no grade: its `getsourcecode` has no `SimilarMatch` field, and on 2026-11-10 it passed a build
without a metadata hash that Sourcify and Blockscout graded partial, and took copies forwarded from
Sourcify and Blockscout submits ([Routescan](../reference/routescan.md#behaviour-to-know)).

## Which match to aim for

- Compile with a metadata hash, the default, and submit the Standard JSON input of that build. That
  build can reach `exact`.
- Submit `settings.libraries` as it was at compile time, not with addresses added afterwards.
- A build without a metadata hash reaches only `partial` on Sourcify and Blockscout, and `exact` on
  Etherscan v2. Routescan reports `partial` for every match. On Sourcify and Blockscout, `partial`
  is the correct result for it.
  See [Builds without a metadata hash](#builds-without-a-metadata-hash).

## Sources

- The metadata hash and `bytecodeHash`:
  [Solidity metadata](https://docs.soliditylang.org/en/v0.8.24/metadata.html) and
  [Solidity compiler input](https://docs.soliditylang.org/en/v0.8.24/using-the-compiler.html),
  read 2026-11-04.
- Exact match and match:
  [Sourcify, exact match and match](https://docs.sourcify.dev/docs/exact-match-vs-match/), read
  2026-11-04.
- Foundry's `bytecode_hash`:
  [Foundry compiler config](https://getfoundry.sh/reference/config/solidity-compiler), read
  2026-11-04.
- Grades of a build without a metadata hash: live probe on 2026-11-10,
  [results](../../contributor/research/2026-11-10-no-metadata-hash-grades.md#results). Blockscout
  on Base Sepolia: live run on 2026-11-04.
- Linked libraries: live probe on 2026-11-03,
  [probe E](../../contributor/research/2026-11-03-m2-live-probes.md#e-a-contract-linked-to-an-external-library).
- Etherscan's badges:
  [Types of contract verification](https://info.etherscan.com/types-of-contract-verification/),
  read 2026-11-04.
- Sourcify's terms: [Sourcify v2 research](../../contributor/research/2026-11-02-sourcify-v2.md#match-values),
  2026-11-02.
- Blockscout's terms: [Blockscout client research](../../contributor/research/2026-11-04-blockscout-client.md),
  live 2026-11-04.
- Routescan's lookup:
  [live probe B](../../contributor/research/2026-11-03-m2-live-probes.md#b-routescan-keyless-submit-as-a-form-encoded-post),
  2026-11-03.
- The Similar Match of a factory child: live probe on 2026-11-03,
  [probe D](../../contributor/research/2026-11-03-m2-live-probes.md#d-similar-match-and-getcontractcreation-for-a-factory-deployment).
- [Blockscout bytecode database](https://docs.blockscout.com/about/features/ethereum-bytecode-database-microservice)
  and [Sourcify similarity verification](https://docs.sourcify.dev/docs/similarity-verification/),
  read 2026-11-04.
