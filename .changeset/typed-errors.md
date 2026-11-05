---
"explorer-verify": minor
"@explorer-verify/cli": patch
"@explorer-verify/hardhat": patch
"@explorer-verify/foundry": patch
---

Breaking: `ExplorerVerifyError` is generic over its code, and checking `error.code` narrows
`error.details`. `ExplorerVerifyError.is(error, "not-confirmed")` checks the error and its code in
one call. It and `instanceof` also recognise an error built by another installed copy of
explorer-verify. New exports: `ERROR_HINTS`, the default hint of each code, and the types
`DetailsOf`, `DetailsByCode` and `AnyExplorerVerifyError`.

The breaking changes:

- An error built with `new ExplorerVerifyError(...)` and no `hint` now has a hint that points to
  its docs page. Pass `hint: ERROR_HINTS[code]` for the code's default hint. Errors the library
  throws keep their hints.
- `details.field` of `incomplete-input` and `insufficient-artifact` has a literal type, and the `source-mismatch` hashes are `Hex`.
- `VerifyOutcome`, `BackendOutcome` and `VerifyEachResult` hold `AnyExplorerVerifyError`, so an
  outcome's error narrows by code. A value typed as the plain `ExplorerVerifyError` no longer fits
  a `VerifyOutcome`; `toEnvelope` and `exitCodeOf` still take it.
- `details.backend` no longer reads `"unknown"`; a name outside `BACKEND_NAMES`, which only code
  that bypasses the types can pass, reads `etherscan-compatible`, as in a handle.

Importing only `ExplorerVerifyError` costs about 2.8 KB less minified, because the hint text moved
out of the class. The CLI, Hardhat and Foundry helpers pass the default hints themselves.

Issue: https://github.com/aelmanaa/explorer-verify/issues/213
