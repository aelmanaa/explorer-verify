# 0037: Routescan entries from a probe of its API, last in each row

Status: Accepted (2026-11-05). Amends the row rule of
[decision 0036](0036-a-sourcify-row-for-every-sourcify-chain.md).

Research: [the chains Routescan's API serves](../research/2026-11-05-routescan-rows.md),
[the Routescan client](../research/2026-11-04-routescan-client.md).

## Context

The Routescan client (R-BE-5) had no rows, so every Routescan call needed `route.apiUrl`, and a key
in `apiKeys.routescan` was never sent. On 68414 (Henesys) Routescan is the only API the table
knows, so that chain had no row at all.

Routescan's explorer lists name 45 chains. A keyless probe on 2026-11-05 found that its API serves
38 of them and answers `chain not supported` for the other 7, so the lists alone would give wrong
rows. No machine-readable list of the API's chains was found.

## Decision

### Rows

- A chain also gets a row when Routescan's API served it in the probe recorded in
  `docs/contributor/research/data/2026-11-05-routescan-chains.json`. The
  row has a `routescan` entry with the network the probe used.
- The `routescan` entry comes last, after `sourcify` and `etherscan-v2` in the order decisions 0027
  and 0036 set. A chain with neither has a row with `routescan` alone.
- On 2026-11-05 that adds 38 entries: 12 to existing rows and 26 new rows. The table has 314 rows.
- `withRoutescan()` in `scripts/routing-routescan.ts` adds the entries, and
  `node scripts/compare-routing-table.ts --rows` prints the table with them. The rows of this change
  come from that command, not from hand edits.

### How a call is routed

The resolver's rule does not change: a call goes to the first backend in the row that works with
the caller's keys. Routescan needs no key, so:

- with no key, a call goes to Sourcify where the row has it, and to Routescan on a Routescan-only
  row such as 68414;
- with an Etherscan key, a call goes to Etherscan v2 where the row lists it first;
- `apiKeys.routescan` does not move a call to Routescan. `route: { backend: "routescan" }` picks it
  without `route.apiUrl`, and the key then goes to `api.routescan.io` (decision 0016).

### Keeping the entries current

The weekly comparison reads Routescan's two explorer lists. It reports a chain the probe has not
checked, a chain whose list changed network, a served chain that left its list, and a table entry
that differs from the probe data, each with the list `Routescan chain list`. It does not probe the
API itself, which takes one request per chain at 2 requests a second.
`node scripts/compare-routing-table.ts --probe-routescan` runs the probe and prints a new data
file for a pull request.

## Alternatives considered

- Routescan first, or before Sourcify. Rejected: Routescan forgets a job about 51 minutes after its
  submit, its lookup never reports a partial match, and Foundry and Hardhat send these chains to
  Sourcify or Etherscan by default. Putting Routescan last keeps every chain that resolved before
  this change on the same backend.
- Take the rows from Routescan's explorer lists. Rejected: 7 of the 45 chains they name answered
  `chain not supported`, including 10 (OP Mainnet) and 11155420 (OP Sepolia).
- Probe the API in the weekly comparison. Rejected for now: 45 requests at the keyless rate add
  about 30 seconds and depend on Routescan's answer to a made-up job id. The list comparison flags
  the chains that need a new probe.
- Send a caller with `apiKeys.routescan` to Routescan before Sourcify. Rejected: the key is
  optional, and a key passed for another chain would change where this chain's call goes.

## Consequences

- R-RT-1 states the Routescan rule and the count.
- `route: { backend: "routescan" }` works without `apiUrl` on the 38 chains, and a result there has
  no `explorerUrl`, as before.
- The `routing table` entry has 83 bytes left under its ceiling of 1,995 bytes; `verify with table`
  has 764 bytes left. Further rows, such as Blockscout's, may need a new ceiling.
