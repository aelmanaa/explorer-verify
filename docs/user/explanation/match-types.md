# Match types

Version: explorer-verify 0.1.0

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
| Routescan                           | `Pass - Verified`; the lookup has no field that grades the match | `exact`                         |

The same contract built with the default `"ipfs"` hash got `exact` on all four. Blockscout gave the
same partial grade on Base Sepolia ([Blockscout](../reference/blockscout.md#partial-matches)).

On Sourcify and Blockscout, partial is the best such a build can get; it is not a failure.
Etherscan's `exact` fits its own definition of an Exact Match, "the exact contract code that was
deployed", which does not depend on a metadata hash.

Routescan states no grade. So explorer-verify reports every Routescan match as `exact`, which there
means "verified", not a checked grade.

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
up first (R-FLOW-1): when the explorer already has a match, it returns `already-verified` with that
match and sends no source.

## What explorer-verify reports

| Case                                                       | Result                                      |
| ---------------------------------------------------------- | ------------------------------------------- |
| The lookup finds an exact or partial match                 | `already-verified`, with that match         |
| The submit or the job ends with a match                    | `verified`, with that match                 |
| The explorer answers that the contract is already verified | `already-verified`                          |
| The explorer rejects the source                            | `failed`, with the explorer's reason        |
| An answer explorer-verify cannot classify                  | A typed error; never `verified` or `failed` |

Each client maps the explorer's answer to `match` this way:

| Explorer   | `exact`             | `partial`                                |
| ---------- | ------------------- | ---------------------------------------- |
| Sourcify   | `exact_match`       | `match`                                  |
| Etherscan  | `Pass - Verified`   | A lookup with a non-empty `SimilarMatch` |
| Blockscout | `is_fully_verified` | `is_partially_verified`                  |

The client pages say how each answer is read: [Sourcify](../reference/sourcify.md#how-answers-are-read),
[Etherscan](../reference/etherscan.md#how-answers-are-read),
[Blockscout](../reference/blockscout.md#how-answers-are-read) and
[Routescan](../reference/routescan.md#how-answers-are-read).

On Etherscan, a `SimilarMatch` means Etherscan matched the contract from another contract's
verified source, not from a source submitted for this address. explorer-verify reports `partial`
even where the explorer page shows `Exact Match` next to it.

A partial match found by the lookup is returned as `already-verified`, without a submit
([verify()](../reference/verify.md)). On Blockscout, a build without a metadata hash gives
`verified` with `partial`, never `failed`.

On Sourcify, a submit of exact sources for a contract with only a partial match upgrades it to an
exact match. explorer-verify does not do that yet: to upgrade, submit the exact sources another
way. An option for this is planned.

## Which match to aim for

- Compile with a metadata hash, the default, and submit the Standard JSON input of that build. That
  build can reach `exact`.
- Submit `settings.libraries` as it was at compile time, not with addresses added afterwards.
- A build without a metadata hash reaches only `partial` on Sourcify and Blockscout, and `exact` on
  Etherscan v2 and Routescan. On Sourcify and Blockscout, `partial` is the correct result for it.
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
