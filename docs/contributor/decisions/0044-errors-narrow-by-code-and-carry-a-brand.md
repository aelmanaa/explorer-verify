# 0044: Errors narrow by code and carry a brand; library errors get their hint from a separate table

Status: Accepted (2026-11-05). Supersedes the "No `isExplorerVerifyError` brand check" point of
[decision 0009](0009-options-handle-and-errors.md), section 3, and changes how an error gets its
default hint. The rest of decision 0009 stands.

Research: [narrowing errors, a brand across copies, and the cost of the hint text](../research/2026-11-05-error-narrowing-and-brand.md).

## Context

`ExplorerVerifyError` typed `code` as `ErrorCode` and `details` as `ErrorDetails`, with no link
between the two. `error instanceof ExplorerVerifyError && error.code === "not-confirmed"` did not
narrow `details`, so callers and the docs checked `error.details.code`.

Decision 0009 declined a brand check because it needs a type predicate. It noted that two copies
of the package break `instanceof`, and that a later decision would add the check if that case
turned out common. The CLI, the Hardhat helper and the Foundry helper each depend on the core and
can resolve another version than the caller's code, so the case is common.

The class held the 25 default hints, 3,024 bytes of text. Importing `ExplorerVerifyError` alone,
to check a caught error, cost 12,500 bytes minified with Vite.

## Decision

1. The class is generic: `ExplorerVerifyError<C extends ErrorCode = ErrorCode>`, with
   `readonly code: C` and `readonly details: DetailsOf<C>`. `DetailsOf<C>` is the member of
   `ErrorDetails` whose `code` is `C`. The constructor takes `details: DetailsOf<C> & { code: C }`,
   so `C` is inferred from the literal code. `DetailsByCode`, the map from each code to its member,
   is exported too.
2. `AnyExplorerVerifyError<C>` is the union of `ExplorerVerifyError<K>` for each `K` in `C`.
   `ExplorerVerifyError.is(value)` and `ExplorerVerifyError.is(value, code)` (two overloads, so a
   type argument without a code does not compile) and `static [Symbol.hasInstance]` narrow a value
   to it, so a check of `error.code`, in an `if` or a `switch`, narrows `details`. These are the
   three type predicates in `src/errors.ts`, listed in `scripts/type-escapes.json`.
3. The types the library hands errors back in use the union: `VerifyOutcome`, and the default of
   `BackendOutcome` and `VerifyEachResult`. `toEnvelope` and `exitCodeOf` also take the plain
   `ExplorerVerifyError`, so a value typed that way still passes.
4. Each instance has a brand: an own key `Symbol.for("explorer-verify.error")`, not enumerable,
   value `true`. `is()` and `instanceof ExplorerVerifyError` check the brand, not the prototype, so
   both hold for an error built by another copy of the package. Only an own property counts, so a
   brand set on `Object.prototype` does not brand every object. `is()` returns `false` and never
   throws for a value whose fields cannot be read. The brand is absent from `Object.keys(error)`, a
   spread and `JSON.stringify(error)`; `structuredClone` and `postMessage` drop it, so a worker gets
   `toJSON()` instead. For a subclass, `instanceof` checks the prototype chain as usual and narrows
   to the subclass.
   `toEnvelope` and `exitCodeOf` still treat an error from another copy as foreign and check its
   handle field by field: an error is this copy's only when this copy's class is on its prototype
   chain. A branded value without a usable `toJSON()` is refused with a message that names it.
5. The default hints move to `ERROR_HINTS` in `src/error-hints.ts`, a public export. The library
   builds every error through an internal factory, `newError`, which passes `ERROR_HINTS[code]`
   when no specific hint applies. The class does not import the table. A caller who constructs an
   error and passes no hint, or a blank one, gets `Read <docsUrl> for what to do next.`; the CLI and
   the build helpers pass `ERROR_HINTS[code]`. `hint` stays an own property, so `Object.keys(error)`
   and `toJSON()` do not change.
6. Closed sets get literal types: `incomplete-input.field` and `insufficient-artifact.field`.
   `unsupported-compiler.field` stays a string: it can name a zksolc field, such as
   `input.zksolc_version`. The `source-mismatch` hashes are `Hex`; a value of another form
   becomes `0x`. A backend name outside `BACKEND_NAMES`, which only code that bypasses the types can
   pass, becomes `etherscan-compatible`, as it already did in a handle, so `details.backend` is
   `BackendName` with no `"unknown"`.

### The `verify (one file)` ceiling

Main at 74201ae measured 25,788 bytes on `verify (one file)`, 208 under its ceiling of 25,996.
This change adds 271 bytes there: the brand check, the subclass-aware `instanceof`, the factory,
and the redactor table. Retryable codes moved to a list, which saved 76 bytes. By
[decision 0014](0014-measured-bundle-ceilings.md)'s rule, the ceiling becomes the measured size
plus 20%, rounded up. Measured with esbuild 0.28.2 and Node 24.21.0 zlib on 2026-11-05.

| Entry               | Before (74201ae) | After  | Old ceiling | New ceiling |
| ------------------- | ---------------- | ------ | ----------- | ----------- |
| `verify (one file)` | 25,788           | 26,059 | 25,996      | 31,271      |

The other entries keep their ceilings: `verify` 15,057 → 15,234, `checkStatus` 12,873 → 13,050,
`verifyEach` 16,656 → 16,830, `linkProxy` 11,931 → 12,123, `buildVerifyInput` 12,819 → 13,068,
`index` 27,592 → 27,789, `createVerifyHandler` 13,122 → 13,371 and
`buildVerifyInputFromBytecode` 22,303 → 22,567, all under their ceilings.

## Alternatives considered

| Option                                                        | For                                       | Against                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| Keep `details.code` as the way to narrow                      | No type predicate                         | The first check people write does not compile; no way to recognise an error across copies     |
| One subclass per code                                         | `instanceof` narrows                      | 25 classes; still fails across copies without a brand                                         |
| A `hint` getter that reads a table in another module          | `hint` correct for every constructor call | The class references the table, so every bundle with the class still holds it; no bytes saved |
| A required `hint` option                                      | Every error has its specific hint         | Every caller that builds an error must import the table, tests included                       |
| Brand as a getter on the prototype                            | Not on the instance                       | A computed class member with an unexported symbol fails `isolatedDeclarations`                |
| `"unknown"` for a backend outside `BACKEND_NAMES` (as before) | Names the case                            | Ten members widen `backend` for a case typed callers cannot reach                             |

## Consequences

- Importing `ExplorerVerifyError` alone drops by 2,792 bytes minified with Vite and 2,799 with
  esbuild in one file. esbuild with `splitting` groups the hints with the class through `index.js`
  and grows by 661 bytes; the light subpaths change removes that grouping.
- `verify` grows by about 520 bytes minified (one file) and 610 (Vite). Every size ceiling still holds.
- `name-budget.json` ([decision 0042](0042-every-exported-name-measured-in-real-bundlers.md))
  gains an `ERROR_HINTS` row, and the esbuild one-file and Rollup rows of `ExplorerVerifyError`
  are measured again and their ceilings lowered, so the saving cannot be lost unseen.
- An error built with `new ExplorerVerifyError(...)` and no `hint` has a hint that points to its
  page, not the code's default. Code outside the library that wants the default passes
  `ERROR_HINTS[code]`.
- A function typed to take a `VerifyOutcome` or a `BackendOutcome` no longer accepts a value
  typed as the plain `ExplorerVerifyError`; type it `AnyExplorerVerifyError`, or narrow it first.
- The CLI, Hardhat and Foundry packages import `ERROR_HINTS`, so they need a core that has it.
- The error JSON form (#214), handler refusals (#215) and handles (#218) build on `DetailsOf<C>`
  and `newError`.
