---
"explorer-verify": patch
---

The package ships a guide to verify a Vyper contract, `docs/guides/verify-a-vyper-contract.md`:
the versions that verify, Sourcify and Etherscan v2 and how routing picks between them, the input
from `vyper -f solc_json`, a Foundry build-info or a Standard JSON input, the match grade per
explorer, and a dry run from Node.js and from the CLI. The skill links it. The npm package guide no
longer says that no backend verifies Vyper, and the Sourcify reference no longer says that only
Sourcify does.
