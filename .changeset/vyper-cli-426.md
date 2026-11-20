---
"@explorer-verify/cli": minor
---

`explorer-verify verify --foundry . --contract src/Counter.vy:Counter` verifies a Vyper contract from a Foundry project built with `build_info = true` or `forge build --build-info`, on Sourcify or Etherscan v2. Without a build-info that lists the contract, it exits 2 with `insufficient-artifact`, and the hint says to run `forge build --build-info`. `--hardhat` refuses a Vyper contract with `insufficient-artifact`. The help of `--compiler-version` now says it takes the full solc or Vyper version.

Issue: https://github.com/aelmanaa/explorer-verify/issues/426
