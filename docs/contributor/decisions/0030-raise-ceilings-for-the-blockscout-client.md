# 0030: Raise the verify and checkStatus ceilings for the Blockscout client

Status: Accepted (2026-11-04). Amends the `verify`, `verify with table` and `checkStatus`
ceilings of [decision 0024](0024-compact-routing-table.md), set by the rule of
[decision 0014](0014-measured-bundle-ceilings.md).

Research: [Blockscout client](../research/2026-11-04-blockscout-client.md).

## Context

Issue [#92](https://github.com/aelmanaa/explorer-verify/issues/92) adds the Blockscout client.
`verify()` and `checkStatus()` import every client, and the size check bundles without code
splitting, so each client adds to both entries. Decision 0024 set the ceilings as the budget for
the Etherscan v2 and Routescan clients. With those two clients, the bytecode resolver (#34),
the Etherscan v2 rows ([decision 0027](0027-etherscan-rows-and-paid-plan-chains.md)) and the
CLI verify command with the core dry run ([decision 0029](0029-dry-run-in-the-core.md)) merged,
main had 568 bytes left on `verify`, 172 on `verify with table` and 652 on `checkStatus`.

The Blockscout client was made smaller before this record. The resubmit wait, the lookup after a
submit without a clear answer, the Standard JSON submit fields, the `result` reader, the
`unexpected-response` error and the contract page moved to `backends/common.ts`, and the Etherscan
and Routescan clients use them too. The client still adds about 940 bytes to `verify`.

## Decision

Raise the three ceilings by decision 0014's rule: the measured size with this change plus 20%,
rounded up. Measured with esbuild 0.28.2 and Node 24.21.0 zlib on 2026-11-04. "Before" is main
at commit 297a5b2; "After" is that commit with #92.

| Entry               | Before (297a5b2) | After  | Old ceiling | New ceiling |
| ------------------- | ---------------- | ------ | ----------- | ----------- |
| `verify`            | 19,627           | 20,567 | 20,195      | 24,681      |
| `verify with table` | 20,725           | 21,718 | 20,897      | 26,062      |
| `checkStatus`       | 17,699           | 18,592 | 18,351      | 22,311      |

The other entries keep their ceilings. `index` grows from 27,871 to 28,803 bytes, under its
ceiling of 28,979 with 176 bytes left. `buildVerifyInput` (11,870), `createVerifyHandler` (12,395),
`resolveInputFromBytecode` (21,124) and the `routing table` (933) change by at most one byte.

This raise is a stopgap. Issue [#136](https://github.com/aelmanaa/explorer-verify/issues/136)
plans to load each explorer client only when a call is routed to it. That brings `verify` and
`checkStatus` back toward the size of one client. When it lands, the size check measures the
entry chunk and each client chunk apart, and a new record sets those ceilings.

## Alternatives considered

- Keep the ceilings and leave Blockscout out of `verify()`. Rejected: R-BE-3 asks for the client,
  and decision 0003 makes keyless backends such as Blockscout the default for browser-direct use.
- Load the client with a dynamic `import()` now. Rejected for this change: `scripts/bundle.ts`
  bundles without code splitting, so esbuild inlines the import and the measured size does not
  change. Measuring chunks apart is the scope of #136.
- Ship Blockscout routing-table rows in the same change. Rejected: the hosts of the five prior-art
  instances were not checked live. They are left to a later change with its own host checks.

## Consequences

- `size-budget.json` records the new ceilings and measured sizes for the three entries.
- The next client, or any code added to `verify`, has about 4 KB of room until #136 changes how
  the clients are measured.
