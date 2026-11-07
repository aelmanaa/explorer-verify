---
"explorer-verify": minor
"@explorer-verify/cli": patch
---

Breaking: `VerifyInput.compiler` takes a second kind, `{ kind: "zksolc", version, solcVersion, solcFork?, input }`, for contracts compiled with zksolc for EraVM on ZKsync Era. `version` is the zksolc version, such as `1.5.15`; `solcVersion` is the full version of the solc that zksolc ran; `solcFork` is the revision of ZKsync's solc fork, such as `1.0.2`. `validateInput` checks each field and names it in its issue. The new types `SolcCompiler` and `ZksolcCompiler` are exported. The routing table passes over a backend that does not verify the input's kind, and a route whose backend does not verify it throws `unsupported-compiler` with `details.field` `compiler.kind` before any request, in `verify()`, `dryRun()` and `verifyEach()` of `explorer-verify` and `explorer-verify/core`. No backend verifies zksolc in this release; the Blockscout mapping for chains 324 and 300 comes next. `verify()` never derives constructor arguments for zksolc input, and logs why once a backend verifies the kind and arguments would otherwise be derived. Code that reads `input.compiler.version` gets the zksolc version for zksolc input. The CLI's `--input-json` and `input.schema.json` accept the zksolc fields. Issue: https://github.com/aelmanaa/explorer-verify/issues/206

What should I do? Switch on `compiler.kind` before reading compiler-specific fields. For solc input, leave out `solcVersion` and `solcFork`.
