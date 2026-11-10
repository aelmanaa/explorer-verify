---
"explorer-verify": patch
"@explorer-verify/cli": patch
"@explorer-verify/foundry": patch
"@explorer-verify/hardhat": patch
---

The READMEs and the Setup sections of the user guides now say how the supported Node.js range
changes: it follows Node's active and maintenance LTS lines, and a line is dropped when it reaches
end of life, in a minor release while the version is 0.x. Node 22 reaches end of life on
2027-04-30. Node 20 is not supported. `engines.node` stays `>=22.18.0`.

Issue: https://github.com/aelmanaa/explorer-verify/issues/291
