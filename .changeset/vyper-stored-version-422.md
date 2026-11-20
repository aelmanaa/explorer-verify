---
"explorer-verify": patch
---

For Vyper input, the check of the contract an explorer already holds drops a leading `vyper:` from the stored compiler version, in any case, before it compares the version: Etherscan stores `vyper:0.4.3`. A Vyper contract that Etherscan verified from this source now reads as this source, not as another contract's. Vyper input also keeps its `interfaces` in the Standard JSON input that a client builds; each explorer that maps Vyper sends them as it takes them.

Issues: https://github.com/aelmanaa/explorer-verify/issues/421, https://github.com/aelmanaa/explorer-verify/issues/422
