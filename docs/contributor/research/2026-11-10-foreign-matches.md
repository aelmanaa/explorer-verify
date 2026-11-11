# Matches from another contract's source

Date: 2026-11-10. Scope: issue [#293](https://github.com/aelmanaa/explorer-verify/issues/293).
Question: what do Sourcify, Blockscout, Routescan and Etherscan store for a newly deployed contract
whose bytecode matches a common contract, and what in each lookup answer names the stored source?

## Observation

While explorer-verify was integrated into the Remix contract-verification plugin on 2026-11-10,
two contracts deployed on Ethereum Sepolia (11155111) were verified on Etherscan from the
deployer's source. Outside parties had stored a match on the other explorers 56 to 94 seconds after
each deployment, under other contract names and compiler versions (issue #293). The deployer did
not submit to those explorers. Before this change, `verify()` with `route.backend` `sourcify`,
`blockscout` or `routescan` returned `already-verified` and never submitted the deployer's source.

| Address                                      | Etherscan (the deployer's source)    | Sourcify                                                                       | Blockscout                                                            | Routescan                                     |
| -------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------- |
| `0xA67A1256B513AfA0cBD89671bD0eca062117A3D9` | `EvBox`, `v0.8.34+commit.80d5c536`   | `match`, `simplestorage2.sol:SimpleStorage`, `0.8.33+commit.64118f21`          | partial, `SimpleStorage`, `v0.8.31+commit.fd3a2265`                   | `SimpleStorage`, `v0.8.33+commit.64118f21`    |
| `0xFb56a32956Ab007ea2a02C67609740A10f9ED362` | `EvProxy`, `v0.8.34+commit.80d5c536` | `match`, `src/FundManagerProxy.sol:FundManagerProxy`, `0.8.27+commit.40a35a09` | partial, `AuctionProxy`, `v0.8.34+commit.80d5c536`, bytecode database | `FundManagerProxy`, `v0.8.27+commit.40a35a09` |

Blockscout's answer for the second address has `is_verified_via_eth_bytecode_db` `true` and the
file path `project/contracts/AuctionProxy.sol`: a path the bytecode database gives, not the one
the source was compiled with. Its compiler version equals the deployer's; only the name differs.
Blockscout's `verified_at` reads `2026-11-10T08:04:04Z` and `2026-11-10T08:07:34Z`; Sourcify's
`verifiedAt` for the first address reads `2026-11-10T08:03:50Z`.

## Recorded answers

Read-only requests on 2026-11-10 between 13:17:11 and 13:17:15 UTC, with the `fetch` of Node.js
24.21.0, all answered HTTP 200. The reduced recordings are in
`packages/explorer-verify/test/fixtures/{sourcify,blockscout,routescan,etherscan}/2026-11-10-*.json`;
each keeps the match, name and compiler fields and says what it dropped. The Etherscan request
carried a key in its form body; the recording does not.

| Explorer     | Request                                                                                                                             | Name field                                           | Compiler field                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------- |
| Sourcify     | `GET https://sourcify.dev/server/v2/contract/11155111/<address>?fields=compilation`                                                 | `compilation.fullyQualifiedName`, `compilation.name` | `compilation.compilerVersion` |
| Blockscout   | `GET https://eth-sepolia.blockscout.com/api/v2/smart-contracts/<address>`                                                           | `name`, and `file_path`                              | `compiler_version`            |
| Routescan    | `GET https://api.routescan.io/v2/network/testnet/evm/11155111/etherscan/api?module=contract&action=getsourcecode&address=<address>` | `ContractName`                                       | `CompilerVersion`             |
| Etherscan v2 | `POST https://api.etherscan.io/v2/api?chainid=11155111`, `action=getsourcecode`                                                     | `ContractName`                                       | `CompilerVersion`             |

- Sourcify answers `fields=compilation` with the same match fields plus `compilation`. A 404 for an
  unverified address is unchanged: `match` `null` and no `compilation` (curl, 2026-11-10, for
  `0x000000000000000000000000000000000000dEaD`).
- Routescan's answer has no `SimilarMatch` field (it is absent, not empty). Nothing else in it
  shows whether the metadata hash matched, so a non-empty `SourceCode` cannot tell an exact match
  from a partial one.
- Etherscan's records name the deployer's contracts, with `SimilarMatch` empty: `EvBox` and
  `EvProxy`, both `v0.8.34+commit.80d5c536`.
- The server handler's reduced lookup keeps `ContractName` and `CompilerVersion`
  ([decision 0021](../decisions/0021-server-handler-forwards-a-reduced-lookup.md)).

## What the stored name looks like

- Sourcify's `fullyQualifiedName` has the compilation's source path, such as
  `simplestorage2.sol:SimpleStorage`: the same form as `VerifyInput.contractName`.
- Etherscan and Routescan give the name alone.
- Blockscout gives the name, and `file_path` separately. A source from the bytecode database
  carries a path of its own (`project/contracts/…` above), so the path does not say what the caller
  compiled.
- Compiler versions come with a leading `v` on Etherscan, Routescan and Blockscout, and without on
  Sourcify. For zksolc, Blockscout keeps the solc version in `compiler_version` and the zksolc
  version in `zk_compiler_version` ([Blockscout zksolc](2026-11-07-blockscout-zksolc.md)).

## Result

A match does not show whose source the explorer holds. The name and the compiler version do, on
all four explorers. [Decision 0063](../decisions/0063-submit-over-another-contracts-match.md)
compares them with the input and submits when they differ.

## Sources

- Issue [#293](https://github.com/aelmanaa/explorer-verify/issues/293): the observation of
  2026-11-10 on Ethereum Sepolia, with the stored names and compiler versions and the 56 to 94
  second delay after each deployment.
- Sourcify:
  [contract lookup with `fields`](https://sourcify.dev/server/api-docs/#/Contract%20Lookup/get-contract)
  (read 2026-11-10).
- Local runs, Node.js 24.21.0 `fetch`, 2026-11-10, 13:17:11 to 13:17:15 UTC, against
  `https://sourcify.dev/server`, `https://eth-sepolia.blockscout.com/api`,
  `https://api.routescan.io` and `https://api.etherscan.io`: the read-only requests listed above.
- Local run, curl 8.7.1, 2026-11-10: Sourcify's `fields=compilation` answers for an unverified
  address and for the Sepolia Greeter at `0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC`.
