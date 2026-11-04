// The docs site helpers (R-AX-10, R-AX-17, decision 0015): site paths, link rewriting, the site's
// llms.txt, the sidebar, the Markdown copies, the build check (test 3) and the smoke check
// (test 4).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { RAW_MAIN } from "../agent-docs.ts";
import {
  API_SECTION,
  docsUrlsOf,
  rewriteForSite,
  SITE_URL,
  siteLlmsTxt,
  sitePath,
  siteProblems,
  siteRewrites,
  siteSourceExcludes,
  siteSidebar,
  SMOKE_TIMEOUT_MS,
  smokeProblems,
  writeSiteCopies,
} from "../site-docs.ts";
import type { Fetch } from "../site-docs.ts";
import { AGENT, IMAGE, makeFixture, read, README, removeFixture, writeFiles } from "./fixture.ts";

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

  it("throws when a folder holds both README.md and index.md", () => {
    writeFiles(root, { "docs/user/index.md": "# Index\n" });
    assert.throws(
      () => siteRewrites(root),
      /^Error: docs\/user\/README\.md and docs\/user\/index\.md would both be index\.md$/,
    );
  });
});

describe("siteSourceExcludes", () => {
  it("hides every Markdown file outside docs/user and site/api, and skips hidden entries", () => {
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

  it("adds a last section that links the Markdown copy of each API reference page", () => {
    const text = `# explorer-verify

> Verifies contract source.

## User docs

- [Index](${RAW_MAIN}docs/user/README.md): the index
`;
    const api = [
      { page: "index.md", title: "API reference" },
      { page: "core-server.md", title: "core/server" },
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
- [core/server](${SITE_URL}api/core-server.md): the exports of \`core/server\`
`,
    );
  });

  it("throws without a summary blockquote", () => {
    assert.throws(() => siteLlmsTxt("# explorer-verify\n", "1.2.3"), /has no summary blockquote/);
  });
});

describe("siteSidebar", () => {
  it("groups the pages by folder, the folder index first and the error codes collapsed", () => {
    writeFiles(root, {
      "docs/user/reference/b.md": "# B page\n",
      "docs/user/reference/errors/zeta.md": "# zeta\n",
      "docs/user/reference/errors/index.md": "# Errors\n",
      "docs/user/explanation/untitled.md": "No heading.\n",
    });
    assert.deepEqual(siteSidebar(root), [
      {
        text: "Guides",
        collapsed: false,
        items: [
          { text: "Using explorer-verify from an agent", link: "/guides/using-from-an-agent" },
        ],
      },
      {
        text: "Errors",
        collapsed: true,
        items: [
          { text: "Errors", link: "/reference/errors/" },
          { text: "zeta", link: "/reference/errors/zeta" },
        ],
      },
      { text: "Reference", collapsed: false, items: [{ text: "B page", link: "/reference/b" }] },
      {
        text: "Explanation",
        collapsed: false,
        items: [{ text: "explanation/untitled.md", link: "/explanation/untitled" }],
      },
    ]);
  });

  it("ends with the API reference, its index first, once site/api holds pages", () => {
    writeFiles(root, {
      "site/api/core.md": "# core\n",
      "site/api/core-server.md": "# core/server\n",
      "site/api/index.md": "# API reference\n",
    });
    assert.deepEqual(siteSidebar(root).at(-1), {
      text: "API reference",
      collapsed: false,
      items: [
        { text: "API reference", link: "/api/" },
        { text: "core", link: "/api/core" },
        { text: "core/server", link: "/api/core-server" },
      ],
    });
  });
});

describe("writeSiteCopies", () => {
  it("writes each page next to its HTML, copies other files and writes llms.txt", () => {
    const out = path.join(root, "out");
    assert.deepEqual(writeSiteCopies(root, out, "1.2.3"), [
      "index.md",
      "guides/using-from-an-agent.md",
      "img/logo.png",
      "llms.txt",
    ]);
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

function fakeFetch(
  answers: Readonly<Record<string, number | Error>>,
  body: string = LLMS_BODY,
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
    return { status: answer, text: async () => body };
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
    ]);
  });

  it("gives each request its own timeout signal of 10 seconds", async () => {
    assert.equal(SMOKE_TIMEOUT_MS, 10_000);
    const { fetchUrl, signals } = fakeFetch({});
    await smokeProblems(site, "1.2.3", urls, fetchUrl);
    assert.equal(signals.length, 6);
    assert.equal(new Set(signals).size, 6);
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

  it("reports an llms.txt that does not load, and still checks the docsUrls", async () => {
    const { fetchUrl, seen } = fakeFetch({ [`${site}llms.txt`]: 500 });
    assert.deepEqual(await smokeProblems(site, "1.2.3", urls.slice(0, 1), fetchUrl), [
      `${site}llms.txt: status 500`,
    ]);
    assert.equal(seen.length, 3);
  });
});
