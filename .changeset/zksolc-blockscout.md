---
"explorer-verify": patch
---

Verify zksolc input through the Blockscout instances on ZKsync Era (324) and ZKsync Sepolia (300). Submit both the upstream solc version and the zksolc version. Preserve supplied constructor arguments; refuse unsupported backend and chain pairs before requests. Recorded lookup answers cover both instances. Build helpers still require solc documents.

Issue: https://github.com/aelmanaa/explorer-verify/issues/207
