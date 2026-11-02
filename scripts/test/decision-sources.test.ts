import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  checkDecisionSources,
  NO_RESEARCH_LINE,
  RESEARCH_INDEX,
  sourcesSection,
} from "../decision-sources.ts";
import { edit, makeFixture, removeFixture, writeFiles } from "./fixture.ts";

const BACKED = "docs/contributor/decisions/0001-backed.md";
const CHOICE = "docs/contributor/decisions/0002-choice.md";
const NOTE = "docs/contributor/research/2026-01-01-topic.md";
const NOTE_LINK = "../research/2026-01-01-topic.md";

/** Decision records and research notes that follow the sources rule. */
const SOURCES: Readonly<Record<string, string>> = {
  [BACKED]: `# 0001: Backed

## Context

See [the research](${NOTE_LINK}#question).
`,
  [CHOICE]: `# 0002: Choice

${NO_RESEARCH_LINE}
`,
  "docs/contributor/decisions/README.md": "# Decisions\n\nNo research here.\n",
  "docs/contributor/decisions/notes.md": "# Not a record\n",
  [NOTE]: `# 2026-01-01: Topic

## Question

A fact ([docs](https://example.com/docs), read 2026-01-01).

## Sources

\`\`\`text
## Not a heading
\`\`\`

- [Example docs](https://example.com/docs), read 2026-01-01.

### Local runs

- gh 2.92.0, run 2026-01-01.

## After
`,
  [RESEARCH_INDEX]: "# Research\n\n| [2026-01-01-topic.md](2026-01-01-topic.md) | Topic |\n",
};

let root = "";

/** Asserts that the check reports exactly one problem per pattern, each matching its pattern. */
function assertProblems(...patterns: RegExp[]): void {
  const problems = checkDecisionSources(root);
  assert.equal(
    problems.length,
    patterns.length,
    `expected ${patterns.length} problems, got:\n${problems.join("\n")}`,
  );
  for (const pattern of patterns) {
    assert.ok(
      problems.some((problem) => pattern.test(problem)),
      `expected a problem matching ${pattern}, got:\n${problems.join("\n")}`,
    );
  }
}

beforeEach(() => {
  root = makeFixture();
  writeFiles(root, SOURCES);
});

afterEach(() => {
  removeFixture(root);
});

describe("checkDecisionSources", () => {
  it("passes decisions and notes that follow the rule", () => {
    assertProblems();
  });

  it("passes a tree with no decisions and no research", () => {
    rmSync(path.join(root, "docs/contributor/decisions"), { recursive: true });
    rmSync(path.join(root, "docs/contributor/research"), { recursive: true });
    assertProblems();
  });

  describe("decision records", () => {
    it("fails when a record has neither a research link nor the none line", () => {
      edit(root, CHOICE, NO_RESEARCH_LINE, "Research: none.");
      assertProblems(/^docs\/contributor\/decisions\/0002-choice\.md: links no research note/);
    });

    it("does not count an absolute link to a research note", () => {
      edit(
        root,
        BACKED,
        `(${NOTE_LINK}#question)`,
        "(https://github.com/aelmanaa/explorer-verify/blob/main/docs/contributor/research/2026-01-01-topic.md)",
      );
      assertProblems(/0001-backed\.md: links no research note/);
    });

    it("does not count a link to another folder", () => {
      edit(root, BACKED, NOTE_LINK, "README.md");
      assertProblems(/0001-backed\.md: links no research note/);
    });

    it("fails when a record links a research note that does not exist", () => {
      edit(root, BACKED, NOTE_LINK, "../research/2026-01-01-missing.md");
      assertProblems(
        /^docs\/contributor\/decisions\/0001-backed\.md:5: links docs\/contributor\/research\/2026-01-01-missing\.md, which is not a research note/,
      );
    });

    it("does not count the research index or folder as a note", () => {
      edit(root, BACKED, NOTE_LINK, "../research/");
      assertProblems(/0001-backed\.md:5: links docs\/contributor\/research, which is not/);
    });

    it("fails when a record links research and also says none", () => {
      edit(root, BACKED, "## Context", `${NO_RESEARCH_LINE}\n\n## Context`);
      assertProblems(/0001-backed\.md: links research and also says/);
    });

    it("accepts the none line with trailing spaces", () => {
      edit(root, CHOICE, NO_RESEARCH_LINE, `${NO_RESEARCH_LINE}  `);
      assertProblems();
    });

    it("rejects the none line with other text on it", () => {
      edit(root, CHOICE, NO_RESEARCH_LINE, `- ${NO_RESEARCH_LINE}`);
      assertProblems(/0002-choice\.md: links no research note/);
    });

    it("checks only NNNN-*.md files directly in the decisions folder", () => {
      writeFiles(root, { "docs/contributor/decisions/old/0003-nested.md": "# 0003: Nested\n" });
      assertProblems();
    });
  });

  describe("research notes", () => {
    it("fails when a note has no Sources section", () => {
      edit(root, NOTE, "## Sources", "## References");
      assertProblems(
        /^docs\/contributor\/research\/2026-01-01-topic\.md: has no `## Sources` section/,
      );
    });

    it("fails when the Sources section has no http or https link", () => {
      edit(
        root,
        NOTE,
        "- [Example docs](https://example.com/docs), read 2026-01-01.",
        "- [Prior art](../prior-art.md), read 2026-01-01.",
      );
      assertProblems(/2026-01-01-topic\.md: the `## Sources` section has no http or https link/);
    });

    it("does not count a link after the Sources section ends", () => {
      edit(
        root,
        NOTE,
        "- [Example docs](https://example.com/docs), read 2026-01-01.",
        "Read 2026-01-01.",
      );
      edit(root, NOTE, "## After\n", "## After\n\n[Later](https://example.com/later)\n");
      assertProblems(/the `## Sources` section has no http or https link/);
    });

    it("fails when a note is not listed in the research index", () => {
      writeFiles(root, { [RESEARCH_INDEX]: "# Research\n" });
      assertProblems(
        /^docs\/contributor\/research\/2026-01-01-topic\.md: not listed in docs\/contributor\/research\/README\.md/,
      );
    });

    it("fails for every note when the research index is missing", () => {
      rmSync(path.join(root, RESEARCH_INDEX));
      assertProblems(/2026-01-01-topic\.md: not listed/);
    });

    it("reports every problem of a note", () => {
      writeFiles(root, { "docs/contributor/research/2026-01-02-bare.md": "# Bare\n" });
      assertProblems(/2026-01-02-bare\.md: has no `## Sources`/, /2026-01-02-bare\.md: not listed/);
    });
  });
});

describe("sourcesSection", () => {
  it("returns the lines up to the next heading of level 1 or 2", () => {
    const section = sourcesSection(
      "# Note\n\n## Sources\n\n- one\n\n### Sub\n\n- two\n\n# End\n\n- three\n",
    );
    assert.equal(section, "\n- one\n\n### Sub\n\n- two\n");
  });

  it("returns undefined without a Sources heading at level 2", () => {
    assert.equal(sourcesSection("# Sources\n\n### Sources\n\n## Source\n"), undefined);
  });

  it("returns an empty section for a Sources heading at the end", () => {
    assert.equal(sourcesSection("# Note\n\n## Sources"), "");
  });
});
