---
"explorer-verify": minor
"@explorer-verify/cli": minor
---

Add `submitOverPartial` to `verify()` and `verifyEach()`, and `--submit-over-partial` to the
`verify` command. By default, a partial match of your own source ends the call as
`already-verified` without a submit. With the option, explorer-verify submits your source so the
explorer can replace the partial match with an exact one. An exact match never submits.

- The result follows the explorer: `verified` with the job's match, or `already-verified` with the
  match a lookup reads when the explorer answers that the contract is already verified.
- When the explorer rejects the source, the partial match stays and the result is
  `already-verified` with `partial`, not `failed`. A `warn` line gives the explorer's reason. On
  Etherscan, Routescan and the Etherscan-compatible explorers, a lookup after the rejection that
  finds no match gives `failed`.
- After the submit, a lookup that finds only the partial match does not confirm the job.
- The handle of such a job ends with `:over-partial`, and its object has `overPartial: true`.
  `checkStatus()` and `explorer-verify status` end the job by the same rules. Every other handle
  reads and resumes as before.
- Every Routescan match is `partial`, so on Routescan the option submits over every match, and
  Routescan replaces the source it holds.
- `dryRun()` takes the option and says whether `verify()` would submit over a partial match; the
  CLI's dry-run summary follows `--submit-over-partial`.
- A value that is not a boolean throws `invalid-input`. The CLI refuses `submitOverPartial` in an
  `--input-json` request and names the flag.

On Ethereum Sepolia on 2026-11-11, Sourcify and Blockscout upgraded a partial match to exact after
a submit of the exact source, and Routescan replaced the source it held.
