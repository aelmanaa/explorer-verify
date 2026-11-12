# CCIP EVM adoption validation

Issue #265; parent #263. This standalone consumer wraps explorer-verify the way a token and pool
SDK would, and calls it from its own API and from a small CLI. It does not change the upstream
CCIP SDK.

Since 2026-11-12 the wrapper takes the SDK's deploy result as input. Each EVM deploy of the CCIP
SDK (`deployToken`, `deployTokenPool` and the others, at ccip-tools-ts `053a92ed`) returns:

```ts
type DeployResult = { hash: string } & {
  contractAddress: string;
  verification: { contract: string; encodedConstructorArgs: string };
};
```

`verification.contract` is unqualified, such as `BurnMintTokenPool`.

## Run

From the repository root, with Node 24 and npm:

```sh
node validation/ccip/run.mjs --output validation/ccip/results
```

Without `--tarballs`, the runner installs the published `explorer-verify@0.2.1` from npm, as
`package.json` and `package-lock.json` pin it. To test a release candidate, pass a directory that
holds its core tarball:

```sh
node validation/ccip/run.mjs --tarballs <candidate-tarball-directory> --output validation/ccip/results
```

The runner then points the dependency at that tarball, with its version and integrity. The suite
command `pnpm run validate:adoption --project ccip` always passes `--tarballs` with packages built
from the checkout.

The runner copies the consumer to a temporary directory and runs
`npm ci --ignore-scripts --no-audit --no-fund`. The lockfile pins ethers 6.15.0. It needs npm
registry access or a populated npm cache, writable temporary storage, and permission to bind a
loopback HTTP port. It needs no key, RPC endpoint or funded account.

The command writes `results.json` with the scenario outcomes and `packages.json` with the
installed version and where it came from. A failed assertion gives `success: false` and exit 1.

## What the caller adds

A deploy result holds the address, the contract name and the constructor arguments. It does not
hold the Standard JSON input, the compiler version or the chain id. The caller adds them:

| `verify()` input field | Source                                                                     |
| ---------------------- | -------------------------------------------------------------------------- |
| `address`              | `deploy.contractAddress`                                                   |
| `constructorArgs`      | `deploy.verification.encodedConstructorArgs`; left out when it is `0x`     |
| `contractName`         | `deploy.verification.contract`, mapped to `path:Name` in the Standard JSON |
| `compiler`             | The Standard JSON and the compiler version, from the caller's build map    |
| `chainId`              | The caller: the deploy result does not hold it                             |

`sdk.mjs` keeps the builds in a map keyed by `<contract>@<pool version>`:

```js
const builds = {
  "BurnMintTokenPool@2.0.0": {
    standardJson: () => loadJson("BurnMintTokenPool.standard-input.json"),
    compilerVersion: "0.8.26+commit.8a97fa7a",
    // contract: "contracts/pools/BurnMintTokenPool.sol:BurnMintTokenPool", // only to settle a name
  },
};
```

The SDK deploys pool version 2.0.0 only, so `version` defaults to `2.0.0`.

## The wrapper

`sdk.mjs` exports:

- `qualifiedName(standardJson, name)`: finds the source files that declare `contract Name`, with
  comments removed. One file gives `path:Name`. No file, or several, throws and lists the
  candidates; the caller then sets `contract` in the build entry. A Standard JSON input lists no
  contracts, so `buildVerifyInput` needs `path:Name` and refuses a bare name with
  `incomplete-input`.
- `inputFromDeployResult({ chainId, version, deploy }, builds)`: builds the `verify()` input.
- `verifyDeployResults(deployments, options, builds)`: verifies each deployment in turn and
  returns one result per deployment, after a rejection or an error too. It sets
  `indexWaitMs: 120000` and `timeoutMs: 300000` unless the caller sets them: right after a deploy,
  Etherscan may not have indexed the contract. A result with `storedContract` means the explorer
  holds another contract's source for the address. `submitOverPartial` and every other
  `verify()` option pass through.
- `resumeCcip(handle, options)`: calls `checkStatus` with a saved handle.

`cli.mjs verify deployments.json http://127.0.0.1:PORT/api` calls `verifyDeployResults`. The file
is an array of `{ "chainId": 31337, "version": "2.0.0", "deploy": <DeployResult> }`.
`--submit-over-partial` sets `submitOverPartial`, and `--index-wait-ms N` sets `indexWaitMs`.
`cli.mjs resume handle.json http://127.0.0.1:PORT/api` reads `{ "handle": "ev1:..." }`. Both
print JSON. The CLI accepts loopback endpoints only. It is a consumer CLI, not the explorer-verify
CLI.

## Scenarios

`exercise.mjs` stands in for the SDK's deploy: it builds the same `DeployResult`, encoding the
constructor arguments with the contract's ABI as the SDK does, and sends no transaction. A local
Etherscan-compatible explorer answers each request and checks the form.

| Scenario                                                      | What it shows                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `exact-upstream-artifact-hashes`                              | The vendored files match their recorded SHA-256                                                              |
| `sdk-token-and-pool`                                          | Two deploy results, token and pool, verified through the wrapper                                             |
| `deploy-result-in-verified`                                   | Each deploy result field reaches the explorer: address, `path:Name`, constructor arguments                   |
| `cli-per-contract-rejection-isolation`                        | A rejected token does not stop the pool, through the CLI                                                     |
| `cli-pending-persist-and-resume-without-resubmit`             | Pending jobs saved as handles and resumed by new CLI processes, with no second submit                        |
| `other-contract-source-submit-then-stored-contract`           | The explorer holds another contract's source: one submit, the refusal, then `storedContract`                 |
| `not-indexed-wait-then-verified`                              | Two submits find no contract code; `indexWaitMs` sends a third, which is verified; two `verify.retry` events |
| `partial-match-submit-over-partial`                           | A partial match of this source: no submit by default; `--submit-over-partial` submits and gets `exact`       |
| `unqualified-name-mapped-from-standard-json`                  | A bare name gives `incomplete-input`; the wrapper maps it; a name in two sources is refused, then settled    |
| `http-payload-constructor-and-no-external-library-assertions` | The explorer saw no assertion failure, no key and no `chainid`                                               |

## Evidence

`evidence/` holds the run of 2026-11-12 against the published 0.2.1: all ten scenarios passed.
`evidence/packages.json` records the npm tarball URL and integrity.

The run of 2026-11-08 against the 0.1.0 candidate passed the six scenarios of that time. The
published 0.2.1 passed the same six on 2026-11-12, before this change, with no code change.

## Provenance and limits

The six vendored files are byte-for-byte copies from
[smartcontractkit/ccip-tools-ts at 1cecb266d924bb52c6c6030e0bdc2b4b6f5e430e](https://github.com/smartcontractkit/ccip-tools-ts/tree/1cecb266d924bb52c6c6030e0bdc2b4b6f5e430e).
`artifacts/provenance.json` records each source path and SHA-256. `artifacts/LICENSE` preserves
the upstream MIT notice, copyright SmartContract Chainlink Limited SEZC. Embedded Solidity
license notices remain intact. The compiler version and the source path of each contract come
from that commit's `ccip-sdk/src/verify/fixtures/manifest.json`.

That commit is an older branch. On `main` at `053a92ed`, the SDK no longer holds Standard JSON
files. Its creation bytecode for BurnMintTokenPool and CrossChainToken 2.0.0 comes from
`@chainlink/contracts-ccip` 2.0.0 (`bytecode/v2_0_0/*.bin`), and is the same hex as the vendored
bytecode: `provenance.json` records both hashes. The npm package ships sources, ABIs, bytecode and
a `foundry.toml`, and no Standard JSON or build-info.

The local explorer asserts protocol payloads and gives controlled answers. No contract is deployed
here, and the constructor addresses are synthetic. A deploy and verification on Sepolia, with
the Standard JSON recovered from the explorers, is recorded in
[the 2026-11-12 research note](../../docs/contributor/research/2026-11-12-ccip-deploy-result.md).

The repository checks lint the runner and the wrapper. Vendored artifacts keep their exact
upstream bytes, are excluded from formatting, and are checked by their SHA-256.
