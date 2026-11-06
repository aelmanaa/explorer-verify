# Stored handle forms, a template literal type for the one-line form, and a check that does not throw

Date: 2026-11-06. Issue: [#218](https://github.com/aelmanaa/explorer-verify/issues/218).

Question: which handle form should callers store, can TypeScript type the one-line form without a
cast, and what does a check that never throws cost a bundle compared with `parseHandle`?

## Forms in the repository on main 411169e

- Five examples stored `JSON.stringify(error.details.handle)`: `docs/user/reference/verify.md`,
  `docs/user/reference/errors/index.md`, and the TSDoc of `verify()`, `ExplorerVerifyError` and
  `Handle`. `parseHandle` and `checkStatus` took the handle object or the one-line form, and threw
  `invalid-input` with the message `The handle is invalid: handle.` for that JSON text.
- The `checkStatus()` example, the `verify.submitted` event and `toJSON()` used the one-line form.
- `formatHandle`, the event's `handle` and `ErrorJson.handle` were typed `string`.

## TypeScript, checked locally on 2026-11-06

TypeScript 7.0.2 (`tsc` of the repository), `strict` and `exactOptionalPropertyTypes`. The checks
are the type tests at the top of `packages/explorer-verify/test/unit/check-handle.test.ts`.

| Check                                                                                         | Result                                                   |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `` `ev1:${BackendName}:${number}:${Hex}:${string}` `` as the return type of a template string | Compiles with no cast when each part has the part's type |
| `"ev1:sourcify:1:0xab:job"` assigned to it                                                    | Accepted                                                 |
| `ev2:…`, an unknown backend, `one` as the chain id, an address without `0x`                   | Rejected at compile time                                 |
| `string` assigned to it                                                                       | Rejected                                                 |
| `Handle \| HandleString \| string` as a parameter                                             | Accepts the same values as `Handle \| string`            |
| `isHandleString(value: unknown): value is HandleString`                                       | Narrows; no typed alternative narrows a `string`         |

## Bundle size, measured locally on 2026-11-06

`node scripts/check-names.ts name-budget.json` on main 919359e plus this change, esbuild 0.28.2,
Rollup 4.67.4, Node.js 24.21.0. Each row imports one name from `explorer-verify`.

| Name             | esbuild one file, min / gzip | Rollup, min / gzip |
| ---------------- | ---------------------------- | ------------------ |
| `parseHandle`    | 15,097 / 5,839               | 14,853 / 5,641     |
| `tryParseHandle` | 2,223 / 1,104                | 2,092 / 1,020      |
| `isHandleString` | 2,278 / 1,112                | 2,147 / 1,027      |
| `formatHandle`   | 222 / 186                    | 114 / 113          |

`parseHandle` loads the error class, its hint text and the redaction code. `tryParseHandle` and
`isHandleString` load only the field checks and the backend names.

## How other libraries pair a throwing and a non-throwing parse

- Zod has `parse`, which throws, and `safeParse`, which returns a result object.
- Valibot has `parse` and `safeParse`, and `is`, a type predicate that never throws.
- The URL standard has `new URL()`, which throws, and `URL.canParse()` and `URL.parse()`, which
  return a boolean and `null`.

## Sources

- TypeScript handbook, template literal types:
  https://www.typescriptlang.org/docs/handbook/2/template-literal-types.html (read 2026-11-06)
- TypeScript handbook, type predicates:
  https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates
  (read 2026-11-06)
- Zod, basic usage, `.parse` and `.safeParse`: https://zod.dev/basics (read 2026-11-06)
- Valibot, parse data: https://valibot.dev/guides/parse-data/ (read 2026-11-06)
- MDN, `URL.parse()`:
  https://developer.mozilla.org/en-US/docs/Web/API/URL/parse_static (read 2026-11-06)
