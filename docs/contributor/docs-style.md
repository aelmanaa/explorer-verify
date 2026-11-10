# Docs style

Audience: contributors who write or rewrite pages under `docs/user/`.

This page sets the density and style of the user docs. Most rules are enforced: `pnpm run check`
runs `scripts/check-agent-docs.ts`, which applies the rules in `scripts/docs-style.ts` to every
user page. Their unit tests are in `scripts/test/docs-style.test.ts`.

## Legacy pages

Pages written before these rules hold this line after their H1:

```md
<!-- docs-style: legacy -->
```

The check skips the style rules on such a page. Its `ts` examples may still use `input` and
`built` without defining them. The issue that rewrites a page removes the line, and the page must
then pass every rule below. A new page never gets the line.

## Paragraphs

- Keep a paragraph to about 50 words. The check fails a paragraph, list item or quote over 80.
- Use at most 4 code spans in one sentence. Put a longer set in a list or a table.
- Give each H2 one idea. Split a section that answers two questions.

`pnpm run check` prints each page's block count, average and longest word count. Use it to see
which pages are dense.

## Guides and quickstarts

Pages under `guides/`, `start/` and `tutorials/` follow one shape:

- a "For:" line that names the reader, and a "You need:" line that lists the prerequisites, both in
  the first 15 lines;
- the task, one step per H2;
- a "Next steps" H2 last, with links to what the reader does next.

The check fails a guide without the two lines, or whose last H2 is not "Next steps".

## Code blocks

- End the sentence that introduces a code block with a colon. An output block that follows a
  command block needs no introduction.
- Give a block that is a file a title after the language, as in `ts [verify.ts]`. A flag comes
  before the title: `ts no-run [verify.ts]`. GitHub reads the first word as the language.
- Show the output after a command, in a `text` block.
- Start every CLI example with `npx @explorer-verify/cli`. A bare `explorer-verify` fails after a
  local install with exit 127. Split a long command over lines that end in `\`.

The check fails a block whose introducing line does not end with a colon. It also fails a `sh`,
`bash`, `shell`, `console` or `zsh` line that starts with a bare `explorer-verify`. A `text` block,
such as the usage lines of the CLI reference, may show the bare name.

The dry run in [Verify from CI with the CLI](../user/guides/verify-from-ci-with-the-cli.md) has
this shape, and the CLI page tests run it:

```sh [dry-run.sh]
# exit code 0
npx @explorer-verify/cli verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \
  --chain 11155111 --foundry . --contract src/Greeter.sol:Greeter \
  --backend sourcify --dry-run --json
```

The example tests read titles and continuations. On a page without the legacy line, a `ts`
example is type-checked without the `input` and `built` globals, so it must define what it uses.
The keys, `deployerAddress` and `request` stay predefined.

## Callouts

Use GitHub alerts for notes and warnings:

```md
> [!WARNING]
> A submit cannot be undone.
```

The check fails a paragraph that starts with a label such as `Note:` or `**Warning:**`. The alert
types are `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` and `[!CAUTION]`.

## Sources

Keep research dates and citations out of the task text. Put them in a "Sources" H2 at the end of
the page, before "Next steps" in a guide:

```md
## Sources

- Etherscan API v2 documentation, read 2026-11-04.
```

The check fails a dated citation, such as "read 2026-11-04" or "fetched on 2026-11-04", outside
that H2. The research notes under `docs/contributor/research/` hold the full evidence.
