# 0069: `--require-own-source` fails a run on another contract's source with exit code 1

Status: Accepted (2026-11-11). Amends R-AX-5 and R-AX-7 for the CLI's `verify` only. Settles
point 9 of [decision 0063](0063-submit-over-another-contracts-match.md).

Research: none (maintainer choice).

The maintainer chose option C of issue
[#351](https://github.com/aelmanaa/explorer-verify/issues/351) on 2026-11-11; exit code 1 follows
from the R-AX-7 table as point 4 argues. Evidence: the recorded answers of issue
[#293](https://github.com/aelmanaa/explorer-verify/issues/293), in which Sourcify, Blockscout and
Routescan held other contracts' sources on Ethereum Sepolia on 2026-11-10.

## Context

When the explorer holds another contract's source at the address, `verify()` returns
`already-verified`, `partial`, with `storedContract` (decision 0063). At `1ef1660`, `exitCodeOf`
maps a result by its `status` alone (`packages/explorer-verify/src/envelope.ts`), so the CLI exits
0 and the envelope says `ok: true`. The caller's source is not on the explorer. A CI step or an
agent that reads only the exit code reports success.

Issue #351 lists four options: a new exit code (A), exit code 1 for everyone (B), an opt-in flag
(C), or documentation only (D). A and B change the meaning of a run that exits 0 today.

## Decision

1. `explorer-verify verify` takes `--require-own-source`, a boolean flag. Without it, nothing
   changes. It may go with `--input-json`, and with a repeated `--backend`.
2. With the flag, a result `already-verified` with `storedContract` exits 1, and the envelope keeps
   the result with `ok: false`. R-AX-5's rule holds: `ok` is true exactly when the exit code is 0.
   stderr gets one `error` line that names the backend and says to check the contract name and the
   compiler version.
3. In a run on several backends, each such outcome gets `ok: false` and counts as exit code 1. The
   run's code follows R-AX-7's order 6, 4, 3, 2, 5, 1, 130, so it becomes 1 when it was 0 or 130,
   and stays as it was otherwise. The other outcomes keep their `ok`.
4. Exit code 1, not a new code. Of the existing codes, 1 is the only one whose action fits: the run
   reached a final answer from the explorer, and neither a retry nor a resume changes it. Exit 2
   says nothing was submitted, but `verify()` submitted. Exit 4 says to run again later. Exit 6
   says the state is unknown, but the explorer named the stored contract. A new code, such as 7,
   would add a row to R-AX-7 that every caller must learn, for a case that only callers who ask
   for it see.
5. The CLI applies the flag to the envelope that `toEnvelope()` returns. `toEnvelope()` and
   `exitCodeOf()` take no new option, so their types and the `explorer-verify/envelope` bundle stay
   as they are. A library caller reads `result.storedContract` directly.
6. `envelope.schema.json` gains one form at the top level and one per outcome: `ok: false` with an
   `already-verified` result that has `storedContract`. Only the CLI with the flag prints them.
   The schema's description now lets a release within `schemaVersion` 1 add forms that only an
   opt-in CLI flag produces; this adds a combination, removes none, and a run without the flag
   never produces it, so the changeset is a patch.
7. `status` does not take the flag. A resumed handle carries no input, so `checkStatus()` never sets
   `storedContract` (decision 0063, point 8).

## Alternatives considered

- A new exit code for the case, with `ok: false` by default (option A). Rejected: breaking, and it
  adds a row to R-AX-7 for every caller.
- Exit code 1 by default (option B). Rejected: breaking, and a caller that did not ask for the
  check would read exit 1 as a rejection of its source.
- Documentation only (option D). Rejected: a caller that reads only the exit code still passes.
- An option on `toEnvelope()` and `exitCodeOf()`. Rejected for now: the `Envelope` type in
  `packages/explorer-verify/src/envelope.ts` at `1ef1660` states `ok: true` for every
  `already-verified` result, so the option would need new overloads and a
  wider `Envelope` type for every TypeScript caller.

## Consequences

- R-AX-5 lists the new form, and R-AX-7's codes 0 and 1 name the flag.
- Exit code 1 now has two meanings under the flag. `result.status` tells them apart: `failed`
  carries `reason`, and `already-verified` carries `storedContract`. The agent skill and the agent
  guide say not to edit the source after the second.
- The CLI's help lists the flag and the two exit code lines name it.
- The core package's code and bundles do not change; only its schema file does.
