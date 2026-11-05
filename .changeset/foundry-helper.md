---
"@explorer-verify/foundry": minor
---

New package `@explorer-verify/foundry`, for Node 22.18 and later. It takes `explorer-verify` as a peer dependency, so it uses your copy of the core. `findFoundryBuild({ root, contract })` finds a contract's artifact under `out/` and the build-info file that lists it with the same metadata, parses them, and returns them ready for `buildVerifyInput`. After a default `forge build`, which writes only a stub build-info, it reads the source files that the artifact's metadata lists, so the core rebuilds the input from the metadata. `buildVerifyInputFromFoundry` does the same, then calls `buildVerifyInput`. The `outDir` and `buildInfoDir` options cover a project that sets another output directory. The `artifact` option picks one file when Foundry built the contract with several compiler versions and wrote one artifact for each.

`contract` is `path:Name` or a bare `Name`. A name that matches two artifacts fails with `invalid-input` listing each `path:Name` and its file. A file that cannot be read fails with `invalid-input` naming it relative to the root. When no build-info lists the contract and a source file is missing or changed, the core's `incomplete-input` or `source-mismatch` error keeps its details and gets a hint to run `forge build --build-info`. The search skips `Name.metadata.json` files and never follows a symbolic link. Sources are read only when they are regular files of at most 16 MB under the root. The package uses only the public entry point of `explorer-verify`, runs no `forge` command and reads no `foundry.toml`.

[#99](https://github.com/aelmanaa/explorer-verify/issues/99)
