# 2026-11-03: Where Hardhat 2 and Hardhat 3 write a contract's build files

Audience: whoever changes `@explorer-verify/hardhat` (R-DX-2). The question: given a project
folder and a contract name, which files hold that contract's build, and how does one file name the
next? Checked on 2026-11-03 by building one project with Hardhat 2.29.1 (`npx hardhat compile`) and
Hardhat 3.21.2 (`npx hardhat build`), solc 0.8.24, and by reading the Hardhat source at those two
release tags. The build output is the fixture set in `packages/hardhat/test/fixtures/`.

## Both versions

- The artifact of contract `Name` in source `path` is `<artifacts>/<path>/<Name>.json`, where
  `<artifacts>` is `artifacts/` unless the config sets `paths.artifacts`. Seen in both builds:
  `artifacts/contracts/Pair.sol/First.json` and `artifacts/contracts/Pair.sol/Second.json` for
  two contracts in one file.
- Build-info files are in `<artifacts>/build-info/`, a flat folder
  ([`build-system.ts` at hardhat@3.21.2, lines 1092 to 1100 and 1201](https://github.com/NomicFoundation/hardhat/blob/5280c3a2a540e48a49c60cad4f1a4b71851b2094/packages/hardhat/src/internal/builtin-plugins/solidity/build-system/build-system.ts#L1092-L1100),
  read 2026-11-03; seen in both builds).
- An artifact of a contract that links an external library records the link in
  `linkReferences`. The build-info's `settings` has no `libraries`: Hardhat links at deploy time.
  Seen in both builds for `Counter`, which calls the library `Tally`.

## Hardhat 3

- The artifact has `buildInfoId` and `inputSourceName` next to `sourceName`. In the build, the id
  was `solc-0_8_24-2c15e64bd16481586acae188ce2eaa479a4781e0` and `inputSourceName` was
  `project/contracts/Counter.sol` for `sourceName` `contracts/Counter.sol`.
- The build id names two files: `build-info/<id>.json` with the compiler input
  (`_format: "hh3-sol-build-info-1"`) and `build-info/<id>.output.json` with the compiler output
  (`_format: "hh3-sol-build-info-output-1"`)
  ([`build-system.ts` at hardhat@3.21.2, lines 1041 to 1057](https://github.com/NomicFoundation/hardhat/blob/5280c3a2a540e48a49c60cad4f1a4b71851b2094/packages/hardhat/src/internal/builtin-plugins/solidity/build-system/build-system.ts#L1041-L1057);
  [`artifacts.ts` at hardhat@3.21.2](https://github.com/NomicFoundation/hardhat/blob/5280c3a2a540e48a49c60cad4f1a4b71851b2094/packages/hardhat/src/internal/builtin-plugins/solidity/build-system/artifacts.ts),
  read 2026-11-03).
- The build also writes `artifacts.d.ts` files next to the artifacts and at the top of the
  artifacts folder. They are TypeScript declarations, not JSON.

### Build profiles

- Hardhat 3 builds with a named profile. When the config does not define `production`, Hardhat
  creates it from `default` with three changes: the optimizer on with the default runs, `isolated`
  builds (one compilation job per contract) and `toolVersionsInBuildInfo`
  ([`config.ts` at hardhat@3.21.2, lines 470 to 547](https://github.com/NomicFoundation/hardhat/blob/5280c3a2a540e48a49c60cad4f1a4b71851b2094/packages/hardhat/src/internal/builtin-plugins/solidity/config.ts#L470-L547),
  read 2026-11-03).
- Hardhat Ignition's deploy task builds with `defaultBuildProfile: "production"`
  ([`hardhat-ignition/src/index.ts` at hardhat@3.21.2, line 160](https://github.com/NomicFoundation/hardhat/blob/5280c3a2a540e48a49c60cad4f1a4b71851b2094/packages/hardhat-ignition/src/index.ts#L160),
  read 2026-11-03). A plain `hardhat build` uses `default`, so its build files can differ from
  what Ignition deployed. `--build-profile production` selects the same profile
  ([`build.ts` at hardhat@3.21.2, lines 34 and 35](https://github.com/NomicFoundation/hardhat/blob/5280c3a2a540e48a49c60cad4f1a4b71851b2094/packages/hardhat/src/internal/builtin-plugins/solidity/tasks/build.ts#L34-L35),
  read 2026-11-03).

## Hardhat 2

- The artifact has no `buildInfoId`. Next to it, `<Name>.dbg.json` holds
  `{ "_format": "hh-sol-dbg-1", "buildInfo": "../../build-info/<id>.json" }`. The `buildInfo` path
  is relative to the folder of the `.dbg.json` file
  ([`artifacts.ts` at hardhat@2.29.1, `_createDebugFile` and `_getDebugFilePath`](https://github.com/NomicFoundation/hardhat/blob/ae4a62f7dfbb45645b8b5da4058d7505382b0591/packages/hardhat-core/src/internal/artifacts.ts),
  read 2026-11-03; seen in the build).
- One build-info file holds the input and the output (`_format: "hh-sol-build-info-1"`). Its id
  in the build was a 32-character hex string.

## What the helper needs from Hardhat

Nothing at run time. The links between the files are two fields, `buildInfoId` (Hardhat 3) and
`buildInfo` in the `.dbg.json` file (Hardhat 2). Reading them needs no Hardhat code, so the helper
does not depend on `hardhat`, and one helper reads both versions.

## Sources

- Hardhat 3.21.2 source, tag `hardhat@3.21.2` (commit `5280c3a2`):
  https://github.com/NomicFoundation/hardhat/blob/5280c3a2a540e48a49c60cad4f1a4b71851b2094/packages/hardhat/src/internal/builtin-plugins/solidity/build-system/build-system.ts
  and
  https://github.com/NomicFoundation/hardhat/blob/5280c3a2a540e48a49c60cad4f1a4b71851b2094/packages/hardhat/src/internal/builtin-plugins/solidity/build-system/artifacts.ts,
  read 2026-11-03.
- Hardhat 3.21.2 build profiles and Ignition, same commit:
  https://github.com/NomicFoundation/hardhat/blob/5280c3a2a540e48a49c60cad4f1a4b71851b2094/packages/hardhat/src/internal/builtin-plugins/solidity/config.ts,
  https://github.com/NomicFoundation/hardhat/blob/5280c3a2a540e48a49c60cad4f1a4b71851b2094/packages/hardhat-ignition/src/index.ts
  and
  https://github.com/NomicFoundation/hardhat/blob/5280c3a2a540e48a49c60cad4f1a4b71851b2094/packages/hardhat/src/internal/builtin-plugins/solidity/tasks/build.ts,
  read 2026-11-03.
- Hardhat 2.29.1 source, tag `hardhat@2.29.1` (commit `ae4a62f7`):
  https://github.com/NomicFoundation/hardhat/blob/ae4a62f7dfbb45645b8b5da4058d7505382b0591/packages/hardhat-core/src/internal/artifacts.ts,
  read 2026-11-03.
- Local builds on 2026-11-03 with Node 24.21.0: `hardhat` 2.29.1 (`npx hardhat compile`) and
  3.21.2 (`npx hardhat build`), solc 0.8.24, optimizer on with 200 runs. The output, trimmed as its
  README says, is in `packages/hardhat/test/fixtures/`.
