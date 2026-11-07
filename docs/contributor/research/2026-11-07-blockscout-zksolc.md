# Blockscout zksolc mapping

Date: 2026-11-07. Scope: issue #207, backend and chain capabilities, form fields and lookup grading.

## Sources

Blockscout's [RPC contract controller at commit 5e22da2](https://github.com/blockscout/blockscout/blob/5e22da2f0427ff11b99736d5ede34cccfb168878/apps/block_scout_web/lib/block_scout_web/controllers/api/rpc/contract_controller.ex)
maps `compilerversion` to `compiler_version`. When built for ZKsync, it also maps `zksolcVersion`
to `zk_compiler_version`. The Standard JSON request keeps `codeformat=solidity-standard-json-input`.
The compiler union stores the upstream long solc version separately from the zksolc version.

## Recorded reads

Keyless GETs on 2026-11-07, recorded with curl 8.7.1, returned HTTP 200:

| Chain | Contract                                     | solc                      | zksolc    |
| ----- | -------------------------------------------- | ------------------------- | --------- |
| 324   | `0x98d2F44dBaeD82765e90fc8F7299E860B95d2231` | `v0.8.24+commit.e11b9ed9` | `v1.4.1`  |
| 300   | `0x685eFBe097741899a66851b816a953619AF376c9` | `v0.8.24+commit.e11b9ed9` | `v1.5.11` |

Endpoints were `https://zksync.blockscout.com/api/v2/smart-contracts/<address>` and
`https://zksync-sepolia.blockscout.com/api/v2/smart-contracts/<address>`. Both returned
`is_verified: true`, `is_fully_verified: true`, `is_partially_verified: false` and a
`zk_compiler_version`. Reduced recordings are in
`packages/explorer-verify/test/fixtures/blockscout/2026-11-07-zksync-lookup.json` and
`2026-11-07-zksync-sepolia-lookup.json` beside it.

The existing lookup already grades these answers as exact. Reading `zk_compiler_version` must
not turn an unverified answer into a verified one. No submission was sent in this recording;
form tests assert request construction, and issue #208 tracks live submission evidence.

## Result

Enable the instance backend only on 324 and 300. Preserve the existing lookup grading and solc
form, and refuse other compiler and backend pairs before network requests. Decision 0059 records
this boundary. Build helpers and EraVM constructor argument derivation remain separate work.
