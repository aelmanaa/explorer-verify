# 0066: Wait for the explorer to index a new deployment, and `not-indexed` is new

Status: Accepted (2026-11-10). Extends R-FLOW-7 and adds a row to R-AX-7. Builds on
[decision 0063](0063-submit-over-another-contracts-match.md), whose foreign-match rule it leaves
unchanged.

Research: [Etherscan v2 answers the client maps](../research/2026-11-04-etherscan-client.md#answers),
which records `Unable to locate ContractCode at …` live on 2026-11-02 and 2026-11-04.
Evidence: issue [#297](https://github.com/aelmanaa/explorer-verify/issues/297), filed 2026-11-10.

## Context

Etherscan answers a submit with `Unable to locate ContractCode at …` when it finds no contract code
at the address on that chain. It was recorded on 2026-11-04 for an address with no code on Arbitrum
Sepolia (fixture `2026-11-04-verifysourcecode-no-code.json`). Etherscan also gives it right after a
deployment it has not indexed yet.

The Etherscan client serves Routescan and standalone Etherscan-compatible explorers too. On this
answer it sends the submit again every `pollIntervalMs`. At `af14512` it stopped after 10 submits
(`MAX_NOT_INDEXED_TRIES`): about 27 seconds with the default `pollIntervalMs` of 3000. It then threw
`unexpected-response`, or `timeout` when the next submit would pass the budget.

Issue #297 reports a Remix plugin proof of concept on 2026-11-10: a verify started about 30 seconds
after a Sepolia deployment ended with "Etherscan found no contract code at the address after 3
submits". The issue names three gaps: a caller cannot wait longer without slowing every poll; the
two error codes do not say "not indexed yet", so a caller has to parse the message; and the hint
told an end user to call `verify()` again once the explorer shows the contract.

## Decision

1. `VerifyOptions` and `VerifyEachOptions` gain `indexWaitMs`: how long, from the first submit,
   the client sends the submit again while the explorer finds no contract code at the address.
   Without it the client keeps the cap of 10 submits. With it, the submits have no cap, and the
   loop goes on while a whole `pollIntervalMs` still fits in `indexWaitMs`. No wait is cut short,
   so no two submits go out less than `pollIntervalMs` apart. Either way the loop stops when the
   next submit would pass `timeoutMs`: `indexWaitMs` never extends the budget. The wait and the
   count belong to the call's submit: when a submit gets no clear answer and the client sends it
   again after a lookup, the second try continues the first one's wait and count. It is checked as
   `timeoutMs` is (R-IN-6): a positive number, with `Infinity` lowered to 2147483647, and a key in
   the strict option list. `dryRun()`, `checkStatus()` and `linkProxy()` accept and check it, as they accept every
   `VerifyOptions` key, and do not use it.
2. A new error code, `not-indexed`, ends the loop whatever stopped it: the cap, `indexWaitMs` or the
   budget. Its details are `backend`, `submits` (the answers that found no contract code, not
   HTTP requests) and `elapsedMs` (from the first submit to the last answer). It is retryable and carries no handle,
   since nothing was submitted for verification. Its default hint says to check `chainId` and
   `address`, then call again in a minute or raise `indexWaitMs`; the CLI hint names `--chain` and
   `--address`.
3. `not-indexed` exits 4, "no verdict yet", with `verification-inconclusive`: the explorer gave no
   verdict, and the action is a new `verify()` a little later. Exit 5 would tell an agent that the
   network or the explorer is down.
4. `verify.retry` with `reason` `not-indexed` is unchanged: the same event before each wait, with the
   same fields.
5. The flow passes `indexWaitMs` to the clients in `Context.indexWaitMs`. The shared resubmit loop
   takes an `end` callback that builds the error; the Etherscan-style client passes one that builds
   `not-indexed`, so the Blockscout client and its empty-submit loop keep `timeout` and
   `unexpected-response`.

## Alternatives considered

- Raise the default cap. Rejected: every caller would wait longer before a wrong chain ID or
  address fails, and the cap would still be fixed.
- Keep `timeout` and `unexpected-response` and add a reason field to their details. Rejected: a
  caller would branch on a field inside two codes, and the hint would stay one for every cause.
- Exit 5 for `not-indexed`. Rejected for the reason in point 3. Before this decision the case
  exited 5, so the change moves it from 5 to 4.
- Cut the last wait to what is left of `indexWaitMs`. Rejected: with `indexWaitMs: 1` it sent two
  submits 1 ms apart.
- Map the server handler's 503 `address-not-indexed`, sent when its `deployers` option is set, to
  `not-indexed`. Left for a later change: the handler refuses at the lookup, before any submit,
  so `indexWaitMs` has no effect there and the call ends with `unexpected-response`.
- Check for code with `eth_getCode` before the submit. Rejected (issue non-goal): the RPC node can
  have the code before the explorer has indexed it.
- A CLI flag for `indexWaitMs`. Left out of this change; the issue's scope is the library options.
  The CLI keeps the cap of 10 submits within `--timeout`.

## Consequences

- R-FLOW-7 lists the answer and the wait; R-AX-7 lists `not-indexed` under exit code 4.
- A caller that matched `timeout` or `unexpected-response` for this answer now gets `not-indexed`.
  The changeset says so.
- The CLI adds the code to its exit code 4 help line and gives it a hint.
- Bundle size, measured with `pnpm run size` on 2026-11-11 against `23a2cd0`, the head of
  [#327](https://github.com/aelmanaa/explorer-verify/pull/327) on `main` (esbuild 0.28.2, Rollup
  4.67.4, Node.js 24.21.0 zlib): `verify` grows by 130 bytes (18271 to 18401), `checkStatus` by
  134 and `index` by 131. The new code adds about 90 bytes to every bundle that holds the error
  class: its details, its default hint and its end-user hint. The client chunks grow by 34 to 50
  bytes for the shared resubmit loop and, in the Etherscan-style chunks, the wait and the `end`
  callback. The loop builds no `not-indexed` error itself, so the Blockscout chunks hold none of
  that error's code. The log line before each new submit no longer names the most submits: the
  event's `attempt` field carries the count, and the end-user hint for older JSON reuses the new
  code's entry.
- Four entries of `size-budget.json` passed their ceilings after those cuts and rise by the
  [decision 0014](0014-measured-bundle-ceilings.md) rule, the measured size plus 20% rounded up:
  `index` 31516 bytes (ceiling 31510, now 37820), `createVerifyHandler` 14491 (14429, now 17390),
  the routescan chunk 4042 (4032, now 4851) and the etherscan-compatible chunk 3979 (3942, now
  4775). The etherscan and proxy-blockscout chunks stay under their ceilings: 3926 against 3933,
  and 4769 against 4769.
- Six rows of `name-budget.json` (decision 0042) rise by the same rule, in gzip bytes: from
  `explorer-verify`, `checkStatus` as one esbuild file 30491 (ceiling 30374, now 36590), `verifyEach`
  as one esbuild file 36927 (36755, now 44313), `verifyEach` split 26065 (26039, now 31278),
  `linkProxy` split 20219 (20148, now 24263), `verify` under Rollup 21923 (21870, now 26308) and
  `dryRun` under Rollup 20140 (20050, now 24168). This change adds 125 to 183 bytes to each.
