# 0061: Hints name values in words, and `hintFor` gives a hint for a tool's end users

Status: Accepted (2026-11-10). Amends the hint point of
[decision 0044](0044-errors-narrow-by-code-and-carry-a-brand.md), section 5, and extends R-DX-3.

Research: [hints that reach a wrapper's users](../research/2026-11-10-hints-for-wrappers.md),
from issue [#286](https://github.com/aelmanaa/explorer-verify/issues/286), on field paths in hints,
and issue [#298](https://github.com/aelmanaa/explorer-verify/issues/298), from the Remix
contract-verification plugin integration, where library hints such as "call verify() again once
the explorer shows it" reached the IDE's terminal. The CLI met the same problem first;
[decision 0049](0049-error-details-in-json-and-cli-hints.md) gave it its own hints.

## Context

12 of the 26 default hints named a field path as a word of the sentence, such as "report
details.status and details.excerpt". A tool that wraps explorer-verify maps the error onto its own
class, often as `${error.message} ${error.hint}`, and its error has no `details`, or holds it under
another name. The `cancelled` hint named the CLI's `status` command, though the library has
`checkStatus`.

Every hint is written for the developer who calls the library. It names functions such as
`verify()` and options such as `timeoutMs`. A tool's own users, in an IDE, a dapp or a receipt,
cannot act on them, and the library gave a tool nothing else to show.

## Decision

1. A library hint names each value in words. A field path, such as `details.retryAfterMs`, may
   follow only in parentheses: "Wait as long as the explorer asked (details.retryAfterMs), ...".
   With every parenthesised part removed, no hint holds `details.`, `options.` or `error.`. A test
   checks `ERROR_HINTS` and each hint literal in the core's source. Functions and option names
   stay: the audience is the developer.
2. The `cancelled` hint says to resume each handle with `checkStatus`, not with the CLI's command.
3. `hintFor(error, audience)` is exported from `explorer-verify/errors` and, like the other error
   names (decision 0055), from `explorer-verify`. `"developer"` returns `error.hint`. Any other
   audience value returns the user hint: one or two sentences that name no function, option, field
   or CLI command and hold no parenthesis. It takes the error or its JSON form, from `toJSON()` or
   an envelope. It never throws: it reads each field in a `try`, so a non-object, missing details,
   a throwing getter or a revoked `Proxy` gets the general hint. A code counts only as an own key
   of the table, so `"toString"` or `"__proto__"` gets the general hint too.
4. The end-user hint is one fixed sentence per code, in a table in its own module,
   `src/user-hints.ts`, which nothing else imports. Three cases read the details:
   - `rate-limited` with a usable `retryAfterMs` names the wait, rounded up: in seconds below 120
     seconds, in minutes up to one hour, and "Try again later" above one hour;
   - `unexpected-response` whose excerpt holds "Unable to locate ContractCode at", the answer of the
     Etherscan-style APIs (Etherscan, Routescan, Etherscan-compatible explorers) while they have not
     indexed the contract, says the explorer has not found the contract yet. The client and
     `hintFor` read the phrase from one module, `src/not-indexed.ts`;
   - `cancelled` with a non-empty `handle` or a non-empty `handles` list says the explorer accepted
     the submission, and asks the user to check the contract's page before submitting again.

   A code this copy does not know, such as one from a newer copy's JSON, gets a general hint.

5. Each error page gains a "For end users:" line after "Default hint:", equal to the hint of the
   code's sample details without the optional fields that change it. A test keeps the pages equal
   to the source.
6. Hint text is not API. The table's keys and type, and the rule that an error carries its code's
   default hint when no specific hint applies, are. A change to a hint's words is not a breaking
   change; callers switch on `error.code`. R-DX-3 now states it: hint text may change in any release. The CLI, which
   rewrites library hints word by word, ships in the same release, and its rewrite table now maps
   the parenthesised forms.

## Size

Measured with esbuild 0.28.2 and Node 24.21.0 zlib on 2026-11-10, main 9d55a2a plus this change,
in bytes gzipped.

| Entry                                  | Main 9d55a2a | This change | Ceiling | New ceiling |
| -------------------------------------- | ------------ | ----------- | ------- | ----------- |
| `errors` (`export *` from the subpath) | 5,269        | 6,686       | 6,278   | 8,024       |
| `index` (`export *` from the main)     | 28,969       | 30,460      | 31,510  | 31,510      |
| `verify`                               | 17,643       | 17,741      | 19,738  | 19,738      |
| `createVerifyHandler`                  | 14,277       | 14,358      | 14,429  | 14,429      |

`hintFor` alone is 1,942 bytes gzipped, one file, from `explorer-verify/errors`. A bundle that
does not import it holds none of its text: `import { verify }` and `import { ERROR_HINTS }` grow
only by the longer default hints, about 100 bytes. The `export *` entries grow by the end-user
table. By the rule of [decision 0014](0014-measured-bundle-ceilings.md), the `errors` ceiling
becomes the measured size plus 20%. `name-budget.json` gains a row for `hintFor` from each entry.

`createVerifyHandler` keeps 71 bytes under its ceiling. The server handler bundles `ERROR_HINTS`,
so a later change that lengthens a default hint by a sentence or two can pass it. That change then
trims the hint or resets the ceiling by decision 0014's rule.

## Alternatives considered

| Option                                                 | For                                | Against                                                                                         |
| ------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| Export `USER_HINTS`, a table per code (issue #298, A)  | Smallest API                       | Cannot read the details, so no wait time, no not-indexed case, no cancel with a handle          |
| A `userHint` field on every error                      | No import needed                   | Every bundle with the error class carries the text, the cost decision 0044 removed              |
| Drop field paths from the default hints                | Shorter hints                      | A developer who reads `error.details` loses the pointer to the field                            |
| Name the explorer in the end-user hint, from `backend` | "Etherscan has not indexed it yet" | The message already names it; a table of display names adds bytes and one more text to maintain |

## Consequences

- `error.hint` reads correctly in a wrapper's own error class; the field path is a pointer, not a
  word of the sentence.
- A tool shows `hintFor(error, "user")` to its own users and keeps `error.hint` for its logs.
- The Hardhat and Foundry helpers keep their own hints, which still name `options.` and `details.`
  fields; they follow the same rule in a later change.
- A new code needs an end-user hint: the table is typed by `ErrorCode`, so it does not compile
  without one.
