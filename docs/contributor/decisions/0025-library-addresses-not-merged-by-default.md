# 0025: Library addresses are not merged into the input by default

Status: Accepted (2026-11-04).

## Context

Issue [#65](https://github.com/aelmanaa/explorer-verify/issues/65) adds library link addresses to
`VerifyInput` (R-IN-4). Its scope item 3 proposed adding them to `settings.libraries` of the
compiler input before every submit, as one widely used Hardhat plugin does for Etherscan and
Blockscout.

Foundry and Hardhat compile a contract without the addresses and link it afterwards. Solidity's
metadata includes `settings.libraries`, so the addresses are part of the metadata hash.

[Live probe E](../research/2026-11-03-m2-live-probes.md#e-a-contract-linked-to-an-external-library)
tested this on Arbitrum Sepolia on 2026-11-03, with solc 0.8.24 and two contracts linked after
compiling. One was submitted with the address in `settings.libraries` and one without:

- Etherscan gave an exact match for both, and found the library address itself.
- Sourcify gave `exact_match` without the addresses and only `match` (partial) with them. The
  input with the addresses compiled to a different metadata hash than the deployed code.

## Decision

- `VerifyInput.libraries` holds the addresses, keyed by `path:Name`. `validateInput` checks them
  and rejects one that conflicts with an entry `settings.libraries` already holds for the same
  library.
- `verify()` sends `compiler.input` unchanged. It never adds the addresses.
- `linkLibraries(input)` merges the addresses into `settings.libraries` when the caller asks, for
  an explorer that needs them in the input. Before it merges, it also rejects a different value
  for the same library under the empty path, which solc applies to every file. `validateInput`
  leaves that check out, since `verify()` does not merge: it keeps the `verify` bundle under its
  size ceiling.

## Alternatives considered

- Merge before every submit, as scope item 3 proposed. Rejected: in probe E, Sourcify gave a
  partial match instead of an exact one, and Etherscan did not need the addresses.
- Merge only for some backends. Rejected for now: no backend tested needed the addresses, and this
  release has no Etherscan-family client yet. A backend that turns out to need them can call
  `linkLibraries` itself in a later change.
- Accept no `libraries` field and leave linking to the caller. Rejected: R-IN-4 asks for the
  addresses, and a field lets `validateInput` catch a wrong address before any request.

## Consequences

- A contract linked after compiling keeps its exact match on Sourcify.
- Passing `libraries` alone does not change what `verify()` sends. The reference page and the
  TSDoc say so, and point to `linkLibraries`.
- Probe E did not test a contract compiled with `settings.libraries` already set. Its input
  already holds the addresses, so it is submitted as it is.
