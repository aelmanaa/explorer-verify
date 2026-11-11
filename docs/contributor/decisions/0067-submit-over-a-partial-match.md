# 0067: Submit over a partial match of this source

Status: Accepted (2026-11-11). Extends R-FLOW-1 and R-FLOW-7. Builds on
[decision 0063](0063-submit-over-another-contracts-match.md), whose Consequences name this option
as the way to replace a partial match with the same contract name and compiler version.

Research: [Submits over a partial match](../research/2026-11-11-submit-over-partial.md);
[Matches from another contract's source](../research/2026-11-10-foreign-matches.md).
Evidence: issue [#294](https://github.com/aelmanaa/explorer-verify/issues/294).

## Context

R-FLOW-1 has `verify()` return `already-verified` for a match of this source, partial or exact,
without a submit. Decision 0063 judges "this source" by the stored contract name and compiler
version only, so a partial match of another source with the same name and version also ends the
call. A caller who holds the exact sources cannot replace such a match through explorer-verify.

On Ethereum Sepolia on 2026-11-11, a submit of the exact source over a partial match of the same
source upgraded it to exact on Sourcify and Blockscout, and replaced the stored source on
Routescan. Etherscan kept its Similar Match and answered `Already Verified`. A second submit of the
same partial source ended with Sourcify's job error `already_verified` and with Blockscout's
`Fail - Unable to verify`.

## Decision

1. `VerifyOptions` and `VerifyEachOptions` gain `submitOverPartial?: boolean`, default `false`. It
   is in the strict option keys (decision 0047), so `checkStatus()` and `linkProxy()` accept it at
   run time and ignore it. `DryRunOptions` takes it too (point 7). A value that is not a boolean is
   `invalid-input`.
2. With `true`, a lookup that finds a `partial` match of this source does not end the call:
   `verify()` logs at `info` that it submits over the partial match, and submits. An `exact`
   match still ends the call. A match of another contract's source submits as before, with or
   without the option.
3. The outcome follows the explorer:
   - The job verifies: `verified` with the job's grade.
   - The explorer answers that the contract is already verified, at the submit or from the job:
     `already-verified` with the grade a lookup reads, as for any such answer.
   - The job fails, such as Blockscout's `Fail - Unable to verify`: `already-verified` with the
     first lookup's `partial` match, and a `warn` line with the explorer's reason. The partial match
     is still on the explorer, so `failed` would report a loss that did not happen.
   - Etherscan, Routescan and the Etherscan-compatible explorers look the contract up after
     `Fail - Unable to verify`. When that lookup finds the partial match, the result is
     `already-verified`, `partial`, with the same `warn` line and reason. When it finds no match,
     the newer lookup wins: the result is `failed`, and the `warn` line says the lookup found the
     contract not verified. The client marks that `failed` outcome (`notVerified`), and the other
     outcome carries the reason, so the flow can tell them apart.
4. After the submit, the partial match found first does not show the job's work. A lookup after
   the budget runs out or polls keep failing gives `not-confirmed`, and one after the explorer
   forgets the job gives `job-not-found`, unless it finds an `exact` match; the message says it
   found only the partial match that was there before the submit. The lookup after a submit
   without a clear answer sends the submit again when it finds only that partial match
   (`Context.own`).
5. The handle of such a job carries `overPartial: true`; its one-line form ends with
   `:over-partial`, a sixth part. `checkStatus()` builds its call with the same rules: only an
   `exact` match confirms the job, and a failed job keeps a `partial` match. `parseHandle`,
   `tryParseHandle` and `isHandleString` read the marker; any other sixth part, or an
   `overPartial` that is not `true`, is invalid. Every handle without the marker reads and resumes
   as before. The schemas' handle descriptions name the marker.
6. Every Routescan match is `partial` (decision 0063), so on Routescan the option submits over every
   match, and a forgotten job always ends with `job-not-found`. Its `Pass - Verified` stays
   `partial`. Routescan replaces the source it holds on a resubmit, so a build that differs only in
   its metadata can replace an exact source with a partial one; the option's description says so.
7. `dryRun()` reads the option only for its log line: with it, the line says `verify()` would submit
   over the partial match; without it, that `verify()` would not unless the option is set.
   `DryRunResult` does not change. The CLI's dry-run summary follows `--submit-over-partial` the
   same way.
8. The `verify` command takes `--submit-over-partial`, also with `--input-json`. A
   `submitOverPartial` field in the request is refused with an issue that names the flag. The
   CLI's log lines name the flag where the library's name the option.

## Alternatives considered

- Report the failed job as `failed`. Rejected: the explorer still holds the partial match, and
  without the option the same call returns `already-verified`, `partial`. A caller who sets the
  option to try an upgrade would get exit code 1 for a contract that is still verified.
- Keep the first lookup's match when the Etherscan family's lookup after `Fail` finds nothing.
  Rejected: that lookup is newer, and reporting a partial match it no longer shows would claim a
  verification the explorer does not hold.
- Add a field such as `wouldSubmit` to `DryRunResult`. Rejected for now: `lookup: "partial"`
  without `storedContract` and the caller's own option already say what `verify()` does, and the
  result schema stays as it is.
- Leave the handle as it is and let `checkStatus()` treat every job as a plain submit. Rejected:
  a resumed job would end as `verified`, `partial` from the match that was there before the submit,
  or as `failed` for a contract that still holds its partial match.
- Mark the handle with a new version, `ev2`. Rejected: every reader of 0.x handles would refuse it,
  and the marker is the only change.
- Skip the option on Routescan, whose matches are all `partial`. Rejected: Routescan replaced its
  stored source on a resubmit, so the option is useful there, and the docs say it submits over
  every match.
- Confirm the job with any match after a submit over a partial match. Rejected: the partial match
  was there before the submit, so it would report `verified` for a job that may not have run.

## Consequences

- R-FLOW-1 names the option. R-FLOW-7 says a refused submit over a partial match gives the grade a
  lookup reads, and a rejected one keeps the first lookup's match unless a newer lookup finds none.
- The `verify.lookup` event reports the lookup's grade as before; no event field changes. The
  `verify.submitted` event's handle and an error's handle end with `:over-partial` for such a job.
- A handle with the marker does not resume in a release before this one: its `parseHandle` refuses
  six parts.
- Sourcify caches its lookup answer for up to an hour (`cache-control: public,max-age=3600`). A call
  with the option soon after an upgrade can read the earlier `partial` grade and submit again;
  Sourcify answers `409`, and the result is `already-verified`, `exact`.
- Etherscan does not replace a Similar Match through `verifysourcecode`: the probe's job ended with
  `Already Verified`, and the result is `already-verified`, `partial`.
- `settle()` holds the failed-job rule and `checkStatus()` reads the handle's marker, so the
  `checkStatus()` bundle grows too.
  - Bundle size, measured with `pnpm run size` on 2026-11-11 against `main` at 72de386 (esbuild
    0.28.2, Rollup 4.67.4, Node.js 24.21.0 zlib), in gzip bytes: `verify` grows by 339 (18271 to
    18610), `checkStatus` by 383 (15064 to 15447), `verifyEach` by 336 (20093 to 20429), `linkProxy`
    by 90, `handle` by 137, `errors` by 39, `envelope` by 74, and the Etherscan, Etherscan-compatible
    and Routescan chunks by 16 to 18, for the `notVerified` and `reason` fields of a `Fail` poll.
- Measured again on 2026-11-11 against `main` at 1ef1660, after the `indexWaitMs` change raised
  several ceilings, these rows were over and rise by the
  [decision 0014](0014-measured-bundle-ceilings.md) rule, the measured size plus 20% rounded up:
  the `etherscan` chunk of `size-budget.json` (3948, ceiling 3933 to 4738) and its
  `proxy-blockscout` chunk (4771, ceiling 4769 to 4926), and the esbuild split rows of
  `name-budget.json` (decision 0042) for `checkStatus` (21729, ceiling 26075), `parseHandle`
  (6890, ceiling 8268), `formatHandle` (5774, ceiling 6929), `ExplorerVerifyError` (5776, ceiling
  6932), `BACKEND_NAMES` and `toBackendName` (5783, ceiling 6940).
