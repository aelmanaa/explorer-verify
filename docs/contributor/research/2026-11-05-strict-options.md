# Unknown option keys and optional fields under exactOptionalPropertyTypes

Date: 2026-11-05. Issue: [#216](https://github.com/aelmanaa/explorer-verify/issues/216).

Question: what does the library do with an options key it does not read, and can a caller with
`exactOptionalPropertyTypes` pass a value that may be `undefined` into an optional field?

## The runtime, read on main at commit 0ad78f1 on 2026-11-05

- `settingsOf` in `src/flow/verify.ts` reads `fetch`, `signal`, `timeoutMs`, `pollIntervalMs`,
  `logger`, `onEvent`, `route`, `allowSourcifyFallback`, `apiKeys` and `rpcUrl` by name and no
  other key. `verify(input, { timeout: 5 })` therefore runs with the 120,000 ms default, and
  `{ signa: signal }` gives a call that cannot be cancelled.
- `verify()`, `dryRun()`, `checkStatus()` and `linkProxy()` all take `VerifyOptions`, so the type
  accepts `pollIntervalMs` on `dryRun()` and `rpcUrl` on `checkStatus()`, which neither reads.
- `resolveRoute` reads `backend`, `apiUrl` and `apiKey` of `route` and ignores other keys;
  `verifyEach()` does the same for a `backends` entry (decision 0034).
- `apiKeys` is the one options object checked key by key (decision 0016).
- `duration()` treats an `undefined` value as absent, and so does each other reader.

## TypeScript

The TypeScript reference for `exactOptionalPropertyTypes` (read 2026-11-05) says that with the flag
on, assigning `undefined` to a property declared `?: T` is an error, and suggests adding
`undefined` to the type of the target. The repository's base tsconfig turns the flag on.

Checked locally on 2026-11-05 with TypeScript 7.0.2 and Node.js 24.21.0, in a scratch consumer of
the built package under `strict` and `exactOptionalPropertyTypes`, now kept as
`packages/explorer-verify/test/unit/options-types.test.ts`. The column for main at 0ad78f1 follows
from its declarations, `?: T` without `undefined`, and the rule above; the error codes are the ones
TypeScript gives for that rule:

| Case                                                       | On main at 0ad78f1                 | After the change           |
| ---------------------------------------------------------- | ---------------------------------- | -------------------------- |
| `verify(input, { timeoutMs: maybe, rpcUrl: env.RPC_URL })` | TS2379, `undefined` not assignable | compiles                   |
| `{ ...input, constructorArgs: maybeHex }` as `VerifyInput` | TS2375                             | compiles                   |
| `dryRun(input, { pollIntervalMs: 1000 })`                  | compiles                           | TS2353 on `pollIntervalMs` |
| `checkStatus(handle, { rpcUrl })`                          | compiles                           | TS2353 on `rpcUrl`         |
| `verify(input, { timeout: 5 })`                            | TS2561, suggests `timeoutMs`       | the same                   |

TypeScript's excess-property check covers object literals only: an options object built
elsewhere, read from JSON or passed from JavaScript reaches the runtime unchecked.

## Sources

- TypeScript reference, `exactOptionalPropertyTypes`:
  https://www.typescriptlang.org/tsconfig/#exactOptionalPropertyTypes (read 2026-11-05)
- Issue #216: https://github.com/aelmanaa/explorer-verify/issues/216
