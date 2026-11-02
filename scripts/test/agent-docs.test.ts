import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  anchors,
  checkAgentDocs,
  GITHUB_BLOB,
  githubSlug,
  markdownLinks,
  missingFromPack,
  packageDocs,
  packagedDocFiles,
  packagedLlmsTxt,
  packedFiles,
  rewriteForPackage,
  writeVersions,
} from "../agent-docs.ts";

const README = "docs/user/README.md";
const AGENT = "docs/user/guides/using-from-an-agent.md";

const LLMS_TXT = `# explorer-verify

> Verifies contract source on block explorers.

## User docs

- [Index](${GITHUB_BLOB}${README}): the index
- [Agents](${GITHUB_BLOB}${AGENT}): the agent page
`;

/** A fixture tree that passes every rule. Tests break one rule each. */
const VALID: Record<string, string> = {
  "packages/explorer-verify/package.json": JSON.stringify({ version: "1.2.3" }),
  "llms.txt": LLMS_TXT,
  [README]: `# User docs

Version: explorer-verify 1.2.3

Agents: [llms.txt](../../llms.txt).

See [the agent page](guides/using-from-an-agent.md#api-keys) and [AGENTS](../../AGENTS.md).
`,
  [AGENT]: `# Using explorer-verify from an agent

Version: explorer-verify 1.2.3

Agents: [llms.txt](../../../llms.txt).

## API keys

Back to the [index](../README.md#user-docs) and [this section](#api-keys).
`,
  "docs/contributor/notes.md": "# Notes\n\n[Requirements](requirements.md)\n",
  "docs/contributor/requirements.md": "# Requirements\n",
  "AGENTS.md": "# AGENTS\n",
};

let root = "";

function write(files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

function edit(file: string, from: string, to: string): void {
  const text = readFileSync(path.join(root, file), "utf8");
  assert.ok(text.includes(from), `${file} has no ${from}`);
  writeFileSync(path.join(root, file), text.replace(from, to));
}

function assertProblem(pattern: RegExp): void {
  const problems = checkAgentDocs(root);
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `expected a problem matching ${pattern}, got:\n${problems.join("\n")}`,
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agent-docs-"));
  write(VALID);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("checkAgentDocs", () => {
  it("passes a tree that follows every rule", () => {
    assert.deepEqual(checkAgentDocs(root), []);
  });

  describe("llms.txt (R-AX-1)", () => {
    it("fails when llms.txt is missing", () => {
      rmSync(path.join(root, "llms.txt"));
      assertProblem(/llms\.txt: missing/);
    });

    it("fails without an H1", () => {
      edit("llms.txt", "# explorer-verify", "explorer-verify");
      assertProblem(/first line must be an H1/);
    });

    it("fails without a summary blockquote", () => {
      edit("llms.txt", "> Verifies", "Verifies");
      assertProblem(/no summary blockquote/);
    });

    it("fails without an H2 section", () => {
      edit("llms.txt", "## User docs", "User docs");
      assertProblem(/no H2 section/);
    });

    it("fails on a relative link", () => {
      edit("llms.txt", `${GITHUB_BLOB}${README}`, README);
      assertProblem(/llms\.txt:7: link docs\/user\/README\.md is relative/);
    });

    it("fails when a user page is not listed", () => {
      write({ "docs/user/extra.md": VALID[README] ?? "" });
      assertProblem(/does not list docs\/user\/extra\.md/);
    });

    it("fails when it lists a file that does not exist", () => {
      edit(
        "llms.txt",
        "## User docs\n",
        `## User docs\n\n- [Gone](${GITHUB_BLOB}docs/user/gone.md)\n`,
      );
      assertProblem(/names docs\/user\/gone\.md, which does not exist/);
    });
  });

  describe("user pages (R-AX-2, R-AX-3)", () => {
    it("fails when the agent page is missing", () => {
      rmSync(path.join(root, AGENT));
      assertProblem(/using-from-an-agent\.md: missing/);
    });

    it("fails without a version line", () => {
      edit(README, "Version: explorer-verify 1.2.3", "Version 1.2.3");
      assertProblem(/README\.md: no line `Version: explorer-verify 1\.2\.3`/);
    });

    it("fails when the version line is below line 10", () => {
      edit(
        README,
        "Version: explorer-verify 1.2.3",
        `${"\n".repeat(10)}Version: explorer-verify 1.2.3`,
      );
      assertProblem(/README\.md: no line `Version/);
    });

    it("fails when the version does not match the package", () => {
      edit(AGENT, "explorer-verify 1.2.3", "explorer-verify 1.0.0");
      assertProblem(/states version 1\.0\.0, but packages\/explorer-verify is 1\.2\.3/);
    });

    it("fails without a link to llms.txt in the first 10 lines", () => {
      edit(README, "[llms.txt](../../llms.txt)", "llms.txt");
      assertProblem(/README\.md: no relative link to the root llms\.txt/);
    });

    it("fails when the llms.txt link does not reach the root one", () => {
      edit(AGENT, "../../../llms.txt", "../../llms.txt");
      assertProblem(/using-from-an-agent\.md: no relative link to the root llms\.txt/);
    });
  });

  describe("relative links under docs/", () => {
    it("fails on a link to a missing file", () => {
      edit("docs/contributor/notes.md", "requirements.md", "roadmap.md");
      assertProblem(
        /docs\/contributor\/notes\.md:3: link roadmap\.md points to docs\/contributor\/roadmap\.md, which does not exist/,
      );
    });

    it("fails on a link to a missing heading in another file", () => {
      edit(README, "#api-keys", "#keys");
      assertProblem(/README\.md:7: link guides\/using-from-an-agent\.md#keys names a heading/);
    });

    it("fails on a link to a missing heading in the same file", () => {
      edit(AGENT, "(#api-keys)", "(#keys)");
      assertProblem(/using-from-an-agent\.md:9: link #keys names a heading/);
    });

    it("fails on a link that leaves the repository", () => {
      edit("docs/contributor/notes.md", "requirements.md", "../../../outside.md");
      assertProblem(/leaves the repository/);
    });

    it("ignores links in code and absolute links", () => {
      write({
        "docs/contributor/code.md":
          "# Code\n\n`[x](missing.md)`\n\n```md\n[y](missing.md)\n```\n\n[z](https://example.com/missing.md)\n",
      });
      assert.deepEqual(checkAgentDocs(root), []);
    });
  });
});

describe("githubSlug and anchors", () => {
  it("follows GitHub heading slug rules", () => {
    assert.equal(githubSlug("Agent readiness (R-AX)"), "agent-readiness-r-ax");
    assert.equal(githubSlug("The `files` field"), "the-files-field");
    assert.equal(githubSlug("[Link](x.md) and **bold**"), "link-and-bold");
    assert.equal(githubSlug("Diátaxis layout"), "diátaxis-layout");
  });

  it("numbers repeated headings and reads HTML anchors", () => {
    const found = anchors('# A\n\n## A\n\n```\n# Not a heading\n```\n\n<a id="custom"></a>\n');
    assert.deepEqual([...found].toSorted(), ["a", "a-1", "custom"]);
  });

  it("reads reference definitions and angle-bracket targets", () => {
    const links = markdownLinks("[a](<b c.md>)\n\n[ref]: ref.md\n");
    assert.deepEqual(
      links.map((link) => link.target),
      ["b c.md", "ref.md"],
    );
  });
});

describe("writeVersions", () => {
  it("sets the version line of each user page to the package version", () => {
    edit(AGENT, "explorer-verify 1.2.3", "explorer-verify 1.0.0");
    assert.deepEqual(writeVersions(root), [AGENT]);
    assert.deepEqual(checkAgentDocs(root), []);
  });
});

describe("packaging (R-AX-2)", () => {
  it("rewrites links for the package", () => {
    const text = rewriteForPackage(
      AGENT,
      "[i](../../../llms.txt) [r](../README.md#user-docs) [c](../../contributor/x.md#y) [s](#z) [w](https://example.com) `[k](../../k.md)`\n\n[ref]: ../../../AGENTS.md\n",
    );
    assert.equal(
      text,
      `[i](../../llms.txt) [r](../README.md#user-docs) [c](${GITHUB_BLOB}docs/contributor/x.md#y) [s](#z) [w](https://example.com) \`[k](../../k.md)\`\n\n[ref]: ${GITHUB_BLOB}AGENTS.md\n`,
    );
  });

  it("makes llms.txt links to user pages relative", () => {
    const packaged = packagedLlmsTxt(
      `[a](${GITHUB_BLOB}docs/user/README.md) [b](${GITHUB_BLOB}AGENTS.md)`,
    );
    assert.equal(packaged, `[a](docs/README.md) [b](${GITHUB_BLOB}AGENTS.md)`);
  });

  it("writes the docs and llms.txt into the package", () => {
    const packageDir = path.join(root, "packages/explorer-verify");
    write({ "packages/explorer-verify/docs/stale.md": "old" });
    const written = packageDocs(root, packageDir);
    assert.deepEqual(written, packagedDocFiles(root).slice(1).concat("llms.txt"));
    assert.match(readFileSync(path.join(packageDir, "llms.txt"), "utf8"), /\(docs\/README\.md\)/);
    assert.match(
      readFileSync(path.join(packageDir, "docs/README.md"), "utf8"),
      /\[llms\.txt\]\(\.\.\/llms\.txt\)/,
    );
    assert.throws(() => readFileSync(path.join(packageDir, "docs/stale.md")));
  });

  it("lists the files the tarball must hold", () => {
    assert.deepEqual(packagedDocFiles(root), [
      "llms.txt",
      "docs/README.md",
      "docs/guides/using-from-an-agent.md",
    ]);
  });

  it("finds the files the tarball lacks", () => {
    const output = JSON.stringify([
      { files: [{ path: "llms.txt" }, { path: "docs/README.md" }, {}] },
    ]);
    assert.deepEqual(packedFiles(output), ["llms.txt", "docs/README.md"]);
    assert.deepEqual(missingFromPack(packedFiles(output), packagedDocFiles(root)), [
      "docs/guides/using-from-an-agent.md",
    ]);
    assert.throws(() => packedFiles("{}"), /no file list/);
  });
});
