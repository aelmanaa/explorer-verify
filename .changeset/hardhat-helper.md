---
"@explorer-verify/hardhat": patch
---

Add `@explorer-verify/hardhat`, which finds a contract's build files in a Hardhat 2 or Hardhat 3 project and builds its verification input. `findHardhatBuild({ root, contract, artifacts? })` reads the artifact, then the build-info: on Hardhat 3 the files that the artifact's `buildInfoId` names, `<id>.json` and `<id>.output.json`; on Hardhat 2 the file that the artifact's `.dbg.json` names. It returns the parsed documents and their paths relative to `root`. `verifyInputFromHardhat(options)` passes those documents to `buildVerifyInput` and returns the `compiler` part and the contract name. `contract` is `path:Name` or a bare `Name` that matches one artifact. The package reads files only: it does not compile, load the Hardhat config or need `hardhat` installed. Errors come from the core's catalogue; a missing build-info file throws `incomplete-input` with the file it looked for, relative to `root`. A bare name is searched for without following symlinks. Each file read must be a regular file inside the artifacts folder, at most 256 MiB. A Hardhat 3 input source name such as `project/contracts/Greeter.sol:Greeter` is accepted. `explorer-verify` is a peer dependency, so a project keeps one copy of the core. Node 22.18 and later; Windows is untested.

[#100](https://github.com/aelmanaa/explorer-verify/issues/100)
