# 0004: Solidity first; the compiler is a discriminated union

Status: Accepted (2026-11-02)

## Context

Every target explorer verifies Solidity from Standard JSON input. Vyper support differs per
explorer, and zkSync uses its own compiler. The maintainer wants to start with Solidity and add
others later without breaking callers.

## Decision

`VerifyInput.compiler` is a discriminated union keyed by `kind`. 1.0 ships `{ kind: "solc" }`.
Each backend maps the kinds it supports and rejects the others with a typed error.

## Consequences

- Adding Vyper is a new union member plus backend mappings; Solidity callers do not change.
- Backend code must switch on `kind` exhaustively (lint: `switch-exhaustiveness-check`).
