# 0043: A submitting `verify` needs an explicit target

Status: Accepted (2026-11-05). Changes the CLI's default of R-AX-8 and R-AX-16; the SDK keeps
the routing table's pick (R-RT-1). Answers the risk named in
[decision 0027](0027-etherscan-rows-and-paid-plan-chains.md).

Research: [where `verify` submits without `--backend`](../research/2026-11-05-explicit-verify-target.md),
[the agent evaluation pilot](../research/2026-11-05-agent-evaluation-pilot.md).

## Context

`explorer-verify verify` without `--backend` submitted to the routing table's pick, which depends
on the keys in the environment. A submit publishes source and cannot be undone. In the agent
pilot, an agent asked to verify on Etherscan submitted to Sourcify this way. Decision 0027 names
the key-present side: a free Etherscan key in the environment sends calls to Etherscan.

`--api-url` alone had the same problem: the backend defaulted to `sourcify`, so
`--api-url https://<blockscout>/api` sent Sourcify requests to a Blockscout host
([#225](https://github.com/aelmanaa/explorer-verify/issues/225)).

## Decision

- A submitting `verify` needs `--backend <name>` or `--backend auto`. With `--input-json`,
  `route.backend` does the same, `"auto"` included. `auto` is the routing table's pick.
- Without a target, `verify` exits 2 with `invalid-input` on `--backend` (`route.backend`) before
  any request, whatever the terminal, `CI` or `--json`. The hint lists the backends the chain's
  row lists, says what `auto` would pick and why, such as a backend skipped for lack of a key, and
  suggests `--dry-run`. It never holds a key.
- The CLI builds the hint from `routesFor(chainId, { apiKeys, allowSourcifyFallback })`, a new
  `@experimental` export of the core: it reads the routing table, sends no request, and returns
  the row's backends in order and the table's pick, with the backends skipped and whether the
  pick's key is missing, or the `unsupported-chain` error. If the table cannot be read, the run
  still exits 2, with a hint that names the options only.
- `--api-url` needs `--backend` naming a backend, not `auto`, in a dry run too; `route.apiUrl`
  needs `route.backend`.
- `--allow-sourcify-fallback` is not a target. `auto` with another `--backend`, or with
  `--api-key-file` or `--api-key-stdin`, exits 2: a key needs a named backend (R-AX-9).
- `--dry-run` and `status` need no target. A dry run without `--backend` shows the routing table's
  pick.
- With `auto`, and in a dry run without `--backend`, the `verify.routed` line shows at `info`,
  with how the backend was chosen and which backends were skipped (R-AX-15).
- SDK: `verify()` behaves as before. `verify.routed` gains optional `routedBy` (`caller`, `table`,
  `fallback`, `api-url`) and `skipped`, the passed-over backends joined with `,` so the event stays
  flat (R-DX-6). `DryRunResult` gains `routedBy`. The schemas describe both.

## Alternatives considered

- Keep the table's pick and print it at `info`. Rejected: the line comes after the decision, and
  the pilot's agent did not read stderr before the submit.
- Prompt on a terminal. Rejected: the CLI never prompts (R-AX-6), and agents and CI run without a
  terminal.
- Change `verify()` in the SDK too. Rejected for now: a library call sets `route` in code, where
  the choice is visible, and the change would break every caller.
- Add the row's backends to `verify.routed`. Rejected: `routesFor()` gives them without a call,
  and the event stays as the issue scoped it.
- Build the hint from `dryRun()` runs stopped at `verify.routed`. Rejected in review: it loads
  client code, needs an abort path, and cannot give the row's order.

## Consequences

- Every help, doc and skill example that submits passes `--backend`. The test request
  `verify-input.json` carries `route.backend`.
- The agent evaluation's `no-key` task expects a bare `verify` to exit 2 with zero submits; the
  other submitting tasks pass `--backend auto`.
- A script that ran `verify` without `--backend` now exits 2. It adds `--backend auto` to keep the
  old behaviour.
