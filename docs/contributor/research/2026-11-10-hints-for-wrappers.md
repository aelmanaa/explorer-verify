# Hints that reach a wrapper's users, 2026-11-10

Audience: contributors reviewing [decision 0061](../decisions/0061-hint-wording-and-end-user-hints.md),
issues [#286](https://github.com/aelmanaa/explorer-verify/issues/286) and
[#298](https://github.com/aelmanaa/explorer-verify/issues/298).

Question: which library hints name the error's fields or the library's API, and where do tools
show them?

## What the hints named

Read from `packages/explorer-verify/src/error-hints.ts` on main 9d55a2a, on 2026-11-10:

- 12 of the 26 default hints named a field as a word of the sentence: 11 a `details.` field, and
  `cancelled` `error.handle` and `error.handles`. The `cancelled` hint also named the CLI command
  `explorer-verify status`.
- Hints that name a function or an option, such as `checkStatus`, `verify()`, `linkProxy()`,
  `timeoutMs`, `apiKeys` or `ipfsGateway`, are written for the developer who calls the library.
- Specific hints in the core named `details.` or `options.` fields too: three constants in
  `src/input/build.ts`, one inline hint there, `MISMATCH_HINT` in `src/input/metadata.ts`,
  `OPTIONS_HINT` in `src/input/resolvers/bytecode.ts` and the suffix that `validateInput` adds for
  more than one issue in `src/input/validate.ts`.
- The Etherscan client's not-indexed hint says "call verify() again once the explorer shows it"
  (`src/backends/etherscan.ts`). That hint names no field, only a function.

## Where tools show them

- The Remix consumer of the adoption validation recorded the `incomplete-input` hint "Pass each
  path in details.candidates as a key of options.sources, ..." in its
  [results](../../../validation/browser-remix/evidence/results.json) (2026-11-08,
  [adoption validation](2026-11-08-adoption-validation.md)).
- The wrapper guide maps an error onto the tool's own class as `${error.message} ${error.hint}`
  (`docs/user/guides/wrap-explorer-verify-in-your-tool.md`, main 9d55a2a). The tool's error has no
  `details` field, or holds it under another name.
- Issue #298 reports that hints such as "call verify() again once the explorer shows it" reached
  the IDE terminal of the Remix contract-verification plugin, where the user cannot call a
  function or set an option.
- The CLI met the same problem and replaced the library's hints with its own
  ([decision 0049](../decisions/0049-error-details-in-json-and-cli-hints.md)).

## What the details allow

The error details hold what an end-user hint can use without the library's names, read from
`ErrorDetails` in `src/errors.ts` on main 9d55a2a:

- `rate-limited.retryAfterMs`, the wait the explorer asked for, when it sent one;
- `unexpected-response.excerpt`, which holds Etherscan's "Unable to locate ContractCode at" when
  the client gave up waiting for Etherscan to index the contract (`MAX_NOT_INDEXED_TRIES` submits,
  `src/backends/etherscan.ts`);
- `cancelled.handle` and `cancelled.handles`, present when an explorer accepted a submission before
  the cancel.

A `timeout` thrown while Etherscan had not indexed the contract carries no excerpt, so the
not-indexed case cannot be told apart there.

## Sources

- [Issue #286](https://github.com/aelmanaa/explorer-verify/issues/286), read 2026-11-10: the
  default and specific hints that name `details.` and `options.` fields, and the wrapper guide's
  mapping.
- [Issue #298](https://github.com/aelmanaa/explorer-verify/issues/298), read 2026-11-10: hints that
  reached the Remix plugin's IDE terminal, and the two API options.
- [Source at main 9d55a2a](https://github.com/aelmanaa/explorer-verify/tree/9d55a2a/packages/explorer-verify/src),
  read 2026-11-10: `error-hints.ts`, `errors.ts`, `input/` and `backends/etherscan.ts`.
