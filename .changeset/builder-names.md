---
"explorer-verify": minor
"@explorer-verify/foundry": minor
"@explorer-verify/hardhat": minor
---

Breaking: the input builders share one name family, and the two build helpers share option and result names. Each builder returns `BuiltVerifyInput`; add `chainId` and `address` to get a `VerifyInput`.

- `verifyInputFromFoundry` is now `buildVerifyInputFromFoundry`, `verifyInputFromHardhat` is now `buildVerifyInputFromHardhat`, and `resolveInputFromBytecode` is now `buildVerifyInputFromBytecode`, with its options type `BuildFromBytecodeOptions` (was `ResolveInputOptions`).
- The resolver option `sourcify` is now `allowSourcifyLookup`. The resolver takes `onEvent`, which receives a `verify.retry` event before each retry of a Sourcify request.
- `findFoundryBuild` and `findHardhatBuild` take `FindBuildOptions` (`root`, `contract`, `outDir`, `artifact`; Foundry also `buildInfoDir`) and return `ProjectBuild` (`contract`, `documents`, `sources`, `files`). Foundry's `out` option is now `outDir`, and its `files` is now a list of paths: the artifact, then the build-info, or else the source files. Hardhat's `artifacts` option is now `outDir`; Hardhat adds `artifact`, and its result adds `contract` and an empty `sources`.
- `buildVerifyInputFromFoundry` and `buildVerifyInputFromHardhat` take `BuildFromProjectOptions`: the find options plus `compilerVersion` and `sources`, which they pass to `buildVerifyInput`.
- `linkLibraries` takes a `VerifyInput`, so `linkLibraries(42)` no longer compiles. For untyped data, call `validateInput` first.

[#223](https://github.com/aelmanaa/explorer-verify/issues/223)
