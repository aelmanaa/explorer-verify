---
"explorer-verify": minor
"@explorer-verify/cli": patch
---

Breaking: `VerifyInput.compiler` accepts `SolcCompiler` or `ZksolcCompiler`. The zksolc member names `version`, `solcVersion` and optional `solcFork`. Validation checks each field. Solc input refuses the zksolc-only fields.

The routing check records compiler support by backend and chain. Calls refuse unsupported pairs with `unsupported-compiler` before any request. Constructor arguments are never derived for EraVM input. The CLI's JSON input accepts the new compiler fields.

What should I do? Switch on `compiler.kind` before reading compiler-specific fields. For solc input, leave out `solcVersion` and `solcFork`.

Issue: https://github.com/aelmanaa/explorer-verify/issues/206
