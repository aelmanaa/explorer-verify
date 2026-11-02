# 0001: Build a standalone library instead of extending thirdweb or a deploy tool

Status: Accepted (2026-11-02)

## Context

Verification from code exists in deploy tools and in thirdweb's SDK. Read on 2026-11-02:
`forge verify-contract` (Foundry 1.8.1) runs inside Foundry, and
`@nomicfoundation/hardhat-verify` 3.1.4 and `@rocketh/verifier` 0.19.34 run on Node as part of their
deploy tool. thirdweb's `verifyContract` (thirdweb 5.122.1, thirdweb-dev/js commit 940b3745) takes a
`ThirdwebContract`, finds sources through the IPFS metadata hash in the bytecode, and downloads them
through the thirdweb client. It supports Etherscan-style explorers, Blockscout and Routescan. It
submits and returns; the exported `checkVerificationStatus` polls the explorer every 3 seconds.
Caller-supplied compiler input, Sourcify and a server handler would be a new API inside thirdweb's
SDK. See [the landscape research](../research/2026-11-02-landscape.md).

## Decision

Build a focused library: exact verification on every major explorer, from any runtime, with a
self-hosted server handler. Do not contribute the design to thirdweb.

## Consequences

- thirdweb's API stays unchanged; this library owns caller-supplied input, Sourcify and the server
  handler.
- Any dapp, and SDKs with audit or size limits, can depend on a small library.
- The bytecode-metadata approach stays available as one input resolver (R-IN-5).
- The library carries the maintenance: explorer API changes and the routing table.
