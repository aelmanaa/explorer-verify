---
"@explorer-verify/hardhat": patch
---

Two hints name each value in words, with the field path only in parentheses. A missing artifacts folder gives "Compile the project first, or pass outDir with the artifacts folder of the Hardhat config (paths.artifacts)." A contract name that matches several artifacts gives "Pass the contract (options.contract) as path:Name, such as contracts/Greeter.sol:Greeter, or as a Name that matches one of the candidates (details.candidates)."

[#326](https://github.com/aelmanaa/explorer-verify/issues/326)
