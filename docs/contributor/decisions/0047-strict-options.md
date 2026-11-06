# 0047: Unknown option keys throw, and each function has its own options type

Status: Accepted (2026-11-05). Supersedes the rule of [decision 0034](0034-verify-each-for-several-backends.md)
that other fields of a `backends` entry are ignored, and the same rule for `route`. Amends the
options shape of [decision 0009](0009-options-handle-and-errors.md), and resets the
`buildVerifyInput` ceiling of [decision 0014](0014-measured-bundle-ceilings.md).

Research: [2026-11-05-strict-options.md](../research/2026-11-05-strict-options.md).

## Context

Issue [#216](https://github.com/aelmanaa/explorer-verify/issues/216). The runtime ignores an
options key it does not read, so a misspelled `timeoutMs` or `signal` changes the call without a
word. TypeScript catches the misspelling in an object literal only; JavaScript callers, options
read from JSON and generated code reach the runtime unchecked. `verify()`, `dryRun()`,
`checkStatus()` and `linkProxy()` share `VerifyOptions`, so the type also accepts options a
function does not read. Under `exactOptionalPropertyTypes`, no optional input field accepts
`undefined`, while the runtime treats `undefined` as absent.

## Decision

- Every optional field of an input type takes `T | undefined`, and `undefined` counts as absent.
  Output types stay `?: T`.
- `CallOptions` holds `fetch`, `handlerUrl` (decision 0046), `signal`, `timeoutMs`, `logger`, `onEvent`, `route`,
  `allowSourcifyFallback` and `apiKeys`. `VerifyOptions` adds `pollIntervalMs` and `rpcUrl`;
  `DryRunOptions` adds `rpcUrl`; `CheckStatusOptions` and `LinkProxyOptions` add
  `pollIntervalMs`. `VerifyEachOptions` stays `VerifyOptions` without `route`, plus `backends`.
  All are exported. The narrow types make TypeScript refuse a misplaced key in an object literal.
- At run time, `verify()`, `dryRun()`, `checkStatus()` and `linkProxy()` all accept every key of
  `VerifyOptions`, and check each value. One options object built for `verify()` can then go to
  each of them, as the agent skill teaches. `verifyEach()` accepts those keys and `backends`.
- `onEvent` sits in `CallOptions`, not in `VerifyOptions` as the issue drafted it: every flow
  function emits events, and removing it from `checkStatus()` would lose its `verify.poll` events.
- `dryRun()` keeps `rpcUrl` in its type: it checks the URL as `verify()` does and sends it no
  request. The CLI relies on this for `verify --dry-run --rpc-url-file`.
- Any other key throws `invalid-input` before any request: the options of the five flow
  functions, `route`, each `backends` entry, `buildVerifyInput()`, `buildVerifyInputFromBytecode()`,
  `toEnvelope()`, `createVerifyHandler()`, `routesFor()`, `findHardhatBuild()`, `findFoundryBuild()`,
  `buildVerifyInputFromHardhat()` and `buildVerifyInputFromFoundry()`. The last two also take
  `compilerVersion` and `sources`, which they pass to `buildVerifyInput`. An array as the options
  of a flow function throws too.
- The issue names the key, after its prefix such as `route.`. It suggests the known name that
  equals the key ignoring case, or of which one is a prefix of the other ignoring case, the
  shortest first: `timeout` gives `timeoutMs`. A transposed name such as `tiemoutMs` gets no
  suggestion. This rule replaced the CLI's edit-distance rule to keep the check small in the
  browser bundle.
- The issue never holds the key's value. A key that is not an identifier of at most 32 characters
  with fewer than 8 digits is not repeated: it may be a secret pasted as a name. The issue then
  names the options object. Only own enumerable string keys count. The keys are listed before any
  value is read, so a getter on an unknown key never runs.
- The rule lives in the core's `src/internal/known-keys.ts`. The Hardhat and Foundry helpers
  cannot import an internal module, so each holds a copy, and a core test keeps the copies the
  same. The CLI keeps its own `suggest.ts`.
- Each key list is built from a `Record<keyof Options, true>` checked with `satisfies`, so a field
  added to a type and not to its list fails to compile.
- The function given as `VerifyHandlerOptions.rateLimit`, and every other nested value, is not
  checked for unknown keys; nor is `compiler.input`, which is Standard JSON.

## Alternatives considered

- Warn through the logger instead of throwing. Rejected: a caller without a logger sees nothing,
  which is the problem.
- Check each function's own key list at run time, so `checkStatus()` refuses `rpcUrl`. Rejected
  in review: an options object shared between `verify()` and `checkStatus()` would break, and
  the narrow types already catch a misplaced key in a literal.
- Suggest by edit distance, as the CLI does. Rejected in review for size: the first version of
  this change, with that rule, per-function key lists and longer hints, added 548 bytes gzipped to
  `verify`; this one adds 273.
- Leave `rpcUrl` out of `DryRunOptions`, as the issue drafted it. Rejected: a dry run that cannot
  check the URL passes a run that `verify()` then refuses.

## Consequences

- A caller that passed an extra key now gets `invalid-input`. This is breaking, and lands before
  0.1.0.
- Adding an option means adding it to the type and to its key record; the compiler enforces both.
- Measured with `pnpm run size` and `scripts/check-names.ts` (esbuild 0.28.2, Rollup 4.67.4,
  Node.js 24.21.0 zlib) on 2026-11-06, one run at a time, main 1a4510c against main 1a4510c plus
  this change, gzipped bytes:

  | Entry                                        | main 1a4510c | with #216 | Change |
  | -------------------------------------------- | ------------ | --------- | ------ |
  | `verify`                                     | 15,686       | 15,959    | +273   |
  | `verify (one file)`                          | 27,545       | 27,867    | +322   |
  | `checkStatus`                                | 13,504       | 13,780    | +276   |
  | `verifyEach`                                 | 17,286       | 17,617    | +331   |
  | `linkProxy`                                  | 12,548       | 12,809    | +261   |
  | `buildVerifyInput`                           | 13,074       | 13,355    | +281   |
  | `index`                                      | 28,589       | 29,121    | +532   |
  | `createVerifyHandler`                        | 13,470       | 13,720    | +250   |
  | `buildVerifyInputFromBytecode`               | 22,626       | 22,968    | +342   |
  | `findHardhatBuild`, esbuild split            | 2,385        | 2,788     | +403   |
  | `buildVerifyInputFromHardhat`, esbuild split | 2,442        | 2,843     | +401   |
  | `findFoundryBuild`, esbuild split            | 2,949        | 3,285     | +336   |
  | `buildVerifyInputFromFoundry`, esbuild split | 3,185        | 3,520     | +335   |

- `buildVerifyInput` passes its ceiling of 13,310, which
  [decision 0014](0014-measured-bundle-ceilings.md) set. It is reset by that rule, the measured
  size plus 20%: 16,026. `verify (one file)` stays under the ceiling of 33,024 that
  [#217](https://github.com/aelmanaa/explorer-verify/issues/217) set (decision 0046).
- The rows of `findHardhatBuild`, `buildVerifyInputFromHardhat`, `findFoundryBuild` and
  `buildVerifyInputFromFoundry` in `name-budget.json` were last measured on main d82957d. Between
  that commit and 1a4510c, [#223](https://github.com/aelmanaa/explorer-verify/issues/223) grew
  `findHardhatBuild` from 2,164 to 2,385 bytes; the table above gives this change's part. The four
  rows are reset by the rule of [decision 0042](0042-every-exported-name-measured-in-real-bundlers.md).
- `VerifyInput` and `LinkProxyTarget` still ignore unknown fields: they are inputs, which
  `validateInput` copies field by field, not options.
