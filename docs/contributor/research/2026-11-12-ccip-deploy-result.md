# A deploy result as verification input

Date: 2026-11-12. Scope: the CCIP consumer in [validation/ccip](../../../validation/ccip/README.md).
Question: what does a caller add to the CCIP SDK's deploy result to verify the contract with
explorer-verify 0.2.1, and can the Standard JSON input be recovered for a new deployment instead
of shipped with the caller?

## Summary

- The published explorer-verify 0.2.1 passed the six existing scenarios with no code change. With
  the wrapper changed to take the deploy result, it passed ten scenarios against a local
  Etherscan-compatible explorer.
- The deploy result gives the address, an unqualified contract name and the constructor
  arguments. The caller adds the chain id, the Standard JSON input and the full compiler version.
  The wrapper that maps one to the other is 85 lines of code.
- The SDK's pool and token bytecode is compiled with `bytecodeHash: "none"`. It carries no metadata
  hash, so `buildVerifyInputFromBytecode` cannot recover its input. It fails with
  `no-metadata-hash`.
- A new pool on Sepolia was matched to another verified pool by Etherscan and by Blockscout
  within a minute. The Standard JSON that Etherscan's `getsourcecode` returned for the new address
  verified it on Sourcify through explorer-verify 0.2.1.

## The deploy result

At ccip-tools-ts `053a92ed` (main, 2026-11-10), each EVM deploy (`deployToken`, `deployTokenPool`
and the others) returns `DeployResult`, defined in `ccip-sdk/src/cct/evm/operation.ts`:

```ts
type DeployResult = TransactionResult & {
  contractAddress: string;
  verification: ExplorerVerificationInput;
};
interface ExplorerVerificationInput {
  contract: string; // unqualified, such as BurnMintTokenPool
  encodedConstructorArgs: string; // 0x-prefixed, or 0x when the constructor takes none
}
```

`TransactionResult` is `{ hash }`. The deploy is a plain CREATE, and the SDK checks that the
address equals `getCreateAddress({ from, nonce })`. Pools deploy at version 2.0.0 only; the SDK
notes that it does not ship bytecode for earlier versions. `contract` is the compiled name, which
differs from the pool type once: the type `BurnToAddressTokenPool` compiles as
`BurnToAddressMintTokenPool`.

## Field mapping

| `verify()` input  | From                                                                       |
| ----------------- | -------------------------------------------------------------------------- |
| `address`         | `contractAddress`                                                          |
| `constructorArgs` | `verification.encodedConstructorArgs`, left out when it is `0x`            |
| `contractName`    | `verification.contract`, mapped to `path:Name` with the Standard JSON      |
| `compiler`        | `buildVerifyInput` of the caller's Standard JSON and full compiler version |
| `chainId`         | The caller; the deploy result does not hold it                             |
| (not used)        | `hash`                                                                     |

`buildVerifyInput` refuses a bare name with a Standard JSON input, with `incomplete-input`
(`details.field` `contract`): the input lists sources, not contracts. The wrapper finds the source
files that declare `contract <Name>`, with comments removed. In the BurnMintTokenPool Standard
JSON, one of 34 sources declares it: `contracts/pools/BurnMintTokenPool.sol`. When no file, or more
than one, declares the name, the wrapper throws with the candidates, and the caller sets
`contract` as `path:Name` in its build entry. A scenario checks both paths.

The caller keys its builds by contract name and pool version, such as
`BurnMintTokenPool@2.0.0`, with the Standard JSON and `0.8.26+commit.8a97fa7a`.

## Integration code size

`validation/ccip/sdk.mjs` is 111 lines, 85 without comments and blank lines:

| Part                                             | Lines of code |
| ------------------------------------------------ | ------------- |
| Imports and the build map for two contracts      | 21            |
| `qualifiedName`: unqualified name to `path:Name` | 18            |
| `inputFromDeployResult`: field mapping           | 20            |
| `verifyDeployResults`: one result per deploy     | 23            |
| `resumeCcip`: `checkStatus` with a handle        | 3             |

The 0.2.x options it uses: `indexWaitMs` (120 s by default, right after the deploy),
`storedContract` in the result, and `submitOverPartial` passed through from the caller.

## Local scenarios

The consumer installs `explorer-verify@0.2.1` from npm
(`sha512-QEENH68r…kiR+Q==`) and runs against a local Etherscan-compatible explorer. All ten
scenarios passed on 2026-11-12 with Node.js 24.21.0. The same run against packages built from
`main` at `281bc9a` also passed. The new scenarios:

| Scenario                                            | Outcome                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `deploy-result-in-verified`                         | The form held `contractaddress`, `path:Name` and the constructor arguments without `0x`     |
| `other-contract-source-submit-then-stored-contract` | One submit, refused; `already-verified`, `partial`, `storedContract` `LockReleaseTokenPool` |
| `not-indexed-wait-then-verified`                    | Two answers `Unable to locate ContractCode`, two `verify.retry` events, then `verified`     |
| `partial-match-submit-over-partial`                 | No submit by default; with `submitOverPartial`, one submit and `verified`, `exact`          |
| `unqualified-name-mapped-from-standard-json`        | `incomplete-input` for the bare name; mapped; a name in two sources refused, then settled   |

## The Standard JSON gap

The SDK's documentation for `ExplorerVerificationInput` says the Standard JSON input and the
compiler version ship in `@chainlink/contracts-ccip`. On 2026-11-12, version 2.0.0 of that
package held 452 files: 118 `.sol` sources, 164 ABI files, bytecode, `foundry.toml` and
`remappings.txt`. It held no Standard JSON input, build-info or metadata file.

| Check                                                      | Result                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| SDK bytecode against the package's `bytecode/v2_0_0/*.bin` | Same hex for BurnMintTokenPool (23,986 bytes) and CrossChainToken (11,864 bytes)                        |
| SDK bytecode against the vendored files from `1cecb266`    | Same hex                                                                                                |
| Compiler settings in the Standard JSON                     | solc 0.8.26, `viaIR`, optimizer 50,000 runs, `evmVersion` `paris`, `bytecodeHash` `none`                |
| `foundry.toml` profiles in the package                     | `bytecode_hash = "none"`; `ccip` 1 run; `ccip-compile` 80,000 runs with `via_ir`; none with 50,000 runs |
| Standard JSON sources against the package's sources        | 14 identical; `contracts/interfaces/IRMN.sol` differs; 19 dependency files are not in the package       |

So the package's files and profiles do not give the settings or the exact source set of the
build behind its bytecode. The vendored Standard JSON from ccip-tools-ts `1cecb266`, an older
branch, does: Etherscan holds the same 34 sources for a pool built from this bytecode (below).

## Recovery for a new deployment

### Deployed pools on Sepolia

Runtime code read with `eth_getCode` on 2026-11-12 and compared with the runtime part of the SDK's
creation bytecode (offset 675, 23,311 bytes):

| Address                                      | Runtime bytes | Compared with the SDK build                             | Etherscan v2 `getsourcecode`              |
| -------------------------------------------- | ------------- | ------------------------------------------------------- | ----------------------------------------- |
| `0xf82E42cf19F61A05762Ff5Aa6a943D1E30b6BE04` | 23,311        | 275 bytes differ, all at zero placeholders (immutables) | Verified, own source, 50,000 runs         |
| `0xfa010aBeA29525bD46FA18D2b833f2a85769FB30` | 17,848        | Another build                                           | Verified, 1 run; Sourcify `match`         |
| `0xF00a40104a57e6a4C0F1DD65d4D9310A0b1e1367` | 19,694        | Another build                                           | Similar Match of `0xb7b8deab…097f`, 1 run |
| `0xa87611d43e90ecff2b736c55f4cbe5e238f845db` | 19,859        | Another build (LockReleaseTokenPool 2.0.0)              | Verified, 1 run                           |
| `0x50e73dda9497c7eC40f3053AB1F38f0FBfD381f6` | 19,915        | Another build, solc 0.8.24, with an IPFS metadata hash  | Not checked                               |

Each of these reports `BurnMintTokenPool 2.0.0` or `LockReleaseTokenPool 2.0.0` from
`typeAndVersion`. Teams build pools with different settings, so a deployed pool shares code with
the SDK's build only when it was deployed from the same bytecode.

### `buildVerifyInputFromBytecode`

| Address                                      | Result                                                            |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `0xf82E42cf19F61A05762Ff5Aa6a943D1E30b6BE04` | `no-metadata-hash`                                                |
| `0xfa010aBeA29525bD46FA18D2b833f2a85769FB30` | `no-metadata-hash`                                                |
| `0x50e73dda9497c7eC40f3053AB1F38f0FBfD381f6` | `metadata-unavailable`: Sourcify answered 404, no gateway was set |

The SDK's runtime code ends with `a164736f6c634300081a000a`: CBOR that holds only the solc version,
0.8.26. With `bytecodeHash: "none"` there is no IPFS hash to compute or look up, on Sourcify or on
any gateway. The resolver cannot recover the input of any contract the SDK deploys.

### A new pool

One BurnMintTokenPool 2.0.0 was deployed on Ethereum Sepolia from the SDK's creation bytecode,
with LINK as the token, no hooks, and the RMN proxy and router of `0xf82E42…E04`:

- address `0x4E2E29d1719bb195D2fAB79Ed30eF7361eB9f99f`;
- transaction `0x8c879ac152570c74ecbd6457b913e49b53d64a902606e815fab03348de37cd99`, block 12120215;
- its runtime differs from the SDK build in 284 bytes, all at zero placeholders.

What each explorer held, and what explorer-verify 0.2.1 did with the recovered input:

| Time (UTC) | Explorer   | Observation                                                                                                   |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| 17:06:33   | Etherscan  | `getsourcecode`: `SimilarMatch` `0xf82E42…E04`, `BurnMintTokenPool`, `v0.8.26+commit.8a97fa7a`, Standard JSON |
| 17:06:34   | Blockscout | `verified_at`; `is_partially_verified` and `is_verified_via_eth_bytecode_db` `true`, 50,000 runs              |
| 17:06:33   | Sourcify   | 404                                                                                                           |
| 17:07      | Sourcify   | `verify()` with the Standard JSON from Etherscan: `verified`, `partial` (`match`)                             |
| 17:07      | Blockscout | `verify()`: `already-verified`, `partial`, no submit                                                          |
| 17:07      | Etherscan  | `verify()` with `submitOverPartial`: job accepted; still `Pending in queue` when the 300 s budget ran out     |
| 17:23      | Etherscan  | `checkStatus()` of the saved handle: `verified`, `partial`; `getsourcecode` still names the `SimilarMatch`    |

The Standard JSON from Etherscan's record for the new address had the same 34 sources as the
vendored one, byte for byte. Blockscout created both records during this study: `verified_at` is
17:00:51 for `0xf82E42…E04` and 17:06:34 for the new pool, within seconds of the first lookup of
each. Both came from its bytecode database (`is_verified_via_eth_bytecode_db`), not from a submit
made here. Blockscout's record lists 34 files and
the same compiler settings, with other remappings. Sourcify gives `match`, not `exact_match`,
because the bytecode has no metadata hash
([no-metadata-hash grades](2026-11-10-no-metadata-hash-grades.md)).

The Etherscan job waited in the queue for more than five minutes, as a submit over a Similar Match
did in the earlier study ([submit over a partial match](2026-11-11-submit-over-partial.md)). When the
job ended, `checkStatus()` returned `verified`, `partial`, and the `getsourcecode` record still
named the Similar Match. The handle was resumed with `checkStatus()`, with no second submit.

## What works and what does not

- Works: a deploy result plus a build map keyed by contract name and version gives a complete
  `verify()` input. The vendored Standard JSON matches the bytecode the SDK deploys today.
- Works: for a pool deployed from the SDK's bytecode on Sepolia, Etherscan and Blockscout already
  hold a match from an earlier deployment. Etherscan's `getsourcecode` for the new address returns
  the Standard JSON, the compiler version and the contract name, and that input verified the new
  address on Sourcify.
- Does not work: `buildVerifyInputFromBytecode`. The bytecode has no metadata hash.
- Does not work: building the Standard JSON from the npm package alone. Its profiles do not hold
  the 50,000 runs of the build, one source differs, and 19 dependency files are not in it.
- Depends on the chain: the recovery through an explorer needs one earlier pool from the same
  bytecode verified on that explorer and chain. This study checked Ethereum Sepolia only.

## What an integration needs

- A Standard JSON input and full compiler version for each contract and version the SDK deploys,
  from the same build as the bytecode. Shipping them next to the bytecode, or a build-info, would
  let a caller pass them to `buildVerifyInput` with no network request.
- The chain id with the deploy result, or a caller that adds it.
- Optionally, the qualified name `path:Name` in `ExplorerVerificationInput`, so no caller scans
  sources for the declaration.
- A wait after the deploy: `indexWaitMs` covers an explorer that has not indexed the contract.
- A check of `storedContract`: an explorer can hold a match from another deployment of the same
  bytecode, or from another contract's source.

## Sources

- ccip-tools-ts, read with `git show` on 2026-11-12: `main` at
  `053a92eda662e62af03d73d0345a40dcb44fd479`, files `ccip-sdk/src/cct/evm/operation.ts`,
  `ccip-sdk/src/cct/evm/token-pool/contracts.ts` and
  `ccip-sdk/src/cct/evm/artifacts/bytecode/V2_0_0/*.ts`; and commit
  [`1cecb266`](https://github.com/smartcontractkit/ccip-tools-ts/tree/1cecb266d924bb52c6c6030e0bdc2b4b6f5e430e)
  for the vendored files ([provenance](../../../validation/ccip/artifacts/provenance.json)).
- [`@chainlink/contracts-ccip` 2.0.0](https://www.npmjs.com/package/@chainlink/contracts-ccip/v/2.0.0),
  npm 11.19.0, `npm pack` and `npm pack --dry-run --json`, 2026-11-12: file list, `foundry.toml`,
  `bytecode/v2_0_0/*.bin` and the sources compared.
- [explorer-verify 0.2.1](https://www.npmjs.com/package/explorer-verify/v/0.2.1) from npm,
  integrity `sha512-QEENH68rKj12xhjG7KxNnxTN3mq4oN/SnTbUmp3RDsuSBjo5GwV1gdrfS+uS74xCmguKUPEIv3s7gtEGHkiR+Q==`.
- Local runs, Node.js 24.21.0 `fetch`, 2026-11-12, 17:00 to 17:23 UTC: `eth_getCode` on
  `https://ethereum-sepolia-rpc.publicnode.com`; Etherscan v2 `getsourcecode` on
  `https://api.etherscan.io/v2/api`; Blockscout `https://eth-sepolia.blockscout.com/api/v2/smart-contracts/<address>`;
  Sourcify `https://sourcify.dev/server/v2/contract/11155111/<address>`.
- The new pool on explorers:
  [Etherscan](https://sepolia.etherscan.io/address/0x4E2E29d1719bb195D2fAB79Ed30eF7361eB9f99f#code),
  [Blockscout](https://eth-sepolia.blockscout.com/address/0x4E2E29d1719bb195D2fAB79Ed30eF7361eB9f99f?tab=contract),
  [Sourcify](https://repo.sourcify.dev/11155111/0x4e2e29d1719bb195d2fab79ed30ef7361eb9f99f).
- The reference pool:
  [Etherscan](https://sepolia.etherscan.io/address/0xf82E42cf19F61A05762Ff5Aa6a943D1E30b6BE04#code).
- [validation/ccip evidence](../../../validation/ccip/evidence/results.json), 2026-11-12.
