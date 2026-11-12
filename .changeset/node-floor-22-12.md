---
"explorer-verify": patch
"@explorer-verify/cli": patch
"@explorer-verify/foundry": patch
"@explorer-verify/hardhat": patch
---

The packages now declare Node.js 22.12.0 or later in `engines.node`, down from 22.18.0. CI installs the packed packages on Node.js 22.12.0 and runs every entry, the build helpers and the `explorer-verify` command there. Before 22.12.0, Node.js prints an experimental warning for the JSON imports the packages use.
