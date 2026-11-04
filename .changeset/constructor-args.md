---
"explorer-verify": patch
"@explorer-verify/cli": patch
---

`verify()` derives missing constructor arguments from the creation code. It does so when `constructorArgs` is absent, the route's backend sends arguments (Etherscan v2, Routescan, Etherscan-compatible, Blockscout) and the input has the new optional `creationBytecode`, the compiler's `evm.bytecode.object`. The creation code comes from the new `rpcUrl` option with `creationTxHash`, for a contract deployed directly, or from Etherscan's `getcontractcreation` when an Etherscan key is bound to the route. The arguments are what follows `creationBytecode` in the creation code; library placeholders are not compared. Arguments you pass always win, and nothing is derived. A call to the CREATE2 deployer is read too: its init code follows a 32-byte salt.

When no arguments are derived, `verify()` logs the reason and submits without them, as before: at `info` when no source is configured, at `warn` when a source gave no usable answer or a factory created the contract.

`buildVerifyInput` fills `creationBytecode` when the documents hold it, and `validateInput` checks it and rejects an empty value. `rpcUrl` follows the `route.apiUrl` rules, and its path segments and query values are removed from logs, events and errors.

A new error code, `constructor-args-unavailable` (exit code 2, not retryable), is thrown before the submit on Etherscan v2, Routescan and Etherscan-compatible explorers when the creation code shows that `creationBytecode` is not the deployed build. `details.reason` is `prefix-mismatch` or `bad-length`. On Blockscout, which reports partial matches, the call goes on without arguments. The CLI's `--input-json` takes `creationBytecode`.

[#64](https://github.com/aelmanaa/explorer-verify/issues/64)
