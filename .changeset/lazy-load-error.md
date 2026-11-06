---
"explorer-verify": patch
---

A module that fails to load, such as a client chunk the page cannot fetch, now rejects `verify()`, `dryRun()`, `checkStatus()`, `verifyEach()` and `linkProxy()` with an `ExplorerVerifyError` `network`: retryable, with the loader's error as `cause` and a hint to check the network and the files the site serves. This covers the explorer clients, the routing table, the constructor argument code, the proxy-link code and the `handlerUrl` code. Before, the call rejected with the runtime's own error, such as `TypeError: Failed to fetch dynamically imported module`. No request is sent. `explorer-verify/core` loads no module and does not change. Issue: https://github.com/aelmanaa/explorer-verify/issues/236
