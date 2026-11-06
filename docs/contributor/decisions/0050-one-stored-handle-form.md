# 0050: One stored handle form, a typed handle string and checks that do not throw

Status: Accepted (2026-11-06). Amends point 2 of
[decision 0009](0009-options-handle-and-errors.md) (the error message for a bad handle and "no
type predicates").

Research: [2026-11-06-handle-forms.md](../research/2026-11-06-handle-forms.md) for the forms in
the repository, the type checks and the bundle sizes.

## Context

Issue [#218](https://github.com/aelmanaa/explorer-verify/issues/218) reports that five examples
stored a pending job with `JSON.stringify(error.details.handle)`, and `checkStatus` and
`parseHandle` rejected that text with `The handle is invalid: handle.` The `checkStatus()`
example, the `verify.submitted` event and `toJSON()` used the one-line form. Three forms
circulated and the documented one failed, with a message that did not say which forms work.

The one-line form was typed `string`. A page that only wanted to know whether a stored value was a
handle had to catch the error of `parseHandle`, which loads the error class: 14,980 bytes
minified with esbuild as one file.

## Decision

1. The one-line form, `ev1:<backend>:<chainId>:<address>:<jobId>`, is the one documented stored
   form. Every example stores `formatHandle(handle)`.
2. `parseHandle` and `checkStatus` keep reading two forms: the handle object and the one-line
   form. A string is read only as the one-line form; JSON text is refused. The package is not
   published yet, so no caller holds a stored `JSON.stringify(handle)`, and a third form would
   bring back the problem this decision removes.
3. For a value of neither form, the message names both forms:
   `The handle is invalid: handle. It must be a handle object or its one-line form ev1:<backend>:<chainId>:<address>:<jobId>.`
   The hint of every handle error names both forms too: `Pass the handle object or its one-line
   form, as verify() or a not-confirmed error returned it.`
4. `` export type HandleString = `ev1:${BackendName}:${number}:${Hex}:${string}` ``. `formatHandle`
   returns it; the `verify.submitted` event's `handle`, `ErrorJson.handle` and each
   `ErrorJson.handles[].handle` use it. `checkStatus` keeps `Handle | string`: the template type
   accepts no value that `string` does not. A handle whose job id was redacted, `…:[redacted]`,
   keeps the type but does not resume.
5. `tryParseHandle(value: unknown): Handle | undefined` reads both forms and never throws.
   `isHandleString(value: unknown): value is HandleString` is `true` only for a string that
   `parseHandle` accepts, which is always the one-line form, so the predicate holds. Both live in
   `src/flow/check-handle.ts`, which imports no error code. `tryParseHandle` alone is about 2.2 KB
   minified with esbuild as one file.
6. `isHandleString` is a type predicate. Decision 0009 said `parseHandle` uses none;
   `parseHandle` still uses none. `scripts/type-escapes.json` allows the one predicate in
   `check-handle.ts`, because TypeScript narrows a `string` to a template literal type only
   through a predicate.
7. The redaction of a one-line handle keeps the type. `splitHandle` returns a prefix typed
   `` `ev1:${BackendName}:${number}:${Hex}:` ``, so it now also checks that the backend is known,
   that the chain id is a number as JavaScript writes it (possibly `NaN` for a handle built by
   untyped code), and that the address starts with `0x`. Text it cannot split, which only code
   that bypasses the types can put in a `verify.submitted` event, becomes `ev1:<backend>:0:0x:`
   followed by the text redacted whole; that line does not parse.

## Consequences

- A breaking change before 0.1.0: `formatHandle`, the event and `ErrorJson` change type, and code
  that assigns a plain `string` to them no longer compiles.
- The checks move out of `src/flow/handle.ts` into `src/flow/check-handle.ts`, which joins
  mutation testing with its own floor.

## Alternatives considered

- Also read the JSON text of a handle object. Rejected: no stored JSON text exists before the
  first release, and three forms are what caused the issue.
- Name the check `isHandle`. Rejected: it narrows to `HandleString`, not to `Handle`, and is false
  for a handle object.
- Return a result object from `tryParseHandle`, as Zod's `safeParse` does. Rejected for now: the
  issues of a bad handle are what `parseHandle` throws, and a caller who needs them calls it.
