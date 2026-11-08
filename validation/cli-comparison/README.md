# CLI comparison validation

Issue #267, parent #263. This standalone project compares the packed explorer-verify 0.1.0
candidate at `df036c7245c1baefa869478c7a5a00ca5366d8a2` with actual
`forge verify-contract` and `forge verify-check` 1.8.1. It does not compare all cast commands.

Run from the repository root:

```sh
node validation/cli-comparison/run.mjs --tarballs <directory-with-four-candidate-tarballs>
```

Optional: `--output <directory>` writes evidence elsewhere; the default is `.work/results`
inside this project. `--foundry-bin <directory>` overrides the default Foundry bin directory
under the current user's home. All four tarballs must carry version 0.1.0 and the candidate
`gitHead`. Their SHA-256 digests are recorded in `evidence/results.json`.

Prerequisites: Node 24, npm, executable Forge/cast/Anvil 1.8.1, access to npm for locked solc
packages, the four supplied tarballs, and permission to bind loopback ports. No wallet,
RPC provider, explorer credentials, native solc installation or public network transaction
is needed. The runner creates an isolated HOME and passes an environment allowlist to tools.
It never inherits API key variables. It installs all four packed public packages together,
so their exact 0.1.0 sibling dependencies cannot resolve to registry placeholders.

The runner uses `npm ci` with the committed compiler lockfile, then installs the four local
tarballs without changing that lockfile. solc-js is pinned to 0.8.24. `solc.cjs` adapts the
native compiler command protocol to that actual compiler; it supports `--version` and
`--standard-json`. Forge's path options are accepted but not used: the contract has no imports.
The runner does a real `forge build --build-info --force`, then obtains framework-free compiler
JSON using `forge verify-contract --show-standard-json-input`. Both CLI submissions must contain
the same source contents, optimizer settings, EVM target, compiler version and contract target.
A fresh compilation of the exported JSON must also reproduce Forge's runtime bytecode exactly.

The original MIT-licensed `project/src/Counter.sol` is deliberately small. The runner starts
Anvil with zero accounts and installs compiled runtime at a fixed address with `anvil_setCode`.
It checks `eth_accounts` is empty and `eth_getCode` equals the compiled runtime. This is a local
code installation, not a deployment transaction. Every explorer call goes to a local fixture.
The fixture implements Etherscan-style lookup, submit and status answers, including Forge's
`getabi` lookup. Forge uses its `blockscout` verifier; explorer-verify uses its keyless
`etherscan-compatible` backend. These are two clients of the same local API, not a comparison
of live Blockscout and standalone explorer services.

## Recorded results

`evidence/results.json` contains exact argument arrays, versions, stdout, stderr, parsed stdout,
HTTP action counts, submission counts and assertions for each scenario. Paths and ephemeral
fixture ports are normalized to `<project>`, `<foundry-bin>`, `<tarballs>` and `<fixture>`.
`evidence/compiler-input.json` is the actual exported compiler input. Scenario `success: true`
means the observed outcome matched its assertion, including expected failures.

The recorded run used Node 24.21.0, Foundry 1.8.1 at commit
`982849d3140c01fd3b72905759581a132df7aa98`, and solc
`0.8.24+commit.e11b9ed9.Emscripten.clang`. Reproduce the committed evidence with:

```sh
node validation/cli-comparison/run.mjs --tarballs <tarballs> --output validation/cli-comparison/evidence
```

| Task                          | explorer-verify                                                                           | Forge                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Successful verification       | 1 invocation, 3 HTTP calls, exit 0                                                        | 1 invocation with `--watch`, 3 HTTP calls, exit 0                                                     |
| Explorer rejects source       | 1 invocation, 4 HTTP calls, exit 1                                                        | 1 invocation with `--watch`, 3 HTTP calls, exit 1                                                     |
| Pending, inspect, then resume | verify exits 4; status exits 0; 2 invocations, 1 submission                               | submit exits 0; pending verify-check exits 1; later verify-check exits 0; 3 invocations, 1 submission |
| Bad address                   | exit 2, no HTTP                                                                           | exit 2, no HTTP                                                                                       |
| Missing source/build data     | exit 2 with build/out-directory advice; separate metadata case reports `incomplete-input` | exit 1 for missing source file                                                                        |
| Machine output with `--json`  | One schemaVersion 1 JSON envelope on stdout, diagnostics on stderr                        | Empty stdout and human-readable diagnostics on stderr in these tested cases                           |

The Forge pending flow deliberately includes a check while the fixture remains pending.
Without that inspection, its submit and eventual successful check also take two invocations.
The exact poll counts depend on the explicit retry and timeout options. These counts are
observations of this fixture, not general efficiency or performance claims. Setup invocations
(install, versions, build and compiler-input export) are recorded separately from task invocations.
The standalone explorer-verify path needs compiler JSON plus explicit compiler version and
contract name. Its Foundry project path also completes successfully using the real build files.
Forge needs project sources, config and a compiler; it recompiles through the pinned adapter.
Both need an address, chain, verifier target and route.

## Missing input and recovery

The missing Foundry output scenario reports `invalid-input` and advises running `forge build`
or choosing `--out-dir`. Metadata without embedded source content reports `incomplete-input`,
names `src/Counter.sol`, and advises supplying matching build-info. Neither scenario makes an
explorer request. The address-only CLI attempt reports that `--input`, `--foundry`, `--hardhat`
or `--input-json` is needed; the existing CLI has no address-only recovery command.

Separately, the packed public `explorer-verify/resolve` export is exercised with actual compiled
runtime bytecode and Sourcify lookup disabled. A local gateway returning 404 produces
`metadata-unavailable`. Serving the exact solc metadata, with its literal source content,
then recovers matching sources and contract name. The resolver validates the metadata hash. The recovered compiler input must reproduce the
installed runtime too. Metadata reconstructed by the SDK omits the default `appendCBOR: true`;
the submission comparison treats that omission as the solc default.
The recovered request is passed to the CLI using `--input-json` and completes verification.
This is SDK recovery followed by a normal CLI invocation, not a hidden CLI recovery feature.

## Limits and attribution

The explorer fixture validates submission fields but does not implement explorer compilation or
bytecode matching. Its success answer is controlled test data. No live explorer accepted these
submissions, and this is not evidence of upstream Foundry adoption. No funded account,
transaction, API key, deployment, push, PR, tag or publish is used. There is no benchmark and
no claim of blanket performance or developer-experience parity. Network failures, constructor
arguments, linked libraries, multi-contract builds and other explorer protocols are outside this
small comparison. Native solc behavior is not tested; Forge compiles using the solc-js adapter.

Source attribution: the contract and harness are original to this validation. CLI behavior and
syntax come from the actual 1.8.1 `forge verify-contract --help` and `forge verify-check --help`
commands, and the packed explorer-verify CLI help and public docs. Solidity Standard JSON is
implemented by [solc-js](https://github.com/ethereum/solc-js) 0.8.24 (MIT);
[Foundry](https://github.com/foundry-rs/foundry) supplies Forge, cast and Anvil (MIT/Apache-2.0).
Local runs dated 2026-11-08 are the evidence for every observed output above. Relevant project
requirements are R-IN (input validation), R-FLOW (submit/poll), and R-AX (machine diagnostics).
Shared documentation indexes and CI are left for the coordinator.
