# no-metadata-hash

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../../llms.txt) lists every page of these docs.

Cause: `resolveInputFromBytecode` read the deployed bytecode, and its end holds no metadata hash,
so the resolver cannot find the metadata. `details.found` says what it found: `no-code` when
nothing is deployed at the address, `no-metadata` when there is no CBOR block (solc's
`appendCBOR: false`, or a compiler other than solc), and `version-only` when the block holds only
the compiler version (solc's `bytecodeHash: "none"`).

Fix: build the input from the contract's build files instead, with `buildVerifyInput`, or with the
Foundry or Hardhat helper. For `no-code`, check the chain ID, the address and the `rpcUrl`.

Default hint: Build the input from the build files with buildVerifyInput instead.

Retryable: no. Nothing was sent to an explorer.

Exit code: 2

[Errors](index.md) describes the fields every error has, key redaction, exit codes and retries.
