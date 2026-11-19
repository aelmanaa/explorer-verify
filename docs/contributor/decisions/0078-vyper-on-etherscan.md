# 0078: Vyper on Etherscan v2 and through the server handler

Status: Accepted (2026-11-19). Extends [decision 0075](0075-vyper-compiler-kind.md) point 8 and
[decision 0077](0077-vyper-on-sourcify.md). Answers open question 16 of the
[research note](../research/2026-11-15-vyper-support.md#open-questions) and part of question 6:
whether Etherscan needs `optimizationUsed` for Vyper. The prerelease spelling stays open.

Research: [Vyper support on each explorer](../research/2026-11-15-vyper-support.md#etherscan-v2),
with its 2026-11-19 addendum, and the live run recorded below.

## Context

Issue [#424](https://github.com/aelmanaa/explorer-verify/issues/424). Decision 0075 added
`kind: "vyper"`, and decision 0077 mapped it on Sourcify. Etherscan v2 verifies Vyper through the
`verifysourcecode` action the client already sends, with `codeformat=vyper-json` and
`compilerversion=vyper:<x.y.z>`. The server handler refused `vyper:0.4.3` with its version pattern.

The issue asked to probe first whether a submit without `optimizationUsed` verifies. On
2026-11-19, on Ethereum Sepolia, it did not: Etherscan answered the submit, before any job, with
`{"status":"0","message":"NOTOK","result":"Missing OptimizationUsed"}`. It gave the same answer to a
submit with the long version form and no `optimizationUsed`; with `optimizationUsed` set, the long
form got `Invalid compiler version`.

## Decision

1. `VYPER_ROUTES` is `[["sourcify", "every"], ["etherscan-v2", "every"]]`, in the
   `"every"` form of decision 0077. The order does not choose the route: the routing table does, as
   for solc, from the chain's row order and the keys set. Etherscan v2 comes first on rows such as
   Ethereum and Sepolia, so with an Etherscan key or `handlerUrl` it takes Vyper input there, and
   without one Sourcify does. One API serves every Etherscan chain, so one probe chain stands for
   all of them.
2. For Vyper input, the Etherscan client sends `codeformat=vyper-json`,
   `compilerversion=vyper:` followed by `compiler.version` before `+`, and `optimizationUsed`: `0`
   when `settings.optimize` is `"none"` or `false`, else `1`. The flag sits on the Etherscan
   dialect (`vyper: true`), so Routescan and the standalone Etherscan-compatible clients, which share
   the dialect code, keep the solc form; the flow refuses Vyper input for them before they load.
   `standardJsonFields` and the solc request do not change.
3. `validateInput` refuses a Vyper `settings.optimize` other than absent, `null`, `"none"`,
   `"gas"`, `"codesize"`, `true` or `false`, with `invalid-input` on
   `compiler.input.settings.optimize`. Those are the values Vyper 0.3.10 and 0.4.3 read
   (`vyper/cli/vyper_json.py` and `OptimizationLevel.from_string` of each release, read
   2026-11-20). A typo would otherwise be sent as `optimizationUsed=1`.
4. The server handler takes `optimizationUsed` as an optional `verifysourcecode` field, checked with
   `^[01]$`. Its `compilerversion` check also accepts `vyper:<x.y.z>`, with no suffix, each part
   `0` or 1 to 4 digits without a leading zero, as `validateInput` bounds a Vyper version. The solc
   form's bound is issue [#444](https://github.com/aelmanaa/explorer-verify/issues/444). A request
   may now hold 12 fields; the limit stays 16.
5. Status texts, lookups, Similar Match and constructor argument derivation are those of solc. The
   rejected Vyper source gave the solc bytecode mismatch text, read as `failed` with `reasonCode`
   `bytecode-mismatch`.
6. `inputCheck` of decision 0077 still removes Sourcify for Vyper 0.3.x input with `interfaces`.
   Etherscan v2 is then left, so such input routes to it where the row lists it, and the refusal
   comes only when Sourcify is named. Its hint names Etherscan v2 first. Etherscan v2 gets the
   `interfaces` field as the compiler reads it; such an input was not submitted live.

## Why

- `optimizationUsed` is required by Etherscan for Vyper (observed). The research note recorded that
  `0` and `1` both verified and that the lookups read `OptimizationUsed "1"` either way, so the value
  follows the input's setting rather than a constant.
- Routing Vyper as solc keeps one rule for every kind: the key decides between Etherscan and
  Sourcify, and a caller who names a backend gets it.
- Keeping the Vyper form behind a dialect flag leaves the two other Etherscan-style clients
  unchanged until one of their explorers is probed (Routescan refuses `vyper-json` on this API).

## Consequences

- Vyper input with no route takes Etherscan v2 where the row lists it first and its key is set,
  and Sourcify otherwise. On a row with neither, such as chain 151, the refusal names the row's first
  backend.
- `verifyEach({ backends: "all" })` keeps both for Vyper input with an Etherscan key, and Sourcify
  alone without one. For 0.3.x input with interfaces, it keeps `etherscan-v2` without a key, so the
  run reports `missing-api-key` for it.
- A server handler of an older release refuses a Vyper submit with `bad-request` on
  `compilerversion` and on the unknown `optimizationUsed` field. Update the handler with the client.
- The default hint of `unsupported-compiler` names Vyper through Sourcify or Etherscan v2.

## Live run, 2026-11-19

Ethereum Sepolia, deployer `0x9d087fC03ae39b088326b67fA3C788236645b717`, Vyper
`0.4.3+commit.bff19ea2`. The three contracts have the same body, `src/Tally<X>.vy`, with constructor
arguments `(uint256, string)`, and differ from the research note's contracts A and C.

| Contract | Address                                      | Creation transaction                                                 | What it showed                                                                                                                                                                           |
| -------- | -------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TallyA   | `0xb723519c03d0529dde21b1cd3dd255e83ab0f32b` | `0x0d2cfb55d2c96b579ebf2ae0a6013addc1400d7ddbdd5926788a8369a0b69a7d` | Without `optimizationUsed`: refused. Then `verify()` derived the arguments from the creation code and returned `verified`, `exact`                                                       |
| TallyB   | `0xbf4ed80f83025577717e4d5ddee115b52495419e` | `0x9d63ff4a97ad939458ef3a47d89a06d9f716d8483b2f9a6d10f77a66ee3cbd80` | A changed source failed with the bytecode mismatch text; then the lookup showed TallyA's source with `SimilarMatch`; `verify()` through the handler example returned `verified`, `exact` |
| TallyC   | `0xc47505ea1c43673bede91041749a92fb8ad485ac` | `0xae4acc93ab4885a2a47d2a023f9130a5e05d2ef6aade5233cd6887e63417892c` | `Unable to locate ContractCode` seconds after the deployment, then `Pending in queue` twice, then `Pass - Verified`                                                                      |

Each contract went to Etherscan before any other explorer. The answers are in
`packages/explorer-verify/test/fixtures/etherscan/2026-11-19-vyper-*.json`, with the key replaced.
TallyA is the live check's `EthSepVy1` target.
