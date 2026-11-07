# Match types

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers and agents who read the `match` of a result and want to know what it says
about the deployed code.

A successful result carries `match`: `exact` or `partial`. This page explains what each means,
which one a build can reach, how explorers verify some contracts without a submit, and what
explorer-verify reports in each case. Each fact about an explorer links its source and the date it
was read or seen.

## The metadata hash

The Solidity compiler appends CBOR-encoded data to the end of the bytecode. By default it holds a
hash of the contract's metadata file
([Solidity metadata](https://docs.soliditylang.org/en/v0.8.24/metadata.html), read 2026-11-04).
The metadata holds a keccak256 hash of each source file, so any change to a source file changes the
metadata hash, a comment or a variable name included
([Sourcify, exact match and match](https://docs.sourcify.dev/docs/exact-match-vs-match/), read
2026-11-04).

So two builds can differ only in that hash: the code runs the same, but the sources or settings
that produced it are not byte for byte the same.

## Exact and partial

explorer-verify uses Sourcify's terms
([Sourcify, exact match and match](https://docs.sourcify.dev/docs/exact-match-vs-match/), read
2026-11-04):

- `exact`: the recompiled bytecode equals the deployed bytecode, metadata hash included.
- `partial`: everything but the metadata hash matches.

A partial match still shows that the published sources compile to the deployed code. It does not
show that they are the exact files the deployer compiled.

## Why a build can reach only a partial match

A build compiled with `bytecodeHash` set to `"none"` carries no metadata hash
([Solidity compiler input](https://docs.soliditylang.org/en/v0.8.24/using-the-compiler.html),
read 2026-11-04). Foundry sets it with `bytecode_hash = "none"`; its default is `"ipfs"`
([Foundry compiler config](https://getfoundry.sh/reference/config/solidity-compiler), read
2026-11-04). With no hash to compare, a match cannot show that the sources are the exact files
compiled, and Blockscout reports such a build as a partial match
([prior art](../../contributor/prior-art.md#behaviour-both-implementations-learned)). For that
build, partial is the best result, not a failure.

Linked libraries can lower the grade too. On 2026-11-03, a contract compiled without library
addresses and linked afterwards, as Foundry does, got an exact match on Sourcify when submitted
with `settings.libraries` empty, and only a partial match when submitted with the library address
in `settings.libraries`: the metadata includes the library addresses, so they change the hash
([live probe E](../../contributor/research/2026-11-03-m2-live-probes.md#e-a-contract-linked-to-an-external-library)).
Etherscan verified both inputs as an exact match in the same probe.

## Each explorer's terms

| Explorer   | Its terms                                                                                       | Source                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Sourcify   | `exact_match` and `match` on the creation code, the runtime code and the whole contract         | [Sourcify v2 research](../../contributor/research/2026-11-02-sourcify-v2.md#match-values), 2026-11-02                                 |
| Etherscan  | Exact Match, Similar Match and Runtime Match badges on the explorer page                        | [Types of contract verification](https://info.etherscan.com/types-of-contract-verification/), read 2026-11-04                         |
| Blockscout | Full and partial verification; the client reads `is_fully_verified` and `is_partially_verified` | [Blockscout client research](../../contributor/research/2026-11-04-blockscout-client.md), live 2026-11-04                             |
| Routescan  | `getsourcecode` returns the source, with no `SimilarMatch` field                                | [Live probe B](../../contributor/research/2026-11-03-m2-live-probes.md#b-routescan-keyless-submit-as-a-form-encoded-post), 2026-11-03 |

Etherscan describes its badges this way (read 2026-11-04):

- Exact Match: "the exact contract code that was deployed", constructor arguments included.
- Runtime Match: the runtime bytecode matches the source, but the creation code and constructor
  arguments are not checked.
- Similar Match: set automatically when a contract's creation bytecode matches a contract that is
  already verified. It "does not take into account constructor arguments". The page says there is
  no tool to turn a Similar Match into an Exact Match for now, and that re-verification of a Similar
  Match is enabled for allowlisted users.

## Verified without a submit

Explorers verify some contracts on their own:

- Etherscan Similar Match, described above. On 2026-11-03 a factory child that was never submitted
  got a Similar Match within 6.7 seconds of its sibling's submit, although its immutable differed
  ([live probe D](../../contributor/research/2026-11-03-m2-live-probes.md#d-similar-match-and-getcontractcreation-for-a-factory-deployment)).
- Blockscout's Ethereum Bytecode Database compares only the functionally significant part of the
  bytecode, without the metadata part, and its docs show a contract verified on one chain being
  verified automatically on another
  ([Blockscout bytecode database](https://docs.blockscout.com/about/features/ethereum-bytecode-database-microservice),
  read 2026-11-04).
- Sourcify similarity verification looks for candidates by the first 75 bytes of the runtime
  bytecode, then recompiles with each candidate's sources and settings until one matches. Explorers
  can start it, and Sourcify's monitor schedules it after contract creation on the chains it watches
  ([Sourcify similarity verification](https://docs.sourcify.dev/docs/similarity-verification/),
  read 2026-11-04).
- A Sourcify submit can verify the contract on other explorers too: on 2026-11-02 its jobs listed
  Etherscan, Blockscout and Routescan submissions, and on Polygon Amoy Etherscan showed the contract
  verified after the Sourcify submit alone ([Sourcify](../reference/sourcify.md#behaviour-to-know)).

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

In this release, Sourcify and Etherscan v2 have a client. On Sourcify, `exact_match` becomes
`exact` and `match` becomes `partial` ([Sourcify](../reference/sourcify.md#how-answers-are-read)).
On Etherscan, `Pass - Verified` becomes `exact`; a lookup with a non-empty `SimilarMatch` field
becomes `partial`, because Etherscan matched the contract from another contract's verified source,
not from a source submitted for this address, even where the explorer page shows `Exact Match` next
to it ([Etherscan](../reference/etherscan.md#how-answers-are-read)). A partial
match found by the lookup is returned as `already-verified`, without a submit
([verify()](../reference/verify.md)). On Sourcify, a submit of exact sources for a contract with
only a partial match upgrades it to an exact match
([Sourcify](../reference/sourcify.md#behaviour-to-know)). explorer-verify does not do that yet: to
upgrade, submit the exact sources another way. An option for this is planned.

On Blockscout, `is_fully_verified` becomes `exact` and `is_partially_verified` becomes `partial`.
On 2026-11-04, a build without a metadata hash gave `verified` with `partial`, never `failed`
([Blockscout](../reference/blockscout.md#partial-matches)).

## Which match to aim for

- Compile with a metadata hash, the default, and submit the Standard JSON input of that build. That
  build can reach `exact`.
- Submit `settings.libraries` as it was at compile time, not with addresses added afterwards.
- A build without a metadata hash can only reach `partial`. That result is correct for it.
