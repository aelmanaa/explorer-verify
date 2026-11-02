# 0003: Etherscan keys stay on the operator's server

Status: Accepted (2026-11-02)

## Context

Etherscan's API terms (last updated 2026-10-01) forbid sharing or exposing an API key, "including by
embedding them in publicly accessible code or client-side applications", and forbid operating "an
API proxy, gateway, relay or data feed that passes API Data through to third parties". The Free,
Lite and Standard plans are for personal and research use only; an application offered to third
parties, or run by or for a business, protocol, foundation or DAO, needs an Advanced or higher
plan. See [the terms research](../research/2026-11-02-etherscan-terms.md).

## Decision

- The library never sends an Etherscan key from a browser in its documented setups.
- It ships `createVerifyHandler` for the dapp operator to run on their own server with their own
  key. The handler forwards only verify-submit and status calls.
- The project never runs a hosted, shared verification relay.
- Keyless backends (Sourcify, per-instance Blockscout) are the default for browser-direct use.

## Consequences

- User docs state the plan requirement and the "Powered by Etherscan.io APIs" attribution rule.
- Whether a narrow verify-only handler counts as a "proxy" under the terms is a reading, not legal
  advice; the docs say so and point operators to Etherscan.
- Blockscout's hosted multichain API takes a key too; its terms are an open question for M3.
