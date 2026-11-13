# How solc resolves an import to a source unit name

Date: 2026-11-13. Issue: [#283](https://github.com/aelmanaa/explorer-verify/issues/283).

Question: which source unit name does solc give each import, so that a builder that follows the
imports of a contract puts the same files in the input as the compiler reads?

## Solidity documentation, 0.8.24

Read on 2026-11-13: <https://docs.soliditylang.org/en/v0.8.24/path-resolution.html>.

- "An import starting with `./` or `../` is a relative import." Any other import is direct and is
  used as written.
- A relative import starts from the importing file's source unit name, with its last segment
  removed. Each segment of the import is then applied from the left: `.` is skipped, `..` removes
  the last segment, any other segment is appended. The example `import "../.././../util.sol";`
  resolves to `util.sol`: extra `..` segments stop at the root.
- "Remapping happens after relative imports have already been resolved into source unit names."
- "At most one remapping is applied to a single import." The longest matching prefix wins, and of
  two equal prefixes "the one specified last wins". The context must match the start of the
  importing file's source unit name; an empty context matches every file.

## solc source, v0.8.24

Read on 2026-11-13:
<https://raw.githubusercontent.com/ethereum/solidity/v0.8.24/libsolidity/interface/ImportRemapper.cpp>.

- `ImportRemapper::apply` loops over the remappings and skips one whose context is shorter than the
  best so far, or whose context is not a prefix of the importing file. Among the rest it keeps the
  longest prefix; a later remapping of the same context and prefix length replaces an earlier one.
  So a longer context wins over a longer prefix, which the documentation does not say.
- `ImportRemapper::parseRemapping` splits at the first `=`. A `:` before it splits the context from
  the prefix. A remapping with an empty prefix is refused.

## What the builder does

`src/input/imports.ts` follows both: relative resolution first, then the remapping loop of
`ImportRemapper::apply`, context first. The unit tests in `sources-imports.test.ts` cover each
rule, and `sources-solc.test.ts` compiles the result with solc-js 0.8.24 and compares the bytecode
([decision 0074](../decisions/0074-input-from-sources.md)).

## Sources

- Solidity 0.8.24 documentation, import path resolution:
  https://docs.soliditylang.org/en/v0.8.24/path-resolution.html (read 2026-11-13)
- solc v0.8.24 source, `ImportRemapper.cpp`:
  https://raw.githubusercontent.com/ethereum/solidity/v0.8.24/libsolidity/interface/ImportRemapper.cpp
  (read 2026-11-13)
