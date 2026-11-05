# 2026-11-05: ZKsync Era, zksolc and the explorers

Audience: whoever adds a zksolc compiler kind (R-EXT-1) or a backend for ZKsync Era (chain 324) and
ZKsync Sepolia (chain 300). Follows [Routescan and the zkSync compiler](2026-11-03-routescan-zksync.md).
Checked on 2026-11-05 from live requests that need no key and from public source code. No contract
was submitted. Each claim names its source; the links and the local runs are listed under
[Sources](#sources).

## Which explorers serve chains 324 and 300

| Explorer                      | Serves 324 and 300 | zksolc contracts                | Source                                                |
| ----------------------------- | ------------------ | ------------------------------- | ----------------------------------------------------- |
| Etherscan v2                  | No                 | No                              | Live: chain list and API, 2026-11-05                  |
| Routescan                     | No                 | No                              | Live: API, 2026-11-05                                 |
| Sourcify                      | Yes                | No: it compiles with solc only  | Live: chain list, 2026-11-05; open question below     |
| Blockscout (ZKsync instances) | Yes                | Yes, with `zksolcVersion`       | Live: config endpoints, 2026-11-05; Blockscout source |
| ZKsync contract verifier      | Yes                | Yes, in an Etherscan-style form | zksync-era source; live version lists, 2026-11-05     |

### Etherscan v2

- `https://api.etherscan.io/v2/chainlist` listed 55 chains, and neither 324 nor 300 (curl 8.7.1,
  2026-11-05).
- A `getabi` request with `chainid=324` answered
  `{"status":"0","message":"NOTOK","result":"Missing or unsupported chainid parameter (required for v2 api), ..."}`
  (curl 8.7.1, 2026-11-05).
- So the open question in the requirements, whether Etherscan v2 verifies a solc contract on chain
  324 without `zksolcVersion`, closes as "not served": Etherscan v2 takes no request for that chain.
  The `verifyzksyncsourcecode` endpoint listed in the
  [earlier note](2026-11-03-routescan-zksync.md) has no chain to serve while 324 and 300 are not in
  the chain list.

### Routescan

- `https://api.routescan.io/v2/network/mainnet/evm/324/etherscan/api` and
  `.../testnet/evm/300/etherscan/api` both answered
  `{"status":"0","message":"chain not supported","result":null}` (curl 8.7.1, 2026-11-05). This
  matches the 2026-11-03 result for 324.

### Sourcify

- `https://sourcify.dev/server/chains` lists 324 (`ZKsync Era`) and 300
  (`ZKsync Era Sepolia Testnet`) with `supported: true` (curl 8.7.1, 2026-11-05).
- Open question: the scoping read of the Sourcify server source found no zksolc compiler, only
  solc. That is not confirmed against a pinned commit. Until it is, a zksolc contract is not sent to
  Sourcify. A contract compiled with plain solc on these chains is ordinary EVM bytecode, and goes to
  Sourcify with `kind: "solc"` like on any other chain.

### Blockscout

- `https://zksync.blockscout.com/api/v2/config/backend-version` and the same path on
  `zksync-sepolia.blockscout.com` answered `{"backend_version":"v12.0.4"}` (curl 8.7.1,
  2026-11-05).
- `https://zksync.blockscout.com/api/v2/smart-contracts/verification/config` lists 39
  `zk_compiler_versions`, from `v1.5.15` down to `v1.3.0`, next to the regular
  `solidity_compiler_versions` such as `v0.8.38+commit.1835d247` (curl 8.7.1, 2026-11-05).
- The Etherscan-style `/api` controller reads an optional `zksolcVersion` parameter into
  `zk_compiler_version`
  ([contract_controller.ex](https://github.com/blockscout/blockscout/blob/master/apps/block_scout_web/lib/block_scout_web/controllers/api/rpc/contract_controller.ex),
  read 2026-11-05). The solc version stays in the long form.
- Both instances already have Blockscout rows in the routing table. Mapping a zksolc compiler kind
  to the `zksolcVersion` field is the smallest step to verify zksolc contracts.

### ZKsync contract verifier

- The hosts are `https://zksync2-mainnet-explorer.zksync.io/contract_verification` (324) and
  `https://explorer.sepolia.era.zksync.dev/contract_verification` (300), as hardhat-zksync and
  foundry-zksync configure them
  ([hardhat-zksync-verify](https://github.com/matter-labs/hardhat-zksync/tree/main/packages/hardhat-zksync-verify),
  read 2026-11-05).
- `.../contract_verification/zksolc_versions` answered `["v1.5.16","v1.5.15","v1.5.17"]` on both
  hosts (curl 8.7.1, 2026-11-05).
- The verifier takes an Etherscan-style form with `compilerversion` and `zksolcVersion`, and its
  status texts are `Pending in queue`, `Pass - Verified` and `Fail - Unable to verify. ...`, the
  texts the Etherscan client already maps
  ([etherscan.rs](https://github.com/matter-labs/zksync-era/blob/ff5f519b11cff863edcfa0f75af10fea113806b0/core/lib/types/src/contract_verification/etherscan.rs),
  read 2026-11-05).
- foundry-zksync sends `compilerversion` as `zkVM-<solc>-<revision>`, with revision `1.0.2` from the
  zksolc version that supports CBOR metadata, and `zksolcVersion` as `v<zksolc>`
  ([verify/src/zksync/mod.rs](https://github.com/matter-labs/foundry-zksync/blob/main/crates/verify/src/zksync/mod.rs),
  read 2026-11-05).
- The block-explorer API at `/api` answers its own failure texts, such as
  `Fail - Unable to verify` with the verifier's message
  ([contract.controller.ts](https://github.com/matter-labs/block-explorer/blob/main/packages/api/src/api/contract/contract.controller.ts),
  read 2026-11-05).

## How zksolc build documents differ from solc ones

zksolc tooling writes the same document shapes as solc tooling: a build-info with `input` and
`output`, and artifacts with `abi` and `bytecode`. Read as solc, a zksolc build gives a solc input
for EraVM bytecode, which no solc verification can match. These fields mark a zksolc document:

| Field                               | Written by                                         | Source                                                                                                                                                          |
| ----------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input.zksolc_version`              | foundry-zksync build-info (`ZkSolcVersionedInput`) | [zksolc/input.rs](https://github.com/matter-labs/foundry-zksync/blob/main/crates/zksync/compilers/src/compilers/zksolc/input.rs)                                |
| `output.metadata.zksolcVersion`     | foundry-zksync compiler output                     | [zksolc/mod.rs](https://github.com/matter-labs/foundry-zksync/blob/main/crates/zksync/compilers/src/compilers/zksolc/mod.rs)                                    |
| `output.zk_version`                 | zksolc output in a hardhat-zksync build-info       | [hardhat-zksync-solc index.ts](https://github.com/matter-labs/hardhat-zksync/blob/main/packages/hardhat-zksync-solc/src/index.ts)                               |
| A contract's `metadata.zk_version`  | zksolc contract output                             | [explorers/service.ts](https://github.com/matter-labs/hardhat-zksync/blob/main/packages/hardhat-zksync-verify/src/explorers/service.ts)                         |
| `solcVersion` starting with `zkVM-` | hardhat-zksync with the ZKsync fork of solc        | [zksync-etherscan/service.ts](https://github.com/matter-labs/hardhat-zksync/blob/main/packages/hardhat-zksync-verify/src/explorers/zksync-etherscan/service.ts) |
| `_format` `hh-zksolc-artifact-1`    | hardhat-zksync artifact                            | [constants.ts](https://github.com/matter-labs/hardhat-zksync/blob/main/packages/hardhat-zksync-solc/src/constants.ts)                                           |

All read on 2026-11-05. `buildVerifyInput` now refuses a document with any of these fields with
`unsupported-compiler`, and names the field in `details.field`. It also checks a contract's
`metadata.zksolcVersion` and a `solcLongVersion` that starts with `zkVM-`.

## What users of chains 324 and 300 can do today

- A contract compiled with plain solc is EVM bytecode on these chains. It verifies with
  `kind: "solc"` on Sourcify or Blockscout, like on any other chain.
- A contract compiled with zksolc is refused before any request, with `unsupported-compiler`. It
  verifies with the ZKsync tooling (hardhat-zksync-verify or foundry-zksync).

## Slices for zksolc support

| Slice | What                                                                                      | Size |
| ----- | ----------------------------------------------------------------------------------------- | ---- |
| A     | `buildVerifyInput` refuses zksolc build documents with `unsupported-compiler` (done)      | S    |
| B     | This note and the requirements edit (done)                                                | S    |
| C     | A `kind: "zksolc"` compiler member, its validation, refusals per backend, routing by kind | M    |
| D     | Blockscout mapping of `zksolcVersion` on 324 and 300                                      | S    |
| E     | A live probe on ZKsync Sepolia with a foundry-zksync or hardhat-zksync deploy             | M    |
| F     | Rows for the ZKsync verifier as an Etherscan-compatible host, and its form fields         | M    |
| G     | `buildVerifyInput` returns `kind: "zksolc"` for foundry-zksync and hardhat-zksync builds  | M    |
| H     | EraVM constructor arguments, which come from the ContractDeployer calldata                | M    |

A compiler member could be
`{ kind: "zksolc"; version: string; solcVersion: string; solcFork?: string; input: SolidityStandardJsonInput }`.
That is a design change and needs a decision record before slice C.

## Risks

- Constructor arguments: on EraVM a contract is deployed through the ContractDeployer system
  contract, so the arguments are not appended to the creation bytecode in the deploy transaction.
  Deriving them from the creation transaction, as `verify()` does for EVM chains, gives wrong
  arguments there (slice H).
- Version forms differ per verifier: Blockscout takes the solc long version, the ZKsync verifier the
  `zkVM-<solc>-<revision>` form (see above).
- Version ranges move: Blockscout lists zksolc up to v1.5.15, the ZKsync verifier v1.5.15 to v1.5.17
  (2026-11-05).

## Sources

Local runs, curl 8.7.1, 2026-11-05, no key:

- `https://api.etherscan.io/v2/chainlist`, and
  `https://api.etherscan.io/v2/api?chainid=324&module=contract&action=getabi` with a dummy key.
- `https://api.routescan.io/v2/network/mainnet/evm/324/etherscan/api` and
  `https://api.routescan.io/v2/network/testnet/evm/300/etherscan/api`, action `getabi`.
- `https://sourcify.dev/server/chains`.
- `https://zksync.blockscout.com/api/v2/config/backend-version`,
  `https://zksync-sepolia.blockscout.com/api/v2/config/backend-version` and
  `https://zksync.blockscout.com/api/v2/smart-contracts/verification/config`.
- `https://zksync2-mainnet-explorer.zksync.io/contract_verification/zksolc_versions` and
  `https://explorer.sepolia.era.zksync.dev/contract_verification/zksolc_versions`.

Source code read on 2026-11-05:

- foundry-zksync, `main`:
  [zksolc/input.rs](https://github.com/matter-labs/foundry-zksync/blob/main/crates/zksync/compilers/src/compilers/zksolc/input.rs),
  [zksolc/mod.rs](https://github.com/matter-labs/foundry-zksync/blob/main/crates/zksync/compilers/src/compilers/zksolc/mod.rs),
  [verify/src/zksync/mod.rs](https://github.com/matter-labs/foundry-zksync/blob/main/crates/verify/src/zksync/mod.rs),
  [verify/src/etherscan/zksync.rs](https://github.com/matter-labs/foundry-zksync/blob/main/crates/verify/src/etherscan/zksync.rs).
- hardhat-zksync, `main`:
  [hardhat-zksync-solc index.ts](https://github.com/matter-labs/hardhat-zksync/blob/main/packages/hardhat-zksync-solc/src/index.ts),
  [constants.ts](https://github.com/matter-labs/hardhat-zksync/blob/main/packages/hardhat-zksync-solc/src/constants.ts),
  [explorers/service.ts](https://github.com/matter-labs/hardhat-zksync/blob/main/packages/hardhat-zksync-verify/src/explorers/service.ts),
  [zksync-etherscan/service.ts](https://github.com/matter-labs/hardhat-zksync/blob/main/packages/hardhat-zksync-verify/src/explorers/zksync-etherscan/service.ts).
- Blockscout, `master`:
  [contract_controller.ex](https://github.com/blockscout/blockscout/blob/master/apps/block_scout_web/lib/block_scout_web/controllers/api/rpc/contract_controller.ex).
- zksync-era at commit `ff5f519b`:
  [etherscan.rs](https://github.com/matter-labs/zksync-era/blob/ff5f519b11cff863edcfa0f75af10fea113806b0/core/lib/types/src/contract_verification/etherscan.rs).
- block-explorer, `main`:
  [contract.controller.ts](https://github.com/matter-labs/block-explorer/blob/main/packages/api/src/api/contract/contract.controller.ts).
