# 2026-11-02: Existing libraries and demand

Audience: the maintainer deciding scope. npm registry searches and package reads on 2026-11-02.
Versions, descriptions and `engines` come from `npm view <package> version description engines
readme` (npm 11.19.0, 2026-11-02).

## Packages that verify contracts

| Package                                 | What it does                                                      | Where it runs                                      |
| --------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `@nomicfoundation/hardhat-verify` 3.1.4 | Hardhat plugin: verifies on Etherscan-style, Blockscout, Sourcify | Hardhat on Node                                    |
| `@rocketh/verifier` 0.19.34             | Verifies on Etherscan, Sourcify and compatible explorers          | Node CLI (`rocketh-verify` bin)                    |
| `@deployoor/sourcify` 0.3.0             | Verifies on Sourcify v2, keyless, when deployoor deploys          | With the deployoor deploy tool                     |
| `etherscan-api` 12.2.0                  | Etherscan v2 API wrapper                                          | Node.js 20 or later (README)                       |
| `@ethereum-sourcify/lib-sourcify` 3.7.4 | Sourcify's verification library                                   | Node (`engines.node` `v26.10.0`); browser (README) |
| `thirdweb` 5.122.1                      | `verifyContract` and `checkVerificationStatus`; see below         | Browser and Node, through the thirdweb SDK         |

Remix IDE (a web IDE) verifies on Sourcify, Etherscan, Blockscout and Routescan through its
Contract Verification plugin
([Remix docs](https://remix-ide.readthedocs.io/en/latest/contract_verification.html), read
2026-11-02).

## thirdweb `verifyContract`

Read on 2026-11-02 from thirdweb-dev/js at commit 940b3745 (thirdweb 5.122.1),
[`packages/thirdweb/src/contract/verification/index.ts`](https://github.com/thirdweb-dev/js/blob/940b3745c7f9643bd20b2e662e27cbb863c16f65/packages/thirdweb/src/contract/verification/index.ts):

- Input is a `ThirdwebContract` (requires a thirdweb client), an explorer API URL and key, optional
  encoded constructor arguments, and a type: `etherscan`, `blockscoutV1`, `blockscoutV2` or
  `routescan`.
- Sources come from the IPFS metadata URI in the deployed bytecode, downloaded through the thirdweb
  client. `verifyContract` throws when the bytecode has no IPFS URI.
- `verifyContract` submits and returns the explorer's result. The exported `checkVerificationStatus`
  polls the explorer every 3 seconds until the status is no longer pending or in progress.

## Demand signals

- Explorers verify repeat deployments automatically (see
  [explorer APIs](2026-11-02-explorer-apis.md#automatic-matching-no-submission-needed)), which narrows
  the need to exact matches, first deployments, explorers without automatic matching, and one result
  format.
- Two independent implementations inside one SDK (see [prior art](../prior-art.md)) show a protocol
  SDK needs this; that is the first adopter profile.

## Sources

- npm registry, read with npm 11.19.0 on 2026-11-02:
  [`@nomicfoundation/hardhat-verify`](https://www.npmjs.com/package/@nomicfoundation/hardhat-verify),
  [`@rocketh/verifier`](https://www.npmjs.com/package/@rocketh/verifier),
  [`@deployoor/sourcify`](https://www.npmjs.com/package/@deployoor/sourcify),
  [`etherscan-api`](https://www.npmjs.com/package/etherscan-api),
  [`@ethereum-sourcify/lib-sourcify`](https://www.npmjs.com/package/@ethereum-sourcify/lib-sourcify),
  [`thirdweb`](https://www.npmjs.com/package/thirdweb).
- thirdweb-dev/js at commit
  [`940b3745`](https://github.com/thirdweb-dev/js/blob/940b3745c7f9643bd20b2e662e27cbb863c16f65/packages/thirdweb/src/contract/verification/index.ts),
  read on 2026-11-02.
- [Remix contract verification docs](https://remix-ide.readthedocs.io/en/latest/contract_verification.html),
  read on 2026-11-02.
- The demand signals rest on [explorer APIs](2026-11-02-explorer-apis.md) and
  [prior art](../prior-art.md).

## Corrections

- 2026-11-02: added the `## Sources` section and the npm version used. Removed "thirdweb's
  deploy flow pins that metadata on IPFS", for which no source was found, and described what
  `verifyContract` does with the IPFS URI instead. Changed where lib-sourcify runs from "Sourcify's
  server" to its `engines.node` field and README. Reworded the Remix sentence to the docs.
