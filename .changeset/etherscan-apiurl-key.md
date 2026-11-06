---
"explorer-verify": patch
"@explorer-verify/cli": patch
---

A `route.apiUrl` on Etherscan's own API now takes `apiKeys["etherscan-v2"]`. Before, `route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" }` threw `missing-api-key` with a message that named `api.etherscan.io` as the only host for the key. The origin is compared after the host is lower-cased and a trailing dot and `:443` are removed, so the key still goes only to `api.etherscan.io`. For an `apiUrl` on any other host, the message now says that `apiKeys.etherscan-v2` goes only to Etherscan's own API and asks for `route.apiKey`. In the CLI, `ETHERSCAN_API_KEY` now goes with `--api-url https://api.etherscan.io/v2/api`. Issue: https://github.com/aelmanaa/explorer-verify/issues/244
