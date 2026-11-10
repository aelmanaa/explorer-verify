import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  checkDocsStyle,
  codeSpansPerSentence,
  densityReport,
  isGuide,
  isLegacy,
  LEGACY_MARKER,
  MAX_CODE_SPANS,
  MAX_WORDS,
  pageDensity,
  styleProblems,
  wordCount,
} from "../docs-style.ts";
import { makeFixture, removeFixture, writeFiles } from "./fixture.ts";

const FILE = "docs/user/guides/verify-x.md";
const PAGE = "guides/verify-x.md";

/** A guide that follows every rule. */
const GUIDE = `# Verify X

Version: explorer-verify 1.2.3

Agents: [llms.txt](../../../llms.txt).

For: people who verify X.

You need: Node 22.18 and a deployed contract.

## Verify

Run the command:

\`\`\`sh [verify.sh]
npx @explorer-verify/cli verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc \\
  --chain 11155111 --dry-run --json
\`\`\`

\`\`\`text
{"ok":true}
\`\`\`

> [!NOTE]
> The dry run submits nothing.

| Flag | Meaning |
| ---- | ------- |
| \`--json\` | prints JSON |

Import it:

<!-- no-run: it needs a live explorer -->

\`\`\`ts no-run [verify.ts]
import { verify } from "explorer-verify";
\`\`\`

::: code-group

\`\`\`ts [a.ts]
const a = 1;
\`\`\`

:::

## Sources

- Etherscan API, read 2026-11-04.

## Next steps

- [Check the status](../reference/check-status.md).
`;

/** The style problems of the guide with `from` replaced by `to`, without the guide-wide suffix. */
function problemsWith(from: string, to: string, file = FILE, page = PAGE): string[] {
  assert.ok(GUIDE.includes(from), `the guide has no ${from}`);
  return styleProblems(file, page, GUIDE.replace(from, to)).map((problem) =>
    problem.replace(/ \(docs\/contributor\/docs-style\.md\)$/, ""),
  );
}

/** `count` words. */
function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `w${index}`).join(" ");
}

describe("styleProblems", () => {
  it("passes a guide that follows every rule", () => {
    assert.deepEqual(styleProblems(FILE, PAGE, GUIDE), []);
  });

  it("skips a page with the legacy marker", () => {
    const broken = GUIDE.replace("For:", "Audience:").replace("Run the command:", "Run it.");
    assert.notDeepEqual(styleProblems(FILE, PAGE, broken), []);
    const legacy = broken.replace("# Verify X\n", `# Verify X\n\n${LEGACY_MARKER}\n`);
    assert.ok(isLegacy(legacy));
    assert.deepEqual(styleProblems(FILE, PAGE, legacy), []);
    assert.ok(!isLegacy(`Text ${LEGACY_MARKER}`));
  });

  it(`fails a paragraph, a list item and a quote over ${MAX_WORDS} words`, () => {
    assert.deepEqual(problemsWith("Run the command:", `${words(MAX_WORDS - 2)} run the command:`), [
      `${FILE}:13: a paragraph of 81 words; keep it near 50 and at most 80`,
    ]);
    assert.deepEqual(problemsWith("Run the command:", `${words(MAX_WORDS - 1)} run:`), []);
    assert.deepEqual(problemsWith("- Etherscan API", `- ${words(MAX_WORDS - 3)} Etherscan API`), [
      `${FILE}:49: a list item of 81 words; keep it near 50 and at most 80`,
    ]);
    assert.deepEqual(problemsWith("> The dry run", `> ${words(MAX_WORDS - 5)} The dry run`), [
      `${FILE}:24: a quote of 81 words; keep it near 50 and at most 80`,
    ]);
  });

  it("counts a paragraph over its lines, until a blank line, a heading or a fence", () => {
    const split = `${words(40)}\n${words(40)}\nrun the command:`;
    assert.deepEqual(problemsWith("Run the command:", split), [
      `${FILE}:13: a paragraph of 83 words; keep it near 50 and at most 80`,
    ]);
    assert.deepEqual(problemsWith("Run the command:", `${words(40)}\n\n${words(40)} run:`), []);
  });

  it(`fails a sentence with more than ${MAX_CODE_SPANS} code spans`, () => {
    const spans = "Use `a`, `b`, `c`, `d` and `e`. Then run the command:";
    assert.deepEqual(problemsWith("Run the command:", spans), [
      `${FILE}:13: a sentence with 5 code spans; use at most 4, or a list or a table`,
    ]);
    assert.deepEqual(
      problemsWith("Run the command:", "Use `a`, `b`, `c` and `d`. Then `e`, run the command:"),
      [],
    );
  });

  it("fails a code block whose introducing line does not end with a colon", () => {
    assert.deepEqual(problemsWith("Run the command:", "Run the command."), [
      `${FILE}:15: end the sentence that introduces this code block with a colon`,
    ]);
    assert.deepEqual(problemsWith("Run the command:\n\n", ""), [
      `${FILE}:13: introduce this code block with a sentence that ends with a colon`,
    ]);
    // An output block follows its command block; a container line is skipped.
    assert.deepEqual(problemsWith("::: code-group", "It holds:\n\n::: code-group"), []);
    assert.deepEqual(problemsWith("::: code-group", "It holds two files.\n\n::: code-group"), [
      `${FILE}:43: end the sentence that introduces this code block with a colon`,
    ]);
    assert.deepEqual(
      styleProblems("docs/user/x.md", "x.md", "```sh\nls\n```\n").map((problem) =>
        problem.replace(/ \(.*\)$/, ""),
      ),
      ["docs/user/x.md:1: introduce this code block with a sentence that ends with a colon"],
    );
  });

  it("fails a labelled callout instead of a GitHub alert", () => {
    for (const label of ["Note:", "**Note:**", "**Warning**:", "__Tip:__", "IMPORTANT:"]) {
      assert.deepEqual(problemsWith("Run the command:", `${label} it is slow. Run it:`), [
        `${FILE}:13: a labelled callout; use a GitHub alert such as > [!NOTE]`,
      ]);
    }
    assert.deepEqual(problemsWith("Run the command:", "Notes on the run follow:"), []);
  });

  it('fails a dated citation outside the "Sources" H2', () => {
    assert.deepEqual(
      problemsWith("Run the command:", "Etherscan says so (fetched on 2026-11-04). Run it:"),
      [`${FILE}:13: a dated citation outside the "Sources" H2; move it there`],
    );
    assert.deepEqual(problemsWith("Run the command:", "Run `read 2026-11-04`:"), []);
  });

  it("fails a bare explorer-verify command in a shell block", () => {
    for (const command of ["explorer-verify verify 0x1", "$ explorer-verify --help"]) {
      assert.deepEqual(
        problemsWith(
          "npx @explorer-verify/cli verify 0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
          command,
        ),
        [`${FILE}:16: a bare explorer-verify command; start it with npx @explorer-verify/cli`],
      );
    }
    assert.deepEqual(
      problemsWith("```text\n{", "```text\nexplorer-verify verify 0x1\n{"),
      [],
      "a text block may show usage lines",
    );
  });

  it('fails a guide without a "For:" or "You need:" line, or without "Next steps" last', () => {
    assert.deepEqual(problemsWith("For: people", "Audience: people"), [
      `${FILE}:1: a guide needs a "For:" line in its first 15 lines`,
    ]);
    assert.deepEqual(problemsWith("You need: Node", "Needs: Node"), [
      `${FILE}:1: a guide needs a "You need:" line in its first 15 lines`,
    ]);
    assert.deepEqual(problemsWith("## Next steps", "## More"), [
      `${FILE}:51: a guide ends with a "Next steps" H2; the last H2 is "More"`,
    ]);
    // Past the first 15 lines, a line does not count.
    assert.deepEqual(
      problemsWith("For: people who verify X.\n", `${"\n".repeat(10)}For: people.\n`),
      [
        `${FILE}:1: a guide needs a "For:" line in its first 15 lines`,
        `${FILE}:1: a guide needs a "You need:" line in its first 15 lines`,
      ],
    );
    const bare = "# Start\n\nFor: you.\n\nYou need: Node.\n";
    assert.deepEqual(
      styleProblems("docs/user/start/x.md", "start/x.md", bare).map((problem) =>
        problem.replace(/ \(.*\)$/, ""),
      ),
      ['docs/user/start/x.md:1: a guide ends with a "Next steps" H2; the last H2 is missing'],
    );
    assert.deepEqual(
      problemsWith("For: people", "Audience: people", "docs/user/reference/x.md", "reference/x.md"),
      [],
    );
  });
});

describe("the counts", () => {
  it("counts words: a code span or a link text as written", () => {
    assert.equal(wordCount("Run `npx @explorer-verify/cli verify` on [the page](x.md) — now."), 6);
    assert.equal(wordCount(""), 0);
  });

  it("counts the code spans of the busiest sentence; a period in a span does not end it", () => {
    assert.equal(codeSpansPerSentence("`a.b` and `c.d`. Then `e`."), 2);
    assert.equal(codeSpansPerSentence("No code."), 0);
  });

  it("reports the density of a page", () => {
    assert.deepEqual(pageDensity("# Title\n"), { blocks: 0, average: 0, longest: 0 });
    assert.deepEqual(pageDensity("One two.\n\n- three four five six\n"), {
      blocks: 2,
      average: 3,
      longest: 4,
    });
  });

  it("knows the guide folders", () => {
    assert.ok(isGuide("guides/x.md") && isGuide("start/x.md") && isGuide("tutorials/x.md"));
    assert.ok(!isGuide("reference/guides/x.md"));
  });
});

describe("checkDocsStyle and densityReport", () => {
  let root = "";

  beforeEach(() => {
    root = makeFixture();
  });

  afterEach(() => {
    removeFixture(root);
  });

  it("checks every user page of a tree and reports its density", () => {
    assert.deepEqual(checkDocsStyle(root), []);
    assert.deepEqual(densityReport(root), [
      "README.md: 4 blocks, average 3 words, longest 7",
      "guides/using-from-an-agent.md: 3 blocks, average 5 words, longest 11, legacy",
    ]);
    writeFiles(root, { [FILE]: GUIDE.replace("## Next steps", "## More") });
    assert.deepEqual(checkDocsStyle(root), [
      `${FILE}:51: a guide ends with a "Next steps" H2; the last H2 is "More" (docs/contributor/docs-style.md)`,
    ]);
  });
});
