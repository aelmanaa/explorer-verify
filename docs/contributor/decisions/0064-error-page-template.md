# 0064: One template for error code pages, with the fix first

Status: Accepted (2026-11-10). Amends the page layout in "Error docs: one page per code" of
[decision 0015](0015-docs-site-versioning-and-error-pages.md). The paths, `docsUrl` and the four
tests of 0015 do not change.

Research: [research/2026-11-10-docs-audit.md](../research/2026-11-10-docs-audit.md), findings F11
and F12.

## Context

Issue [#321](https://github.com/aelmanaa/explorer-verify/issues/321), part of
[#303](https://github.com/aelmanaa/explorer-verify/issues/303). Decision 0015 gave each code page
the labelled lines `Cause:`, `Fix:`, `Default hint:`, `Retryable:` and `Exit code:`, in that
order. The 2026-11-10 audit found that the fix came after the cause: on `source-mismatch`, 76 words
came before it. No page said whether the call had sent anything to an explorer, and no page showed
how to handle the error in code (F11). The errors index had three H3 headings before its first H2
(F12).

## Decision

A code page follows one template:

1. The code as its H1, the version line, the `llms.txt` line, then a one-sentence summary.
2. `## How to fix`, with the `Fix:` and `From the CLI:` lines.
3. `## Facts`, with `Retryable:`, `Exit code:`, `Sent to an explorer:`, `Default hint:` and
   `For end users:`.
4. `## Why`, with the `Cause:` line and the details fields.
5. `## In code`, with a short `ts` block that checks the error's code.

Rules that go with it:

- The fix starts within 40 words of the H1.
- `Sent to an explorer:` answers `no`, `yes`, `maybe` or `unknown`, with one sentence that says
  whether the explorer may hold a submission from the call.
- A page may add H2s between "Why" and "In code" for a case of its own, such as
  `network`'s module that fails to load.
- The line for a tool's end users, `For end users:`, goes in "Facts", right after `Default hint:`.
  It states what `hintFor(error, "user")` returns
  ([decision 0061](0061-hint-wording-and-end-user-hints.md)), and `error-pages.test.ts` compares
  the two.
- The `In code` block is a `ts no-run` block: the docs tests type-check it, so the narrowed
  `details` fields it reads must exist. It defines a handler and calls nothing, so a run would
  print nothing and only add time to the docs tests. A code that only the CLI creates,
  `cancelled` and `internal-error`, shows a check on the `ErrorJson` of the CLI's `--json`
  output.

The errors index opens with `## Handle an error`: an example that checks `error.code`, then how to
recognise an error and what the CLI prints. The list of codes follows, with one line per code.

## Alternatives considered

- A Markdown table for the facts, as the audit suggested. Not taken: the CLI tests, the black-box
  tests and agents read `Retryable: yes` and `Exit code: 2` as lines. Four short lines read as fast
  as a table.
- A generated page per code from the catalogue in `src/errors.ts`. Not taken: the cause and the fix
  need prose that the catalogue does not hold. The tests check each page's hint, retry flag and exit
  code against the catalogue, as before.

## Consequences

- `error-pages.test.ts` checks the H2 order, the section of each labelled line, the 40-word limit,
  the one-sentence summary and the `In code` block of every page.
- The index's first example builds the input with the Foundry helper, so it compiles without the
  `input` global, and the page passes the docs style check.
