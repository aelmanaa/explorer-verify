---
"explorer-verify": patch
"@explorer-verify/cli": patch
---

A new backend, `blockscout-hosted`, verifies through Blockscout's hosted API, `https://api.blockscout.com/<chainId>/api`, for any chain. Name it with `route: { backend: "blockscout-hosted" }` and pass the key as `apiKeys["blockscout-hosted"]`; the key goes only to `api.blockscout.com`, in the `authorization` header as `Bearer <key>`. The routing table never picks it, and `verifyEach()` with `backends: "all"` leaves it out. Its handles start with `ev1:blockscout-hosted:`, so `checkStatus()` resumes on the hosted API. The hosted API's HTTP 401 and 402 answers map to `missing-api-key` or `api-key-rejected`, and its `Network not supported` answer to `unsupported-chain`; the `blockscout` instance client is unchanged. The CLI reads `BLOCKSCOUT_API_KEY` for `--backend blockscout-hosted`. Issue: https://github.com/aelmanaa/explorer-verify/issues/96
