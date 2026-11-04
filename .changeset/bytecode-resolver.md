---
"explorer-verify": patch
---

Add `resolveInputFromBytecode`, exported from the new entry point `explorer-verify/resolve`. It builds the verification input from a deployed contract's bytecode alone. It reads the metadata hash solc appends to the bytecode, passed as `bytecode` (at most 65536 bytes) or read with `eth_getCode` from your `rpcUrl`. It then looks for a verified copy on Sourcify at the same address on any chain, and next, when you pass `ipfsGateway`, fetches the metadata and sources from your IPFS gateway. There is no default gateway, and `sourcify: false` needs one. Metadata is used only when its IPFS hash, computed as solc computes it, equals the one in the bytecode, and each source is checked against its keccak-256 hash. A Sourcify source that fails that check is not used, so the gateway or your `sources` can supply it.

Two error codes are added. `no-metadata-hash` (exit code 2) means the bytecode holds no hash: no code at the address, no CBOR block, or only the compiler version. `metadata-unavailable` (exit code 5, retryable) means the JSON-RPC endpoint gave no bytecode, no source returned matching metadata, or the time budget ran out; `details.attempts` lists each source tried and its outcome. The `MetadataAttempt` type is exported from `explorer-verify`.

[#34](https://github.com/aelmanaa/explorer-verify/issues/34)
