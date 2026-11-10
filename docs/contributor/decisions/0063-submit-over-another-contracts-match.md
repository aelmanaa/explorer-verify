# 0063: Submit over a match of another contract's source

Status: Accepted (2026-11-10). Narrows R-FLOW-1 and amends R-FLOW-3. Builds on
[decision 0021](0021-server-handler-forwards-a-reduced-lookup.md), which kept `ContractName` and
`CompilerVersion` in the handler's reduced lookup.

Research: [Matches from another contract's source](../research/2026-11-10-foreign-matches.md);
[the lookup and Similar Match](../research/2026-11-04-etherscan-client.md#the-lookup-and-similar-match);
[match grades for builds without a metadata hash](../research/2026-11-10-no-metadata-hash-grades.md).
Evidence: issue [#293](https://github.com/aelmanaa/explorer-verify/issues/293).

## Context

R-FLOW-1 has `verify()` look the contract up first and return `already-verified` for any match.
The lookup read only a grade. On Ethereum Sepolia on 2026-11-10, Sourcify, Blockscout and Routescan
held matches for two new contracts 56 to 94 seconds after each deployment, made from other
contracts' sources: `SimpleStorage`, `FundManagerProxy` and `AuctionProxy`, with compilers from
`0.8.27` to `0.8.34`. `verify()` returned `already-verified` on each of them and never submitted the
caller's source. Routescan's lookup mapped any non-empty `SourceCode` to `exact`, so one of those
results claimed an exact match for another project's source.

Each lookup answer names the stored contract and its compiler: Sourcify with `fields=compilation`,
Blockscout's REST answer, and Etherscan's and Routescan's `getsourcecode`.

## Decision

1. The lookup returns, next to the grade, the stored contract's name and compiler version where the
   answer gives them, each a string that is not empty:

   | Backend                                       | Name                                                      | Compiler version              |
   | --------------------------------------------- | --------------------------------------------------------- | ----------------------------- |
   | Sourcify (`fields=compilation`)               | `compilation.fullyQualifiedName`, else `compilation.name` | `compilation.compilerVersion` |
   | Etherscan v2, Routescan, Etherscan-compatible | `ContractName`                                            | `CompilerVersion`             |
   | Blockscout, Blockscout hosted                 | `name`                                                    | `compiler_version`            |

   Blockscout's `file_path` is not read: a source from its bytecode database carries a path of its
   own, such as `project/contracts/AuctionProxy.sol`. Each field is explorer text that reaches the
   result, the logs and the envelope, so the client cuts it to 300 characters, replaces its control
   characters (C0, DEL and C1, ESC among them) with `U+FFFD` and redacts the call's keys from it.

2. A match is this source when both fields that the answer gives equal the input's:
   - A stored name with a `:` is compared with the whole `contractName`; a stored name without one
     with the part of `contractName` after its last `:`.
   - Compiler versions are compared without a leading `v` and in lower case. When one of the two
     has no `+commit.` part, only the part before `+` is compared. A zksolc input compares its
     `solcVersion`, which Blockscout stores as `compiler_version`.
   - An answer that names neither keeps the earlier rule: the match is taken as this source, and
     `verify()` logs at `info` that the answer names no contract. This happens with Sourcify's
     `409` to a submit, an Etherscan-compatible explorer whose answer has no `ContractName`, and a
     Sourcify server that ignores `fields=compilation`.

3. `verify()` returns `already-verified` from the lookup only for a match of this source. For
   another contract's match it logs at `info` what the explorer holds, emits `verify.lookup` with
   the grade as before, and submits.

4. When a result would be `verified` or `already-verified` from a match of another contract's
   source, it is `already-verified`, `partial`, with `storedContract: { name?, compilerVersion? }`,
   and a `warn` line says so. This covers the explorer refusing the submit as already verified,
   Etherscan's `Fail - Unable to verify` followed by a lookup of another contract's exact match, and
   Blockscout's `Pass - Verified` whose lookup still names another contract. An
   answer to the submit that names no contract, such as Sourcify's `409`, keeps the contract the
   first lookup found.

5. A lookup after polling, for a budget that ran out or a job the explorer forgot, confirms the job
   only with a match of this source. The other contract's match gives `not-confirmed` or
   `job-not-found`, as no match does. A lookup after a submit with no clear answer sends the submit
   again when it finds only another contract's match. The flow passes that check to the client as
   `Context.own`, so the comparison stays out of the client chunks.

6. Every Routescan match is `partial`, from a lookup or from `Pass - Verified`. Routescan states no
   grade: its `getsourcecode` has no `SimilarMatch` field, and on 2026-11-10 it answered
   `Pass - Verified` for a build without a metadata hash that Sourcify and Blockscout graded
   partial, and held copies forwarded from Sourcify and Blockscout submits within seconds
   ([match grades for builds without a metadata hash](../research/2026-11-10-no-metadata-hash-grades.md),
   issue [#287](https://github.com/aelmanaa/explorer-verify/issues/287)).
   Its name and compiler version are still compared: a forwarded copy carries the submitted
   source's name and version.

7. `dryRun()` reports the grade in `lookup` and adds `storedContract` when the match is another
   contract's, since `verify()` would submit. `verifyEach()` and `explorer-verify/core` run the same
   flow. The envelope and its schema list `storedContract`.

8. `checkStatus()` has no input, so it compares nothing and keeps its behaviour: a resumed handle
   can report another contract's match as `verified` or `already-verified` without
   `storedContract`. Its bundle holds none of the comparison: `verify()` builds it in
   `verifyOnRoute` and passes it as `Call.otherOf` and `Context.own`.

9. `already-verified` with `storedContract` keeps exit code 0 and `ok: true` in this release.
   `storedContract` present means the caller's source is not on the explorer: the explorer holds
   another contract's. A caller that needs its own source there checks
   `result.storedContract === undefined`. A follow-up issue decides whether this case gets an exit
   code of its own.

## Alternatives considered

- Keep R-FLOW-1 and add an option to submit over any match. Rejected: the default result would
  still call another project's source this contract's verification.
- Return a new `status`, such as `foreign-match`, without submitting. Rejected: Blockscout accepts
  a submit over a partial match ([Blockscout](../../user/reference/blockscout.md#partial-matches)),
  so the caller's source can replace the other one there. Sourcify verifies again only for a
  better match: a partial submit over another contract's partial match ends in a refusal, and the
  result carries `storedContract`.
- Compare Blockscout's `file_path` with the input's path too. Rejected: the bytecode database
  rewrites the path, so the caller's own source could read as another contract's.
- Compare source hashes or compiler settings. Rejected for now (issue non-goal): the name and the
  version separate the recorded cases, and the answers do not all carry the sources.

## Consequences

- R-FLOW-1 now requires the stored contract to be this source; R-FLOW-3 adds Routescan's `partial`
  and `storedContract`.
- The Sourcify lookup sends `?fields=compilation`. Its log lines show the URL's query as
  `?REDACTED`, as for any query.
- A caller whose input names the contract differently from the explorer's record, such as a wrong
  path in `contractName` on Sourcify, now submits again; the explorer then answers already
  verified, and the result carries `storedContract`.
- `already-verified` can now follow a submit. Its `storedContract` says that the explorer page shows
  another contract.
- The comparison uses the name and the compiler version only. A partial match of another source
  with the same contract name and compiler version is taken as this source. The planned option to
  submit over a partial match ([#294](https://github.com/aelmanaa/explorer-verify/issues/294))
  lets a caller replace it; comparing source hashes is a later option.
- The `verify.lookup` event reports the lookup's grade and compares no names; the final result
  does.
- Bundle size, measured with `pnpm run size` on 2026-11-10 against `main` at `acd9ffd` (esbuild
  0.28.2, Node.js 24.21.0 zlib): `verify` grows by 469 bytes (17661 to 18130), `checkStatus` by
  120 (14810 to 14930), `index` by 500 and `envelope` by 155. The client chunks grow by 117 to
  211 bytes, for the stored-contract fields every lookup reads and makes safe with `redactLine`.
  The comparison sits on the `verify()` path only (`Call.otherOf`, `Context.own`): `stored.ts` is
  in neither the client chunks nor the `checkStatus()` bundle, whose 120 bytes are the result
  mapping.
- The Blockscout chunk was 2933 bytes when its ceiling of 3520 was set (decision 0031) and
  measures 3530 on `main` here. With this change it measures 3647 bytes. Its ceiling rises by the
  [decision 0014](0014-measured-bundle-ceilings.md) rule, the measured size plus 20% rounded up:
  4377 bytes.
- The per-name check of `name-budget.json` (decision 0042), against the same `main`: `verify`
  grows from 23552 to 24063 bytes (esbuild split, ceiling 24057) and from 34142 to 34871 (one
  file, ceiling 34804); `dryRun` from 22098 to 22387 (split, ceiling 22359) and from 31319 to
  31827 (one file, ceiling 31445). The four rows rise by the 0014 rule from these sizes: 28876,
  41846, 26865 and 38193 bytes.
