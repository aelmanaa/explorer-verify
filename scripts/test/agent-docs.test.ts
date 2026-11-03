import assert from "node:assert/strict";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  AGENT_PAGE_HEADINGS,
  anchors,
  checkAgentDocs,
  errorCodesOf,
  errorPageFiles,
  githubSlug,
  headings,
  listFiles,
  markdownLinks,
  missingFromPack,
  packageDocs,
  packagedDocFiles,
  packagedLinkProblems,
  packagedLlmsTxt,
  packedFiles,
  RAW_MAIN,
  rewriteForPackage,
  writeVersions,
} from "../agent-docs.ts";
import {
  AGENT,
  edit,
  makeFixture,
  read,
  README,
  removeFixture,
  SKILL,
  writeFiles,
} from "./fixture.ts";

let root = "";

/** Asserts that the check reports exactly one problem per pattern, each matching its pattern. */
function assertProblems(...patterns: RegExp[]): void {
  const problems = checkAgentDocs(root);
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

/** A user page whose line `line` holds `text`, with the other head lines blank. */
function pageWithLineAt(line: number, text: string, other: string): string {
  const lines = ["# Page", other, ...Array.from({ length: 20 }, () => "")];
  lines[line - 1] = text;
  return lines.join("\n");
}

const VERSION = "Version: explorer-verify 1.2.3";
const INDEX_LINK = "[llms.txt](../../llms.txt)";

beforeEach(() => {
  root = makeFixture();
});

afterEach(() => {
  removeFixture(root);
});

describe("checkAgentDocs", () => {
  it("passes a tree that follows every rule", () => {
    assertProblems();
  });

  it("throws when the package has no version", () => {
    for (const manifest of ["{}", "null"]) {
      writeFiles(root, { "packages/explorer-verify/package.json": manifest });
      assert.throws(() => checkAgentDocs(root), /has no version/);
    }
  });

  it("lists no files in a missing folder", () => {
    assert.deepEqual(listFiles(root, "missing"), []);
  });

  describe("llms.txt (R-AX-1)", () => {
    it("reports every rule on an empty llms.txt", () => {
      writeFiles(root, { "llms.txt": "" });
      assertProblems(
        /H1/,
        /summary/,
        /`## User docs`/,
        /`## Contributor docs`/,
        /does not list docs\/user\/README\.md/,
        /does not list docs\/user\/guides/,
        /does not list skills\/explorer-verify\/SKILL\.md/,
      );
    });

    it("fails when llms.txt is missing", () => {
      rmSync(path.join(root, "llms.txt"));
      assertProblems(
        /^llms\.txt: missing at the repository root/,
        /^docs\/user\/README\.md:5: link \.\.\/\.\.\/llms\.txt points to llms\.txt/,
        /^docs\/user\/guides\/using-from-an-agent\.md:5: link \.\.\/\.\.\/\.\.\/llms\.txt points to llms\.txt/,
        /^skills\/explorer-verify\/SKILL\.md:5: link \.\.\/\.\.\/llms\.txt points to llms\.txt/,
      );
    });

    it("fails without an H1", () => {
      edit(root, "llms.txt", "# explorer-verify", "explorer-verify");
      assertProblems(/first line must be an H1/);
    });

    it("fails without a summary blockquote", () => {
      edit(root, "llms.txt", "> Verifies", "Verifies");
      assertProblems(/no summary blockquote/);
    });

    it("fails when the summary comes after the first section", () => {
      edit(
        root,
        "llms.txt",
        "> Verifies contract source on block explorers.\n\n## User docs\n",
        "## User docs\n\n> Verifies.\n",
      );
      assertProblems(/no summary blockquote/);
    });

    it("names a missing User docs section", () => {
      edit(root, "llms.txt", "## User docs", "## Users");
      assertProblems(/no section `## User docs`/);
    });

    it("names a missing Contributor docs section", () => {
      edit(root, "llms.txt", "## Contributor docs", "## Contributors");
      assertProblems(/no section `## Contributor docs`/);
    });

    it("still checks links after `<!--` in inline code", () => {
      edit(root, "llms.txt", "## User docs\n", "## User docs\n\nComments start with `<!--`.\n");
      edit(root, "llms.txt", `${RAW_MAIN}${README}`, README);
      assertProblems(
        /^llms\.txt:9: link docs\/user\/README\.md is relative/,
        /does not list docs\/user\/README\.md/,
      );
    });

    it("fails on a relative link", () => {
      edit(root, "llms.txt", `${RAW_MAIN}${README}`, README);
      assertProblems(
        /^llms\.txt:7: link docs\/user\/README\.md is relative/,
        /does not list docs\/user\/README\.md/,
      );
    });

    it("fails when a user page is not listed", () => {
      writeFiles(root, { "docs/user/extra.md": read(root, README) });
      assertProblems(/does not list docs\/user\/extra\.md/);
    });

    it("fails when it lists a file that does not exist", () => {
      edit(
        root,
        "llms.txt",
        "## User docs\n",
        `## User docs\n\n- [Gone](${RAW_MAIN}docs/user/gone.md)\n`,
      );
      assertProblems(/names docs\/user\/gone\.md, which does not exist/);
    });

    it("fails when a listed file differs in case", () => {
      edit(root, "llms.txt", `${RAW_MAIN}AGENTS.md`, `${RAW_MAIN}agents.md`);
      assertProblems(/names agents\.md, which does not exist/);
    });

    it("fails on a link that leaves the repository", () => {
      edit(root, "llms.txt", `${RAW_MAIN}AGENTS.md`, `${RAW_MAIN}docs/../../AGENTS.md`);
      assertProblems(/llms\.txt:\d+: link .* leaves the repository/);
    });

    for (const [name, prefix] of [
      ["another branch", "https://raw.githubusercontent.com/aelmanaa/explorer-verify/dev/"],
      ["a blob page", "https://github.com/aelmanaa/explorer-verify/blob/main/"],
      ["a tree page", "https://github.com/aelmanaa/explorer-verify/tree/main/"],
    ] as const) {
      it(`does not count a link to ${name} as listing a page`, () => {
        edit(root, "llms.txt", `${RAW_MAIN}${AGENT}`, `${prefix}${AGENT}`);
        assertProblems(
          /llms\.txt:8: link .* is not a raw link to main/,
          /does not list docs\/user\/guides\/using-from-an-agent\.md/,
        );
      });
    }
  });

  describe("skills (R-AX-4)", () => {
    it("fails when llms.txt does not list a skill", () => {
      edit(root, "llms.txt", `- [Skill](${RAW_MAIN}${SKILL}): the skill\n`, "");
      assertProblems(/llms\.txt: does not list skills\/explorer-verify\/SKILL\.md.*\(R-AX-4\)/);
    });

    it("checks the relative links of a skill", () => {
      edit(root, SKILL, "#stop", "#gone");
      assertProblems(/skills\/explorer-verify\/SKILL\.md:5: link #gone names a heading/);
    });
  });

  describe("user pages (R-AX-2, R-AX-3)", () => {
    it("fails when the agent page is missing", () => {
      rmSync(path.join(root, AGENT));
      assertProblems(
        /using-from-an-agent\.md: missing; the agent page is required/,
        /llms\.txt:8: .* which does not exist/,
        /README\.md:7: link guides\/using-from-an-agent\.md#notes points to/,
        /SKILL\.md:5: link \.\.\/\.\.\/docs\/user\/guides\/using-from-an-agent\.md#notes points to/,
      );
    });

    for (const heading of AGENT_PAGE_HEADINGS) {
      it(`names a missing agent page heading: ${heading}`, () => {
        edit(root, AGENT, `## ${heading}\n`, "");
        assertProblems(new RegExp(`has no heading "${heading}"`));
      });
    }

    it("fails on a symbolic link under docs/user", () => {
      symlinkSync("README.md", path.join(root, "docs/user/alias.md"));
      assertProblems(/^docs\/user\/alias\.md: symlinks are not allowed in docs\/user \(R-AX-2\)$/);
    });

    it("does not follow a link to a symbolic link", () => {
      symlinkSync("README.md", path.join(root, "docs/user/alias.md"));
      edit(root, README, "[guides](guides/)", "[guides](alias.md)");
      assertProblems(/symlinks are not allowed/, /link alias\.md points to docs\/user\/alias\.md/);
    });

    it("fails without a version line", () => {
      edit(root, README, VERSION, "Version 1.2.3");
      assertProblems(/^docs\/user\/README\.md: no line `Version: explorer-verify 1\.2\.3`/);
    });

    it("accepts the version line and the llms.txt link on line 10", () => {
      writeFiles(root, { "docs/user/extra.md": pageWithLineAt(10, VERSION, INDEX_LINK) });
      writeFiles(root, { "docs/user/other.md": pageWithLineAt(10, INDEX_LINK, VERSION) });
      edit(
        root,
        "llms.txt",
        "## Contributor docs",
        `- [E](${RAW_MAIN}docs/user/extra.md)\n- [O](${RAW_MAIN}docs/user/other.md)\n\n## Contributor docs`,
      );
      assertProblems();
    });

    it("rejects the version line on line 11", () => {
      writeFiles(root, { "docs/user/extra.md": pageWithLineAt(11, VERSION, INDEX_LINK) });
      edit(
        root,
        "llms.txt",
        "## Contributor docs",
        `- [E](${RAW_MAIN}docs/user/extra.md)\n\n## Contributor docs`,
      );
      assertProblems(/extra\.md: no line `Version/);
    });

    it("rejects the llms.txt link on line 11", () => {
      writeFiles(root, { "docs/user/extra.md": pageWithLineAt(11, INDEX_LINK, VERSION) });
      edit(
        root,
        "llms.txt",
        "## Contributor docs",
        `- [E](${RAW_MAIN}docs/user/extra.md)\n\n## Contributor docs`,
      );
      assertProblems(/extra\.md: no relative link to the root llms\.txt/);
    });

    for (const line of [`${VERSION} (beta)`, `See ${VERSION}`, "Version: explorer-verify"]) {
      it(`rejects a version line with other text: ${line}`, () => {
        edit(root, README, VERSION, line);
        assertProblems(/README\.md: no line `Version/);
      });
    }

    for (const [name, line] of [
      ["a trailing hard break", `${VERSION}  `],
      ["a trailing tab", `${VERSION}\t`],
      ["an indent", `  ${VERSION}`],
    ] as const) {
      it(`accepts a version line with ${name}`, () => {
        edit(root, README, VERSION, line);
        assertProblems();
      });
    }

    it("uses the first version line in the head", () => {
      edit(root, README, VERSION, `${VERSION}\nVersion: explorer-verify 9.9.9`);
      assertProblems();
    });

    it("ignores a version line inside a code fence", () => {
      edit(root, README, VERSION, `\`\`\`text\n${VERSION}\n\`\`\``);
      assertProblems(/README\.md: no line `Version/);
    });

    it("names the file and line of a version that does not match the package", () => {
      edit(root, AGENT, "explorer-verify 1.2.3", "explorer-verify 1.0.0");
      assertProblems(
        /^docs\/user\/guides\/using-from-an-agent\.md:3: states version 1\.0\.0, but packages\/explorer-verify is 1\.2\.3/,
      );
    });

    it("fails without a link to llms.txt in the first 10 lines", () => {
      edit(root, README, INDEX_LINK, "llms.txt");
      assertProblems(/^docs\/user\/README\.md: no relative link to the root llms\.txt/);
    });

    it("fails when the llms.txt link does not reach the root one", () => {
      edit(root, AGENT, "../../../llms.txt", "../../llms.txt");
      assertProblems(
        /using-from-an-agent\.md: no relative link to the root llms\.txt/,
        /using-from-an-agent\.md:5: link \.\.\/\.\.\/llms\.txt points to docs\/llms\.txt/,
      );
    });

    it("does not count an absolute llms.txt link", () => {
      edit(root, README, INDEX_LINK, `[llms.txt](${RAW_MAIN}llms.txt)`);
      assertProblems(/README\.md: no relative link to the root llms\.txt/);
    });
  });

  describe("relative links under docs/", () => {
    const NOTES = "docs/contributor/notes.md";

    it("still checks links after `<!--` in inline code in a user page", () => {
      edit(
        root,
        README,
        "See [the agent page]",
        "Comments start with `<!--`.\n\nSee [the agent page]",
      );
      edit(root, README, "../../AGENTS.md", "../../MISSING.md");
      assertProblems(
        /^docs\/user\/README\.md:9: link \.\.\/\.\.\/MISSING\.md points to MISSING\.md, which does not exist$/,
      );
    });

    it("fails on a link to a missing file", () => {
      edit(root, NOTES, "requirements.md", "roadmap.md");
      assertProblems(
        /^docs\/contributor\/notes\.md:3: link roadmap\.md points to docs\/contributor\/roadmap\.md, which does not exist$/,
      );
    });

    it("fails on a link whose case differs from the file", () => {
      edit(root, NOTES, "requirements.md", "Requirements.md");
      assertProblems(
        /link Requirements\.md points to docs\/contributor\/Requirements\.md, which does not exist/,
      );
    });

    it("fails on a link that goes through a file", () => {
      edit(root, NOTES, "requirements.md", "requirements.md/more.md");
      assertProblems(/which does not exist/);
    });

    it("fails on a link to a missing heading in another file", () => {
      edit(root, README, "#notes", "#keys");
      assertProblems(/README\.md:7: link guides\/using-from-an-agent\.md#keys names a heading/);
    });

    it("fails on a link to a missing heading in the same file", () => {
      edit(root, AGENT, "(#notes)", "(#keys)");
      assertProblems(/using-from-an-agent\.md:17: link #keys names a heading/);
    });

    it("fails on a fragment that is not valid percent-encoding", () => {
      edit(root, AGENT, "(#notes)", "(#%E0%A4%A)");
      assertProblems(/link #%E0%A4%A names a heading/);
    });

    it("matches a percent-encoded fragment to its heading", () => {
      writeFiles(root, {
        [NOTES]: "# Notes\n\n## Diátaxis layout\n\n[d](#di%C3%A1taxis-layout)\n",
      });
      assertProblems();
    });

    it("matches a setext heading", () => {
      writeFiles(root, {
        [NOTES]: "Notes\n=====\n\nSub part\n--------\n\n[n](#notes) [s](#sub-part)\n",
      });
      assertProblems();
    });

    it("fails on a link that leaves the repository", () => {
      edit(root, NOTES, "requirements.md", "../../../outside.md");
      assertProblems(/notes\.md:3: link \.\.\/\.\.\/\.\.\/outside\.md leaves the repository/);
    });

    it("ignores links in code and absolute links", () => {
      writeFiles(root, {
        "docs/contributor/code.md":
          "# Code\n\n`[x](missing.md)`\n\n```md\n[y](missing.md)\n```\n\n[z](https://example.com/missing.md) [p](//example.com/x.md)\n\n[d](../user/guides/#x) [i](../user/img/logo.png#x)\n",
      });
      assertProblems();
    });

    it("closes a fence only on its own marker", () => {
      writeFiles(root, {
        "docs/contributor/code.md": "# Code\n\n```\n~~~\n[bad](missing.md)\n```\n",
      });
      assertProblems();
    });

    it("reads a link after a fence closes", () => {
      writeFiles(root, {
        "docs/contributor/code.md": "# Code\n\n~~~\n```\n~~~\n\n[bad](missing.md)\n",
      });
      assertProblems(/code\.md:7: link missing\.md points to/);
    });
  });
});

describe("githubSlug", () => {
  for (const [heading, slug] of [
    ["Agent readiness (R-AX)", "agent-readiness-r-ax"],
    ["The `files` field", "the-files-field"],
    ["[Link](x.md) and **bold**", "link-and-bold"],
    ["_Foo_ bar", "foo-bar"],
    ["__Foo__ *bar*", "foo-bar"],
    ["A &amp; B", "a--b"],
    ["A & B", "a--b"],
    ["A &#38; B &#x26; C", "a--b--c"],
    ["A &unknown; B", "a-unknown-b"],
    ["&lt;tag&gt;", "tag"],
    ["snake_case name", "snake_case-name"],
    ["a  b", "a--b"],
    ["a\tb", "ab"],
    ["Diátaxis layout", "diátaxis-layout"],
    ["<code>x</code> y", "x-y"],
  ] as const) {
    it(`slugs ${JSON.stringify(heading)} as ${slug}`, () => {
      assert.equal(githubSlug(heading), slug);
    });
  }
});

describe("headings and anchors", () => {
  it("numbers repeated headings and reads HTML anchors", () => {
    const found = anchors(
      '# A\n\n## A\n\n## A\n\n```\n# Not a heading\n```\n\n<a id="custom"></a>\n',
    );
    assert.deepEqual([...found].toSorted(), ["a", "a-1", "a-2", "custom"]);
  });

  it("reads setext headings only under a paragraph line", () => {
    assert.deepEqual(
      headings(
        "Title\n===\n\nSub\n---\n\n- item\n---\n\n---\n\n| a |\n---\n\nText\n\n---\n# ATX #\n",
      ),
      ["Title", "Sub", "ATX"],
    );
  });

  it("does not read an underline across a fence as setext", () => {
    assert.deepEqual(headings("Text\n```\ncode\n```\n---\n"), []);
  });

  it("reads reference definitions and angle-bracket targets", () => {
    const links = markdownLinks("[a](<b c.md>)\n\n[ref]: ref.md\n");
    assert.deepEqual(
      links.map((link) => [link.line, link.target]),
      [
        [1, "b c.md"],
        [3, "ref.md"],
      ],
    );
  });

  it("skips links and headings inside HTML comments, on one line or across lines", () => {
    const text = [
      "[a](a.md) <!-- [b](b.md) --> [c](c.md) <!-- [d](d.md)",
      "# Not a heading",
      "```",
      "--> [e](e.md)",
      "[f](f.md)",
    ].join("\n");
    assert.deepEqual(
      markdownLinks(text).map((link) => [link.line, link.target]),
      [
        [1, "a.md"],
        [1, "c.md"],
        [4, "e.md"],
        [5, "f.md"],
      ],
    );
    assert.deepEqual(headings(text), []);
  });

  it("rewrites a link after `<!--` in inline code", () => {
    assert.equal(
      rewriteForPackage(README, "Use `<!--`.\n[y](../../AGENTS.md)"),
      `Use \`<!--\`.\n[y](${RAW_MAIN}AGENTS.md)`,
    );
  });

  it("keeps the comments of a page it rewrites for the package", () => {
    const text = "<!-- note [x](../../AGENTS.md) --> [y](../../AGENTS.md)";
    assert.equal(
      rewriteForPackage(README, text),
      `<!-- note [x](../../AGENTS.md) --> [y](${RAW_MAIN}AGENTS.md)`,
    );
  });
});

describe("writeVersions", () => {
  it("updates every outdated page and keeps the line's spacing", () => {
    edit(root, AGENT, VERSION, `  Version: explorer-verify 1.0.0  `);
    edit(root, README, VERSION, "Version: explorer-verify 0.9.0\t");
    assert.deepEqual(writeVersions(root), [README, AGENT]);
    assert.match(read(root, AGENT), /^ {2}Version: explorer-verify 1\.2\.3 {2}$/m);
    assert.match(read(root, README), /^Version: explorer-verify 1\.2\.3\t$/m);
    assert.deepEqual(checkAgentDocs(root), []);
  });

  it("leaves a fenced version line and lines below the head alone", () => {
    const page = `# Page\n\n${INDEX_LINK}\n\n\`\`\`\nVersion: explorer-verify 0.1.0\n\`\`\`\n\n${VERSION.replace("1.2.3", "0.2.0")}\n\n\nVersion: explorer-verify 0.3.0\n`;
    writeFiles(root, { [README]: page });
    assert.deepEqual(writeVersions(root), [README]);
    assert.equal(read(root, README), page.replace("Version: explorer-verify 0.2.0", VERSION));
  });

  it("changes nothing on current pages or pages without a version line", () => {
    edit(root, README, VERSION, "No version here");
    assert.deepEqual(writeVersions(root), []);
  });
});

describe("packaging (R-AX-2)", () => {
  it("rewrites links for the package", () => {
    const text = rewriteForPackage(
      AGENT,
      "[i](../../../llms.txt) [r](../README.md#user-docs) [c](../../contributor/x.md#y) [s](#z) [w](https://example.com) [x](../../user-extras/x.md) [a](<../../a b.md>) `[k](../../k.md)`\n\n[ref]: ../../../AGENTS.md\n",
    );
    assert.equal(
      text,
      `[i](../../llms.txt) [r](../README.md#user-docs) [c](${RAW_MAIN}docs/contributor/x.md#y) [s](#z) [w](https://example.com) [x](${RAW_MAIN}docs/user-extras/x.md) [a](<${RAW_MAIN}docs/a b.md>) \`[k](../../k.md)\`\n\n[ref]: ${RAW_MAIN}AGENTS.md\n`,
    );
  });

  it("points links in a skill and links to a skill at the packaged copies", () => {
    assert.equal(
      rewriteForPackage(
        SKILL,
        "[g](../../docs/user/guides/a.md#x) [u](../../docs/user) [o](../other/SKILL.md) [c](../../docs/contributor/x.md)",
      ),
      `[g](../../docs/guides/a.md#x) [u](../../docs) [o](../other/SKILL.md) [c](${RAW_MAIN}docs/contributor/x.md)`,
    );
    assert.equal(
      rewriteForPackage(AGENT, "[s](../../../skills/explorer-verify/SKILL.md#stop)"),
      "[s](../../skills/explorer-verify/SKILL.md#stop)",
    );
  });

  it("keeps a link to the user docs folder itself", () => {
    assert.equal(rewriteForPackage(AGENT, "[u](..)"), "[u](..)");
  });

  it("makes llms.txt links to user pages and skills relative", () => {
    const packaged = packagedLlmsTxt(
      `[a](${RAW_MAIN}docs/user/README.md) [b](${RAW_MAIN}AGENTS.md) [s](${RAW_MAIN}${SKILL}) [t](${RAW_MAIN}packages/explorer-verify/package.json)`,
    );
    assert.equal(
      packaged,
      `[a](docs/README.md) [b](${RAW_MAIN}AGENTS.md) [s](skills/explorer-verify/SKILL.md) [t](${RAW_MAIN}packages/explorer-verify/package.json)`,
    );
  });

  it("copies every file of the user docs and llms.txt into the package", () => {
    const packageDir = path.join(root, "packages/explorer-verify");
    writeFiles(root, { "packages/explorer-verify/docs/stale.md": "old" });
    const written = packageDocs(root, packageDir);
    assert.deepEqual(written, [
      "docs/README.md",
      "docs/guides/using-from-an-agent.md",
      "docs/img/logo.png",
      "skills/explorer-verify/SKILL.md",
      "llms.txt",
    ]);
    assert.equal(
      read(packageDir, SKILL),
      `---\nname: explorer-verify\n---\n\nRead [llms.txt](../../llms.txt), [the agent page](../../docs/guides/using-from-an-agent.md#notes), [stop](#stop) and [AGENTS](${RAW_MAIN}AGENTS.md).\n\n## Stop\n`,
    );
    assert.equal(readFileSync(path.join(packageDir, "docs/img/logo.png"), "utf8"), "PNG");
    assert.match(read(packageDir, "llms.txt"), /\(docs\/README\.md\)/);
    assert.match(read(packageDir, "llms.txt"), /\(skills\/explorer-verify\/SKILL\.md\)/);
    assert.match(read(packageDir, "docs/README.md"), /\[llms\.txt\]\(\.\.\/llms\.txt\)/);
    assert.throws(() => read(packageDir, "docs/stale.md"));
    assert.deepEqual(packagedLinkProblems(packageDir, packagedDocFiles(root)), []);
  });

  it("finds a packaged link to a file the tarball lacks", () => {
    const packageDir = path.join(root, "packages/explorer-verify");
    edit(root, "llms.txt", "## User docs\n", `## User docs\n\n- [Up](../outside.md)\n`);
    packageDocs(root, packageDir);
    const packed = packagedDocFiles(root).filter((file) => file !== "docs/img/logo.png");
    assert.deepEqual(packagedLinkProblems(packageDir, packed), [
      "llms.txt:7: link ../outside.md points to ../outside.md, which is not in the tarball (R-AX-2)",
      "docs/README.md:9: link img/logo.png points to docs/img/logo.png, which is not in the tarball (R-AX-2)",
    ]);
  });

  it("finds a link in a skill to a file the tarball lacks", () => {
    const packageDir = path.join(root, "packages/explorer-verify");
    packageDocs(root, packageDir);
    edit(packageDir, SKILL, "../../docs/guides/using-from-an-agent.md#notes", "../../docs/gone.md");
    assert.deepEqual(packagedLinkProblems(packageDir, packagedDocFiles(root)), [
      "skills/explorer-verify/SKILL.md:5: link ../../docs/gone.md points to docs/gone.md, which is not in the tarball (R-AX-2)",
    ]);
  });

  it("lists the files the tarball must hold", () => {
    assert.deepEqual(packagedDocFiles(root), [
      "llms.txt",
      "docs/README.md",
      "docs/guides/using-from-an-agent.md",
      "docs/img/logo.png",
      "skills/explorer-verify/SKILL.md",
    ]);
  });

  it("finds the files the tarball lacks", () => {
    const output = JSON.stringify([
      { files: [{ path: "llms.txt" }, { path: "docs/README.md" }, {}, "x", null] },
    ]);
    assert.deepEqual(packedFiles(output), ["llms.txt", "docs/README.md"]);
    assert.deepEqual(missingFromPack(packedFiles(output), packagedDocFiles(root)), [
      "docs/guides/using-from-an-agent.md",
      "docs/img/logo.png",
      "skills/explorer-verify/SKILL.md",
    ]);
    assert.throws(() => packedFiles("{}"), /no file list/);
    assert.throws(() => packedFiles("[1]"), /no file list/);
    assert.throws(() => packedFiles("[null]"), /no file list/);
  });
});

describe("error pages in the package (R-AX-10)", () => {
  it("reads ERROR_CODES from a loaded module", () => {
    assert.deepEqual(errorCodesOf({ ERROR_CODES: ["network", "timeout"] }), ["network", "timeout"]);
    assert.deepEqual(errorCodesOf({ ERROR_CODES: [] }), []);
  });

  it("throws when the module has no array of strings", () => {
    for (const module of [
      undefined,
      null,
      1,
      {},
      { ERROR_CODES: "network" },
      { ERROR_CODES: [1] },
    ]) {
      assert.throws(() => errorCodesOf(module), /exports no ERROR_CODES array of strings/);
    }
  });

  it("names the packaged page of each code", () => {
    assert.deepEqual(errorPageFiles(["network", "timeout"]), [
      "docs/reference/errors/network.md",
      "docs/reference/errors/timeout.md",
    ]);
  });
});
