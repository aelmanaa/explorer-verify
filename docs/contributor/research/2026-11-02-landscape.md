# 2026-11-02: Existing libraries and demand

Audience: the maintainer deciding scope and positioning. npm registry searches and package reads on
2026-11-02.

## Packages that verify contracts

| Package                                                   | What it does                                                      | Where it runs                              |
| --------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| `@nomicfoundation/hardhat-verify` 3.1.4                   | Hardhat plugin: verifies on Etherscan-style, Blockscout, Sourcify | Hardhat on Node                            |
| `@rocketh/verifier` 0.19.34, about 3,000 downloads a week | Verifies on Etherscan, Sourcify and compatible explorers          | Node CLI; imports `fs` and `path`          |
| `@deployoor/sourcify` 0.3.0                               | Verifies on Sourcify v2, keyless, when deployoor deploys          | With the deployoor deploy tool             |
| `etherscan-api` 12.2.0, about 2,400 downloads a week      | Etherscan v2 API wrapper                                          | JavaScript package with no dependencies    |
| `@ethereum-sourcify/lib-sourcify` 3.7.4                   | Sourcify's recompilation library                                  | Sourcify's server                          |
| `thirdweb` 5.122.1                                        | `verifyContract` and `checkVerificationStatus`; see below         | Browser and Node, through the thirdweb SDK |

Remix verifies in the browser against Etherscan, Blockscout, Sourcify and Routescan through an IDE
plugin. The searches found no package that is a runtime-neutral verification client with a
server-side key handler.

## thirdweb `verifyContract`

Read on 2026-11-02 from thirdweb-dev/js at commit 940b3745 (thirdweb 5.122.1),
`packages/thirdweb/src/contract/verification/index.ts`:

- Input is a `ThirdwebContract` (requires a thirdweb client), an explorer API URL and key, optional
  encoded constructor arguments, and a type: `etherscan`, `blockscoutV1`, `blockscoutV2` or
  `routescan`.
- Sources come from the IPFS metadata hash in the deployed bytecode; it throws "Contract bytecode
  does not contain IPFS URI, cannot verify" otherwise. This fits contracts whose metadata is pinned
  on IPFS, as thirdweb's own deploy flow does.
- `verifyContract` submits and returns the explorer's result. The exported `checkVerificationStatus`
  polls the explorer every 3 seconds until the status is no longer pending or in progress.
- At this commit the status URL ends with an extra `"` after the API key. Reported as
  thirdweb-dev/js#9049, with a proposed fix in thirdweb-dev/js#9050.

## Demand signals

- No public request for a browser-side verification library was found. An old token-wizard issue
  asked for automatic Etherscan verification after deployment and was shelved.
- No-code token launchers found treat verification as manual or optional.
- Explorers verify repeat deployments automatically (see
  [explorer APIs](2026-11-02-explorer-apis.md#automatic-matching-no-submission-needed)), which narrows
  the need to exact matches, first deployments, explorers without automatic matching, and one result
  format.
- Two independent implementations inside one SDK (see [prior art](../prior-art.md)) show a protocol
  SDK needs this; that is the first adopter profile.
