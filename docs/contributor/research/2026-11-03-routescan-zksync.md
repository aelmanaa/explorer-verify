# 2026-11-03: Routescan API facts and the zkSync compiler

Audience: whoever implements the Routescan backend (R-BE-5) or a zkSync compiler kind (R-EXT-1).
Assumes the Etherscan v2 facts in [explorer APIs](2026-11-02-explorer-apis.md). Checked on
2026-11-03 from public docs, public source code and live requests that need no key. No contract was
submitted. Each claim names its source; the links and the local runs are listed under
[Sources](#sources).

## Routescan

### API base per network

- Template: `https://api.routescan.io/v2/network/{network}/evm/{chainId}/etherscan/api`.
  `{network}` is `mainnet` or `testnet`; `{chainId}` is the numeric chain id
  ([get started](https://docs.routescan.io/getting-started/get-started),
  [migrate from Etherscan](https://docs.routescan.io/getting-started/migrate-from-etherscan),
  read 2026-11-03).
- The chain id goes in the path. The `chainid` query parameter of Etherscan v2 is dropped, and
  every other query parameter stays the same
  ([migrate from Etherscan](https://docs.routescan.io/getting-started/migrate-from-etherscan),
  read 2026-11-03).
- The `{network}` segment must match the chain. Live with curl 8.7.1 on 2026-11-03, a
  `checkverifystatus` request returned these bodies, each with HTTP 200:

  | Path segment        | Body                                                                 |
  | ------------------- | -------------------------------------------------------------------- |
  | `mainnet/evm/43114` | `{"status":"0","message":"NOTOK","result":"Verification not found"}` |
  | `testnet/evm/43113` | `{"status":"0","message":"NOTOK","result":"Verification not found"}` |
  | `mainnet/evm/43113` | `{"status":"0","message":"chain not supported","result":null}`       |
  | `testnet/evm/43114` | `{"status":"0","message":"chain not supported","result":null}`       |
  | `testnet/evm/80002` | `{"status":"0","message":"chain not supported","result":null}`       |
  | `mainnet/evm/324`   | `{"status":"0","message":"chain not supported","result":null}`       |

  So the routing table needs the network per chain, not only the chain id. A chain that Routescan
  does not serve answers HTTP 200 with `status` `"0"` and `message` `chain not supported`.

- The path without the trailing `/api` (`.../etherscan`) returned the same
  `Verification not found` body for chain 43114 (curl 8.7.1, 2026-11-03).
- The supported-chains page lists the chains with their ids; the docs say only listed chain ids
  are supported ([supported chains](https://docs.routescan.io/getting-started/supported-chains),
  [migrate from Etherscan](https://docs.routescan.io/getting-started/migrate-from-etherscan),
  read 2026-11-03). The list changes; the routing table records a date per row (R-RT-1).

### Verify and status requests

Source: [Etherscan-compatible contracts API](https://docs.routescan.io/api/etherscan/contracts),
read 2026-11-03.

- Submit: `POST .../etherscan/api?module=contract&action=verifysourcecode`. The parameters listed
  are `contractaddress`, `sourceCode`, `constructorArguments`, `codeformat`
  (`solidity-single-file` or `solidity-standard-json-input`), `contractname`, `compilerversion`
  (example `v0.8.10+commit.fc410830`), `evmversion`, `optimizationUsed`, `runs` and `licenseType`.
  The page's curl example puts the parameters in the query string. The page shows no example
  response for this action.
- Status: `GET .../etherscan/api?module=contract&action=checkverifystatus&guid=<guid>`. The page
  shows no example response.
- The page documents five contract actions: `getcontractcreation`, `getabi`, `getsourcecode`,
  `verifysourcecode` and `checkverifystatus`. It lists no proxy verification action.
- Responses use the Etherscan envelope `status` / `message` / `result`
  ([migrate from Etherscan](https://docs.routescan.io/getting-started/migrate-from-etherscan),
  read 2026-11-03). Seen live with curl 8.7.1 on 2026-11-03: an unknown GUID gives
  `"result":"Verification not found"`, and a missing `guid` gives `"result":"Missing guid"`, both
  with `message` `NOTOK` and HTTP 200.

### Verification GUID

- The docs' example GUID is `ezq878u486pzijkvvmerl6a9mzwhv6sefgvqi5tkwceejc7tvn`: 50 characters,
  lowercase letters and digits ([contracts API](https://docs.routescan.io/api/etherscan/contracts),
  read 2026-11-03; length counted with `wc -c`).
- Etherscan's example GUID has the same form: `a7lpxkm9kpcpicx7daftmjifrfhiuhf5vqqnawhkfhzfrcpnxj`,
  50 characters ([verifyzksyncsourcecode](https://docs.etherscan.io/api-reference/endpoint/verifyzksyncsourcecode),
  read 2026-11-03).
- Both match the handle's `jobId` pattern `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` (decision 0009).
  This rests on the documented examples; no real Routescan GUID was produced, because no contract
  was submitted.

### Key policy and rate limits

- "No sign-up or API key is required for free-tier access." A key, for higher tiers, is sent in
  the `apikey` header ([get started](https://docs.routescan.io/getting-started/get-started), read
  2026-11-03). The contracts API page marks the key as optional and its examples pass it as an
  `apikey` query parameter ([contracts API](https://docs.routescan.io/api/etherscan/contracts),
  read 2026-11-03).
- One key covers every chain
  ([migrate from Etherscan](https://docs.routescan.io/getting-started/migrate-from-etherscan),
  read 2026-11-03).
- Rate limits ([rate limits](https://docs.routescan.io/plans-and-limits/rate-limits), read
  2026-11-03):

  | Plan              | Requests per second | Calls per day | Key          |
  | ----------------- | ------------------- | ------------- | ------------ |
  | Free (keyless)    | 2                   | 10,000        | Not required |
  | Free (registered) | 5                   | 100,000       | Required     |
  | Standard          | 10                  | 200,000       | Required     |
  | Advanced          | 20                  | 500,000       | Required     |
  | Professional      | 30                  | 1,000,000     | Required     |
  | Pro Plus          | 30                  | 1,500,000     | Required     |

  Over the limit, "the API responds with an error status"; the page names no status code.

- The status requests above were sent without a key and were answered (curl 8.7.1, 2026-11-03).
  The responses carried no rate-limit headers.

### Browser reachability (live, 2026-11-03)

Each request was sent with curl 8.7.1 on 2026-11-03 with `Origin: https://example.com`:

| Request                                                                                                       | Result                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `checkverifystatus` on `mainnet/evm/43114` and `testnet/evm/43113`                                        | HTTP 200, `access-control-allow-origin: *`                                                                                                                           |
| OPTIONS preflight for `verifysourcecode` on `mainnet/evm/43114`, method `POST`, headers `content-type,apikey` | HTTP 204, `access-control-allow-origin: *`, `access-control-allow-methods: GET, HEAD, PUT, PATCH, POST, DELETE`, `access-control-allow-headers: content-type,apikey` |

A browser can call the Routescan API directly, including a POST with a `content-type` or `apikey`
header. The free tier needs no key, so no key has to reach the browser for it.

## zkSync Era

### Compiler

- The custom tooling page lists the tools built for native EraVM bytecode: the `hardhat-zksync`
  suite, with `@matterlabs/hardhat-zksync-solc`, `@matterlabs/hardhat-zksync-vyper` and
  `@matterlabs/hardhat-zksync-verify`, and `foundry-zksync`, with "support for `zksolc`". The page
  calls these legacy tooling and says: "For most new development on ZKsync Era and other ZKsync
  chains powered by EraVM, standard Ethereum tooling can now be used directly through the EVM
  Bytecode Interpreter." It also says "New ZKsync chains powered by ZKsync OS are not compatible
  with any of the tools below"
  ([custom tooling](https://docs.zksync.io/zksync-network/zksync-era/custom-tooling), read
  2026-11-03).
- For Vyper, the verifier source names zkvyper as the EraVM compiler (`compilerZkvyperVersion`, see
  [zkSync's own verifier](#zksyncs-own-verifier)).
- So zkSync Era runs two kinds of contract: EraVM bytecode from zksolc, and EVM bytecode from solc
  run by the EVM Bytecode Interpreter. The next two sections show both verification APIs taking a
  solc version and an optional zksolc version.

### Etherscan

Source: [verifyzksyncsourcecode](https://docs.etherscan.io/api-reference/endpoint/verifyzksyncsourcecode),
read 2026-11-03.

- `POST https://api.etherscan.io/v2/api?chainid=324&module=contract&action=verifysourcecode` (324
  is zkSync Era in the docs' example), with an API key and form-encoded fields.
- Fields as for Solidity (`codeformat`, `sourceCode`, `contractaddress`, `contractname`,
  `compilerversion`, `constructorArguments`) plus `zksolcVersion`: "Required for EraVM contracts
  and optional for EVM contracts. Use a version with the v prefix, beginning with v1.3.0."
- The response is a GUID polled with `checkverifystatus`.

### zkSync's own verifier

- The tutorial sets the Hardhat plugin's `verifyURL` to
  `https://zksync2-mainnet-explorer.zksync.io/contract_verification` for mainnet and
  `https://explorer.sepolia.era.zksync.dev/contract_verification` for Sepolia. It checks a
  submission with a verification id
  ([how to verify contracts](https://code.zksync.io/tutorials/how-to-verify-contracts), read
  2026-11-03; the older `docs.zksync.io/build/tutorials/how-to/verify-contracts.html` redirects
  there).
- The verifier server in the `matter-labs/zksync-era` repository, at commit
  [`ff5f519b`](https://github.com/matter-labs/zksync-era/tree/ff5f519b11cff863edcfa0f75af10fea113806b0)
  (read 2026-11-03):
  - Routes ([api_decl.rs](https://github.com/matter-labs/zksync-era/blob/ff5f519b11cff863edcfa0f75af10fea113806b0/core/node/contract_verification_server/src/api_decl.rs)):
    `POST /contract_verification`, `GET /contract_verification/{id}`,
    `GET /contract_verification/info/{address}`, and version lists under
    `/contract_verification/zksolc_versions`, `solc_versions`, `zkvyper_versions` and
    `vyper_versions`.
  - Request body ([api.rs](https://github.com/matter-labs/zksync-era/blob/ff5f519b11cff863edcfa0f75af10fea113806b0/core/lib/types/src/contract_verification/api.rs)),
    JSON in camelCase: `contractAddress`, `codeFormat` with `sourceCode`
    (`solidity-single-file`, `solidity-standard-json-input`, `vyper-multi-file`,
    `yul-single-file`), `contractName`, `compilerSolcVersion` with an optional
    `compilerZksolcVersion` (or `compilerVyperVersion` with an optional `compilerZkvyperVersion`),
    `optimizationUsed`, `optimizerMode`, `constructorArguments`, `isSystem`, `forceEvmla`, and
    `evmVersion` and `optimizerRuns` for EVM single-file requests.
  - Status body: `status`, with optional `error` and `compilationErrors`.
- This is a JSON API of its own, not the Etherscan form API.

### Consequence for decision 0004

"zkSync uses its own compiler" holds for EraVM contracts. An EVM-bytecode contract on zkSync Era is
compiled with solc, and both APIs above accept it without a zksolc version. A `{ kind: "solc" }`
input could therefore cover EVM-bytecode contracts on zkSync Era; EraVM contracts need a zksolc
member of the compiler union. This note records the facts; it does not change the decision.

## Open questions

- Does Routescan's keyless tier accept `verifysourcecode`, and what does a successful submit
  return? Not tested: this check made no submission.
- Which HTTP status does Routescan return over the rate limit? The docs say only "an error status".
- Is there an API that lists Routescan's supported chains with their network? Not found in the docs
  on 2026-11-03.
- Does the zkSync verifier at the two `contract_verification` hosts send CORS headers? Not checked.

## Sources

Read on 2026-11-03:

- Routescan: [get started](https://docs.routescan.io/getting-started/get-started),
  [migrate from Etherscan](https://docs.routescan.io/getting-started/migrate-from-etherscan),
  [supported chains](https://docs.routescan.io/getting-started/supported-chains),
  [rate limits](https://docs.routescan.io/plans-and-limits/rate-limits),
  [Etherscan-compatible contracts API](https://docs.routescan.io/api/etherscan/contracts).
- Etherscan:
  [verifyzksyncsourcecode](https://docs.etherscan.io/api-reference/endpoint/verifyzksyncsourcecode).
- zkSync: [custom tooling](https://docs.zksync.io/zksync-network/zksync-era/custom-tooling),
  [how to verify contracts](https://code.zksync.io/tutorials/how-to-verify-contracts),
  `matter-labs/zksync-era` at commit
  [`ff5f519b`](https://github.com/matter-labs/zksync-era/tree/ff5f519b11cff863edcfa0f75af10fea113806b0):
  [api_decl.rs](https://github.com/matter-labs/zksync-era/blob/ff5f519b11cff863edcfa0f75af10fea113806b0/core/node/contract_verification_server/src/api_decl.rs),
  [api.rs](https://github.com/matter-labs/zksync-era/blob/ff5f519b11cff863edcfa0f75af10fea113806b0/core/lib/types/src/contract_verification/api.rs).

Local runs, curl 8.7.1, 2026-11-03, against `https://api.routescan.io`, no key:

- `checkverifystatus` with a made-up GUID on `mainnet/evm/43114`, `testnet/evm/43113`,
  `mainnet/evm/43113`, `testnet/evm/43114`, `testnet/evm/80002` and `mainnet/evm/324`, and on
  `mainnet/evm/43114/etherscan` without `/api`.
- `checkverifystatus` without a `guid` on `mainnet/evm/43114`.
- An OPTIONS preflight for `verifysourcecode` on `mainnet/evm/43114`.
- Every request carried `Origin: https://example.com`.
