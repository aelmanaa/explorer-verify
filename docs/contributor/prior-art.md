# Prior art to port

Audience: whoever implements M1 to M3. Two working implementations of explorer verification exist
in [smartcontractkit/ccip-tools-ts](https://github.com/smartcontractkit/ccip-tools-ts) (MIT,
copyright SmartContract Chainlink Limited SEZC). Neither is merged into that repository's `main`.
They verify CCIP contracts only, from bundled artifacts; this library generalises them.

## Licence obligation

Code ported from ccip-tools-ts keeps its MIT notice. When the first ported file lands, add
`THIRD_PARTY_NOTICES.md` to the package with the ccip-tools-ts copyright and licence text, list it
in the package's `files`, and name the source file and commit at the top of each ported file.

## Implementation A: `feat/propose-admin-role`

Commit [`1cecb266`](https://github.com/smartcontractkit/ccip-tools-ts/commit/1cecb266), 2026-07-28,
author Amine El Manaa. Later carried on the `merge-cct-into-propose-admin` branch of the maintainer's fork (`7b194dff`).
About 1,560 hand-written lines plus about 11,800 lines of JSON fixtures.

| File                                                 | What it does                                                                                                                                      | Port?                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `ccip-sdk/src/verify/etherscan.ts`                   | Etherscan v2 and Blockscout client (`EtherscanV2Client`); one URL for every chain with `chainid`, Blockscout per-instance `/api` without it       | Yes: split into the Etherscan and Blockscout backends                   |
| `ccip-sdk/src/verify/sourcify.ts`                    | Sourcify client (`SourcifyClient`)                                                                                                                | Check the API version first: Sourcify v1 was switched off on 2026-07-07 |
| `ccip-sdk/src/verify/verify.ts`                      | `verifyContract`: submit, poll, map the result                                                                                                    | Yes: becomes the flow engine                                            |
| `ccip-sdk/src/verify/registry.ts`                    | `resolveVerifier`, artifact lookup, `verifyDeployedContract`                                                                                      | Routing half yes; artifact half no (CCIP-specific)                      |
| `ccip-sdk/src/verify/fixtures/verifiers.json`        | Routing table: 67 chains (22 Sourcify, 21 Etherscan v2, 12 standalone Etherscan-style, 5 Blockscout, 7 unknown), each with explorer URL and notes | Yes: seed `routing/table.json`, then re-check each row                  |
| `ccip-sdk/src/verify/constructor-args.ts`            | Constructor-argument encoding from types                                                                                                          | Yes                                                                     |
| `ccip-sdk/src/verify/solc-version.ts`                | Resolves the full solc version (`0.8.24` to `0.8.24+commit.…`)                                                                                    | Yes                                                                     |
| `ccip-sdk/src/verify/types.ts`                       | Input and result types                                                                                                                            | Reference for `types.ts`                                                |
| `ccip-cli/src/commands/verify-utils.ts`              | Derives constructor arguments from the on-chain creation code by stripping known bytecode                                                         | Yes: generalise for R-IN-3                                              |
| `ccip-cli/src/commands/verify.ts`                    | `ccip-cli verify --contract --address`, with `--constructor-args` and `--creation-tx` overrides                                                   | Reference for the CLI (R-DX-1)                                          |
| `ccip-sdk/src/verify/verify.test.ts`                 | Tests of the submit and poll flow                                                                                                                 | Yes: port the cases as recorded responses (R-QA-1)                      |
| `ccip-sdk/src/verify/fixtures/*.standard-input.json` | Standard JSON inputs of six CCIP v2 contracts                                                                                                     | No: CCIP artifacts. Useful as real test fixtures                        |

Read a file without checking the branch out:

```bash
git -C <ccip-tools-ts clone> show "1cecb266:ccip-sdk/src/verify/etherscan.ts"
```

## Implementation B: `feature/DAPP-10826-evm-verify-contract`

Commit [`ac4340e7`](https://github.com/smartcontractkit/ccip-tools-ts/commit/ac4340e7), 2026-08-06,
author Pedro Barbosa. An opt-in SDK subpath; about 1,200 generic lines and 1,000 lines of artifact
pipeline.

| File                                         | What it does                                                                                                                                          | Port?                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ccip-sdk/src/cct/evm/verify/verify.ts`      | `verifyDeployedContract(target, { chainId, apiKey, route, fetch, abort, timeoutMs, logger })`; discriminated `VerifyResult`; throws on unknown states | Yes: its option shape and "unknown state throws" rule are the model for R-FLOW-3 and R-FLOW-4 |
| `ccip-sdk/src/cct/evm/verify/etherscan.ts`   | Etherscan v2 submit and poll, `isVerified` check                                                                                                      | Compare with A, keep the better one                                                           |
| `ccip-sdk/src/cct/evm/verify/sourcify.ts`    | Sourcify, creation match when the creation tx hash is known                                                                                           | Same Sourcify v2 check as A                                                                   |
| `ccip-sdk/src/cct/evm/verify/routes.ts`      | Route table, `resolveRoute`, `explorerUrlFor`; Routescan for Avalanche                                                                                | Merge into the routing table                                                                  |
| `ccip-sdk/src/cct/evm/verify/routes.test.ts` | Route resolution tests                                                                                                                                | Yes, with the routing table                                                                   |
| `ccip-sdk/src/cct/evm/verify/verify.test.ts` | 425 lines of tests with mocked explorers, including status strings                                                                                    | Yes: port the cases as recorded responses (R-QA-1)                                            |
| `ccip-sdk/src/cct/evm/verify/index.ts`       | Lazy `import()` of bundled artifacts so non-users do not download them                                                                                | Pattern for any large optional data                                                           |

## Behaviour both implementations learned

These came from live runs. Keep each one as a test:

- Etherscan v2 takes `chainid` per call. Passing an explicit `/v2/api` URL to tools that append
  `chainid` themselves breaks them; build the URL in one place.
- Blockscout returns a partial match for bytecode compiled with `bytecode_hash = "none"`. That is
  the best outcome, not a failure.
- Blockscout can answer a submit right after a deployment with an empty or error response. A second
  full submit a few seconds later succeeds. Retry the submit, not only the poll.
- Snowtrace and Routescan finish verifying but lag on `checkverifystatus` by minutes. When the poll
  budget runs out, one lookup of the contract's verification state before giving up is cheaper than
  resubmitting a large body (implementation B, `verify.ts`).
- A submit can say "already verified"; map it to `already-verified`, not `failed`.
- Constructor arguments are required for an exact match on Etherscan; Similar Match ignores them.
