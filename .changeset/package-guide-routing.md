---
"explorer-verify": patch
---

The guide "Verify contracts your package ships" now describes the routing table as it is: a
call goes to the first backend in the chain's row that works with the keys passed, so a key in
`apiKeys["etherscan-v2"]` sends a Sepolia call to Etherscan. The guide no longer says the table
has no Etherscan rows. Its new backend example runs in the docs tests against a recorded
Etherscan answer.

Issue: https://github.com/aelmanaa/explorer-verify/issues/285
