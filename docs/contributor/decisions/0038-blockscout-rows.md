# 0038: Blockscout entries for the instances that answer, after Sourcify, and raised ceilings

Status: Accepted (2026-11-05). Amends the row rule of
[decision 0036](0036-a-sourcify-row-for-every-sourcify-chain.md), and the `routing table` and
`verify with table` ceilings of decisions 0036 and
[0024](0024-compact-routing-table.md). Composes with the Routescan entries of
[decision 0037](0037-routescan-rows-from-an-api-probe.md).

Research: [the Blockscout instances that answer the API](../research/2026-11-05-blockscout-instances.md),
[the Blockscout client](../research/2026-11-04-blockscout-client.md).

## Context

The Blockscout client (R-BE-3) has no rows: a call reaches an instance only with `route.apiUrl`.
Hardhat's verify plugin verifies on Blockscout by default on each chain whose Blockscout explorer
it knows, from its chain descriptors or from Blockscout's chain registry. Issue
[#169](https://github.com/aelmanaa/explorer-verify/issues/169) lists 47 instances that answered
the API on 2026-11-05.

The probe of the research note sent two keyless requests to each of 125 candidate instances: the
112 registry explorers hosted by Blockscout, 7 Hardhat explorers on other chains, and the 6
self-hosted explorers #169 names. 111 answered, the 47 of #169 among them.

## Decision

### Entries

- A chain gets a `blockscout` entry when its instance answered both probe requests directly, with
  no redirect. The entry's `instance` is the host that answered. A registry or Hardhat host that
  redirects is replaced by the target host when that host answers: OP Mainnet (10) lists
  `explorer.optimism.io`, Gnosis (100) `gnosisscan.io`, OP Sepolia (11155420)
  `testnet-explorer.optimism.io`.
- The candidates are the registry explorers whose `hostedBy` is `blockscout`, the Blockscout
  explorers of Hardhat's chain descriptors, and self-hosted registry explorers a probe has
  checked. A self-hosted explorer joins only through an issue that probes it.
- An instance that sends a bot-check page gets no entry. The probe does not try to get past one.
  On 2026-11-05 that left out 8 instances, Polygon PoS (137), Base (8453) and Arbitrum One (42161)
  among them.
- A chain with no other row gets a row with `blockscout` alone: 11 chains on 2026-11-05. With the
  Routescan rows of decision 0037, the table has 325 rows and 111 Blockscout entries.
- The probe's answers are committed as
  `docs/contributor/research/data/2026-11-05-blockscout-instances.json`. `withBlockscout()` in
  `scripts/routing-blockscout.ts` adds the entries to the rows `tableOf()` builds, before
  `withRoutescan()` adds the Routescan entries, and `node scripts/compare-routing-table.ts --rows`
  prints the result.
- The weekly comparison does not probe instances. It compares the table with the probe data, and
  the probe data with Blockscout's live chain registry: a registry chain hosted by Blockscout that
  the probe did not check, a registry host that moved, and a registry candidate that left the
  registry each show as a difference of the `Blockscout chain registry`, which asks for a new
  probe.

### Order

A row lists its backends in this order, each only when it serves the chain:

1. `etherscan-v2` on a free-tier chain (decision 0027)
2. `sourcify` (decision 0036)
3. `blockscout` (this decision)
4. `etherscan-v2` on a paid-plan chain (decision 0027)
5. `routescan` (decision 0037)

So `blockscout` comes right after `sourcify`. In a row without `sourcify`, it comes after a
free-tier `etherscan-v2` entry, and before a paid-plan one and before `routescan`.

- A call without `route.backend` goes where it went before this change, on every chain that had a
  Sourcify or Etherscan v2 entry. Blockscout is a choice the caller makes with `route.backend` or
  `--backend blockscout`.
- Sourcify answers for 288 chains from one server, which the client's mappings were recorded on.
  The 111 instances run 13 backend versions, from v0.1.0 to v12.0.4; the Blockscout client's
  mappings were recorded on v12.0.4 only.
- An instance's `/api` allowed 10 requests in about 22 minutes on 2026-11-04
  ([client note](../research/2026-11-04-blockscout-client.md)). Sourcify has no such limit on
  record.
- Before a paid-plan `etherscan-v2` entry, for the reason of
  [decision 0027](0027-etherscan-rows-and-paid-plan-chains.md): a free-plan key must not turn a
  call that a keyless backend serves into an Etherscan refusal.
- Before `routescan`, because decision 0037 puts Routescan last in every row. On Numine (8021),
  whose row lists both and no other backend, a call without `route.backend` now goes to
  Blockscout, where it went to Routescan before.

### Size ceilings

Measured with `pnpm run size` (esbuild 0.28.2, Node.js 24.21.0 zlib) on 2026-11-05: "Before" is
main at commit c2142eb, with the Routescan rows of decision 0037, and "After" is that commit with
this change.

| Entry               | Before (c2142eb) | After  | Old ceiling | New ceiling |
| ------------------- | ---------------- | ------ | ----------- | ----------- |
| `routing table`     | 1,912            | 2,971  | 1,995       | 3,566       |
| `verify with table` | 16,867           | 18,208 | 17,632      | 21,850      |

Both ceilings are reset by decision 0014's rule, the measured size plus 20% rounded up. The code
entries measure an empty table and do not change.

## Alternatives considered

- Blockscout before Sourcify. Rejected: it changes where a keyless call goes on 99 chains, sends
  it to instances whose versions the client was not tested on, and to an API with a low request
  limit.
- A compact encoding: leave `.blockscout.com` out of the 42 hosts that end in it, or write an
  entry as `{"blockscout":"<host>"}`. Measured in the research note on the table before the
  Routescan rows: the table falls from 2,767 to 2,752 or 2,706 bytes gzipped, against the 1,100
  bytes the entries add. The hosts differ per instance, and gzip already removes the repeated
  keys. Rejected: it saves at most 61 bytes and needs a second reader in the resolver and the
  table checks.
- Load the table as a separate entry point, as decision 0024 names for a crossed
  `verify with table` ceiling. Rejected for this change: it changes how every call reads the
  table. [#192](https://github.com/aelmanaa/explorer-verify/issues/192) weighs it.
- Every registry explorer, whatever hosts it: 645 candidates. Rejected: most are self-hosted,
  on versions the client was not tested on, and their entries would add several kilobytes.
- Leave out the 6 self-hosted instances of #169. Rejected: each answered both requests, and #169
  asks for them.
- Probe every instance in the weekly comparison. Rejected: 250 requests to 125 hosts a week, some
  behind a bot check. The registry comparison says when a probe is due.

## Consequences

- R-RT-1 states the Blockscout rule, the order and the counts.
- `route: { backend: "blockscout" }` reaches the 111 instances without `route.apiUrl`, and their
  results carry `https://<instance>/address/<address>?tab=contract`.
- `verifyEach()` with `backends: "all"` takes every backend a row lists, so on these 111 chains it
  now verifies on Blockscout too.
- On the 11 chains with `blockscout` alone, a call goes to Blockscout by default; before, it threw
  `unsupported-chain`. On Numine (8021) it goes to Blockscout instead of Routescan.
- A new or moved instance needs a new probe and a pull request that regenerates the table with
  `--rows`.
- The `routing table` entry has 595 bytes left under its new ceiling.
