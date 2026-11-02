# 0001: Build a standalone library instead of extending thirdweb or a deploy tool

Status: Accepted (2026-11-02)

## Context

Verification from code exists in deploy tools (`forge verify-contract`, `@nomicfoundation/hardhat-verify`,
`@rocketh/verifier`) and in thirdweb's SDK. The tools run on Node inside their own workflow.
thirdweb's `verifyContract` (thirdweb 5.122.1, read on 2026-11-02) takes a `ThirdwebContract`, finds
sources only through the IPFS metadata hash in the bytecode, downloads them through the thirdweb
client, supports Etherscan-style explorers, Blockscout and Routescan but not Sourcify, and has no
polling loop. Its last functional change was in July 2024. Adding caller-supplied compiler
input, Sourcify and a server handler would be a new API inside thirdweb's product, which its
maintainers have not asked for. thirdweb ships 31 runtime dependencies.
See [the landscape research](../research/2026-11-02-landscape.md).

## Decision

Build a focused library: exact verification on every major explorer, from any runtime, with a
self-hosted server handler. Do not contribute the design to thirdweb.

## Consequences

- thirdweb's API stays unchanged; this library owns caller-supplied input, Sourcify and the server
  handler.
- Dapps that do not use thirdweb, and SDKs with audit or size limits, can depend on a small library.
- The bytecode-metadata approach stays available as one input resolver (R-IN-5).
- The library carries the maintenance: explorer API changes and the routing table.
