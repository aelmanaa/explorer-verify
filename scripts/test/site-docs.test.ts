// The docs site helpers (R-AX-10, R-AX-17, decisions 0015 and 0062): site paths, site-only pages,
// link rewriting, the header lines, the site's llms.txt, the sidebar and the nav, the Markdown
// copies, the build check (test 3) and the smoke check (test 4).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { RAW_MAIN } from "../agent-docs.ts";
import {
  API_SECTION,
  codeTitleOf,
  docsUrlsOf,
  dropHeaderLines,
  hasSiteHome,
  inCodeGroup,
  rewriteForSite,
  SIDEBAR,
  sidebarProblems,
  SITE_URL,
  siteAssets,
  siteLlmsTxt,
  siteNav,
  sitePages,
  sitePath,
  siteProblems,
  siteRewrites,
  siteSourceExcludes,
  siteSidebar,
  SMOKE_TIMEOUT_MS,
  smokeProblems,
  withCodeTitle,
  writeSiteCopies,
} from "../site-docs.ts";
import type { Fetch, SidebarItem } from "../site-docs.ts";
import {
  AGENT,
  IMAGE,
  makeFixture,
  read,
  README,
  removeFixture,
  SKILL,
  writeFiles,
} from "./fixture.ts";

/** The root of this repository. */
const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let root = "";

beforeEach(() => {
  root = makeFixture();
});

afterEach(() => {
  removeFixture(root);
});

describe("sitePath", () => {
  it("turns README.md into index.md and keeps every other path", () => {
    assert.equal(sitePath("README.md"), "index.md");
    assert.equal(sitePath("guides/README.md"), "guides/index.md");
    assert.equal(sitePath("guides/a.md"), "guides/a.md");
    assert.equal(sitePath("reference/errors/index.md"), "reference/errors/index.md");
  });

  it("serves the top README.md as overview.md once the site has its own home page", () => {
    assert.equal(sitePath("README.md", true), "overview.md");
    assert.equal(sitePath("start/README.md", true), "start/index.md");
    assert.equal(sitePath("guides/a.md", true), "guides/a.md");
  });
});

describe("sitePages, hasSiteHome and siteAssets", () => {
  it("find nothing in a tree without site/pages", () => {
    assert.deepEqual(sitePages(root), []);
    assert.equal(hasSiteHome(root), false);
  });

  it("list the site-only pages and see the home page", () => {
    writeFiles(root, {
      "site/pages/index.md": "---\nlayout: home\n---\n",
      "site/pages/extra/about.md": "# About\n",
      "site/pages/logo.svg": "<svg/>",
    });
    assert.deepEqual(sitePages(root), ["extra/about.md", "index.md"]);
    assert.equal(hasSiteHome(root), true);
  });

  it("list the files under docs/user that are not pages, by their site path", () => {
    writeFiles(root, { "docs/user/start/sample.json": "{}" });
    assert.deepEqual(siteAssets(root), ["img/logo.png", "start/sample.json"]);
  });
});

describe("siteRewrites", () => {
  it("serves docs/user at the root, each README.md as index.md, and site/api under api/", () => {
    writeFiles(root, {
      "docs/user/guides/README.md": "# Guides\n",
      "site/api/index.md": "# API reference\n",
      "site/api/core-server.md": "# core/server\n",
    });
    assert.deepEqual(siteRewrites(root), {
      "docs/user/README.md": "index.md",
      "docs/user/guides/README.md": "guides/index.md",
      "docs/user/guides/using-from-an-agent.md": "guides/using-from-an-agent.md",
      "site/api/index.md": "api/index.md",
      "site/api/core-server.md": "api/core-server.md",
    });
  });

  it("serves the site-only pages at their paths, and the user index at overview.md", () => {
    writeFiles(root, {
      "site/pages/index.md": "---\nlayout: home\n---\n",
      "site/pages/about.md": "# About\n",
    });
    assert.deepEqual(siteRewrites(root), {
      "docs/user/README.md": "overview.md",
      "docs/user/guides/using-from-an-agent.md": "guides/using-from-an-agent.md",
      "site/pages/about.md": "about.md",
      "site/pages/index.md": "index.md",
    });
  });

  it("throws when a site-only page takes the path of a user page", () => {
    writeFiles(root, { "site/pages/guides/using-from-an-agent.md": "# Clash\n" });
    assert.throws(
      () => siteRewrites(root),
      /^Error: docs\/user\/guides\/using-from-an-agent\.md and site\/pages\/guides\/using-from-an-agent\.md would both be guides\/using-from-an-agent\.md$/,
    );
  });

  it("throws when a folder holds both README.md and index.md", () => {
    writeFiles(root, { "docs/user/index.md": "# Index\n" });
    assert.throws(
      () => siteRewrites(root),
      /^Error: docs\/user\/README\.md and docs\/user\/index\.md would both be index\.md$/,
    );
  });
});

describe("siteSourceExcludes", () => {
  it("hides every Markdown file outside docs/user, site/api and site/pages, and skips hidden entries", () => {
    writeFiles(root, {
      "README.md": "# Repository\n",
      "notes.txt": "",
      ".github/pull_request_template.md": "",
      "docs/README.md": "# Docs\n",
      "packages/core/README.md": "# core\n",
      "site/package.json": "{}",
      "site/.vitepress/config.ts": "",
      "site/api/index.md": "# API reference\n",
      "site/dist/index.md": "",
      "site/notes.md": "",
      "site/pages/index.md": "---\nlayout: home\n---\n",
    });
    assert.deepEqual(siteSourceExcludes(root), [
      "AGENTS.md",
      "README.md",
      "docs/README.md",
      "docs/contributor/**",
      "packages/**",
      "site/dist/**",
      "site/notes.md",
      "skills/**",
    ]);
  });
});

describe("rewriteForSite", () => {
  const page = "docs/user/guides/page.md";

  it("keeps links inside docs/user, fragments and absolute URLs", () => {
    const text =
      "[a](../reference/a.md#x) [b](#top) [c](https://example.com/c.md) [d](//example.com/d)\n";
    assert.equal(rewriteForSite(page, text, "1.2.3"), text);
  });

  it("points a link to a README.md at the index page", () => {
    assert.equal(
      rewriteForSite(page, "[i](../README.md#user-docs) [j](README.md)\n", "1.2.3"),
      "[i](../index.md#user-docs) [j](index.md)\n",
    );
    assert.equal(
      rewriteForSite("docs/user/README.md", "[i](README.md)\n", "1.2.3"),
      "[i](index.md)\n",
    );
  });

  it("points the root llms.txt at the site's llms.txt", () => {
    assert.equal(rewriteForSite(page, "[l](../../../llms.txt)\n", "1.2.3"), "[l](../llms.txt)\n");
    assert.equal(rewriteForSite(README, "[l](../../llms.txt)\n", "1.2.3"), "[l](llms.txt)\n");
    assert.equal(
      rewriteForSite("docs/user/reference/errors/a.md", "[l](<../../../../llms.txt>)\n", "1.2.3"),
      "[l](<../../llms.txt>)\n",
    );
  });

  it("points any other repository file at GitHub on the version's tag", () => {
    assert.equal(
      rewriteForSite(
        page,
        "[s](../../../skills/x/SKILL.md#stop) [a](../../../AGENTS.md)\n",
        "1.2.3",
      ),
      "[s](https://github.com/aelmanaa/explorer-verify/blob/v1.2.3/skills/x/SKILL.md#stop) [a](https://github.com/aelmanaa/explorer-verify/blob/v1.2.3/AGENTS.md)\n",
    );
  });

  it("leaves code alone", () => {
    const text = "`[a](../../../AGENTS.md)`\n\n```md\n[a](../../../AGENTS.md)\n```\n";
    assert.equal(rewriteForSite(page, text, "1.2.3"), text);
  });

  it("points a link to the user index at overview.md once the site has its own home page", () => {
    assert.equal(
      rewriteForSite(page, "[i](../README.md#user-docs) [j](README.md)\n", "1.2.3", true),
      "[i](../overview.md#user-docs) [j](index.md)\n",
    );
    assert.equal(
      rewriteForSite(README, "[a](guides/a.md) [i](README.md)\n", "1.2.3", true),
      "[a](guides/a.md) [i](overview.md)\n",
    );
  });

  it("rewrites the skill's links for its copy at the same path on the site", () => {
    assert.equal(
      rewriteForSite(
        SKILL,
        "[l](../../llms.txt) [g](../../docs/user/guides/a.md#notes) [i](../../docs/user/README.md) [s](#stop) [a](../../AGENTS.md)\n",
        "1.2.3",
      ),
      "[l](../../llms.txt) [g](../../guides/a.md#notes) [i](../../index.md) [s](#stop) [a](https://github.com/aelmanaa/explorer-verify/blob/v1.2.3/AGENTS.md)\n",
    );
  });
});

describe("code block titles", () => {
  it("reads the title in brackets from the info string", () => {
    assert.equal(codeTitleOf("ts [verify.ts]"), "verify.ts");
    assert.equal(codeTitleOf("sh [Terminal window]"), "Terminal window");
    assert.equal(codeTitleOf("ts"), undefined);
    assert.equal(codeTitleOf("ts [ ]"), undefined);
  });

  it("knows a fence inside a code group from one outside", () => {
    const types = [
      "fence",
      "container_code-group_open",
      "fence",
      "container_code-group_close",
      "fence",
    ];
    assert.equal(inCodeGroup(types, 0), false);
    assert.equal(inCodeGroup(types, 2), true);
    assert.equal(inCodeGroup(types, 4), false);
  });

  it("puts an escaped title bar above the block", () => {
    assert.equal(
      withCodeTitle("<pre></pre>", '<a> & "b" {{ c }}'),
      '<div class="ev-code-title"><div class="ev-code-title-text" v-pre>&lt;a&gt; &amp; &quot;b&quot; {{ c }}</div><pre></pre></div>',
    );
  });
});

describe("dropHeaderLines", () => {
  it("drops the Version and Agents lines of the header and the blank line after each", () => {
    assert.equal(
      dropHeaderLines(
        "# Title\n\nVersion: explorer-verify 1.2.3\n\nAgents: [llms.txt](../llms.txt).\n\nAudience: you.\n",
      ),
      "# Title\n\nAudience: you.\n",
    );
  });

  it("keeps such lines after the first H2 or inside code, and a line at the end", () => {
    const text =
      "# T\n\n```text\nAgents: in code\n```\n\n## Section\n\nVersion: explorer-verify 1.2.3\n";
    assert.equal(dropHeaderLines(text), text);
    assert.equal(dropHeaderLines("# T\n\nAgents: last"), "# T\n");
  });
});

describe("siteLlmsTxt", () => {
  it("keeps the user pages as site copies, drops the rest and names the version", () => {
    const text = `# explorer-verify

> Verifies contract source.

Read the agent page first.

## User docs

- [Index](${RAW_MAIN}docs/user/README.md): the index
- [Agent](<${RAW_MAIN}docs/user/guides/a.md>): the agent page
- [Skill](${RAW_MAIN}skills/x/SKILL.md): the skill
  which wraps
- [Both](${RAW_MAIN}docs/user/guides/a.md) and [AGENTS](${RAW_MAIN}AGENTS.md)
- No link at all

## Contributor docs

- [AGENTS](${RAW_MAIN}AGENTS.md): start here

## Optional

- [Elsewhere](https://example.com/page.md): not in this repository
`;
    assert.equal(
      siteLlmsTxt(text, "1.2.3"),
      `# explorer-verify

> Verifies contract source.

This site holds the docs of explorer-verify 1.2.3. Each link is the Markdown copy of a page; drop \`.md\` for the HTML page. The npm package ships the docs of the installed version under \`docs/\`, and jsDelivr serves those of any published version: https://cdn.jsdelivr.net/npm/explorer-verify@<version>/llms.txt.

Read the agent page first.

## User docs

- [Index](${SITE_URL}index.md): the index
- [Agent](<${SITE_URL}guides/a.md>): the agent page
`,
    );
  });

  it("adds a last section that links each API reference page, members under their entry point", () => {
    const text = `# explorer-verify

> Verifies contract source.

## User docs

- [Index](${RAW_MAIN}docs/user/README.md): the index
`;
    const api = [
      { page: "index.md", title: "API reference" },
      { page: "core/index.md", title: "core" },
      { page: "core/functions/verify.md", title: "Function: verify()" },
      { page: "core-server/index.md", title: "core/server" },
    ];
    assert.equal(
      siteLlmsTxt(text, "1.2.3", api),
      `# explorer-verify

> Verifies contract source.

This site holds the docs of explorer-verify 1.2.3. Each link is the Markdown copy of a page; drop \`.md\` for the HTML page. The npm package ships the docs of the installed version under \`docs/\`, and jsDelivr serves those of any published version: https://cdn.jsdelivr.net/npm/explorer-verify@<version>/llms.txt.

## User docs

- [Index](${SITE_URL}index.md): the index

${API_SECTION}

Generated from the TSDoc of each package entry point. The \`.d.ts\` files in the npm packages carry the same comments.

- [API reference](${SITE_URL}api/index.md): the list of entry points
- [core](${SITE_URL}api/core/index.md): the exports of \`core\`
  - [Function: verify()](${SITE_URL}api/core/functions/verify.md)
- [core/server](${SITE_URL}api/core-server/index.md): the exports of \`core/server\`
`,
    );
  });

  it("links the skill's copy, and the user index as overview.md with a site home page", () => {
    const text = `# explorer-verify

> Verifies contract source.

## User docs

- [Index](${RAW_MAIN}docs/user/README.md): the index
- [Skill](${RAW_MAIN}${SKILL}): the skill
- [Other skill](${RAW_MAIN}skills/other/SKILL.md): dropped
`;
    assert.match(
      siteLlmsTxt(text, "1.2.3", [], true),
      new RegExp(
        `- \\[Index\\]\\(${SITE_URL}overview\\.md\\): the index\n- \\[Skill\\]\\(${SITE_URL}skills/explorer-verify/SKILL\\.md\\): the skill\n$`,
      ),
    );
  });

  it("throws without a summary blockquote", () => {
    assert.throws(() => siteLlmsTxt("# explorer-verify\n", "1.2.3"), /has no summary blockquote/);
  });
});

describe("siteSidebar", () => {
  it("lists the curated groups in order, skipping pages and groups that do not exist yet", () => {
    writeFiles(root, {
      "docs/user/start/quickstart-node.md": "# Quickstart: Node.js\n",
      "docs/user/reference/verify.md": "# verify()\n",
      "docs/user/reference/sourcify.md": "# Sourcify\n",
      "docs/user/reference/errors/zeta.md": "# zeta\n",
      "docs/user/reference/errors/index.md": "# Errors\n",
      "docs/user/reference/errors/untitled.md": "No heading.\n",
    });
    assert.deepEqual(siteSidebar(root), [
      {
        text: "Get started",
        collapsed: false,
        items: [
          { text: "Overview", link: "/" },
          {
            text: "Quickstarts",
            collapsed: false,
            items: [{ text: "Node.js", link: "/start/quickstart-node" }],
          },
        ],
      },
      {
        text: "Advanced",
        collapsed: false,
        items: [{ text: "From an agent", link: "/guides/using-from-an-agent" }],
      },
      {
        text: "Reference",
        collapsed: false,
        items: [
          { text: "verify()", link: "/reference/verify" },
          {
            text: "Explorers",
            collapsed: true,
            items: [{ text: "Sourcify", link: "/reference/sourcify" }],
          },
          {
            text: "Errors",
            collapsed: true,
            items: [
              { text: "Errors", link: "/reference/errors/" },
              { text: "reference/errors/untitled.md", link: "/reference/errors/untitled" },
              { text: "zeta", link: "/reference/errors/zeta" },
            ],
          },
        ],
      },
    ]);
  });

  it("links the user index at /overview once the site has its own home page", () => {
    writeFiles(root, { "site/pages/index.md": "---\nlayout: home\n---\n" });
    assert.deepEqual(siteSidebar(root)[0]?.items?.[0], { text: "Overview", link: "/overview" });
  });

  it("ends with the API reference, collapsed, its index first, then the entry points only", () => {
    writeFiles(root, {
      "site/api/core/index.md": "# core\n",
      "site/api/core/functions/verify.md": "# Function: verify()\n",
      "site/api/core-server/index.md": "# core/server\n",
      "site/api/index.md": "# API reference\n",
    });
    assert.deepEqual(siteSidebar(root).at(-1), {
      text: "API",
      collapsed: true,
      items: [
        { text: "API reference", link: "/api/" },
        { text: "core", link: "/api/core/" },
        { text: "core/server", link: "/api/core-server/" },
      ],
    });
  });

  it("gives every page of this repository's docs exactly one place", () => {
    assert.deepEqual(sidebarProblems(REPOSITORY), []);
  });

  it("names each listed page once in SIDEBAR", () => {
    const pages: string[] = [];
    const visit = (entries: readonly (typeof SIDEBAR)[number][]): void => {
      for (const entry of entries) {
        if ("page" in entry) {
          pages.push(entry.page);
        } else if ("items" in entry) {
          visit(entry.items);
        }
      }
    };
    visit(SIDEBAR);
    assert.deepEqual(
      pages.filter((page, index) => pages.indexOf(page) !== index),
      [],
    );
  });
});

describe("sidebarProblems", () => {
  it("reports a user page in no group", () => {
    writeFiles(root, { "docs/user/notes/unlisted.md": "# Unlisted\n" });
    assert.deepEqual(sidebarProblems(root), [
      "docs/user/notes/unlisted.md is in no sidebar group; add it to SIDEBAR in scripts/site-docs.ts",
    ]);
  });

  it("reports a page that two entries list, and skips a listed page that does not exist", () => {
    writeFiles(root, { "docs/user/reference/errors/a.md": "# a\n" });
    assert.deepEqual(
      sidebarProblems(root, [
        { text: "Index", page: "README.md" },
        { text: "Agent", page: "guides/using-from-an-agent.md" },
        { text: "Planned", page: "guides/planned.md" },
        { text: "A", page: "reference/errors/a.md" },
        { text: "Errors", collapsed: true, folder: "reference/errors" },
      ]),
      ["docs/user/reference/errors/a.md is in 2 sidebar entries; keep one"],
    );
  });
});

describe("siteNav", () => {
  const sidebar: SidebarItem[] = [
    {
      text: "Get started",
      collapsed: false,
      items: [
        { text: "Quickstarts", items: [{ text: "Node.js", link: "/start/quickstart-node" }] },
      ],
    },
    { text: "Guides by setup", collapsed: false, items: [{ text: "Node.js", link: "/guides/n" }] },
    { text: "Reference", collapsed: false, items: [] },
    { text: "API", collapsed: true, items: [{ text: "API reference", link: "/api/" }] },
  ];

  it("links the first page of each group, skips an empty group and ends with the version", () => {
    assert.deepEqual(siteNav(sidebar, "1.2.3"), [
      { text: "Get started", link: "/start/quickstart-node" },
      { text: "Guides", link: "/guides/n" },
      { text: "API", link: "/api/" },
      {
        text: "1.2.3",
        items: [
          {
            text: "Changelog",
            link: "https://github.com/aelmanaa/explorer-verify/blob/v1.2.3/packages/explorer-verify/CHANGELOG.md",
          },
          { text: "npm", link: "https://www.npmjs.com/package/explorer-verify/v/1.2.3" },
        ],
      },
    ]);
  });
});

describe("writeSiteCopies", () => {
  it("writes each page next to its HTML, copies other files and writes llms.txt", () => {
    const out = path.join(root, "out");
    assert.deepEqual(writeSiteCopies(root, out, "1.2.3"), [
      "index.md",
      "guides/using-from-an-agent.md",
      "img/logo.png",
      SKILL,
      "llms.txt",
    ]);
    assert.match(read(out, "index.md"), /^Version: explorer-verify 1\.2\.3$/m);
    assert.match(
      read(out, SKILL),
      /\[the agent page\]\(\.\.\/\.\.\/guides\/using-from-an-agent\.md#notes\)/,
    );
    assert.match(read(out, "llms.txt"), new RegExp(`\\(${SITE_URL}${SKILL}\\)`));
    assert.match(read(out, "index.md"), /\[llms\.txt\]\(llms\.txt\)/);
    assert.match(
      read(out, "index.md"),
      /\[AGENTS\]\(https:\/\/github\.com\/aelmanaa\/explorer-verify\/blob\/v1\.2\.3\/AGENTS\.md\)/,
    );
    assert.match(
      read(out, "guides/using-from-an-agent.md"),
      /\[index\]\(\.\.\/index\.md#user-docs\)/,
    );
    assert.equal(read(out, "img/logo.png"), read(root, IMAGE));
    assert.match(
      read(out, "llms.txt"),
      new RegExp(`\\(${SITE_URL}guides/using-from-an-agent\\.md\\)`),
    );
    assert.ok(existsSync(path.join(out, path.relative("docs/user", AGENT))));
  });

  it("writes the user index as overview.md once the site has its own home page", () => {
    writeFiles(root, { "site/pages/index.md": "---\nlayout: home\n---\n" });
    rmSync(path.join(root, SKILL));
    const out = path.join(root, "out");
    assert.deepEqual(writeSiteCopies(root, out, "1.2.3"), [
      "overview.md",
      "guides/using-from-an-agent.md",
      "img/logo.png",
      "llms.txt",
    ]);
    assert.match(
      read(out, "guides/using-from-an-agent.md"),
      /\[index\]\(\.\.\/overview\.md#user-docs\)/,
    );
    assert.match(read(out, "llms.txt"), new RegExp(`\\(${SITE_URL}overview\\.md\\)`));
    assert.ok(!existsSync(path.join(out, "index.md")));
  });

  it("copies the API reference pages under api/ and lists them in llms.txt", () => {
    const page = "# core/server\n\nSee [core](core.md#api-verify).\n";
    writeFiles(root, {
      "site/api/index.md": "# API reference\n",
      "site/api/core-server.md": page,
    });
    const out = path.join(root, "out");
    assert.deepEqual(writeSiteCopies(root, out, "1.2.3").slice(-3), [
      "api/index.md",
      "api/core-server.md",
      "llms.txt",
    ]);
    assert.equal(read(out, "api/core-server.md"), page);
    assert.match(read(out, "llms.txt"), new RegExp(`\\(${SITE_URL}api/core-server\\.md\\)`));
  });
});

function parseHandle(): unknown {
  return { parsed: true };
}

// A constructor that returns a function: `new` then gives that function, not an object.
function NotAnError(): () => void {
  return () => {};
}

describe("docsUrlsOf", () => {
  class FakeError {
    docsUrl: unknown;
    constructor(details: { code: string; handle: unknown }) {
      this.docsUrl = details.code === "bad" ? 1 : `${SITE_URL}reference/errors/${details.code}`;
      assert.deepEqual(details.handle, { parsed: true });
    }
  }
  it("reads the docsUrl of each code from an error built for it", () => {
    assert.deepEqual(
      docsUrlsOf({ ERROR_CODES: ["a", "b-c"], ExplorerVerifyError: FakeError, parseHandle }, "m"),
      [`${SITE_URL}reference/errors/a`, `${SITE_URL}reference/errors/b-c`],
    );
  });

  it("throws when the module lacks the class, parseHandle or the codes", () => {
    for (const module of [
      { ERROR_CODES: [], parseHandle },
      { ERROR_CODES: [], ExplorerVerifyError: FakeError },
    ]) {
      assert.throws(
        () => docsUrlsOf(module, "m"),
        /^Error: m exports no ExplorerVerifyError or parseHandle; run the build$/,
      );
    }
    assert.throws(() => docsUrlsOf(null, "m"), /m exports no ExplorerVerifyError/);
    assert.throws(
      () => docsUrlsOf({ ExplorerVerifyError: FakeError, parseHandle }, "m"),
      /m exports no ERROR_CODES/,
    );
  });

  it("throws when an error has no docsUrl", () => {
    assert.throws(
      () => docsUrlsOf({ ERROR_CODES: ["bad"], ExplorerVerifyError: FakeError, parseHandle }, "m"),
      /^Error: m: the error for bad has no docsUrl$/,
    );
  });

  it("throws when the class builds no object", () => {
    assert.throws(
      () => docsUrlsOf({ ERROR_CODES: ["a"], ExplorerVerifyError: NotAnError, parseHandle }, "m"),
      /the error for a has no docsUrl/,
    );
  });
});

describe("siteProblems", () => {
  let out = "";
  const url = `${SITE_URL}reference/errors/a`;

  beforeEach(() => {
    out = mkdtempSync(path.join(tmpdir(), "site-out-"));
    writeFiles(out, {
      "404.html": "",
      "index.html": "",
      "index.md": "",
      "reference/errors/a.html": "",
      "reference/errors/a.md": "",
      "llms.txt": `# x\n\n> y\n\n## User docs\n\n- [Index](${SITE_URL}index.md)\n- [A](${SITE_URL}reference/errors/a.md)\n`,
    });
  });

  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it("passes a build where every docsUrl, llms.txt link and page resolves", () => {
    assert.deepEqual(siteProblems(out, [url, SITE_URL, `${SITE_URL}#top`]), []);
  });

  it("reports a docsUrl off the site, and a page or copy the build lacks", () => {
    rmSync(path.join(out, "reference/errors/a.md"));
    assert.deepEqual(siteProblems(out, ["https://example.com/a", url, `${SITE_URL}reference/b`]), [
      `docsUrl https://example.com/a is not on the docs site ${SITE_URL} (R-AX-10)`,
      `docsUrl ${url}: the built site has no reference/errors/a.md (R-AX-10)`,
      `docsUrl ${SITE_URL}reference/b: the built site has no reference/b.html (R-AX-10)`,
      `docsUrl ${SITE_URL}reference/b: the built site has no reference/b.md (R-AX-10)`,
      "llms.txt:8: link https://aelmanaa.github.io/explorer-verify/reference/errors/a.md names reference/errors/a.md, which is not built (R-AX-17)",
      "reference/errors/a.html has no Markdown copy reference/errors/a.md (R-AX-17)",
    ]);
  });

  it("accepts a site-only page without a copy, and reports an asset the build lacks", () => {
    writeFiles(out, { "about.html": "", "data/sample.json": "{}" });
    assert.deepEqual(
      siteProblems(out, [url], {
        siteOnly: ["about.md"],
        assets: ["data/sample.json", "img/logo.png"],
      }),
      ["the built site has no img/logo.png, a file under docs/user/ (R-AX-17)"],
    );
    assert.deepEqual(siteProblems(out, [url]), [
      "about.html has no Markdown copy about.md (R-AX-17)",
    ]);
  });

  it("reports a missing llms.txt", () => {
    rmSync(path.join(out, "llms.txt"));
    assert.deepEqual(siteProblems(out, []), [
      "the built site has no llms.txt; run node scripts/site-copies.ts (R-AX-17)",
    ]);
  });

  it("reports an llms.txt link that is not a Markdown copy, and a page llms.txt does not list", () => {
    writeFiles(out, {
      "llms.txt": `# x\n\n> y\n\n- [Index](${SITE_URL}index.md)\n- [A](${SITE_URL}reference/errors/a)\n- [E](https://example.com/e.md)\n`,
    });
    assert.deepEqual(siteProblems(out, []), [
      `llms.txt:6: link ${SITE_URL}reference/errors/a is not a Markdown copy on the site (R-AX-17)`,
      "llms.txt:7: link https://example.com/e.md is not a Markdown copy on the site (R-AX-17)",
      "llms.txt does not list reference/errors/a.md (R-AX-17)",
    ]);
  });
});

const LLMS_BODY = `# explorer-verify\n\n> x\n\nThis site holds the docs of explorer-verify 1.2.3. More.\n\n- [A](${SITE_URL}reference/errors/a.md)\n- [B](${SITE_URL}b.md)\n`;

const SITEMAP_BODY = `<urlset><url><loc>${SITE_URL}</loc></url></urlset>`;

function fakeFetch(
  answers: Readonly<Record<string, number | Error>>,
  body: string = LLMS_BODY,
  bodies: Readonly<Record<string, string>> = {},
): { fetchUrl: Fetch; seen: string[]; signals: AbortSignal[] } {
  const seen: string[] = [];
  const signals: AbortSignal[] = [];
  const fetchUrl: Fetch = async (url, init) => {
    assert.equal(init.redirect, "follow");
    signals.push(init.signal);
    seen.push(url);
    const answer = answers[url] ?? 200;
    if (answer instanceof Error) {
      throw answer;
    }
    return {
      status: answer,
      text: async () => bodies[url] ?? (url.endsWith("sitemap.xml") ? SITEMAP_BODY : body),
    };
  };
  return { fetchUrl, seen, signals };
}

describe("smokeProblems", () => {
  const site = "http://127.0.0.1:9/";
  const urls = [`${SITE_URL}reference/errors/a`, "https://example.com/other"];

  it("fetches each docsUrl, its copy, llms.txt and each link in it, once each", async () => {
    const { fetchUrl, seen } = fakeFetch({});
    assert.deepEqual(await smokeProblems(site, "1.2.3", urls, fetchUrl), []);
    assert.deepEqual(seen, [
      `${site}llms.txt`,
      `${site}reference/errors/a`,
      `${site}reference/errors/a.md`,
      "https://example.com/other",
      "https://example.com/other.md",
      `${site}b.md`,
      `${site}sitemap.xml`,
    ]);
  });

  it("gives each request its own timeout signal of 10 seconds", async () => {
    assert.equal(SMOKE_TIMEOUT_MS, 10_000);
    const { fetchUrl, signals } = fakeFetch({});
    await smokeProblems(site, "1.2.3", urls, fetchUrl);
    assert.equal(signals.length, 7);
    assert.equal(new Set(signals).size, 7);
    for (const signal of signals) {
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
    }
  });

  it("reports a request that times out", async () => {
    const { fetchUrl } = fakeFetch({
      [`${site}b.md`]: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    });
    assert.deepEqual(await smokeProblems(site, "1.2.3", urls, fetchUrl), [
      `${site}b.md: TimeoutError: The operation was aborted due to timeout`,
    ]);
  });

  it("accepts the version sentence on a line of its own", async () => {
    const { fetchUrl } = fakeFetch(
      {},
      "# x\n\nThis site holds the docs of explorer-verify 1.2.3.\n",
    );
    assert.deepEqual(await smokeProblems(site, "1.2.3", urls, fetchUrl), []);
  });

  it("reports an llms.txt that names another version", async () => {
    for (const version of ["1.2.4", "0.2.3", "1.2"]) {
      const { fetchUrl } = fakeFetch({});
      assert.deepEqual(await smokeProblems(site, version, urls, fetchUrl), [
        `${site}llms.txt: does not say "This site holds the docs of explorer-verify ${version}."`,
      ]);
    }
  });

  it("reports a status other than 200 and a failed request", async () => {
    const { fetchUrl } = fakeFetch({
      [`${site}reference/errors/a.md`]: 404,
      [`${site}reference/errors/a`]: new TypeError("fetch failed"),
    });
    assert.deepEqual(await smokeProblems(site, "1.2.3", urls, fetchUrl), [
      `${site}reference/errors/a: TypeError: fetch failed`,
      `${site}reference/errors/a.md: status 404`,
    ]);
  });

  it("fetches each asset first, and parses a JSON asset", async () => {
    const seen: string[] = [];
    const bodies: Record<string, string> = {
      [`${site}start/good.json`]: '{"a":1}',
      [`${site}start/bad.json`]: "<!doctype html>",
      [`${site}llms.txt`]: LLMS_BODY,
      [`${site}sitemap.xml`]: SITEMAP_BODY,
    };
    const fetchUrl: Fetch = async (target) => {
      seen.push(target);
      return {
        status: target.endsWith("missing.png") ? 404 : 200,
        text: async () => bodies[target] ?? "",
      };
    };
    assert.deepEqual(
      await smokeProblems(site, "1.2.3", [], fetchUrl, [
        "start/good.json",
        "start/bad.json",
        "img/logo.png",
        "img/missing.png",
      ]),
      [`${site}start/bad.json: the body is not JSON`, `${site}img/missing.png: status 404`],
    );
    assert.deepEqual(seen.slice(0, 5), [
      `${site}start/good.json`,
      `${site}start/bad.json`,
      `${site}img/logo.png`,
      `${site}img/missing.png`,
      `${site}llms.txt`,
    ]);
  });

  it("reports an llms.txt that does not load, and still checks the docsUrls", async () => {
    const { fetchUrl, seen } = fakeFetch({ [`${site}llms.txt`]: 500 });
    assert.deepEqual(await smokeProblems(site, "1.2.3", urls.slice(0, 1), fetchUrl), [
      `${site}llms.txt: status 500`,
    ]);
    assert.equal(seen.length, 4);
  });

  it("reports a sitemap that does not load or does not list the home page (R-AX-17)", async () => {
    const missing = fakeFetch({ [`${site}sitemap.xml`]: 404 });
    assert.deepEqual(await smokeProblems(site, "1.2.3", [], missing.fetchUrl), [
      `${site}sitemap.xml: status 404`,
    ]);
    const empty = fakeFetch({}, LLMS_BODY, { [`${site}sitemap.xml`]: "<urlset></urlset>" });
    assert.deepEqual(await smokeProblems(site, "1.2.3", [], empty.fetchUrl), [
      `${site}sitemap.xml: does not list ${SITE_URL}`,
    ]);
  });

  it("fetches the verification file and the home page's set search console tags (R-AX-17)", async () => {
    const file = "google0123.html";
    const content = `google-site-verification: ${file}\n`;
    const search = {
      files: { [file]: content },
      homeMeta: { "google-site-verification": "g-token", "msvalidate.01": "" },
    };
    const home = '<head><meta name="google-site-verification" content="g-token"></head>';
    const passing = fakeFetch({}, LLMS_BODY, { [`${site}${file}`]: content, [site]: home });
    assert.deepEqual(await smokeProblems(site, "1.2.3", [], passing.fetchUrl, [], search), []);
    assert.deepEqual(passing.seen.slice(-2), [`${site}${file}`, site]);
    const failing = fakeFetch({}, LLMS_BODY, { [`${site}${file}`]: "<!doctype html>", [site]: "" });
    assert.deepEqual(await smokeProblems(site, "1.2.3", [], failing.fetchUrl, [], search), [
      `${site}${file}: the body is not "google-site-verification: ${file}"`,
      `${site}: has no <meta name="google-site-verification"> with the expected token`,
    ]);
    const down = fakeFetch({ [`${site}${file}`]: 404, [site]: 500 });
    assert.deepEqual(await smokeProblems(site, "1.2.3", [], down.fetchUrl, [], search), [
      `${site}${file}: status 404`,
      `${site}: status 500`,
    ]);
  });
});
