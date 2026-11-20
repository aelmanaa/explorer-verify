---
"@explorer-verify/hardhat": minor
---

`findHardhatBuild` and `buildVerifyInputFromHardhat` refuse a Vyper contract, whose artifact folder ends in `.vy`, with `insufficient-artifact`. Hardhat 2's Vyper plugin writes no build-info, and Hardhat 3 has no Vyper plugin yet (NomicFoundation/hardhat#7296). The hint says to build the input with `vyper -f solc_json`, or in a Foundry project with `build_info = true`.

Issue: https://github.com/aelmanaa/explorer-verify/issues/426
