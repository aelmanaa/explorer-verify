# Vyper support on each explorer

Date: 2026-11-15. Requirement: R-EXT-1.

Question: what would explorer-verify need to verify Vyper contracts on each explorer, and what do
the compiler and the build tools provide?

Audience: whoever adds a `kind: "vyper"` compiler member, a Vyper mapping in a backend client, or
Vyper support in a build helper. Assumes the facts in [explorer APIs](2026-11-02-explorer-apis.md)
and [Sourcify v2](2026-11-02-sourcify-v2.md).

Labels used below: "observed" means a live request or a local run on 2026-11-15; "source" means
code read at the commit given; "inferred" means neither. Inferred claims are marked as such.

## Summary

- Each explorer takes a different spelling of the compiler version. Etherscan takes
  `vyper:0.4.3`, Blockscout `v0.4.3+commit.bff19ea2`, Sourcify `0.4.3+commit.bff19ea2` and
  Routescan `v0.4.3`. Each refused the other spellings it was sent (observed).
- Etherscan v2 verifies Vyper through the same `verifysourcecode` action as solc, with
  `codeformat=vyper-json` (observed). Sourcify v2 takes the same request body as for solc
  (observed).
- Blockscout's Etherscan-style `/api` refuses `codeformat=vyper-json`, and Routescan's
  Etherscan-style API refuses it too. Each needs its own endpoint: Blockscout's
  `/api/v2/.../verification/via/vyper-standard-input`, which returns no job id, and Routescan's
  `/vyper-verifications` (observed).
- An exact match is possible only from Vyper 0.4.1, whose creation code ends with an integrity hash
  of the sources. Sourcify and Blockscout graded the 0.4.3 contract exact and the 0.4.0 and 0.3.10
  contracts partial. Etherscan and Routescan give no grade (observed).
- Vyper bytecode holds no IPFS or Swarm pointer, so a Vyper input cannot be rebuilt from bytecode
  alone (source).
- `vyper -f solc_json` and Foundry's build-info hold the exact compiler input. Hardhat 2 writes no
  build-info for Vyper, and Hardhat 3 has no Vyper plugin (observed).
- Inputs that import packages from a Python environment carry source keys with the absolute path of
  that environment, including the home directory. A rewrite to package-relative keys gave the same
  bytecode (observed).
- In this codebase the solc assumptions sit in a few places: the shared Etherscan-style form
  builder, input validation, the builder's language gate, the stored-version comparison and the
  server handler's version pattern (source).

## Probe setup

- Chain: Ethereum Sepolia (11155111). Deployer `0x9d087fC03ae39b088326b67fA3C788236645b717`.
- Compilers: vyper `0.4.3+commit.bff19ea2`; vyper 0.3.10 and 0.4.0 from their PyPI wheels, run with
  uv 0.11.16 under Python 3.11. The 0.3.x wheels fail on a newer Python with
  `AttributeError: 'Constant' object has no attribute 'n'` (observed).
- Requests sent with viem 2.57.16 and the `fetch` of Node.js 24.21.0. Every request and answer was
  logged with keys redacted.

| Id  | Compiler                 | Shape                                                                    | Address                                      | Creation transaction                                                 | Constructor arguments              |
| --- | ------------------------ | ------------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------- |
| A   | `0.4.3+commit.bff19ea2`  | `src/Counter.vy` imports the module `src/lib/math_lib.vy`; one immutable | `0x87cefeb68fd8a7ca7ae10891300c3140a84f1ca1` | `0x6433f516827f9927395d6d779c365e467918a96e67ad1f7f2dafbdfbaba4858e` | `(uint256 5, string "ev-track-a")` |
| B   | `0.3.10+commit.91361694` | one file, `Greeter.vy`                                                   | `0xb0de5e59ce0236e6a4b51de0ceb6b20c90dfdd36` | `0xf74d1b6812e8f4a723ce007055945eedd599e812c5f2c56b4bc833efe06cabd0` | `(uint256 42)`                     |
| C   | `0.4.0+commit.e9db8d9f`  | the two files of A, with `# pragma version 0.4.0`                        | `0xc4d2674d90d008bd32a36d438efc4c6f9f2bbb6b` | `0x53470b72451aa27e801ab45c8abbc1e816c998a25e9b66d685b857692000bc1a` | `(uint256 5, string "ev-track-c")` |

The inputs of A and C came from `vyper -f solc_json`, reduced to `language`, `sources` and
`settings`. The settings were `{"outputSelection":{"src/Counter.vy":["*"]},"search_paths":["."]}`.
vyper 0.3.10 has no `solc_json` format (`ValueError: Unsupported format type 'solc_json'`), so B's
input was written by hand. Its bytecode equals `vyper -f bytecode` (observed).

## Explorers

### Etherscan v2

| Field                  | Value for Vyper                                                                                                                          | Source                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Endpoint               | `POST https://api.etherscan.io/v2/api?chainid=…`, `module=contract&action=verifysourcecode`, form-encoded, as for solc                   | Etherscan `verifyvyper` docs; observed               |
| `codeformat`           | `vyper-json`                                                                                                                             | Etherscan docs; Foundry `block-explorers`; observed  |
| `sourceCode`           | The Vyper Standard JSON input as a string                                                                                                | Etherscan docs; observed                             |
| `contractname`         | `path:Name`, such as `src/Counter.vy:Counter`                                                                                            | Etherscan docs; Foundry `standard_json.rs`; observed |
| `compilerversion`      | `vyper:<semver>`, with no `v` and no commit: `vyper:0.4.3`, `vyper:0.3.10`. Foundry sends `vyper:` and the version before `+`            | Etherscan docs; Foundry `mod.rs`; observed           |
| `optimizationUsed`     | Listed as required. Sent `1` for A and B, `0` for C; all three verified, and every lookup reads `OptimizationUsed "1"`, `Runs "0"`       | Etherscan docs; observed                             |
| `constructorArguments` | Bare hex with no `0x`; decoded in the lookup                                                                                             | Etherscan docs; observed                             |
| Modules                | All files in `sources`; A and C verified with an imported module and `settings.search_paths`                                             | observed                                             |
| Integrity hash         | Not sent; A verified without the top-level `integrity` key                                                                               | observed                                             |
| Submit answer          | `{"status":"1","message":"OK","result":"<guid>"}`                                                                                        | observed                                             |
| Poll                   | `checkverifystatus`: `Pending in queue`, then `Pass - Verified`, the same texts as for solc. A took 133 s, B 23 s, C about 15 s          | observed                                             |
| Lookup                 | `getsourcecode`: `SourceCode` is the input wrapped in `{{…}}`, `CompilerVersion "vyper:0.4.3"`, `CompilerType "vyper-j"`, `SimilarMatch` | observed                                             |

- The version spelling of `-f solc_json`, `v0.4.3+commit.bff19ea2`, was refused at submit:
  `{"status":"0","message":"NOTOK","result":"Invalid compiler version. See https://etherscan.io/vyperversions for list of supported solc versions"}`
  (observed).
- The versions page lists `vyper:0.1.0b4` to `vyper:0.4.3`, prereleases such as `vyper:0.4.2rc1`
  and `vyper:0.4.0b2`, and one entry spelled `vyper:v0.5.0b1` (read 2026-11-15).
- Inferred: Etherscan takes the optimizer setting from the JSON input and does not read
  `optimizationUsed`.
- Match grade: no grade field. Before C was submitted, its lookup returned A's source, with
  `CompilerVersion "vyper:0.4.3"` and `SimilarMatch` set to A's address, although C was built with
  0.4.0 and other constructor arguments. After C was verified, `SimilarMatch` was `""` and the
  version `vyper:0.4.0` (observed). The client's rule, a non-empty `SimilarMatch` is a partial
  match, holds for Vyper.

### Blockscout

The Etherscan-style `/api` does not carry Vyper Standard JSON:

- `contract_controller.ex` (blockscout `d8d2be5`) accepts only `solidity-standard-json-input` and
  `solidity-single-file`. Any other `codeformat` renders `Missing codeformat field` (source).
- Live: `POST https://eth-sepolia.blockscout.com/api` with `codeformat=vyper-json` answered HTTP
  200 with `{"message":"Missing codeformat field","result":null,"status":"0"}` (observed).
- The legacy action `verify_vyper_contract` takes one source file and answers synchronously
  (source; not probed).
- `getsourcecode` for A returns `CompilerVersion "v0.4.3+commit.bff19ea2"` and no language or grade
  field (observed).

The REST API v2 has three Vyper methods. `GET /api/v2/smart-contracts/verification/config` on
eth-sepolia lists `vyper-code`, `vyper-multi-part` and `vyper-standard-input` (observed).
`vyper-multi-part` and `vyper-standard-input` need the verifier service; the ZKsync instances offer
only `standard-input` (`verification_controller.ex`, source).

| Field              | Value                                                                                                                                                        | Source                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Endpoint           | `POST /api/v2/smart-contracts/{address}/verification/via/vyper-standard-input`, `multipart/form-data`                                                        | source; observed with A |
| Fields             | `compiler_version`, `files[0]` (the JSON input as a `.json` file), optional `license_type`                                                                   | source; observed        |
| Not sent           | Contract name, constructor arguments, EVM version. The verifier compiles every contract and reads the arguments from the creation transaction                | source; observed        |
| `compiler_version` | `v<semver>[-pre]+commit.<8 hex>`, from the config list: `v0.4.3+commit.bff19ea2`, `v0.4.0-rc6+commit.33719560`. 56 versions, `v0.1.0-beta.16` to `v0.5.0-b1` | observed                |
| `evm_version` list | byzantium to cancun, osaka and default; no prague                                                                                                            | observed                |
| Submit answer      | HTTP 200 `{"message":"Smart-contract verification started"}`, with no job id                                                                                 | observed                |
| Lookup             | `GET /api/v2/smart-contracts/{address}`: `language "vyper"`, `compiler_version`, `is_fully_verified`, `is_partially_verified`                                | observed                |

`vyper-code` takes one file as JSON with `compiler_version`, `source_code`, `contract_name`,
`constructor_args` and `evm_version` (source; observed with B). `vyper-multi-part` takes the sources
and optional interfaces as multipart files (source; not probed).

Match grade:

| Contract  | Method                 | `is_fully_verified` | `is_partially_verified` |
| --------- | ---------------------- | ------------------- | ----------------------- |
| A, 0.4.3  | `vyper-standard-input` | `true`              | `false`                 |
| B, 0.3.10 | `vyper-code`           | `false`             | `true`                  |
| C, 0.4.0  | forwarded by Sourcify  | `false`             | `true`                  |

A verified in under 10 seconds. `is_partially_verified` is set when the verifier's `matchType` is
`PARTIAL` (`vyper/publisher.ex`, source). The verifier's CBOR reader parses the 5-item trailer of
0.4.1 and later, with its 32-byte integrity hash (`vyper-cbor-auxdata`, blockscout-rs `552ecd9`,
source). Inferred: a full match needs the integrity hash, so only 0.4.1 and later can be full.

For 0.4.0 and later the verifier derives the output selection and leaves library search paths out
(`normalize_output_selection` in `vyper_compiler.rs`, source).

### Sourcify v2

| Field                 | Value                                                                                                                               | Source                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Endpoint              | `POST https://sourcify.dev/server/v2/verify/{chainId}/{address}`, JSON, as for solc                                                 | Foundry `sourcify.rs`; observed |
| `stdJsonInput`        | The Vyper Standard JSON object, `language: "Vyper"`                                                                                 | observed                        |
| `compilerVersion`     | `<semver>+commit.<8 hex>`, with no `v`: `0.4.0+commit.e9db8d9f`                                                                     | `vyperCompiler.ts`; observed    |
| `contractIdentifier`  | `path:Name`, such as `src/Counter.vy:Counter`                                                                                       | observed                        |
| Constructor arguments | Not sent; read from the creation transaction given in `creationTransactionHash`                                                     | observed                        |
| Submit and poll       | 202 with `verificationId`; `GET /v2/verify/{id}` gives `isJobCompleted`, the match fields and `error.customCode`                    | observed                        |
| Lookup                | `GET /v2/contract/{chainId}/{address}`: `compilation.language "Vyper"`, `compilerVersion`, `match`, `creationMatch`, `runtimeMatch` | observed                        |

- Sourcify downloads the compiler from
  `https://github.com/vyperlang/vyper/releases/download/v<version without commit>/vyper.<version>.<platform>`,
  so the version must name a release asset (`vyperCompiler.ts`, sourcify `48176f5`, source).
- A 7-hex commit, as some `vyper --version` builds print, is accepted at submit and fails the job:
  202, then `error.customCode "compiler_error"` and
  `Failed fetching vyper 0.4.0+commit.e9db8d9 for platform linux. Please check if the version is valid.`
  (observed).
- For semver checks, `returnFixedVyperVersion` drops `bN` and `rcN`; the download uses the raw
  string (`VyperCompilation.ts`, source).
- The live server reports `sourcifyServerVersion 4.3.0` (`GET https://sourcify.dev/server/version`,
  observed).
- The `staging` tree has no `apiv1` folder. Inferred: the legacy `/verify/vyper` route is gone; not
  probed live.

Match grade:

| Contract  | `match`       | `creationMatch` | `runtimeMatch` |
| --------- | ------------- | --------------- | -------------- |
| A, 0.4.3  | `exact_match` | `exact_match`   | `match`        |
| B, 0.3.10 | `match`       | `match`         | `match`        |
| C, 0.4.0  | `match`       | `match`         | `match`        |

`Verification.ts` grades a byte-equal match exact only when every trailer carries the integrity
hash, which it checks for the `VYPER` auxdata style at 0.4.1 and later. Any older Vyper is partial.
The runtime code has no trailer from 0.3.10 on, so `runtimeMatch` is `match`, and `match` follows
the creation match (source; observed above).

### Routescan

| Field                 | Value                                                                                                                                                                                       | Source                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Etherscan-style API   | `verifysourcecode` with `codeformat=vyper-json` refused at submit: `{"status":"0","message":"NOTOK","result":"Invalid body request"}`, with `vyper:0.4.0` and with `v0.4.0+commit.e9db8d9f` | observed                 |
| Same API, solc form   | `codeformat=solidity-standard-json-input` and `vyper:0.4.0` accepted, then the poll answered `Invalid solc version vyper:0.4.0`                                                             | observed                 |
| Vyper endpoint        | `POST https://api.routescan.io/v2/network/{mainnet\|testnet}/evm/{chainId}/vyper-verifications`, JSON, optional `apikey` header; the docs list no body fields                               | Routescan docs           |
| Body                  | From the schema errors: `{format:"json", address, data, compilerVersion, contract}` or `{format:"archive", address, data}`                                                                  | observed                 |
| Working body          | `{"format":"json","address":"0x…","data":<input object>,"compilerVersion":"v0.4.0","contract":"src/Counter.vy:Counter"}`, answered `{"id":"<uuid>"}`                                        | observed                 |
| Constructor arguments | Not sent; decoded anyway                                                                                                                                                                    | observed                 |
| Poll                  | `GET …/vyper-verifications/{id}`: `{"status":"pending"}`, then `{"status":"ok"}` or `{"status":"error","message":"Error: …"}`, in 30 to 40 s                                                | Routescan docs; observed |
| Lookup                | `getsourcecode`: `CompilerVersion "v0.4.0"`, `OptimizationUsed "0"`, no `CompilerType` and no `SimilarMatch` key; no grade field                                                            | observed                 |

- `compilerVersion` worked only as `v<semver>`. Each of `0.4.0+commit.e9db8d9f`, `0.4.0`,
  `v0.4.0+commit.e9db8d9f` and `vyper:0.4.0` was accepted at submit and failed at the poll with
  `Error: Vyper version not found: <version>` (observed).
- The first lookups after `ok` still answered that the source was not verified. A lookup with an
  extra query parameter returned the verified answer (observed).
- Inferred: the `archive` format takes the base64 output of `vyper -f archive`. Not probed.
- Only C was submitted to Routescan.

### Version spelling per explorer

| Explorer      | Accepted                 | Refused, and where                                                                     |
| ------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| Etherscan v2  | `vyper:0.4.3`            | `v0.4.3+commit.bff19ea2`, at submit                                                    |
| Blockscout v2 | `v0.4.3+commit.bff19ea2` | Not probed; the config lists only this form                                            |
| Sourcify v2   | `0.4.0+commit.e9db8d9f`  | `0.4.0+commit.e9db8d9` (7-hex commit), in the job                                      |
| Routescan     | `v0.4.0`                 | `0.4.0+commit.e9db8d9f`, `0.4.0`, `v0.4.0+commit.e9db8d9f`, `vyper:0.4.0`, at the poll |

All rows observed on 2026-11-15.

### Cross-forwarding

- Blockscout forwarded A to Sourcify: Blockscout `verified_at` 00:48:26Z, Sourcify `verifiedAt`
  00:48:33Z. A later Sourcify submit of A answered `already_verified` (observed).
- Sourcify forwarded C to Blockscout (`externalVerifications.blockscout.verificationId`
  `BLOCKSCOUT_VYPER_SUBMITTED`); C was verified on Blockscout 12 s later (observed).
- Sourcify's forward of C to Etherscan failed with `Daily limit of 500 source code submissions
  reached`, a quota of Sourcify's own key (observed).
- A live test of one backend therefore needs a contract that no other backend has seen.

### Other Etherscan-style explorers

Not probed. Each standalone explorer needs its own evidence before it maps Vyper.

## Compiler

### Standard JSON input

From `vyper/cli/vyper_json.py` at 0.4.3 (source; the behaviours marked observed were run with vyper
0.4.3):

- `language` must be `"Vyper"`.
- `sources` is `{path: {content, keccak256?}}`. `urls` is refused. A `keccak256` is checked against
  `content`. The `sha256sum` that `-f solc_json` writes is ignored on input. Two sources with the
  same file stem are refused.
- `interfaces` is `{path: {content}}` or `{path: {abi}}`. A bare ABI list is accepted too.
- `settings.evmVersion` before london is refused. 0.4.3 accepts london, paris, shanghai, cancun and
  prague, and defaults to prague.
- `settings.optimize` is `"gas"`, `"codesize"` or `"none"`. A boolean is accepted with a
  deprecation warning (observed).
- Other settings: `experimentalCodegen` (alias `venomExperimental`), `debug`, `enable_decimals`,
  `bytecodeMetadata` (false drops the trailer, observed), `search_paths` (default `"."`) and
  `outputSelection`.
- A top-level `integrity` that differs from the computed hash gives only a warning; compilation
  succeeds (observed).
- Source pragmas can set the version, `optimize`, `evm-version`, `experimental-codegen` and
  `enable-decimals` (`vyper/ast/pre_parser.py`). The Vyper docs tell users to set the EVM version
  in a pragma for block explorers.

### Changes per version

| Version | Change                                                                                                                                                             | Source                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| 0.3.4   | CBOR signature appended to the runtime                                                                                                                             | release notes; observed            |
| 0.3.5   | Length suffix after the CBOR                                                                                                                                       | release notes; observed            |
| 0.3.8   | `bytecodeMetadata` in Standard JSON; shanghai default; fix for nondeterministic output                                                                             | release notes; sourcify#2825       |
| 0.3.10  | Signature removed from the runtime; runtime layout added to the creation-code trailer; `optimize` a string                                                         | release notes                      |
| 0.4.0   | Module system (`import`, `initializes:`, `uses:`, `exports:`, `.vyi`); `sys.path` in the search path; `-f archive`, `-f solc_json`, `-f integrity`; cancun default | release notes; `vyper -h` of 0.4.0 |
| 0.4.1   | Integrity hash added to the creation-code trailer                                                                                                                  | release notes; observed            |
| 0.4.2   | `-f settings`                                                                                                                                                      | release notes; `vyper -h`          |
| 0.4.3   | prague default; latest stable release                                                                                                                              | release notes; GitHub releases     |
| 0.5.0b2 | Prerelease: `optLevel` (exclusive with `optimize`) and `settings.venom` flags                                                                                      | GitHub releases; `vyper_json.py`   |

In 0.5.0b2, `-f solc_json` writes `settings.venom_flags` with snake_case keys, while the JSON parser
reads `settings.venom` (source). Whether the flags round-trip is an open question.

### The `solc_json` and archive formats

- `-f solc_json` writes the Standard JSON input with `sources[*].sha256sum`, an `outputSelection`
  for the target, `search_paths` and the non-default settings. It adds a top-level
  `compiler_version: "v0.4.3+commit.bff19ea2"` and `integrity`. Fed back to
  `vyper --standard-json` from another directory, it gave the same bytecode (observed). No explorer
  needed the extra fields: they were stripped before every submit above.
- `-f archive` writes a zip (`.vyz`, or base64 with `--base64`). It holds the sources and a
  `MANIFEST/` folder with `compilation_targets`, `compiler_version`, `integrity`, `searchpaths`,
  `settings.json` and `cli_settings.txt`. `settings.json` uses snake_case keys. `vyper file.vyz`
  compiles it to the same bytecode (observed for 0.4.3 and 0.5.0b2).

### Source keys from a Python environment

From 0.4.0 the CLI adds `sys.path` to the search path, so `from snekmate.auth import ownable`
resolves from a pip install. `-f solc_json` and `-f archive` turn each `..` of a path into its
index (`_anonymize` in `vyper/compiler/output_bundle.py`, source).

Compiling against snekmate 0.1.2 installed in a Python environment gave a source key of this form,
with a matching `search_paths` entry (observed):

```text
0/1/2/3/4/5/6/7/8/<absolute path of the Python environment>/lib/python3.12/site-packages/snekmate/auth/ownable.vy
```

The absolute path of the user's Python environment includes the home directory. Submitted as is,
it is published with the source on the explorer. A rewrite of the keys to `snekmate/auth/ownable.vy`
with `search_paths: ["."]` gave byte-identical bytecode (observed), as expected: the integrity hash
does not cover paths.

`.vyi` and `.json` imports are interfaces. `solc_json` puts them under `sources`; Foundry puts them
under `interfaces`. Both forms compile (observed).

### Bytecode trailer

Decoded with cbor2 6.3.0 from each compiler's output (observed):

| Version           | Where                    | Decoded                                                                                                   | Length suffix |
| ----------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- | ------------- |
| 0.3.3 and earlier | none                     | none                                                                                                      | none          |
| 0.3.4             | end of the runtime       | `{"vyper":[0,3,4]}`                                                                                       | none          |
| 0.3.5 to 0.3.9    | end of the runtime       | `{"vyper":[0,3,7]}`                                                                                       | CBOR length   |
| 0.3.10            | end of the creation code | `[runtime size, [data section lengths], immutables length, {"vyper":[0,3,10]}]`                           | CBOR + 2      |
| 0.4.0             | end of the creation code | the 4-item array of 0.3.10                                                                                | CBOR + 2      |
| 0.4.1 to 0.5.0b2  | end of the creation code | `[integrity hash (32 bytes), runtime size, [data section lengths], immutables length, {"vyper":[0,4,3]}]` | CBOR + 2      |

The probe contracts match: B ends with `…a16576797065728300030a0014`, C with
`…a1657679706572830004000015`, and A with a 5-item array whose first item is
`vyper -f integrity`. Sourcify's lookup reads an empty `runtimeBytecode.cborAuxdata` for all three
(observed). Sourcify's `VyperCompilation.ts` names four auxdata styles: `VYPER_LT_0_3_4`,
`VYPER_LT_0_3_5`, `VYPER_LT_0_3_10` and `VYPER` (source).

### Integrity hash and match grade

- The hash is recursive: `sha256` of the source's own `sha256` followed by the hash of each imported
  module, in import order. An interface adds only its own source hash. A storage layout override is
  hashed in. Paths, settings and the compiler version are not covered (`imports.py`, `phases.py`,
  source).
- The same sources gave the same hash on 0.4.0, 0.4.1, 0.4.2 and 0.4.3, and with
  `-O codesize --evm-version cancun` (observed).
- Before 0.4.1 the bytecode holds nothing derived from the source text. Inferred: a comment change
  then leaves the bytecode unchanged, so a match does not prove that the source is the same. That
  is why the explorers grade it partial.
- A search result for the Sourcify docs page on Vyper says every Vyper match is a plain match. The
  current code allows an exact match from 0.4.1 (see Sourcify v2 above).

### Constructor arguments and immutables

- The constructor arguments follow the whole creation code, trailer included. The 0.4.3 creation
  code of a test contract is 505 bytes and reads its arguments with `CODECOPY` from offset 505
  (observed).
- Inferred: in a creation transaction the trailer is therefore not at the end. A reader must search
  for the CBOR pattern, or subtract the compiled creation code's length.
- The deployed runtime is the compiled runtime followed by the immutables. A titanoboa 0.2.8 deploy
  gave 367 runtime bytes and a 32-byte tail, the trailer's immutables length (observed). Sourcify's
  immutables docs describe the same layout.
- ERC-5202 blueprints hold `0xFE71 <version>` and the creation code. sourcify#2826 (closed
  2026-07-06) added their verification and says Etherscan has a "Vyper (Blueprint)" mode.

### No bytecode-only resolver

Vyper bytecode holds no IPFS or Swarm pointer, so its source cannot be fetched from the bytecode
(source, from the trailer layout above). The trailer gives only `major.minor.patch`, the sizes and,
from 0.4.1, a source hash that can check supplied sources but not locate them (inferred).

Inferred, not tested: the Solidity auxdata reader expects a CBOR map with byte, text or boolean
values. Vyper 0.3.5 to 0.3.9 carry a map with an array value, and the last two bytes of a 0.3.10+
runtime are data-section bytes. Both would read as "no metadata".

## Versions and downloads

- Tags are spelled `v0.4.3`, `v0.4.1rc3` and `v0.5.0b2`. Assets are
  `vyper.<version>+commit.<8 hex>.{linux,darwin,windows.exe}`. 0.4.0b2, 0.4.0b3 and 0.3.10rc1 have no
  binaries (GitHub releases API, observed).
- The 0.3.x PyPI wheels print a 7-hex commit (`0.3.7+commit.6020b8b`); the asset says `6020b8bb`.
  For 0.4.3 both say `bff19ea2` (observed).
- No official `list.json` like `binaries.soliditylang.org` was found. Lists that exist: the GitHub
  releases API; Blockscout's `vyper.list.json` in `blockscout/solc-bin`, with `longVersion` and
  hashes, which includes 0.5.0b1; Hardhat's `vyper-releases-mirror.hardhat.org/list.json`, 60
  entries up to v0.4.3 (observed).
- The trailer gives no commit and no prerelease tag, so a long version from bytecode alone needs the
  release list, and an rc and its release share a number (inferred).

### Browser

- No official WebAssembly build. Remix compiles Vyper on a remote service (Remix docs).
- Vyper 0.4.3 runs in Pyodide 0.27.7 on Node.js 24.21.0 (observed). The run installed `cbor2<6`,
  `asttokens`, `pycryptodome`, `packaging`, `lark` and `wheel`, then `vyper==0.4.3` without its
  dependencies. The `immutables` package has no pure-Python wheel, so it was replaced by a stub; only
  `vyper/venom/analysis/available_expression.py` imports it.
- `compile_json` of a `solc_json` input gave bytecode with the same sha256 as the native compiler.
  Install and load took 3.6 s, the compile 0.9 s. The Pyodide package is 15 MB on disk (observed).
- Inferred: the stub breaks `experimentalCodegen` builds, and 0.3.x was not tried, since Pyodide
  0.27 ships Python 3.12. The download size makes it an opt-in, not a default.

## Build tools

### Foundry

Observed with forge 1.8.1 on a project with a module and a `.vyi` interface:

- `forge build` writes `out/<File>.vy/<Name>.json` with ABI and bytecode and no metadata. With
  `build_info = true` it writes `out/build-info/<id>.json` with `language: "Vyper"`,
  `solcVersion: "0.4.3"` and `solcLongVersion: "0.4.3"`, without a commit.
- The build-info `input` is the exact Vyper Standard JSON: sources, `interfaces`, and settings with
  an explicit `evmVersion`, `optimize`, `outputSelection` and `search_paths: ["", "src"]`.
  `vyper --standard-json` on it reproduced the artifact bytecode.
- `forge verify-contract --show-standard-json-input` on the multi-module target printed one source,
  the target, keyed by its absolute path, with `interfaces: {}` and no `search_paths`. vyper
  answered that `lib.ownable` was not found. `get_vyper_standard_json_input` reads the target's own
  file (`crates/verify/src/provider.rs`, foundry `cd37671`, source).
- foundry-compilers drops `search_paths` below 0.4 and clamps `evmVersion` per Vyper version
  (`crates/artifacts/vyper/src/settings.rs`, source). foundry#10702 (closed 2025-07-07) added
  Etherscan verification of Vyper.
- Inferred: the Foundry helper can read a Vyper build-info as it reads a solc one, then pick the
  target's sources and map the version to the long form.

### Hardhat

- Hardhat 2: `@nomiclabs/hardhat-vyper` 3.1.2 runs `vyper -f combined_json` and writes
  `hh-vyper-artifact-1` artifacts, with no build-info and no Standard JSON. It passes only
  `evmVersion` and `optimize` (`packages/hardhat-vyper/src/compiler.ts`, branch `v2`, source).
  Inferred: the input must be rebuilt from the sources and the config.
- Hardhat 3: `@nomiclabs/hardhat-vyper` 4.0.0 is a placeholder; its README says it "does not work
  with Hardhat 2 nor 3". The port is tracked in hardhat#7296 (open). hardhat#5477 (open) asks for
  verification from `-f archive`.
- Other open Hardhat issues ask for all Vyper settings (hardhat#4873), for modules found on
  `sys.path` (hardhat#5479) and for Vyper in hardhat-verify (hardhat#3980).

### Ape

- ape-vyper reads settings from source pragmas and the project config (README, `2bb7b6160a`).
- ape-etherscan rebuilds the Standard JSON at verify time. It follows the imports, reads the files
  from disk, takes the settings from the cached manifest, and removes `search_paths`. It sends
  `vyper-json` and `vyper:X.Y.Z` (`ape_etherscan/verify.py`, `a80ca6f8ac`, source).
- Inferred: the `.build/__local__.json` manifest holds the sources and settings, so the input can be
  rebuilt but is not stored as sent to the compiler.

### titanoboa and Moccasin

- `boa.verify` keeps the deployer's `-f solc_json` output and posts it to Blockscout's
  `vyper-standard-input` with `compiler_version` taken from that output (`boa/verifiers.py`,
  titanoboa `4094da1464`, source). Blockscout is the explorer it implements.
- Moccasin wraps boa's verifiers for Blockscout, the ZKsync explorer and Etherscan
  (`moccasin/supported_verifiers.py`, `4fb9f35d6c`, source).
- Inferred: these tools hold the exact input at deploy time, so a script could pass it to
  explorer-verify. That input carries the Python-environment source keys described above.

## Usage

- DefiLlama TVL by language: Vyper $1.14B (0.83%) against Solidity $119.4B on 2026-11-15, from
  $2.48B (1.09%) a year before. DefiLlama tags two protocols as Vyper, Curve DEX and Yearn Finance,
  so this undercounts Vyper parts of other protocols (fetched 2026-11-15).
- sourcify#2825 (closed 2026-06-12) counts about 2,200 mainnet contracts on Vyper 0.3.4 to 0.3.7,
  2,045 of them on 0.3.7. Their compiler output depends on Python set order, fixed in 0.3.8 and not
  backported.
- sourcify#2826 reports that all 11 bytecode mismatches on 0.4.3 in a mainnet corpus were ERC-5202
  blueprints.
- GitHub code search, `language:Vyper`, on 2026-11-15: `"pragma version 0.4"` 836 files,
  `"pragma version 0.3.10"` 434, `"@version 0.3.7"` 537, `"@version ^0.3"` 857, `"@version 0.2"`
  2,122. The queries overlap.

## What this codebase would change

Paths are relative to the repository; line numbers are at `e3b2bdd`.

### Solidity assumptions that a Vyper input would hit

| Where                                                                   | Today                                                                                                                                                                             | For Vyper                                                                                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/explorer-verify/src/types.ts:14-100`                          | `SolidityStandardJsonInput`, `language: "Solidity"`; the union is `SolcCompiler \| ZksolcCompiler`                                                                                | A `VyperCompiler` member and a Vyper input type with optional `interfaces`                                                                          |
| `packages/explorer-verify/src/input/validate.ts:135-169`                | `checkKind` accepts solc and zksolc; `checkVersion` requires the solc long form; `checkLanguage` requires `Solidity`                                                              | A Vyper kind, a Vyper version rule and a language per kind                                                                                          |
| `packages/explorer-verify/src/input/validate.ts:478-560`                | Library link addresses                                                                                                                                                            | Vyper has no libraries: refuse `libraries`                                                                                                          |
| `packages/explorer-verify/schema/input.schema.json:30-79`               | `kind` enum `solc`, `zksolc`; `language` const `Solidity`                                                                                                                         | A `vyper` branch                                                                                                                                    |
| `packages/explorer-verify/src/compiler-kinds.ts:20-80`                  | `ZKSOLC_ROUTES` keyed by backend and chain; `kindCheck`                                                                                                                           | A Vyper capability per backend                                                                                                                      |
| `packages/explorer-verify/src/backends/common.ts:347-361`               | `standardJsonFields`, shared by four clients: `codeformat=solidity-standard-json-input`, `compilerversion=v<version>`, and only `language`, `sources`, `settings` in `sourceCode` | `vyper-json`, `vyper:<semver>` for Etherscan, and `interfaces` kept                                                                                 |
| `packages/explorer-verify/src/backends/sourcify.ts:319-332`             | Sends `language`, `sources`, `settings`                                                                                                                                           | Keep `interfaces`; send the long version                                                                                                            |
| `packages/explorer-verify/src/backends/blockscout.ts:163-200`           | Submits through `/api` `verifysourcecode`                                                                                                                                         | A multipart request to `vyper-standard-input` and a poll of the v2 lookup                                                                           |
| `packages/explorer-verify/src/flow/stored.ts:68-78`                     | `sameVersion` strips one `v` and splits at `+`                                                                                                                                    | Etherscan's stored `vyper:0.4.0` never equals `0.4.0+commit…`, so a verified Vyper contract would read as another contract's source. Strip `vyper:` |
| `packages/explorer-verify/src/server/handler.ts:168`                    | `COMPILER_VERSION` is `/^v?[0-9]+\.[0-9]+\.[0-9]+…/`                                                                                                                              | `vyper:0.4.0` fails it, so the handler would answer 400 to every Etherscan Vyper submit                                                             |
| `packages/explorer-verify/src/input/build.ts:1078-1082`                 | A language other than `Solidity` throws `unsupported-compiler`                                                                                                                    | Accept `Vyper`, return `kind: "vyper"`, keep `interfaces`                                                                                           |
| `packages/explorer-verify/src/input/sources.ts`, `src/input/imports.ts` | Solidity import scanner and remappings                                                                                                                                            | Vyper imports resolve through `search_paths`; refuse `.vy` until a Vyper scanner exists                                                             |
| `packages/explorer-verify/src/input/resolvers/auxdata.ts`               | Reads solc's CBOR map                                                                                                                                                             | Nothing to build from; a message that Vyper bytecode has no metadata pointer                                                                        |
| `packages/foundry/src/foundry.ts`                                       | Matches build-info by Solidity metadata, then by name                                                                                                                             | Vyper artifacts have no metadata, so only the name match applies                                                                                    |

The kind checks already sit outside the client chunks, and `checkStatus()` does not read the
compiler kind (decision 0057). The Blockscout chunk measures 3,647 of its 4,377-byte ceiling in
`size-budget.json`, which bounds a new request shape there.

The tests that assert a Vyper refusal today include `packages/explorer-verify/test/unit/validate-input.test.ts`,
`blackbox-13.test.ts` and `packages/cli/test/unit/input-schema.test.ts`. Builder refusals
(`build-input.test.ts`, `build-mutants.test.ts`) stay if the builder stays solc-only.

### Proposed slices

The zksolc work followed the same shape: one pull request added the type, validation, schema and a
refusal everywhere, and later ones turned on one backend each (#254, #256).

| Slice | Content                                                                                                                                | Depends on                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1     | `VyperCompiler`, validation, schema, a refusal on every backend, hints, a decision record, the R-EXT-1 edit, the refusal tests flipped | the version-form decision |
| 2     | Keep `interfaces` in the Etherscan form and the Sourcify body for Vyper only, so solc requests stay byte-identical                     | none                      |
| 3     | Sourcify maps Vyper: long version, recorded lookup, submit and failure, reference page, live target                                    | 1, 2                      |
| 4     | `sameVersion` reads Etherscan's `vyper:` form                                                                                          | 1                         |
| 5     | Etherscan v2 maps Vyper: `vyper-json`, `vyper:<semver>`, the handler's version pattern, result texts, recordings                       | 1, 2, 4                   |
| 6     | Blockscout maps Vyper through `vyper-standard-input`, with a poll of the v2 lookup and no job id                                       | 1, 2, 4                   |
| 7     | Routescan maps Vyper through `/vyper-verifications`, with its own version form and a stale-lookup guard                                | 1, 2, 4                   |
| 8     | `buildVerifyInput` and the Foundry helper accept Vyper Standard JSON, `solc_json` and Foundry build-info, with key rewriting           | 1                         |
| 9     | Later: `buildVerifyInputFromSources` for Vyper, with an import scanner over `search_paths`                                             | 8                         |

Constructor-argument derivation subtracts the compiled creation code from the creation
transaction. Inferred from the layout above, this works unchanged for Vyper; a recorded Vyper
creation transaction in slice 3 or 5 would confirm it.

## Open questions

1. Canonical `compiler.version`: require the long form `x.y.z[rcN|bN]+commit.<8 hex>` and let each
   backend format it, or also accept `x.y.z`? The solc "short version" message must not fire for
   Vyper.
2. One Standard JSON type with a `language` discriminant, or a separate Vyper type? Is `settings`
   required for Vyper input, as the builder's shape check assumes?
3. Should validation require the `contractName` Name to equal the file stem?
4. Refuse `libraries` and `linkLibraries` for Vyper, or ignore them?
5. Capability model: one table in `compiler-kinds.ts` for zksolc and Vyper, or one list per kind?
   Where does per-backend formatting go, given that `standardJsonFields` serves four clients?
6. Etherscan: does it read `optimizationUsed` for `vyper-json`? What does a failed Vyper verify
   answer at the poll? Which spelling does it take for a prerelease, `vyper:0.4.1rc3` or the
   `vyper:v0.5.0b1` form?
7. Blockscout: a failed `vyper-standard-input` verify has no job to poll. How does a client tell a
   failure from a pending job? Does an explicit `prague` EVM version work, given that the config
   list lacks it?
8. Routescan: the `archive` format, mainnet behaviour, prerelease spelling, rate limits and whether
   the endpoint needs a key.
9. Sourcify: do 0.4.1 and 0.4.2 grade exact as 0.4.3 does, and how do rc and beta versions download?
10. Do the explorers accept the `0/1/…` source keys of `solc_json` as they stand?
11. Vyper before 0.3.10 (runtime trailer, legacy immutables, nondeterministic 0.3.4 to 0.3.7
    output) was not probed on any explorer. What minimum version should the library support?
12. Does the 0.5.0 `venom_flags` setting round-trip through `solc_json`?
13. Does Pyodide run 0.3.x, and `experimentalCodegen` with a real `immutables` build?
14. Should the library bundle a Vyper release list (Blockscout's has hashes) or query GitHub?
15. How many verified Vyper contracts exist per version? No public count was found.
16. Is a server-handler change for Vyper limited to the version pattern, or does it need fields it
    does not forward? A new field changes R-SRV-3.

## Sources

Explorers, live (2026-11-15):

- Etherscan API v2: https://api.etherscan.io/v2/api, chain 11155111.
- Blockscout eth-sepolia: https://eth-sepolia.blockscout.com/api and
  https://eth-sepolia.blockscout.com/api/v2/smart-contracts/verification/config
- Sourcify: https://sourcify.dev/server/v2/verify and https://sourcify.dev/server/version
- Routescan: https://api.routescan.io/v2/network/testnet/evm/11155111/etherscan/api and
  https://api.routescan.io/v2/network/testnet/evm/11155111/vyper-verifications

Explorer docs (read 2026-11-15):

- Etherscan, verify Vyper source code: https://docs.etherscan.io/api-reference/endpoint/verifyvyper
- Etherscan, verify with the API: https://docs.etherscan.io/contract-verification/verify-with-api.md
- Etherscan Vyper versions: https://etherscan.io/vyperversions
- Routescan contracts API: https://docs.routescan.io/api/contracts
- Sourcify docs, Vyper (search result only): https://docs.sourcify.dev/docs/vyper
- Sourcify docs, immutables: https://github.com/sourcifyeth/docs

Explorer source (read 2026-11-15):

- blockscout `d8d2be5`:
  https://github.com/blockscout/blockscout/blob/d8d2be5/apps/block_scout_web/lib/block_scout_web/controllers/api/rpc/contract_controller.ex,
  https://github.com/blockscout/blockscout/blob/d8d2be5/apps/block_scout_web/lib/block_scout_web/controllers/api/v2/verification_controller.ex,
  https://github.com/blockscout/blockscout/blob/d8d2be5/apps/block_scout_web/lib/block_scout_web/routers/smart_contracts_api_v2_router.ex,
  https://github.com/blockscout/blockscout/blob/d8d2be5/apps/explorer/lib/explorer/smart_contract/vyper/publisher.ex
- blockscout-rs `552ecd9`:
  https://github.com/blockscout/blockscout-rs/blob/552ecd9/smart-contract-verifier/smart-contract-verifier/src/verify/vyper_compiler.rs,
  https://github.com/blockscout/blockscout-rs/blob/552ecd9/smart-contract-verifier/smart-contract-verifier/src/verify/vyper_compiler_input.rs,
  https://github.com/blockscout/blockscout-rs/blob/552ecd9/smart-contract-verifier/vyper-cbor-auxdata/src/lib.rs
- sourcify `48176f5` (`staging`) and `fbb7509f8c`:
  https://github.com/argotorg/sourcify/blob/48176f5/packages/lib-sourcify/src/Compilation/VyperCompilation.ts,
  https://github.com/argotorg/sourcify/blob/48176f5/packages/lib-sourcify/src/Verification/Verification.ts,
  https://github.com/argotorg/sourcify/blob/48176f5/packages/compilers/src/lib/vyperCompiler.ts
- sourcify issues: https://github.com/argotorg/sourcify/issues/2825 and
  https://github.com/argotorg/sourcify/issues/2826

Compiler (read or run 2026-11-15):

- Vyper releases: https://github.com/vyperlang/vyper/releases
- Vyper release notes: https://docs.vyperlang.org/en/stable/release-notes.html
- Vyper, compiling a contract: https://docs.vyperlang.org/en/stable/compiling-a-contract.html
- Vyper source at v0.4.3: https://github.com/vyperlang/vyper/blob/v0.4.3/vyper/cli/vyper_json.py,
  https://github.com/vyperlang/vyper/blob/v0.4.3/vyper/compiler/output_bundle.py,
  https://github.com/vyperlang/vyper/blob/v0.4.3/vyper/ir/compile_ir.py,
  https://github.com/vyperlang/vyper/blob/v0.4.3/vyper/semantics/analysis/imports.py,
  https://github.com/vyperlang/vyper/blob/v0.4.3/vyper/ast/pre_parser.py
- Blockscout Vyper list: https://raw.githubusercontent.com/blockscout/solc-bin/main/vyper.list.json
- Hardhat Vyper mirror: https://vyper-releases-mirror.hardhat.org/list.json
- Remix Vyper docs: https://remix-ide.readthedocs.io/en/latest/vyper.html
- Pyodide: https://pyodide.org (0.27.7, run on Node.js 24.21.0)
- snekmate: https://github.com/pcaversaccio/snekmate (0.1.2)
- Tools run: vyper 0.3.1, 0.3.3 to 0.3.7, 0.3.9, 0.3.10, 0.4.0 to 0.4.3 and 0.5.0b2, forge 1.8.1, titanoboa 0.2.8, cbor2 6.3.0, uv
  0.11.16, viem 2.57.16, Node.js 24.21.0.

Build tools (read 2026-11-15):

- Foundry `cd37671`:
  https://github.com/foundry-rs/foundry/blob/cd37671/crates/verify/src/etherscan/mod.rs,
  https://github.com/foundry-rs/foundry/blob/cd37671/crates/verify/src/etherscan/standard_json.rs,
  https://github.com/foundry-rs/foundry/blob/cd37671/crates/verify/src/sourcify.rs,
  https://github.com/foundry-rs/foundry/blob/cd37671/crates/verify/src/provider.rs
- Foundry Vyper Etherscan verification: https://github.com/foundry-rs/foundry/pull/10702
- foundry block-explorers:
  https://github.com/foundry-rs/block-explorers/blob/main/crates/block-explorers/src/verify.rs
- foundry-compilers `18b5178625`:
  https://github.com/foundry-rs/compilers/blob/18b5178625/crates/artifacts/vyper/src/settings.rs
- hardhat-vyper, branch `v2`:
  https://github.com/NomicFoundation/hardhat/blob/v2/packages/hardhat-vyper/src/compiler.ts
- hardhat-vyper on npm: https://www.npmjs.com/package/@nomiclabs/hardhat-vyper
- Hardhat issues: https://github.com/NomicFoundation/hardhat/issues/7296,
  https://github.com/NomicFoundation/hardhat/issues/5477,
  https://github.com/NomicFoundation/hardhat/issues/4873,
  https://github.com/NomicFoundation/hardhat/issues/5479 and
  https://github.com/NomicFoundation/hardhat/issues/3980
- ape-vyper `2bb7b6160a`: https://github.com/ApeWorX/ape-vyper/tree/2bb7b6160a
- ape-etherscan `a80ca6f8ac`:
  https://github.com/ApeWorX/ape-etherscan/blob/a80ca6f8ac/ape_etherscan/verify.py
- titanoboa `4094da1464`: https://github.com/vyperlang/titanoboa/blob/4094da1464/boa/verifiers.py
- Moccasin `4fb9f35d6c`:
  https://github.com/Cyfrin/moccasin/blob/4fb9f35d6c/moccasin/supported_verifiers.py

Usage (fetched 2026-11-15):

- DefiLlama TVL by language: https://api.llama.fi/langs
- GitHub code search: https://github.com/search?type=code&q=language%3AVyper
