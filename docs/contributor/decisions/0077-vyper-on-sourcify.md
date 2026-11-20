# 0077: Vyper on Sourcify, with interfaces sent as sources

Status: Accepted (2026-11-19). Amends [decision 0075](0075-vyper-compiler-kind.md) point 8: the
Vyper list is no longer empty.

Research: [Vyper support on each explorer](../research/2026-11-15-vyper-support.md), with its
2026-11-19 addendum on Sourcify.

## Context

Issue [#423](https://github.com/aelmanaa/explorer-verify/issues/423), part of epic
[#430](https://github.com/aelmanaa/explorer-verify/issues/430). Sourcify v2 verifies Vyper through
the request the client sends for solc. The issue planned to send the Vyper Standard JSON input as
`standardJsonInput` keeps it, `interfaces` included (#421).

On 2026-11-19, a submit with a top-level `interfaces` field got 400 `invalid_parameter`:
`Standard JSON input contains unsupported top-level field(s): interfaces`. Sourcify server 4.4.0
accepts only `language`, `sources`, `settings` and the fields it stores, because a field it does
not store could change the compiler output and leave the contract impossible to recompile from its
records (`middlewares.ts`, sourcify `d7642636`).

Vyper 0.4.3 reads `sources` and `interfaces` into one input bundle (`vyper_json.py`,
`get_inputs`). A `.vyi` interface compiled to the same bytecode from either field. Before 0.4.0
this does not hold: `vyper_json` keeps interfaces in a separate map keyed without the extension,
and `compile_from_input_dict` compiles every entry of `sources`. Sourcify's `outputSelection` names
only the target, so a moved `.vy` or `.vyi` interface fails with a `KeyError`, and a moved `.json`
interface with `Cannot locate interface` (review of #423, vyper 0.3.10 source). An `abi`
interface is read as the text `json.dumps({"abi": [...]})`, and from 0.4.1 that text goes into the
integrity hash at the end of the creation code. A source with that text as `content` gave the same
bytecode; the compact JSON that JavaScript writes gave other bytecode (local runs, vyper 0.4.3,
2026-11-19).

## Decision

1. `VYPER_ROUTES` is `[["sourcify", "every"]]`. An entry's chains are a list of chain ids or
   `"every"`. The routing table passes over other backends for Vyper input, so the default route
   of every chain with a Sourcify row picks Sourcify.
2. The Sourcify client sends `compilerVersion` as `compiler.version`, the long form without `v`,
   as for solc.
3. The Sourcify client moves each entry of `interfaces` into `sources` under its own path, for
   Vyper 0.4.0 and later. The flow refuses Vyper 0.3.x input with a non-empty `interfaces` with
   `unsupported-compiler` on `compiler.input.interfaces` before any request, and the hint says to
   inline each interface or to build with 0.4.0 or later. An entry with `content` keeps its
   text. An `abi` entry gets the text of Python's `json.dumps` with its
   defaults: `", "` and `": "`, keys in their order, and each character outside printable ASCII
   as a `\u` escape. A source keeps its path over an interface of the same path; Vyper refuses
   such an input anyway.
4. The other clients keep the `interfaces` field. `standardJsonInput` does not change.
5. The unsupported-compiler hint names Vyper through Sourcify.
6. The weekly live check polls the job of a submit that starts one. A Vyper resubmit gets 202, not
   409, because Sourcify grades the runtime code `match`; the job ends with `already_verified`.

## Alternatives considered

- Refuse Vyper input with `interfaces` on Sourcify. Foundry and `vyper -f solc_json` put `.vyi`
  files in `sources`, but a caller who builds the input by hand or with JSON ABI interfaces would
  get a refusal for an input Sourcify can verify.
- Send an `abi` entry's content as `JSON.stringify`. It verifies only as a partial match on 0.4.1
  and later, or not at all, because the integrity hash differs.

## Consequences

- Sourcify publishes the interface files as sources of the contract.
- A JSON number in an ABI keeps the text JavaScript gives it, which can differ from Python's for a
  float. An ABI holds no floats.
- A Vyper build before 0.4.1 verifies `partial` on Sourcify, and no submit raises it.
- Sourcify forwards a verified Vyper contract to Etherscan and Blockscout. The live target of this
  issue is verified there too, so the Blockscout and Etherscan mappings need their own contracts.
- Measured with esbuild 0.28.2 on 2026-11-19, main `5193afa` against this change: the `sourcify`
  chunk grows from 3321 to 3582 bytes gzip, past its ceiling of 3462, and `verify` from 20253 to 20294. The interface move and the Python JSON writer are the growth; they load only with the
  Sourcify client. The `sourcify` ceiling is reset to the measured size plus 20%, 4299 bytes, as
  decision 0014 sets. No other ceiling was passed.
- The refusal of Vyper 0.3.x input with interfaces is in the kind check of every flow that takes
  input. With it, on 2026-11-20, `verifyEach` measured 22394 bytes gzip, past its ceiling of
  22178, and `verify (core, Etherscan v2, one file)` 31065, 18 bytes under its ceiling of 31083.
  The Etherscan one-file ceiling is reset to the measured size plus 20%, 37278. Decision 0076 had
  already reset the `verifyEach` ceiling to 26630, so this change keeps that one.
- Rebased on main `c1bf45d`, with decision 0076, on 2026-11-20: `verify` 20692, `verifyEach`
  22502, `verify (core, Etherscan v2, one file)` 31168, the `sourcify` chunk 3595 and the
  `proxy-sourcify` chunk 4009 bytes gzip, each under its ceiling.
- The `proxy-sourcify` chunk imports the Sourcify client, so it carries the new code too: 3746 to
  3996 bytes gzip, 24 bytes under its ceiling of 4020. Its ceiling is reset to the measured size
  plus 20% as well, because the next change to the Sourcify client would pass it with no change to
  the proxy code.
