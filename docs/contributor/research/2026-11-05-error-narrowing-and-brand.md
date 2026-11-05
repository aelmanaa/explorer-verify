# Narrowing errors by code, a brand across copies, and the cost of the hint text

Date: 2026-11-05. Issue: [#213](https://github.com/aelmanaa/explorer-verify/issues/213).

Question: can one generic error class narrow `details` when a caller checks `error.code`, can a
check recognise an error from a second installed copy of the package, and how many bytes does the
hint text add to a bundle that imports only `ExplorerVerifyError`?

## TypeScript, checked locally on 2026-11-05

TypeScript 7.0.2 (`tsc` of the repository), `strict` and `exactOptionalPropertyTypes`. The checks
are the type tests at the top of `packages/explorer-verify/test/unit/errors-brand.test.ts`, and a
consumer file compiled against the built `dist/src/index.d.ts`.

| Shape                                                                                                     | Does `code === "rate-limited"` narrow `details`?        |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `ExplorerVerifyError<C>` with `code: C` and `details: DetailsOf<C>`, value typed `ExplorerVerifyError`    | No. One object type, not a union: `code` narrows alone. |
| The union of `ExplorerVerifyError<K>` for each code `K` (`AnyExplorerVerifyError`)                        | Yes, in an `if` and in each `case` of a `switch`.       |
| `static is(value, code?): value is AnyExplorerVerifyError<K>`                                             | Yes. With `code`, `details` narrows at once.            |
| `static [Symbol.hasInstance](value): value is AnyExplorerVerifyError`, then `instanceof`                  | Yes. TypeScript narrows `instanceof` by this predicate. |
| Constructor `details: DetailsOf<C> & { code: C }`                                                         | Infers `C` from the literal `code`; extra fields fail.  |
| A redactor table typed `{ [C in ErrorCode]: (d: DetailsOf<C>) => DetailsOf<C> }`, indexed with a `C` code | Compiles with no cast, so the copy keeps type `C`.      |

`is()` and `[Symbol.hasInstance]` narrow only through a type predicate; no typed alternative exists.

## Runtime, checked locally on 2026-11-05

Node 24.21.0. The test copies the built `dist/src` to two temporary folders and imports each, so
each copy has its own class. A `Symbol.for("explorer-verify.error")` key set on each instance
makes `ExplorerVerifyError.is` and `instanceof` hold in both directions. A `Proxy` whose traps
throw, and a revoked `Proxy`, give `false`, not an exception.

## Comparable libraries

- AWS SDK for JavaScript v3: `ServiceException.isInstance(value)` and a static
  `[Symbol.hasInstance]` let `instanceof` work across duplicate copies of the package.
- Vercel AI SDK: each error class has `isInstance(error)`, which checks a `Symbol.for` marker.
- viem: errors carry a `name`; its docs narrow with `instanceof` on subclasses.

## Bundle cost of `ExplorerVerifyError` alone

esbuild 0.28.2 and Vite 5.4.21 (Rollup 4.67.4) from the repository, minified, gzip level 6. Entry:
`export { ExplorerVerifyError } from "explorer-verify"` (esbuild), or the same name assigned to a
global (Vite). "Before" is main at d82957d; "after" is the change for #213. Bytes are minified /
gzip.

| Import                                | esbuild one file           | esbuild split, initial load | Vite, initial load       |
| ------------------------------------- | -------------------------- | --------------------------- | ------------------------ |
| `ExplorerVerifyError`, before         | 12,722 / 4,720             | 12,705 / 4,783              | 12,500 / 4,583           |
| `ExplorerVerifyError`, after          | 9,923 / 3,816 (−2,799 B)   | 13,366 / 5,134 (+661 B)     | 9,708 / 3,664 (−2,792 B) |
| `ExplorerVerifyError` + `ERROR_CODES` | 13,219 → 10,420 / 3,945    | 13,217 → 13,878 / 5,257     | 12,985 → 10,193 / 3,776  |
| `verify`                              | 101,719 → 102,241 / 29,351 | 53,900 → 54,500 / 20,388    | 55,555 → 56,164 / 19,057 |

- The hint text is 3,024 bytes. A getter that reads a table cannot leave the table out: the class
  holds the getter, so every bundle with the class holds the table. The table leaves the class
  bundle only when the class does not reference it, so the library fills the hint where it builds
  each error, through an internal factory.
- esbuild with `splitting` places every module the entry point reaches through `index.js` in one
  shared chunk with the class, the hints included, so that mode does not gain. Light subpaths, a
  separate issue, remove that grouping.
- `verify` grows by about 520 bytes minified (one file) and 610 (Vite): the brand check, the subclass-aware `instanceof`, the factory and a redactor table in
  place of one `switch`.

## Sources

- TypeScript 5.3 release notes, "`instanceof` Narrowing Through `Symbol.hasInstance`":
  https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-3.html (read 2026-11-05)
- MDN, `Symbol.for()`:
  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/for
  (read 2026-11-05)
- MDN, `Symbol.hasInstance`:
  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/hasInstance
  (read 2026-11-05)
- Smithy TypeScript, `ServiceException`:
  https://github.com/smithy-lang/smithy-typescript/blob/main/packages/smithy-client/src/exceptions.ts
  (read 2026-11-05)
- AI SDK, error handling: https://ai-sdk.dev/docs/ai-sdk-core/error-handling (read 2026-11-05)
- viem, error handling: https://viem.sh/docs/error-handling (read 2026-11-05)
