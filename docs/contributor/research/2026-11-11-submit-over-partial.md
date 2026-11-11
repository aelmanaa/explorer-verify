# Submits over a partial match

Date: 2026-11-11. Scope: issue [#294](https://github.com/aelmanaa/explorer-verify/issues/294).
Question: what do Sourcify, Blockscout, Routescan and Etherscan answer when a contract already has a
partial match of its own source and the source is submitted again, exact or partial?

## Method

Five contracts were deployed on Ethereum Sepolia (11155111) on 2026-11-11 between 07:38 and
07:41 UTC, compiled with solc `0.8.30+commit.73712a01`, optimizer on with 200 runs, Foundry 1.8.1.
Each has a constant with a value unique to the probe, so no other project's source matches it.

| Label | Contract    | Address                                      | Used for                                 |
| ----- | ----------- | -------------------------------------------- | ---------------------------------------- |
| S     | `Probe294S` | `0x6c7ff2cf19865fa06523c01bc76dc4c68f16a7b1` | Sourcify                                 |
| B     | `Probe294B` | `0xdce2c184bfa3baecf2fbfc85248563e6b03d5360` | Blockscout                               |
| R     | `Probe294R` | `0xa41f8628a322d5928a145323758b375a0b0ee46a` | Routescan                                |
| E1    | `Probe294E` | `0x42a97fb5d5b652ce47a90ba4930dad1d3f58cdac` | Etherscan, the source of a Similar Match |
| E2    | `Probe294E` | `0xc00d59930cfe782876cb11d671738b2e5885fff0` | Etherscan, the Similar Match             |

The partial source is the same file with one comment line added. It compiles to the same bytecode
except the metadata hash: the last 43 bytes of the runtime code differ. Each step ran `verify()`
from this branch with the `fetch` of Node.js 24.21.0, and a wrapper recorded each request and
answer. The keys were read inside the process; the recordings do not hold them.

## Results

| Explorer   | Step                                           | Answer                                                                                        | `verify()` result                      |
| ---------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------- |
| Sourcify   | Partial source, no match before                | `202`, job with `match`                                                                       | `verified`, `partial`                  |
| Sourcify   | Exact source, no option                        | Lookup `match`, no submit                                                                     | `already-verified`, `partial`          |
| Sourcify   | Partial source again, with the option          | `202`; the job ended with `error.customCode` `already_verified`                               | `already-verified`, `partial`          |
| Sourcify   | Exact source, with the option                  | `202`; the job ended with `exact_match`                                                       | `verified`, `exact`                    |
| Sourcify   | Exact source again, with the option, 8 s later | Lookup still `match`; the submit answered `409` `already_verified`                            | `already-verified`, `exact`            |
| Blockscout | Partial source, no match before                | `Pass - Verified`; lookup `is_partially_verified` `true`                                      | `verified`, `partial`                  |
| Blockscout | Partial source again, with the option          | Accepted, then `Fail - Unable to verify`                                                      | `already-verified`, `partial`          |
| Blockscout | Exact source, with the option                  | Accepted, then `Pass - Verified`; lookup `is_fully_verified` `true`                           | `verified`, `exact`                    |
| Routescan  | Partial source, no match before                | `Pass - Verified`                                                                             | `verified`, `partial`                  |
| Routescan  | Exact source, with the option                  | Accepted, then `Pass - Verified`; `getsourcecode` then returned the exact source              | `verified`, `partial`                  |
| Etherscan  | Exact source on E1, no match before            | Accepted; `Pending in queue` for about 42 minutes, then `Pass - Verified`                     | `not-confirmed` after the 300 s budget |
| Etherscan  | Lookup of E2 after E1 passed                   | `SimilarMatch` `0x42a97fb5…cdac`, `ContractName` `Probe294E`, the same compiler               | (lookup) `partial`, this source        |
| Etherscan  | Exact source on E2, with the option            | Accepted; `Pending in queue` for 6 minutes, then `Already Verified`; `SimilarMatch` unchanged | `already-verified`, `partial`          |

Other observations:

- The Sourcify jobs listed `externalVerifications`: Sourcify forwarded each submit to Etherscan,
  Blockscout and Routescan. The partial source of S reached Etherscan, which then held it with
  `SimilarMatch` empty, so explorer-verify reads it as `exact`. Etherscan's answer does not show
  that the metadata hash differs. The forward of the exact source to Etherscan failed with
  `Daily limit of 500 source code submissions reached`, Sourcify's own limit.
- Sourcify's lookup answers carry `cache-control: public,max-age=3600`. At 08:26 UTC, the lookup
  of S with `fields=compilation` still answered `match` with `age: 2684`, while the same lookup
  without the query answered `exact_match`. A call made within the hour after an upgrade reads
  the earlier grade.
- Routescan's `getsourcecode` answer for an unverified contract now has a `SimilarMatch` field,
  empty. On 2026-11-10 the field was absent
  ([Matches from another contract's source](2026-11-10-foreign-matches.md)).
- Routescan does not grade: after the exact source replaced the partial one, the answer had no
  field to show it, so the result stays `partial`.

## What this means for explorer-verify

- A submit of the exact source over a partial match upgrades it on Sourcify and Blockscout, and
  replaces the stored source on Routescan.
- Etherscan does not replace its Similar Match with a submitted source: the job ended with
  `Already Verified`, and the record still named the other address in `SimilarMatch`.
- A submit that cannot improve the match is refused in three ways: Sourcify's job error
  `already_verified`, Blockscout's `Fail - Unable to verify`, and Etherscan's `Already Verified`.
  Only Blockscout's reads as a rejection of the source, so the flow keeps the partial match from
  the first lookup for it ([decision 0067](../decisions/0067-submit-over-a-partial-match.md)).

## Sources

- Local runs, Node.js 24.21.0 `fetch`, 2026-11-11, 07:41 to 08:33 UTC, against
  `https://sourcify.dev/server`, `https://eth-sepolia.blockscout.com/api`,
  `https://api.routescan.io` and `https://api.etherscan.io`. The reduced recordings are in
  `packages/explorer-verify/test/fixtures/{sourcify,blockscout,etherscan}/2026-11-11-*.json`.
- Local run, curl 8.7.1, 2026-11-11 08:26 UTC: the headers of Sourcify's lookup of S with and
  without `fields=compilation`.
- Sourcify:
  [contract lookup](https://sourcify.dev/server/api-docs/#/Contract%20Lookup/get-contract) (read
  2026-11-11).
