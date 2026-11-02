# 2026-11-02: Existing libraries and demand

Audience: the maintainer deciding scope and positioning. npm registry searches and package reads on
2026-11-02.

## Packages that verify contracts

| Package                                                   | What it is                                            | Runs in a browser?                                                           |
| --------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `@nomicfoundation/hardhat-verify` 3.1.4                   | Hardhat plugin: Etherscan-style, Blockscout, Sourcify | No: Hardhat and Node                                                         |
| `@rocketh/verifier` 0.19.34, about 3,000 downloads a week | Etherscan, Sourcify and compatible explorers          | No: Node CLI, imports `fs` and `path`, depends on `fs-extra` and `commander` |
| `@deployoor/sourcify` 0.3.0                               | Sourcify v2, keyless                                  | Tied to the deployoor deploy tool                                            |
| `etherscan-api` 12.2.0, about 2,400 downloads a week      | Thin Etherscan v2 API wrapper, no dependencies        | Building block only: no routing, no other explorers, no polling flow         |
| `@ethereum-sourcify/lib-sourcify` 3.7.4                   | Sourcify's server-side recompilation library          | Not a client                                                                 |
| `thirdweb` 5.122.1 `verifyContract`                       | See below                                             | Yes, inside the thirdweb SDK                                                 |

Remix verifies in the browser against Etherscan, Blockscout, Sourcify and Routescan, but as an IDE
plugin, not an installable library. No package found is a runtime-neutral verification client with
a server-side key handler.

## thirdweb `verifyContract`

Read from the published package source (`src/contract/verification/index.ts`, thirdweb 5.122.1) and
the GitHub history of that file:

- Input is a `ThirdwebContract` (requires a thirdweb client), an explorer API URL and key, optional
  encoded constructor arguments, and a type: `etherscan`, `blockscoutV1`, `blockscoutV2` or
  `routescan`.
- Sources come only from the IPFS metadata hash in the deployed bytecode; it throws "Contract
  bytecode does not contain IPFS URI, cannot verify" otherwise. In practice that means contracts
  whose metadata is pinned on IPFS, as thirdweb's own deploy flow does.
- No Sourcify. Submission only; `checkVerificationStatus` is a separate call that polls every 3
  seconds without a deadline.
- Last functional change 2024-07-03 (Blockscout v2). Two issues or pull requests ever mention it.
- The status URL appended a stray `"` to the API key; reported as thirdweb-dev/js#9049 with a fix in
  thirdweb-dev/js#9050.
- The package has 31 runtime dependencies (wallet SDKs, React, WalletConnect) and a 99 MB `dist`.

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
