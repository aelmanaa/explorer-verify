---
"explorer-verify": patch
---

The Routescan client reads the status answer `Error: Compilation successful, but bytecode does not match with deployed bytecode for address …` as `failed`, with that text as the reason. `verify()` and `checkStatus()` used to throw `unknown-state` for it. The match uses the text before the address. Etherscan has not been recorded giving this text, so the Etherscan client still throws `unknown-state` for it. Issue: https://github.com/aelmanaa/explorer-verify/issues/164
