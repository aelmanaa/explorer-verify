---
"explorer-verify": minor
"@explorer-verify/cli": patch
---

Breaking: `VerifyInput.compiler` adds a third member, `VyperCompiler`, with its own input type, `VyperStandardJsonInput`. `validateInput` checks Vyper input, but no backend verifies it in this release: every route refuses it with `unsupported-compiler` before any request. The CLI's `verify` without a target reports that refusal before it asks for a backend.

What should I do? An exhaustive `switch` on `compiler.kind` that handles only `solc` and `zksolc` no longer compiles: add a `vyper` case. Code that reads `compiler.input` as `SolidityStandardJsonInput` checks `kind` first.

Issue: https://github.com/aelmanaa/explorer-verify/issues/420
