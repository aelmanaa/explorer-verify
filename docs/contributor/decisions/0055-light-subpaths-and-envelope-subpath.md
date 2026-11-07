# 0055: Small subpaths for handles, errors and backends; the CLI envelope leaves the main entry

Status: Accepted (2026-11-06). Applies the light-name rule that
[decision 0042](0042-every-exported-name-measured-in-real-bundlers.md) left pending, and moves
`toEnvelope`, `exitCodeOf` and `ERROR_EXIT_CODES`, which
[decision 0009](0009-options-handle-and-errors.md) and the machine contract put on the main entry,
to a subpath.

Research: [2026-11-06-subpath-splits.md](../research/2026-11-06-subpath-splits.md) for how viem,
ethers and the AWS SDK split their entry points.

## Context

Issue [#219](https://github.com/aelmanaa/explorer-verify/issues/219). The main entry re-exports
the five flow functions, and `flow/defaults.ts` and `routing/load-table.ts` behind them hold
dynamic `import()`s. esbuild with `splitting: true` makes a chunk for each target before it
tree-shakes, and puts the modules those chunks share with the entry into one shared chunk. Any name
from `explorer-verify` then loads that chunk, even a name that needs none of it. Rollup tree-shakes
per name and is not affected.

The main entry also carried the CLI's machine contract: `toEnvelope`, `exitCodeOf`,
`ERROR_EXIT_CODES`, `Envelope`, `EnvelopeOptions`, `ExitCode` and `VerifyOutcome`. They shake out
of per-name imports, but they add to `import *` and put exit codes in the autocomplete of an
application that only verifies.

## Decision

- Four new subpaths, each a module under `src/entries/` that only re-exports:

  | Subpath                    | Names                                                                                                                 |
  | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
  | `explorer-verify/handle`   | `formatHandle`, `parseHandle`, `tryParseHandle`, `isHandleString`, `Handle`, `HandleString`                           |
  | `explorer-verify/errors`   | `ExplorerVerifyError`, `ERROR_CODES`, `ERROR_HINTS` and the error types, `ErrorJson` and the `details` types included |
  | `explorer-verify/backends` | `BACKEND_NAMES`, `toBackendName`, `BackendName`, `KeyedBackendName`                                                   |
  | `explorer-verify/envelope` | `toEnvelope`, `exitCodeOf`, `ERROR_EXIT_CODES`, `Envelope`, `EnvelopeOptions`, `ExitCode`, `VerifyOutcome`            |

- No module these entries import reaches `flow/verify.ts`, the clients, the routing code, the
  HTTP layer or a dynamic `import()`. A unit test walks their imports and fails otherwise.
- The handle, error and backend names stay on `explorer-verify` too. A caller who imports `verify`
  already loads them, and catching an error next to a `verify()` call should take one import. The
  values are the same objects, so `instanceof` holds across entries.
- The envelope names leave `explorer-verify`. `ERROR_EXIT_CODES` and `ExitCode` move from
  `errors.ts` to `envelope.ts`, so `explorer-verify/errors` holds no exit code. The CLI imports
  them from `explorer-verify/envelope`.
- `VerifyOutcome` is exported from `explorer-verify/envelope` only (maintainer choice).
- `size-budget.json` gains one entry per subpath, `export * from "explorer-verify/<subpath>"`,
  gzipped, at the measured size plus 20% by decision 0014's rule: `handle` 5,975 (ceiling
  7,170), `errors` 5,231 (6,278), `backends` 168 (202) and `envelope` 8,637 (10,365).
- `name-budget.json` lists the four subpaths under `light`: each of their names emits one file
  under esbuild splitting, and `formatHandle`, `ERROR_CODES` and `BACKEND_NAMES` stay under
  1,024 bytes minified in every build. Each name has its row, by decision 0042's rule.
- The browser smoke test runs a name from each subpath in Node and Chromium.
- `explorer-verify/core` re-exports none of these names. Its docs point to the subpaths, which
  reach no dynamic `import()` either.

## Sizes

`scripts/check-names.ts` on 2026-11-06, esbuild 0.28.2 and Rollup 4.67.4, gzip from the zlib of
Node.js 24.21.0. "Before" is main at f3fda61, from `explorer-verify`; "after" is the same name from
its subpath. Minified bytes, then gzipped, then files emitted.

| Name                  | Before, esbuild split    | After, esbuild split | Before, one file | After, one file | Before, Rollup | After, Rollup  |
| --------------------- | ------------------------ | -------------------- | ---------------- | --------------- | -------------- | -------------- |
| `formatHandle`        | 13,884 / 5,355, 21 files | 114 / 115, 1 file    | 222 / 187        | 114 / 115       | 114 / 113      | 114 / 113      |
| `parseHandle`         | 15,955 / 6,408, 21 files | 15,680 / 5,926, 1    | 15,996 / 6,143   | 15,680 / 5,926  | 15,762 / 5,930 | 15,762 / 5,930 |
| `tryParseHandle`      | 15,614 / 6,172, 21 files | 2,072 / 1,017, 1     | 2,223 / 1,104    | 2,072 / 1,017   | 2,092 / 1,020  | 2,092 / 1,020  |
| `isHandleString`      | 15,669 / 6,183, 21 files | 2,127 / 1,023, 1     | 2,278 / 1,112    | 2,127 / 1,023   | 2,147 / 1,027  | 2,147 / 1,027  |
| `ERROR_CODES`         | 14,382 / 5,434, 21 files | 523 / 326, 1         | 628 / 403        | 523 / 326       | 525 / 329      | 525 / 329      |
| `ERROR_HINTS`         | 13,884 / 5,352, 21 files | 3,489 / 1,492, 1     | 3,594 / 1,575    | 3,489 / 1,492   | 3,491 / 1,493  | 3,491 / 1,493  |
| `ExplorerVerifyError` | 13,884 / 5,356, 21 files | 10,082 / 3,856, 1    | 10,331 / 4,021   | 10,082 / 3,856  | 10,140 / 3,849 | 10,140 / 3,849 |
| `BACKEND_NAMES`       | 13,885 / 5,363, 21 files | 130 / 128, 1         | 235 / 202        | 130 / 128       | 132 / 130      | 132 / 130      |
| `toBackendName`       | 13,885 / 5,362, 21 files | 168 / 151, 1         | 273 / 218        | 168 / 151       | 170 / 151      | 170 / 151      |
| `ERROR_EXIT_CODES`    | 14,435 / 5,483, 21 files | 576 / 365, 1         | 681 / 444        | 576 / 365       | 578 / 366      | 578 / 366      |
| `exitCodeOf`          | 24,813 / 8,694, 21 files | 24,501 / 8,131, 1    | 24,835 / 8,343   | 24,501 / 8,131  | 24,642 / 8,142 | 24,642 / 8,130 |
| `toEnvelope`          | 26,286 / 9,207, 21 files | 25,974 / 8,584, 1    | 26,310 / 8,806   | 25,974 / 8,584  | 26,159 / 8,596 | 26,159 / 8,587 |

The names that stay on `explorer-verify` keep their sizes there. Removing the
envelope names took `export * from "explorer-verify"` in `size-budget.json` from 31,073 to 28,056
bytes gzipped.

## Alternatives considered

- Remove the handle, error and backend names from `explorer-verify`. Rejected: a caller of
  `verify()` would need a second import to catch its errors, with no byte saved, since `verify`
  already loads the error class. The subpaths serve the callers who import those names alone.
- Keep the envelope on the main entry and add the subpath beside it. Rejected: the envelope is the
  CLI's contract, and keeping it on the main entry keeps it in every application's autocomplete.
  Before 0.1.0 the move costs one import line.
- Export the light names from `explorer-verify/core`. Rejected: the core's job is the flows with
  passed clients; a separate entry per concern keeps each one-file.

## Consequences

- Four new subpath exports are public API before 0.1.0.
- Code that imported `toEnvelope`, `exitCodeOf`, `ERROR_EXIT_CODES` or the envelope types from
  `explorer-verify` changes its import to `explorer-verify/envelope`. The changeset says so.
- A new name in a light subpath must keep to one file under esbuild splitting, or the size check
  fails.
