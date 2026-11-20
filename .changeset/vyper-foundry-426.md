---
"@explorer-verify/foundry": minor
---

`findFoundryBuild` and `buildVerifyInputFromFoundry` find the build-info of a Vyper contract, such as `src/Counter.vy:Counter`. A Vyper artifact holds no metadata, so the helper takes the first build-info that lists the contract's name with the artifact's creation bytecode, and returns the contract as `path:Name`. When no build-info lists a Vyper contract, both functions throw `insufficient-artifact`, and the hint says to run `forge build --build-info`. They never rebuild a Vyper input from the source files.

For an artifact without metadata, the helper takes a build-info entry under the source path given in `contract` first, then one under a path that ends with it, such as `src/Greeter.sol` for `Greeter.sol:Greeter`. When only other paths list the contract, it throws `invalid-input` that names them. `contract` is then the `path:Name` that the build-info gives, not the bare name.

Fix: a build-info entry whose creation bytecode differs from the artifact's is now skipped, so a build-info from another build is not taken. Two artifacts without metadata that match one contract now get a hint to pass `artifact`.

What should I do? Nothing for Solidity artifacts with metadata: they give the same results as before. Code that compared `contract` with a bare name for an artifact without metadata now gets `path:Name`.

Issue: https://github.com/aelmanaa/explorer-verify/issues/426
