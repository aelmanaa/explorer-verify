# 0075: The Vyper compiler kind, refused on every backend

Status: Accepted (2026-11-15). Extends [decision 0004](0004-solidity-first-pluggable-compilers.md)
with its third union member, in the shape of [decision 0057](0057-zksolc-compiler-kind.md).

Research: [Vyper support on each explorer](../research/2026-11-15-vyper-support.md).

## Context

Issue [#420](https://github.com/aelmanaa/explorer-verify/issues/420), part of epic
[#430](https://github.com/aelmanaa/explorer-verify/issues/430). A Vyper contract could not be
described in `VerifyInput`: `compiler` was `SolcCompiler | ZksolcCompiler`, `validateInput` required
`language: "Solidity"`, and the input schema had no Vyper branch. The research note probed
Etherscan v2, Blockscout, Sourcify and Routescan with Vyper 0.3.10, 0.4.0 and 0.4.3, and found that
each explorer takes a different spelling of the version and its own request shape.

This decision adds the type, its validation and a refusal on every backend. Later issues map one
backend each.

## Decision

1. `VerifyInput.compiler` is `SolcCompiler | ZksolcCompiler | VyperCompiler`. The Vyper member is
   `{ kind: "vyper"; version; input: VyperStandardJsonInput }`. `VyperStandardJsonInput` is a
   separate type: `{ language: "Vyper"; sources; interfaces?; settings }`, where a source is
   `{ content; keccak256? }` and an interface is `{ content }` or `{ abi }`. `settings` is required.
   `SolidityStandardJsonInput` does not change. Both new types are exported.
2. `compiler.version` is the long form, `x.y.z+commit.<8 hex>`, with one leading `v` stripped, as
   for solc. Each client formats it for its explorer. A 7-character commit is `invalid-input` on
   `compiler.version`, with a hint that names the release asset form. The solc "short version"
   message does not apply to Vyper.
3. Vyper 0.3.10 and later releases are accepted. A release before 0.3.10, or a prerelease (`rcN`,
   `bN`, `aN`, or Blockscout's `-rcN`), throws `unsupported-compiler` on `compiler.version`.
   `validateInput` throws it before any `invalid-input`, because fixing the other fields would not
   make the input verifiable.
4. `contractName` for Vyper is `path:Name`, where the path is a key of `sources` that ends in
   `.vy`, and `Name` is the file name without `.vy`. Anything else is `invalid-input` on
   `contractName`.
5. Vyper has no linked libraries. `libraries` on Vyper input is `invalid-input` on `libraries`, a
   library placeholder in `creationBytecode` is `invalid-input` on `creationBytecode`, and
   `linkLibraries` throws `invalid-input` on `compiler.kind`. The zksolc fields `solcVersion` and
   `solcFork` are refused on a Vyper compiler, as on solc.
6. `validateInput` refuses, for Vyper input only, a key of `sources` or `interfaces`, and an entry of
   `settings.search_paths`, that holds a local path. That includes keys that start with `0/`, the
   index form `vyper -f solc_json` writes for each `..` of a path. The issue names the field and the
   position, never the path. Solidity validation does not change. The builder (#425) will rewrite
   such keys; until then the hint says how to rename them.
7. Etherscan's `Pass - Verified` with an empty `SimilarMatch` still reads `exact`, and every
   Routescan match still reads `partial`, for Vyper as for solc
   ([match types](../../user/explanation/match-types.md), decision 0063).
8. `compiler-kinds.ts` holds one list per kind other than solc. Each entry is a backend and either
   the chains it maps or `{ except: [...] }`, every chain but those. The Vyper list is empty in this
   release, so `kindCheck` refuses Vyper input on every chain with `unsupported-compiler` on
   `compiler.kind`, before any request, in `verify()`, `dryRun()` and `verifyEach()` of both
   entries. Each client will format the version and the fields behind `kind === "vyper"`; the shared
   `standardJsonFields` keeps its solc output byte for byte.
9. `schema/input.schema.json` gets a `vyper` branch: `kind: "vyper"` requires `language: "Vyper"`
   and allows `interfaces`; the other kinds keep `language: "Solidity"`.

## Why

- The long form is what Sourcify downloads by and what Blockscout lists. The shorter forms that
  Etherscan and Routescan take follow from it by truncation; the long form cannot be rebuilt from
  them without a release list, and Vyper publishes none.
- 0.3.10 and 0.4.0 verified on every explorer they were sent to. Older versions use other trailer
  layouts and were not probed. No backend's prerelease spelling was verified except Blockscout's
  list, which differs from the release asset name.
- A separate input type leaves Solidity callers with no change, and `kind` already narrows the input.
- A contract name check catches a wrong name before a submit. Refusing `libraries` makes a caller
  mistake visible, as the zksolc kind refuses fields that do not apply.
- A `0/1/…/` key publishes the absolute path of the caller's Python environment, home directory
  included, with the source.
- One list per kind keeps the route choice before a client loads (decisions 0031 and 0057). The
  `except` form fits Vyper, which every Blockscout instance but ZKsync's offers.

## Consequences

- A switch on `compiler.kind` that is exhaustive on solc and zksolc no longer compiles without a
  `vyper` case. Code that reads `input.compiler.input` as `SolidityStandardJsonInput` narrows on
  `kind` first. This is a breaking type change, released as a minor version under 1.0.
- `FlowDependencies.zksolc` is now `compilers`, a list per kind. It is internal.
- The default hint of `unsupported-compiler` says that no backend verifies Vyper in this release.
- `buildVerifyInput` and the build helpers still refuse Vyper documents (#425, #426).
- The Vyper rules of `validateInput` ship in every entry that validates input. Measured with
  esbuild 0.28.2 on 2026-11-16, main `7142817` against this change: `verify` grows from 19162 to
  20398 bytes gzip, `verifyEach` from 20976 to 22250, `buildVerifyInputFromBytecode` from 24384 to
  25597, and the `validateInput` name, esbuild split, from 9368 to 10539. Five entries of
  `size-budget.json` and 19 rows of `name-budget.json` passed their ceilings. Each such ceiling is
  reset to the new measured size plus 20%, as decision 0014 sets.
