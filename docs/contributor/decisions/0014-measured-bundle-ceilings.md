# 0014: Measured bundle ceilings for every public entry

Status: Accepted (2026-11-03). Amends the bundle budget of
[decision 0008](0008-package-split-and-bundle-budget.md).

Research: none (maintainer choice).

## Context

Decision 0008 set a provisional ceiling of 10,000 bytes for `import { verify } from
"explorer-verify"`, minified and gzipped, before any client code existed. It said the browser
smoke test ([#19](https://github.com/aelmanaa/explorer-verify/issues/19)) replaces it with the
measured size plus 20%.

The bundle has now been measured: `verify` alone is 14,402 bytes, 44% above the estimate. The
largest parts are the HTTP layer, the flow engine, the error catalogue with its hints, the Sourcify
client and input validation. The bundle holds no input builder and no Keccak code, so R-RUN-5
holds; the estimate was low. `checkStatus` (#18) and `buildVerifyInput` are public entries too, and
decision 0008 measured neither.

Measured on 2026-11-03 with esbuild 0.28.2 (`platform: "browser"`, ESM, minified) and gzip at the
default level (Node 24.21.0 zlib):

| Entry                                  | Measured (bytes) | Ceiling (bytes) |
| -------------------------------------- | ---------------- | --------------- |
| `export { verify } from "…"`           | 14,402           | 17,283          |
| `export { checkStatus } from "…"`      | 13,038           | 15,646          |
| `export { buildVerifyInput } from "…"` | 11,091           | 13,310          |
| `export * from "explorer-verify"`      | 21,802           | 26,163          |

## Decision

- The 10,000-byte ceiling is dropped. Each ceiling is the measured size plus 20%, rounded up, as
  decision 0008 set out.
- `size-budget.json` lists four entries: `verify`, `checkStatus`, `buildVerifyInput` and the
  whole index. Each has its own ceiling. A change that pulls the input builder into `verify`, or
  the flow into `buildVerifyInput`, fails its entry even when the index stays under its ceiling.
- `pnpm run size` measures every entry and fails above a ceiling. The CI package job runs it, so a
  pull request that grows an entry past its ceiling fails a required check.
- The rest of decision 0008 stands: zero runtime dependencies, vendored code counts, growth past a
  ceiling needs a pull request that raises it and says why.

## Alternatives considered

- Keep 10,000 bytes for `verify` and shrink the code to fit. Rejected for now: it means cutting
  the error hints, validation messages or redaction, which other requirements ask for (R-AX-10,
  R-IN-6, R-SEC-1). A later pull request can lower a ceiling after it shrinks an entry.
- Measure `verify` only, as decision 0008 did. Rejected: `buildVerifyInput` is the entry a
  browser build tool imports, and `checkStatus` is the entry a page imports after a reload.
- Headroom below 20%. Rejected: 20% is what decision 0008 and #19 set, and the M2 backends will
  add to `verify` and `checkStatus` before the next measurement.

## Consequences

- R-RUN-3 is unchanged: it points at `size-budget.json` for the ceiling.
- The M2 clients (Etherscan, Blockscout, Routescan) will grow `verify` and `checkStatus`. Each
  one that crosses a ceiling raises it in its own pull request, with the measured size.
- Sizes depend on the esbuild version. A Dependabot update of esbuild that moves an entry over its
  ceiling fails CI, and the pull request records the new measurement.
