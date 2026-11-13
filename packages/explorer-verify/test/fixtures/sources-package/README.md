# Sources-only package fixture

A contract package that ships Solidity sources, its compiler settings and creation bytecode, and
no build-info, Standard JSON input or metadata. The tests of `buildVerifyInputFromSources`
(R-IN-7, #283) and the guide "Verify contracts from a package that ships only sources" (#284) use
it.

## Files

| Path                               | What it is                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `src/Vault.sol`                    | `Vault`, the contract to verify                                                   |
| `src/VaultMath.sol`                | A library; `Vault` imports it relatively, with an alias (`import "..." as Maths`) |
| `src/Events.sol`                   | An interface; `Vault` imports it with `import * as Events from`                   |
| `src/Unused.sol`                   | Imported only in comments and a string in `Vault.sol`, so not in the input        |
| `lib/acl/src/Ownable.sol`          | A dependency that `Vault` imports through the remapping `@acl/=lib/acl/src/`      |
| `lib/acl/src/Context.sol`          | Imported relatively by `Ownable.sol`                                              |
| `foundry.toml`, `remappings.txt`   | The compiler settings and the remapping, as the package ships them                |
| `bytecode/Vault.json`              | Creation bytecode built with `bytecode_hash = "none"`, the package's build        |
| `bytecode/Vault.default-hash.json` | Creation bytecode of the same sources built with the default metadata hash (IPFS) |

`Events.sol` and `VaultMath.sol` import each other, so the import graph has a cycle. The import
closure of `Vault` is five files: every file above but `Unused.sol`.

## How the bytecode was made

Generated once on 2026-11-13 with solc-js 0.8.24 (`0.8.24+commit.e11b9ed9`, the `solc` devDependency
of the core package) from a Standard JSON input that held all six files, keyed by the paths above:

- `optimizer`: `{ "enabled": true, "runs": 200 }`;
- `evmVersion`: `"paris"`;
- `remappings`: `["@acl/=lib/acl/src/"]`;
- `metadata`: `{ "bytecodeHash": "none" }` for `Vault.json`, and no `metadata` key for
  `Vault.default-hash.json`.

Each file holds `evm.bytecode.object` of `src/Vault.sol:Vault`, with `0x`. To make it again, run
`solc.compile(JSON.stringify(input))` from `require("solc")` in the core package with that input
and write the object to the two files. `test/unit/sources-solc.test.ts` compiles the builder's
input with the same solc-js and fails if either bytecode no longer matches.
