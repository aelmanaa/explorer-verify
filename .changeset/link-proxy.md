---
"explorer-verify": patch
"@explorer-verify/cli": patch
---

Add `linkProxy(target, options?)`, which links a verified proxy to its implementation so the explorer shows the implementation's functions on the proxy's page. `target` holds `chainId`, `address` and an optional `expectedImplementation`; `options` are those of `verify()`. Run it after you verify the implementation and the proxy: it verifies nothing itself.

It returns `linked`, with the implementation the explorer reports and `implementationVerified`; `mismatch`, with the implementation the explorer holds and `expectedImplementation`, when they differ; or `not-linked`, with the explorer's reason, when the explorer refuses because the proxy is not verified there or no implementation is detected. On Etherscan v2 and standalone Etherscan-compatible explorers it sends `verifyproxycontract` and checks `checkproxyverification`; on Blockscout it does the same, then looks the implementation up, and after Blockscout's `Only one attempt in <n>ms` it waits once, or reads the implementation Blockscout holds; on Sourcify it reads `proxyResolution` and sends no request that changes anything. Routescan throws `invalid-input`.

Each explorer's proxy-link code loads only when `linkProxy()` is routed to it, so `import { verify }` does not bundle it. Two error codes are added, neither with a handle: `proxy-link-unknown-state` (exit code 6, not retryable) for a link state the library cannot classify, including an implementation that is not exactly one address; and `proxy-link-pending` (exit code 4, retryable) for a link still pending at the time budget. The CLI's help lists both under their exit codes.

The server handler forwards `verifyproxycontract` and `checkproxyverification` only with the new option `allowProxyLink: true`; it is off by default. With `deployers` set, the deployer check runs on the proxy. Its reduced `getsourcecode` answer now also keeps `Implementation` when it is an address, which `linkProxy()` reads after a mismatch.

[#94](https://github.com/aelmanaa/explorer-verify/issues/94)
