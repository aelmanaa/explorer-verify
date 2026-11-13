# @explorer-verify/foundry

## 0.4.0

### Patch Changes

- Updated dependencies [[`7587efa`](https://github.com/aelmanaa/explorer-verify/commit/7587efaafe578be779e1f91cf15d7b3d22731028), [`6a86c54`](https://github.com/aelmanaa/explorer-verify/commit/6a86c5408981428eebb30b14a356599071b5e626)]:
  - explorer-verify@0.4.0

## 0.3.0

### Patch Changes

- [#395](https://github.com/aelmanaa/explorer-verify/pull/395) [`3801a0d`](https://github.com/aelmanaa/explorer-verify/commit/3801a0d0f80d0ec3fbc29f53e1a58c34a534b166) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The packages now declare Node.js 22.12.0 or later in `engines.node`, down from 22.18.0. CI installs the packed packages on Node.js 22.12.0 and runs every entry, the build helpers and the `explorer-verify` command there. Before 22.12.0, Node.js prints an experimental warning for the JSON imports the packages use.
- Updated dependencies [[`3801a0d`](https://github.com/aelmanaa/explorer-verify/commit/3801a0d0f80d0ec3fbc29f53e1a58c34a534b166), [`88fe71c`](https://github.com/aelmanaa/explorer-verify/commit/88fe71c4ced5f49c2476cc596a25e57942c74d42), [`3801a0d`](https://github.com/aelmanaa/explorer-verify/commit/3801a0d0f80d0ec3fbc29f53e1a58c34a534b166)]:
  - explorer-verify@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`8c72179`](https://github.com/aelmanaa/explorer-verify/commit/8c72179b3e304c3c47c3b5083efd427b17dfe52c)]:
  - explorer-verify@0.2.1

## 0.2.0

### Patch Changes

- [#342](https://github.com/aelmanaa/explorer-verify/pull/342) [`a64a7aa`](https://github.com/aelmanaa/explorer-verify/commit/a64a7aa80a25f786d71bc5010c6ba8987f1cf8f1) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Each entry point's declaration file opens with a `@packageDocumentation` comment whose first line
  says what the entry point is for. The API reference on the docs site shows that line next to each
  entry point, and gives each exported function, class, type and constant a page of its own.

- [#360](https://github.com/aelmanaa/explorer-verify/pull/360) [`93488b4`](https://github.com/aelmanaa/explorer-verify/commit/93488b4db2ca5b04d5fca6381986a6a877e7ee15) Thanks [@aelmanaa](https://github.com/aelmanaa)! - A project folder that does not exist, is a file or cannot be read is now reported on `root`:
  "The input is invalid: root is not a folder: it does not exist." The message never repeats the
  path, since a path typed by mistake can hold a key. Both helpers use the same wording.
  
  The Hardhat helper checks `root` first, before the artifacts folder, even when `outDir` or
  `artifact` is an absolute path. It no longer reports a missing `outDir` that the caller did not
  pass.
  
  The Foundry helper's `invalid-input` messages now carry the issue text, as the Hardhat helper's
  do: "The input is invalid: root is not a folder: …" instead of "The input is invalid: root." An
  output directory that this process cannot read is now `outDir could not be read`, not
  `outDir is not a directory`.
  
  The CLI names `--foundry` or `--hardhat` in the message and the issue, and its hint says to check
  the folder instead of to compile the project:
  
  ```text
  $ explorer-verify verify 0x… --chain 11155111 --hardhat no/such/project --contract contracts/A.sol:A --dry-run
  error: The input is invalid: --hardhat is not a folder: it does not exist. (invalid-input)
    hint: Check the folder that --hardhat names: it must exist and should hold the Hardhat config. Pass . for the current folder.
  ```
  
  Without `--out-dir`, a project folder with no output folder, or one the CLI cannot read, now
  names the project flag in the message too, for both Foundry and Hardhat: "The input is invalid:
  --hardhat has no artifacts folder: build the project, or pass --out-dir." The message used to
  name `--out-dir`, which the caller had not passed. The hint is unchanged.
  
  [#350](https://github.com/aelmanaa/explorer-verify/issues/350)

- [#301](https://github.com/aelmanaa/explorer-verify/pull/301) [`9bb2f0f`](https://github.com/aelmanaa/explorer-verify/commit/9bb2f0f0e534365a078d7459e14dd58a4bd35684) Thanks [@aelmanaa](https://github.com/aelmanaa)! - The READMEs and the Setup sections of the user guides now say how the supported Node.js range
  changes: it follows Node's active and maintenance LTS lines, and a line is dropped when it reaches
  end of life, in a minor release while the version is 0.x. Node 22 reaches end of life on
  2027-04-30. Node 20 is not supported. `engines.node` stays `>=22.18.0`.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/291
- Updated dependencies [[`acd9ffd`](https://github.com/aelmanaa/explorer-verify/commit/acd9ffd171e26af0802b6a68ba0d221988e752cf), [`a64a7aa`](https://github.com/aelmanaa/explorer-verify/commit/a64a7aa80a25f786d71bc5010c6ba8987f1cf8f1), [`c1ef895`](https://github.com/aelmanaa/explorer-verify/commit/c1ef895ef2865b5b56c05ab7c16659ac1b69a8d6), [`ec55dde`](https://github.com/aelmanaa/explorer-verify/commit/ec55ddede0e935d3ce77f6566cae89c57cfbdea6), [`72de386`](https://github.com/aelmanaa/explorer-verify/commit/72de38635010c26a34014f3fe2256585e1eab09e), [`1162d86`](https://github.com/aelmanaa/explorer-verify/commit/1162d86dbc4adde5dad787c262965488f21ffcaa), [`ec55dde`](https://github.com/aelmanaa/explorer-verify/commit/ec55ddede0e935d3ce77f6566cae89c57cfbdea6), [`1ef1660`](https://github.com/aelmanaa/explorer-verify/commit/1ef16609b9ea50793970ef4565460d4916496672), [`015930d`](https://github.com/aelmanaa/explorer-verify/commit/015930dc9993cd6cfb050374322076d702624225), [`c3e5ed8`](https://github.com/aelmanaa/explorer-verify/commit/c3e5ed8f5bceac042246390f42a80c4cb051ebaa), [`9bb2f0f`](https://github.com/aelmanaa/explorer-verify/commit/9bb2f0f0e534365a078d7459e14dd58a4bd35684), [`6ad0688`](https://github.com/aelmanaa/explorer-verify/commit/6ad0688bd6e50a3356718fe5aaaa4c524554ded8), [`899e945`](https://github.com/aelmanaa/explorer-verify/commit/899e9454200f67106881efe6eefa5e767875e7a8), [`93488b4`](https://github.com/aelmanaa/explorer-verify/commit/93488b4db2ca5b04d5fca6381986a6a877e7ee15), [`ec55dde`](https://github.com/aelmanaa/explorer-verify/commit/ec55ddede0e935d3ce77f6566cae89c57cfbdea6), [`1a2c786`](https://github.com/aelmanaa/explorer-verify/commit/1a2c786f76dedeef3286f3bbdc8926bdea03a155), [`2c317c0`](https://github.com/aelmanaa/explorer-verify/commit/2c317c0a37872c3b92292f48af56610d4d522e54), [`ec55dde`](https://github.com/aelmanaa/explorer-verify/commit/ec55ddede0e935d3ce77f6566cae89c57cfbdea6), [`fba3a2a`](https://github.com/aelmanaa/explorer-verify/commit/fba3a2a74b8ccfeabb812b42d033009cf473326d), [`7ee0497`](https://github.com/aelmanaa/explorer-verify/commit/7ee049753c0162a44b2f6e61b9c9b5cd263c4b0d), [`1ef1660`](https://github.com/aelmanaa/explorer-verify/commit/1ef16609b9ea50793970ef4565460d4916496672)]:
  - explorer-verify@0.2.0

## 0.1.0

### Minor Changes

- [#232](https://github.com/aelmanaa/explorer-verify/pull/232) [`74201ae`](https://github.com/aelmanaa/explorer-verify/commit/74201ae23f03a401758692e3df3088494ad09317) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: the input builders share one name family, and the two build helpers share option and result names. Each builder returns `BuiltVerifyInput`; add `chainId` and `address` to get a `VerifyInput`.
  
  - `verifyInputFromFoundry` is now `buildVerifyInputFromFoundry`, `verifyInputFromHardhat` is now `buildVerifyInputFromHardhat`, and `resolveInputFromBytecode` is now `buildVerifyInputFromBytecode`, with its options type `BuildFromBytecodeOptions` (was `ResolveInputOptions`).
  - The resolver option `sourcify` is now `allowSourcifyLookup`. The resolver takes `onEvent`, which receives a `verify.retry` event before each retry of a Sourcify request.
  - `findFoundryBuild` and `findHardhatBuild` take `FindBuildOptions` (`root`, `contract`, `outDir`, `artifact`; Foundry also `buildInfoDir`) and return `ProjectBuild` (`contract`, `documents`, `sources`, `files`). Foundry's `out` option is now `outDir`, and its `files` is now a list of paths: the artifact, then the build-info, or else the source files. Hardhat's `artifacts` option is now `outDir`; Hardhat adds `artifact`, and its result adds `contract` and an empty `sources`.
  - `buildVerifyInputFromFoundry` and `buildVerifyInputFromHardhat` take `BuildFromProjectOptions`: the find options plus `compilerVersion` and `sources`, which they pass to `buildVerifyInput`.
  - `linkLibraries` takes a `VerifyInput`, so `linkLibraries(42)` no longer compiles. For untyped data, call `validateInput` first.
  
  [#223](https://github.com/aelmanaa/explorer-verify/issues/223)

- Prepare the first public release of the core, CLI and build helpers. Release and promotion remain separate maintainer actions.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/257

- [#111](https://github.com/aelmanaa/explorer-verify/pull/111) [`ae1da35`](https://github.com/aelmanaa/explorer-verify/commit/ae1da35cc431fe0ea6d03dcea26a6151f1a6cd48) Thanks [@aelmanaa](https://github.com/aelmanaa)! - New package `@explorer-verify/foundry`, for Node 22.18 and later. It takes `explorer-verify` as a peer dependency, so it uses your copy of the core. `findFoundryBuild({ root, contract })` finds a contract's artifact under `out/` and the build-info file that lists it with the same metadata, parses them, and returns them ready for `buildVerifyInput`. After a default `forge build`, which writes only a stub build-info, it reads the source files that the artifact's metadata lists, so the core rebuilds the input from the metadata. `buildVerifyInputFromFoundry` does the same, then calls `buildVerifyInput`. The `outDir` and `buildInfoDir` options cover a project that sets another output directory. The `artifact` option picks one file when Foundry built the contract with several compiler versions and wrote one artifact for each.
  
  `contract` is `path:Name` or a bare `Name`. A name that matches two artifacts fails with `invalid-input` listing each `path:Name` and its file. A file that cannot be read fails with `invalid-input` naming it relative to the root. When no build-info lists the contract and a source file is missing or changed, the core's `incomplete-input` or `source-mismatch` error keeps its details and gets a hint to run `forge build --build-info`. The search skips `Name.metadata.json` files and never follows a symbolic link. Sources are read only when they are regular files of at most 16 MB under the root. The package uses only the public entry point of `explorer-verify`, runs no `forge` command and reads no `foundry.toml`.
  
  [#99](https://github.com/aelmanaa/explorer-verify/issues/99)

- [#235](https://github.com/aelmanaa/explorer-verify/pull/235) [`919359e`](https://github.com/aelmanaa/explorer-verify/commit/919359ea02e2195b5422c4302a5e0c824c96e690) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: an options key that a function does not read now throws `invalid-input` before any request, where it was ignored before. The issue names the key and, when one matches it ignoring case or by prefix, the option it may mean: `verify(input, { timeout: 5 })` gives `timeout: is not a known option; did you mean timeoutMs?`. The error never repeats the key's value. The rule covers the options of `verify()`, `dryRun()`, `checkStatus()`, `linkProxy()`, `verifyEach()`, `buildVerifyInput()`, `buildVerifyInputFromBytecode()`, `toEnvelope()`, `createVerifyHandler()`, `routesFor()`, `findHardhatBuild()`, `findFoundryBuild()`, `buildVerifyInputFromHardhat()` and `buildVerifyInputFromFoundry()`, and the keys of `route` and of each `backends` entry.
  
  Each flow function has its own options type: `VerifyOptions`, `DryRunOptions`, `CheckStatusOptions` and `LinkProxyOptions`, all built on the new `CallOptions`. In an object literal, TypeScript now refuses `pollIntervalMs` for `dryRun()` and `rpcUrl` for `checkStatus()` and `linkProxy()`. At run time those four functions still accept every key of `VerifyOptions`, so one options object built for `verify()` works with each of them. Every optional input field now accepts `undefined`, which counts as absent, so code built with `exactOptionalPropertyTypes` can pass `rpcUrl: process.env.RPC_URL` without a conditional spread.
  
  [#216](https://github.com/aelmanaa/explorer-verify/issues/216)

### Patch Changes

- [#242](https://github.com/aelmanaa/explorer-verify/pull/242) [`450b8b4`](https://github.com/aelmanaa/explorer-verify/commit/450b8b4b3d0b9f50dce6670051af9b0b30ec2d59) Thanks [@aelmanaa](https://github.com/aelmanaa)! - `explorer-verify verify` reads a Foundry or Hardhat project: `--foundry <dir>` or
  `--hardhat <dir>` with `--contract path:Name` finds the contract's artifact and the build-info
  file that lists it, whatever its hash name. `--contract` also takes a bare `Name` when one
  contract has that name. `.` is the current folder, not the Git root. For example, in a Foundry
  project after `forge build --build-info`:
  
  ```sh
  explorer-verify verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc --chain 11155111 \
    --foundry . --contract src/Greeter.sol:Greeter --backend sourcify --dry-run
  ```
  
  - `--out-dir <dir>` names the build's output folder when the config moves it, and
    `--artifact <file>` names the artifact when Foundry wrote one for each compiler version or
    profile. Both are relative to the project folder, or absolute. `--compiler-version` is passed
    on.
  - A project option with `--input` or `--input-json`, `--foundry` with `--hardhat`, a project
    without `--contract`, and `--out-dir` or `--artifact` without a project exit 2 before any
    request.
  - Errors name these flags in place of the helpers' option names, list the matching contracts when
    a name is ambiguous, and name `--foundry` or `--hardhat` when the default output folder is
    missing.
  - `--input` with a folder exits 2 and names `--foundry` and `--hardhat`. An extra argument after
    `--input`, as a shell glob such as `--input out/build-info/*.json` gives, exits 2 with
    `--input takes one file; repeat --input for each`; after `--artifact`, with
    `--artifact takes one file`. The generic issue now reads `verify takes at most 1 argument`.
  - An `invalid-input` error whose hint pointed at `details.issues`, which the envelope does not
    carry, now has the CLI's usage hint.
  - The CI guide's `scripts/verify.sh` adds the error message to its `::error::` line.
  
  The CLI now depends on `@explorer-verify/foundry` and `@explorer-verify/hardhat`, and loads each
  only when its option is given. The help examples, the CLI reference and the CI guide use project
  mode.
  
  In `findFoundryBuild` and `findHardhatBuild`, an error names a file outside the project root by
  its absolute path instead of a path that starts with `..`. `files` in the result is unchanged.
  
  [#221](https://github.com/aelmanaa/explorer-verify/issues/221)

- [#258](https://github.com/aelmanaa/explorer-verify/pull/258) [`0454017`](https://github.com/aelmanaa/explorer-verify/commit/0454017813533a87e4ff816c11ebd8f9e9945be6) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Add tested CLI and SDK quickstarts to the package READMEs. Remove contributor tracking IDs from editor documentation and omit internal dependency injection declarations from builds. Package checks reject internal IDs in generated declarations.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/226

- [#233](https://github.com/aelmanaa/explorer-verify/pull/233) [`f4e5523`](https://github.com/aelmanaa/explorer-verify/commit/f4e55232a49ea8300c50c1ced7e21626313f2ef5) Thanks [@aelmanaa](https://github.com/aelmanaa)! - Breaking: `ExplorerVerifyError` is generic over its code, and checking `error.code` narrows
  `error.details`. `ExplorerVerifyError.is(error, "not-confirmed")` checks the error and its code in
  one call. It and `instanceof` also recognise an error built by another installed copy of
  explorer-verify. New exports: `ERROR_HINTS`, the default hint of each code, and the types
  `DetailsOf`, `DetailsByCode` and `AnyExplorerVerifyError`.
  
  The breaking changes:
  
  - An error built with `new ExplorerVerifyError(...)` and no `hint` now has a hint that points to
    its docs page. Pass `hint: ERROR_HINTS[code]` for the code's default hint. Errors the library
    throws keep their hints.
  - `details.field` of `incomplete-input` and `insufficient-artifact` has a literal type, and the `source-mismatch` hashes are `Hex`.
  - `VerifyOutcome`, `BackendOutcome` and `VerifyEachResult` hold `AnyExplorerVerifyError`, so an
    outcome's error narrows by code. A value typed as the plain `ExplorerVerifyError` no longer fits
    a `VerifyOutcome`; `toEnvelope` and `exitCodeOf` still take it.
  - `details.backend` no longer reads `"unknown"`; a name outside `BACKEND_NAMES`, which only code
    that bypasses the types can pass, reads `etherscan-compatible`, as in a handle.
  
  Importing only `ExplorerVerifyError` costs about 2.8 KB less minified, because the hint text moved
  out of the class. The CLI, Hardhat and Foundry helpers pass the default hints themselves.
  
  Issue: https://github.com/aelmanaa/explorer-verify/issues/213
- Updated dependencies [[`a32473b`](https://github.com/aelmanaa/explorer-verify/commit/a32473bb291ef2753b8c4c5873e275d57cef7e0c), [`d82957d`](https://github.com/aelmanaa/explorer-verify/commit/d82957d8a0155f67f88d65dc18f8cb6a0919c8b2), [`0aa6b15`](https://github.com/aelmanaa/explorer-verify/commit/0aa6b154f775d6541565f9432d1f56aa69081d38), [`34ea774`](https://github.com/aelmanaa/explorer-verify/commit/34ea77463b4304a0cae724c9349adca601367c5a), [`ff437c9`](https://github.com/aelmanaa/explorer-verify/commit/ff437c9e233d6b084d70a50d06c5550d07596ca7), [`ff83bab`](https://github.com/aelmanaa/explorer-verify/commit/ff83baba4b739a97303a6667b342cb07382a86c3), [`1d0279c`](https://github.com/aelmanaa/explorer-verify/commit/1d0279cf04fa90d4e9e28d63bd3d6eab8137808b), [`d233f17`](https://github.com/aelmanaa/explorer-verify/commit/d233f170b43311b804dc1f653a0e69966cbf04c3), [`decb62b`](https://github.com/aelmanaa/explorer-verify/commit/decb62bf3765e104a9cd5428259ec7310477eb8b), [`74201ae`](https://github.com/aelmanaa/explorer-verify/commit/74201ae23f03a401758692e3df3088494ad09317), [`5b03fda`](https://github.com/aelmanaa/explorer-verify/commit/5b03fda602aff8c20b976345a6fe21b23a8131a3), [`1f57b85`](https://github.com/aelmanaa/explorer-verify/commit/1f57b857f8ade904c82882c0b4bc04ab5d47ad40), [`0a6f2fe`](https://github.com/aelmanaa/explorer-verify/commit/0a6f2fe95dcb810eafe12dfdb615f7e48bbdd8e1), [`9df3fe1`](https://github.com/aelmanaa/explorer-verify/commit/9df3fe122abecc3d2a85a6432485a1c696281527), [`33b513b`](https://github.com/aelmanaa/explorer-verify/commit/33b513bab47d9cb12fe2811c3a34cbb4037c9a3c), [`86c2c9c`](https://github.com/aelmanaa/explorer-verify/commit/86c2c9cf1ca0f7e10aa03676fd86d15bef8876a0), [`297a5b2`](https://github.com/aelmanaa/explorer-verify/commit/297a5b2a748944e3a57205abacb02036d23b117b), [`deba6de`](https://github.com/aelmanaa/explorer-verify/commit/deba6de80209f5f41165c7e11ed64c3548c7a413), [`147262f`](https://github.com/aelmanaa/explorer-verify/commit/147262f637dddbf960d4d06a5d371971d964cc95), [`e603436`](https://github.com/aelmanaa/explorer-verify/commit/e6034361ecd24217508c79ede5b81bcbbdac908c), [`76fa17b`](https://github.com/aelmanaa/explorer-verify/commit/76fa17b4e98f66a27f7035f1a44201aafc46a50c), [`369cf19`](https://github.com/aelmanaa/explorer-verify/commit/369cf19d9f93fb52f2c46f9c953f15ba8e12ea94), [`f3fda61`](https://github.com/aelmanaa/explorer-verify/commit/f3fda619c3f4e82d20949c02b3876f79bc18e583), [`755a5fa`](https://github.com/aelmanaa/explorer-verify/commit/755a5fa3a2a6763547a09c0f112a53e3405ec5d7), [`49ce96c`](https://github.com/aelmanaa/explorer-verify/commit/49ce96c75baa159742b3388529486e74ced5a20b), [`5faa6a6`](https://github.com/aelmanaa/explorer-verify/commit/5faa6a69d2243d32249dd7406a9c508c0e3a4918), [`f26cd8d`](https://github.com/aelmanaa/explorer-verify/commit/f26cd8dc004c7f3b36dccddaf525888fdb3f517b), [`4adfd26`](https://github.com/aelmanaa/explorer-verify/commit/4adfd26acbf7a246db2d6316aef15be0875c6a07), [`3ba6cf3`](https://github.com/aelmanaa/explorer-verify/commit/3ba6cf3b2352ed191f58c383cef938fbc0de8940), [`1e0f804`](https://github.com/aelmanaa/explorer-verify/commit/1e0f804365982790bd6c1f00051a4df7ac1595ba), [`8953d09`](https://github.com/aelmanaa/explorer-verify/commit/8953d09532860df5ca445aa8ce3c82507dae27a0), `7e80097`, [`784792b`](https://github.com/aelmanaa/explorer-verify/commit/784792b609264dff46316ebf6da380fd9d0af8e3), [`0a07946`](https://github.com/aelmanaa/explorer-verify/commit/0a07946f30dfd2f6b76e0bfc55a73b84702cbca4), [`1a4510c`](https://github.com/aelmanaa/explorer-verify/commit/1a4510ce032629cbb8cb8083152825cabe6a0e7e), [`2945a05`](https://github.com/aelmanaa/explorer-verify/commit/2945a05034b84ed2dc4f6fa8e1165303ac891c6e), [`df6ed4d`](https://github.com/aelmanaa/explorer-verify/commit/df6ed4da0b35d1acac3585a426c0241fb087aa7d), [`2c9ad23`](https://github.com/aelmanaa/explorer-verify/commit/2c9ad231fe5dbf7446fa503b0a96aa5a17053bd4), [`c3da921`](https://github.com/aelmanaa/explorer-verify/commit/c3da9218b85844940c7253f28cf6aa4fb2487b38), [`afac930`](https://github.com/aelmanaa/explorer-verify/commit/afac930f5579c1e0768590a1c2d545a8a851493b), [`d88f582`](https://github.com/aelmanaa/explorer-verify/commit/d88f5828a292b84e685602391eac1f8665867cfb), [`6f42c8d`](https://github.com/aelmanaa/explorer-verify/commit/6f42c8ddcc03bd208275cf1bf63acfbab3b177f0), [`c21dcc8`](https://github.com/aelmanaa/explorer-verify/commit/c21dcc866c2d8a9d59c6a9c144c56fbd3ce9a6a4), [`60f089c`](https://github.com/aelmanaa/explorer-verify/commit/60f089ce4d27f8a38f9b3ae961dab95369caf590), [`9c3bad5`](https://github.com/aelmanaa/explorer-verify/commit/9c3bad5636286bd1596400ae2c89416c8464abed), [`e2f7a18`](https://github.com/aelmanaa/explorer-verify/commit/e2f7a18649865dc1d3640ebc0a9d5ccab892f10b), [`3545aad`](https://github.com/aelmanaa/explorer-verify/commit/3545aade082511be19e44805fb649250b8ceb09b), [`feba0d6`](https://github.com/aelmanaa/explorer-verify/commit/feba0d6a06ebff3df6453539363ef95bd8679d0b), [`28d9682`](https://github.com/aelmanaa/explorer-verify/commit/28d9682eee4a8b892d4f3ef64cdc3fb5918b9601), [`f7c12bf`](https://github.com/aelmanaa/explorer-verify/commit/f7c12bf549560b9f2f52b2782fd0bee8043f2548), [`0454017`](https://github.com/aelmanaa/explorer-verify/commit/0454017813533a87e4ff816c11ebd8f9e9945be6), [`29a08aa`](https://github.com/aelmanaa/explorer-verify/commit/29a08aa66688870aa703a89235f0b46742f70bc2), [`3a69911`](https://github.com/aelmanaa/explorer-verify/commit/3a69911cf2aa9a89f21567f9ed4bc48db869f6da), [`99ee2a4`](https://github.com/aelmanaa/explorer-verify/commit/99ee2a49a31a6cde894f7ca1555f5f9fa16e0ae2), [`ec98e86`](https://github.com/aelmanaa/explorer-verify/commit/ec98e86f355bb7308d979da3d9a56e9f1ecbf1bd), [`dc7b98d`](https://github.com/aelmanaa/explorer-verify/commit/dc7b98dc342d282b8b6925f5b51177d363adbc94), [`c2142eb`](https://github.com/aelmanaa/explorer-verify/commit/c2142eb9fbd565002f62f66d4f16870dafa8d4d3), [`0559bba`](https://github.com/aelmanaa/explorer-verify/commit/0559bbae45487faeb57f8c1c8786295aee39ba2c), [`946aac4`](https://github.com/aelmanaa/explorer-verify/commit/946aac4f4fa141925365d7877624d6226733bc96), [`e89d615`](https://github.com/aelmanaa/explorer-verify/commit/e89d6158586191eef1d72754b58c1ff1a40d55d1), [`6a18410`](https://github.com/aelmanaa/explorer-verify/commit/6a184103013ac6f3b382ceaecd265b03e034264d), [`64c1d58`](https://github.com/aelmanaa/explorer-verify/commit/64c1d585787a9e1d9c6da9bf20674c0ebd19155e), [`21e7360`](https://github.com/aelmanaa/explorer-verify/commit/21e7360f2eb9223f74713934c911793e2594d023), [`5c7a1ac`](https://github.com/aelmanaa/explorer-verify/commit/5c7a1ac0f3d2723dfc38d5902731f64c0cf006ae), [`5f5fd62`](https://github.com/aelmanaa/explorer-verify/commit/5f5fd62d3056106a0f47731be7d0f990110bbf33), [`0ee4ea4`](https://github.com/aelmanaa/explorer-verify/commit/0ee4ea44c2ec4e98bf16f98d322eba1acf42e19f), [`919359e`](https://github.com/aelmanaa/explorer-verify/commit/919359ea02e2195b5422c4302a5e0c824c96e690), [`9e12c51`](https://github.com/aelmanaa/explorer-verify/commit/9e12c51c022a657877ff45d30260bdeb7de2849c), [`f4e5523`](https://github.com/aelmanaa/explorer-verify/commit/f4e55232a49ea8300c50c1ced7e21626313f2ef5), [`46ae3ee`](https://github.com/aelmanaa/explorer-verify/commit/46ae3ee7fb728bf4a6f31b3c27aa57fd7bcccebd), [`38365f3`](https://github.com/aelmanaa/explorer-verify/commit/38365f3b145c2c03694c6dc3b87254472560cc93), [`1ddf9eb`](https://github.com/aelmanaa/explorer-verify/commit/1ddf9eb8d58c5dd916d24741c612581b12a025e3), [`dbbfaf8`](https://github.com/aelmanaa/explorer-verify/commit/dbbfaf8e2eca8192bbcbb733dc1593c5bdae302a), [`64dd510`](https://github.com/aelmanaa/explorer-verify/commit/64dd5103e851580c0d7e1d116fb6861d50457986), [`1fdd7ad`](https://github.com/aelmanaa/explorer-verify/commit/1fdd7adeb21fe8f02b7d983ac3eab1c022487d93), [`e0b8d40`](https://github.com/aelmanaa/explorer-verify/commit/e0b8d40ab4bade8e654e3d465afb8ecfaca948b7)]:
  - explorer-verify@0.1.0
