# CCIP EVM adoption validation

Issue #265; parent #263. This standalone consumer tests the packed 0.1.0 candidate at
`df036c7245c1baefa869478c7a5a00ca5366d8a2`. It implements a CCIP artifact wrapper and a CLI
that calls the same `verifyCcipBatch` SDK function. It does not change the upstream CCIP SDK.

Run from the repository root with Node 24 and npm available:

```sh
node validation/ccip/run.mjs --tarballs <candidate-tarball-directory> --output validation/ccip/results
```

The directory must contain `explorer-verify-0.1.0.tgz`. The runner copies it to a temporary
consumer installation and uses `npm ci --ignore-scripts --no-audit --no-fund`. The lockfile pins
the candidate's integrity and ethers 6.15.0 with its transitive dependencies. npm registry access
(or a populated npm cache), writable temporary storage, and permission to bind loopback HTTP are
required. No credentials, RPC endpoint or funded account is required. Temporary installations
remain available for inspection. Only the core public package is imported; the other three
candidate tarballs are hashed for identification and are not used by this consumer.

The command writes `results.json` with scenario outcomes and `packages.json` with candidate
version and tarball SHA-256 hashes. A failed assertion produces `success: false` and exit 1.
Successful rejected-contract and pending-contract tests mean the expected behavior was observed;
individual contracts retain their `failed` and `pending` statuses.

## Consumer behavior

`sdk.mjs` lazily loads exact Standard JSON, ABI and creation bytecode for CrossChainToken and
BurnMintTokenPool. `buildVerifyInput` receives the fully qualified contract and compiler version
from the upstream manifest. ethers encodes the real tuple and address constructors. The wrapper
continues after each contract's rejected result or SDK error and returns one result per deployment.
`resumeCcip` calls public `checkStatus` with a saved handle.

`cli.mjs verify deployments.json http://127.0.0.1:PORT/api` calls that wrapper. The deployment
file is an array of `{ "name": "CrossChainToken", "chainId": 31337, "address": "0x..." }`
objects. `cli.mjs resume handle.json http://127.0.0.1:PORT/api` reads `{ "handle": "ev1:..." }`.
Both print JSON. This validation CLI restricts endpoints to loopback. Run it from the temporary
installation, which contains the installed dependencies and copied artifacts. The runner exercises
both commands in separate processes. This is a consumer CLI, not the official explorer-verify CLI.

## Evidence

The committed `evidence/` contains the actual successful run. Scenarios check:

- Exact upstream artifact hashes before use.
- Direct SDK verification of both token and pool.
- A rejected token followed by a successful pool through the CLI.
- Pending jobs saved as handles, resumed by fresh CLI processes without another submission.
- `incomplete-input` for Standard JSON without contract/version, followed by reconstruction with
  pinned manifest fields. This is input completion, not address-only bytecode recovery.
- HTTP form source equality, compiler version, contract name, constructor bytes and decoding,
  and absence of API-key and Etherscan v2 chain fields. Both artifacts have empty external library
  settings and fully hexadecimal creation bytecode; no external library address is needed.

The first development run used a 500 ms budget, below the SDK's documented minimum 1000 ms poll
interval, and correctly returned pending. The final consumer uses 1500 ms and 1000 ms. An initial
incomplete-input assertion expected invalid-input; the observed specific code is incomplete-input.
These were validation harness corrections, with no product change.

## Provenance and limits

The six vendored files are byte-for-byte copies from
[smartcontractkit/ccip-tools-ts at 1cecb266d924bb52c6c6030e0bdc2b4b6f5e430e](https://github.com/smartcontractkit/ccip-tools-ts/tree/1cecb266d924bb52c6c6030e0bdc2b4b6f5e430e).
`artifacts/provenance.json` records each source path and SHA-256. `artifacts/LICENSE` preserves
the upstream MIT notice, copyright SmartContract Chainlink Limited SEZC. Embedded Solidity
license notices remain intact. Compiler version and fully qualified names come from that commit's
`ccip-sdk/src/verify/fixtures/manifest.json`. The deployment-bytecode modules attribute their
original chainlink-ccip generated Go bindings. They are preserved, not fabricated or recompiled.

The local HTTP stand-in asserts protocol payloads and supplies controlled Etherscan-compatible
answers. No contracts are deployed, no bytecode is matched on-chain, and constructor addresses
are synthetic local inputs. Source/bytecode compiler equivalence is inherited from upstream and
is not independently recompiled here. The result is local consumer interoperability evidence,
not live-explorer acceptance, a production deployment, or upstream adoption. Address-only recovery
through `buildVerifyInputFromBytecode` and real RPC constructor inference are not exercised.
The existing official CLI has no address-only recovery command. No public submissions or
transactions occur. Root checks and CI integration remain the coordinator's responsibility.

Repository pre-commit lint was attempted. Its shared type-aware rules report untyped JavaScript
conditions and console output in this standalone `.mjs` consumer; it does not include a consumer
TypeScript project. The commit skips that shared hook to preserve exact upstream artifact bytes
(the formatting hook would rewrite them). Syntax checks and the isolated packed consumer run are
the checks for this project. No root lint configuration was changed.
