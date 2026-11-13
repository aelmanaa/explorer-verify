# 0074: Build the input from Solidity sources on its own subpath

Status: Accepted (2026-11-13). Extends R-IN-7 and the entry points of
[decision 0008](0008-package-split-and-bundle-budget.md), as
[decision 0026](0026-bytecode-metadata-resolver.md) did for `explorer-verify/resolve`.

Research: [2026-11-13: How solc resolves an import](../research/2026-11-13-solc-import-resolution.md).

## Context

Issue [#283](https://github.com/aelmanaa/explorer-verify/issues/283). Some packages ship Solidity
sources, compiler settings and bytecode, but no build-info, Standard JSON input or metadata.
`buildVerifyInput` needs one of those, and the bytecode resolver needs a metadata hash, which a
build with `bytecodeHash: "none"` lacks. A tool that deploys such a package's contracts had to
write its own import walker and remapping resolver.

## Decision

- `buildVerifyInputFromSources(options)` takes `contract` (`path:Name`), `compilerVersion`,
  `settings`, `remappings` and `sources`: an object of contents by source unit name, or a function
  that returns one, sync or async. It returns a promise of `BuiltVerifyInput`.
- It follows the import directives from the contract's file. A small lexer skips comments and
  string literals, and takes the first string literal of each `import` directive, which covers the
  four Solidity forms.
- It resolves each import as solc 0.8.24 does: relative imports first, then the remapping loop of
  `ImportRemapper::apply`, where a longer context wins over a longer prefix and the last of equal
  ones wins.
- Each name is read once, so a cycle ends. Only the reachable files go in the input. The remappings
  go into `settings.remappings`, and an `outputSelection` for the ABI, the bytecode and the
  metadata is added when the settings have none. The input then goes through `buildVerifyInput`.
- An import the sources lack throws `incomplete-input` with `field: "sources"` and every missing
  name in `candidates`, sorted, at most 1000. A local path in the contract, a remapping or a
  resolved import throws `invalid-input` naming the field, never the path. A reader's own error
  passes through unchanged.
- It is exported from a new subpath, `explorer-verify/sources`, not from the main entry, so the
  `verify` entry does not grow (R-RUN-3). Its `size-budget.json` entry was measured at 16,074 bytes
  gzipped, ceiling 19,289 (decision 0014's rule), on 2026-11-13 on main 2064f8d plus #283.
- It never compiles (R-IN-2). The guide tells the caller to compile the input once with solc-js
  and compare the creation bytecode.

## Alternatives

| Alternative                                          | Why not                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Export it from `explorer-verify`                     | Adds the lexer and resolver to `import *`; a caller who verifies never needs it |
| Put it on `explorer-verify/resolve`                  | That entry carries the HTTP layer; this builder sends nothing                   |
| Read `foundry.toml` and `remappings.txt` in the core | The core reads no file (R-RUN-1); a Foundry reader can follow in the helper     |
| Compare the bytecode in the builder                  | Needs a compiler; R-IN-2 keeps the library from compiling                       |
