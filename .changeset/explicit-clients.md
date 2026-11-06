---
"explorer-verify": minor
---

New entry `explorer-verify/core`: `verify()`, `dryRun()`, `checkStatus()`, `verifyEach()` and `linkProxy()` that take the explorer clients and the routing table from the caller, with no dynamic `import()` behind them. Create the clients with the factories of `explorer-verify/clients/<name>` (`sourcify`, `etherscan-v2`, `etherscan-compatible`, `routescan`, `blockscout`), import the table from `explorer-verify/table`, then call `verify(input, { clients: [sourcify()], table: routingTable })`. A bundle that does not split code, such as esbuild without `splitting`, Wrangler or a wrapper SDK that bundles its dependencies, then holds only those: `verify` with the Sourcify client and no table measures 65,572 bytes minified as one file, against 112,520 for `verify` from `explorer-verify`. Leave `table` out when every call sets `route.apiUrl`, or names `sourcify`, `etherscan-v2` or `blockscout-hosted` in `route.backend`. A missing client, a missing table and `handlerUrl` without `etherscanV2()` each throw before any request. `explorer-verify` keeps its lazy loaders, and its error for `clients` or `table` points to `explorer-verify/core`. The new [Core entry](https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/core.md) page lists the clients and the errors.

[#220](https://github.com/aelmanaa/explorer-verify/issues/220)
