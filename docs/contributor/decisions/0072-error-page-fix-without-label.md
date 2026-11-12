# 0072: Error pages give the fix without a "Fix:" label

Status: Accepted (2026-11-12). Amends [0064](0064-error-page-template.md) point 2.

Research: none (maintainer choice).

## Context

Issue [#379](https://github.com/aelmanaa/explorer-verify/issues/379). Decision 0064 put a `Fix:`
line under the `## How to fix` heading of each error page. On the site, a reader sees "How to fix",
then "Fix: call again, or raise `timeoutMs`": the label repeats the heading. The error's `hint`, in
the CLI's output and in the JSON envelope, is a separate text that a page states on its
`Default hint:` line. It does not change.

## Decision

1. The first paragraph under `## How to fix` is the fix, written as a sentence with no label. The
   `From the CLI:` line follows it, as before.
2. `error-pages.test.ts` fails a page whose fix paragraph starts with a label or a lower-case
   letter, and a page with a `Fix:` line anywhere. The 40-word limit counts the words before the
   `## How to fix` heading.
3. The other labelled lines (`From the CLI:`, `Retryable:`, `Exit code:`, `Sent to an explorer:`,
   `Default hint:`, `For end users:`, `Cause:`) stay. Agents and tests read them as lines, and none
   repeats its heading.

## Consequences

- Every error page changes its fix line; the hints in `src/errors.ts`, the CLI output and the
  envelope do not change.
- R-AX-10's test row in [testing.md](../testing.md) names the fix paragraph instead of `Fix:`.
