---
"explorer-verify": minor
"@explorer-verify/cli": minor
---

Breaking: `verify()` now submits when the explorer's match comes from another contract's source,
and Routescan matches are `partial`. Sourcify, Blockscout and Routescan can hold a match for a new
contract within two minutes of its deployment, made from another project's source. Before,
`verify()` returned `already-verified` for it and never sent your source.

The breaking changes:

- `already-verified` can now follow a submit. The lookup reads the contract name and the compiler
  version the explorer stores; when either differs from the input, `verify()` submits. A match of
  your own source still ends the call with no submit.
- A new field, `storedContract: { name?, compilerVersion? }`, on `already-verified` and on
  `dryRun()`, names the other contract when the explorer refuses your source as already verified.
  Its `match` is then `partial`. `storedContract` present means your source is not on the
  explorer, while the exit code stays 0 and `ok` stays `true`: check
  `result.storedContract === undefined` to require your own source.
- Every Routescan match is `partial`, from a lookup or from `Pass - Verified`, where it was
  `exact`: Routescan states no grade. After `Fail - Unable to verify`, a Routescan lookup that
  finds the source now gives `already-verified` with `partial`, where it gave `verified` with
  `exact`.
- The CLI summary and its JSON output show `storedContract`, and the envelope schema lists it.

Also:

- The Sourcify lookup asks for `fields=compilation`.
- The stored name and version are cut to 300 characters, their control characters are replaced
  and your keys are removed from them. The CLI's text log lines show control characters as
  escapes.

[#293](https://github.com/aelmanaa/explorer-verify/issues/293)
