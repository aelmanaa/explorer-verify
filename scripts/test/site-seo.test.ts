// What the docs site tells search engines (R-AX-17, issues #366 and #367): canonical URLs, the
// head tags of each page, the home page's JSON-LD, the search console tokens and file, the
// sitemap's lastmod, the page descriptions and the check of a built site.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { descriptionProblems, readPageDescriptions } from "../site-descriptions.ts";
import { SITE_URL, siteDescription, siteStaticFiles } from "../site-docs.ts";
import {
  BRAND_FILES,
  canonicalUrl,
  gitLastModified,
  iconHead,
  googleFileContent,
  lastModifiedFromLog,
  packageFacts,
  pngSize,
  readHead,
  readVerification,
  searchHead,
  searchProblems,
  SITE_NAME,
  sitemapUrls,
  SOCIAL_IMAGE_ALT,
  softwareSourceCode,
  verificationFiles,
  verificationTags,
} from "../site-seo.ts";
import type { SearchExpectations, Verification } from "../site-seo.ts";
import {
  builtPage,
  makeFixture,
  pngHeader,
  removeFixture,
  sitemapOf,
  writeBrandFiles,
  writeFiles,
} from "./fixture.ts";
import { commit, git, makeRepo, remove } from "./git-repo.ts";

/** The root of this repository. */
const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const NONE: Verification = { google: "", bing: "", googleFile: "" };
const FACTS = {
  name: "explorer-verify",
  version: "1.2.3",
  description: "Verifies contracts.",
  license: "MIT",
  repository: "https://github.com/aelmanaa/explorer-verify",
};

describe("canonicalUrl (R-AX-17)", () => {
  it("is absolute, under the base, without .md or .html, and a folder index is the folder", () => {
    assert.equal(canonicalUrl("index.md"), SITE_URL);
    assert.equal(canonicalUrl("guides/verify-from-node.md"), `${SITE_URL}guides/verify-from-node`);
    assert.equal(canonicalUrl("api/explorer-verify/index.md"), `${SITE_URL}api/explorer-verify/`);
    assert.equal(canonicalUrl("reference/errors/index.md"), `${SITE_URL}reference/errors/`);
  });
});

describe("searchHead (R-AX-17)", () => {
  const input = { title: "T | explorer-verify", description: "D", facts: FACTS };

  it("gives the 404 page no tag", () => {
    assert.deepEqual(searchHead({ ...input, page: "404.md", verification: NONE }), []);
  });

  it("gives a page one canonical link and Open Graph tags whose og:url is the canonical", () => {
    const tags = searchHead({ ...input, page: "guides/x.md", verification: NONE });
    const url = `${SITE_URL}guides/x`;
    assert.deepEqual(tags, [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:site_name", content: "explorer-verify" }],
      ["meta", { property: "og:title", content: "T | explorer-verify" }],
      ["meta", { property: "og:description", content: "D" }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:image", content: `${SITE_URL}og-image.png` }],
      ["meta", { property: "og:image:width", content: "1280" }],
      ["meta", { property: "og:image:height", content: "640" }],
      ["meta", { property: "og:image:alt", content: SOCIAL_IMAGE_ALT }],
      ["meta", { name: "twitter:card", content: "summary_large_image" }],
      ["meta", { name: "twitter:image", content: `${SITE_URL}og-image.png` }],
      ["meta", { name: "twitter:image:alt", content: SOCIAL_IMAGE_ALT }],
    ]);
  });

  it("adds the JSON-LD and the set search console tags on the home page only", () => {
    const home = searchHead({
      ...input,
      page: "index.md",
      verification: { google: "g-token", bing: "", googleFile: "" },
    });
    assert.deepEqual(
      home.filter(([tag]) => tag === "meta").filter(([, attrs]) => attrs.name !== undefined),
      [
        ["meta", { name: "twitter:card", content: "summary_large_image" }],
        ["meta", { name: "twitter:image", content: `${SITE_URL}og-image.png` }],
        ["meta", { name: "twitter:image:alt", content: SOCIAL_IMAGE_ALT }],
        ["meta", { name: "google-site-verification", content: "g-token" }],
      ],
    );
    const script = home.find(([tag]) => tag === "script");
    assert.ok(script !== undefined && script.length === 3);
    assert.deepEqual(JSON.parse(script[2]), softwareSourceCode(FACTS));
    const page = searchHead({
      ...input,
      page: "guides/x.md",
      verification: { google: "g", bing: "b", googleFile: "" },
    });
    assert.equal(
      page.some(([tag, attrs]) => tag === "script" || attrs.name === "google-site-verification"),
      false,
    );
  });

  it("escapes < in the JSON-LD so it cannot close the script", () => {
    const tags = searchHead({
      ...input,
      page: "index.md",
      facts: { ...FACTS, description: "a </script> b" },
      verification: NONE,
    });
    const script = tags.find(([tag]) => tag === "script");
    assert.ok(script !== undefined && script.length === 3);
    assert.equal(script[2].includes("<"), false);
    assert.equal(stringField(JSON.parse(script[2]), "description"), "a </script> b");
  });
});

/** A string field of a parsed JSON value. */
function stringField(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

describe("softwareSourceCode and packageFacts (R-AX-17)", () => {
  it("reads the version, description, license and repository from the core manifest", () => {
    const facts = packageFacts(REPOSITORY);
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(REPOSITORY, "packages/explorer-verify/package.json"), "utf8"),
    );
    assert.equal(facts.version, stringField(manifest, "version"));
    assert.equal(facts.repository, "https://github.com/aelmanaa/explorer-verify");
    const data = softwareSourceCode(facts);
    assert.equal(data["@type"], "SoftwareSourceCode");
    assert.equal(data.version, facts.version);
    assert.equal(data.programmingLanguage, "TypeScript");
    assert.equal(data.codeRepository, facts.repository);
  });

  it("throws when the manifest lacks a fact", () => {
    const root = makeFixture();
    try {
      assert.throws(() => packageFacts(root), /has no description/);
    } finally {
      removeFixture(root);
    }
  });
});

describe("readVerification (R-AX-17)", () => {
  let root = "";
  beforeEach(() => {
    root = makeFixture();
  });
  afterEach(() => {
    removeFixture(root);
  });

  it("reads the tokens and the file name, empty for none", () => {
    writeFiles(root, {
      "site/verification.json": JSON.stringify({ google: "a_B-1", bing: "", googleFile: "" }),
    });
    assert.deepEqual(readVerification(root), { google: "a_B-1", bing: "", googleFile: "" });
  });

  it("refuses a value that is not a token, and a missing field", () => {
    for (const value of [
      { google: '"><script>', bing: "", googleFile: "" },
      { google: "", bing: "", googleFile: "../x.html" },
      { google: "", bing: "" },
    ]) {
      writeFiles(root, { "site/verification.json": JSON.stringify(value) });
      assert.throws(() => readVerification(root), /must be a token string/);
    }
  });

  it("holds in this repository: the Google file is in site/static with its exact content", () => {
    const verification = readVerification(REPOSITORY);
    assert.equal(verification.bing, "");
    assert.ok(siteStaticFiles(REPOSITORY).includes(verification.googleFile));
    assert.equal(
      readFileSync(path.join(REPOSITORY, "site/static", verification.googleFile), "utf8"),
      googleFileContent(verification.googleFile),
    );
  });
});

describe("lastModifiedFromLog (R-AX-17)", () => {
  const log = [
    "",
    "2026-11-12T10:00:00+00:00\n\ndiff --git a/docs/user/a.md b/docs/user/a.md\n--- a/docs/user/a.md\n+++ b/docs/user/a.md\n@@ -3 +3 @@\n-Version: explorer-verify 0.1.0\n+Version: explorer-verify 0.2.0\ndiff --git a/docs/user/b.md b/docs/user/b.md\n--- a/docs/user/b.md\n+++ b/docs/user/b.md\n@@ -3 +3 @@\n-Version: explorer-verify 0.1.0\n+Version: explorer-verify 0.2.0\n@@ -9 +9 @@\n-old\n+new\n",
    "2026-11-05T10:00:00+00:00\n\ndiff --git a/docs/user/a.md b/docs/user/a.md\n--- a/docs/user/a.md\n+++ b/docs/user/a.md\n@@ -9 +9 @@\n-old\n+new\n",
    "2026-11-01T10:00:00+00:00\n\ndiff --git a/docs/user/c.md b/docs/user/c.md\n--- a/docs/user/c.md\n+++ b/docs/user/c.md\n@@ -3 +3 @@\n-Version: explorer-verify 0.0.9\n+Version: explorer-verify 0.1.0\n",
  ].join("\0");

  it("keeps the earlier date of a page whose only later change is its Version line", () => {
    const dates = lastModifiedFromLog(log);
    assert.equal(dates.get("docs/user/a.md"), "2026-11-05T10:00:00+00:00");
    assert.equal(dates.get("docs/user/b.md"), "2026-11-12T10:00:00+00:00");
    assert.equal(dates.has("docs/user/c.md"), false);
  });
});

describe("gitLastModified (R-AX-17)", () => {
  let repo = "";
  afterEach(() => {
    remove(repo);
  });

  it("skips a commit that only changes the Version line, and gives none on a shallow clone", () => {
    repo = makeRepo("site-lastmod-", {
      "docs/user/a.md": "# A\n\nVersion: explorer-verify 0.1.0\n\nText.\n",
    });
    const first = git(repo, ["log", "-1", "--format=%cI"]);
    commit(repo, { "docs/user/a.md": "# A\n\nVersion: explorer-verify 0.2.0\n\nText.\n" }, "v");
    assert.equal(gitLastModified(repo, ["docs/user"])?.get("docs/user/a.md"), first);
    const clone = mkdtempSync(path.join(tmpdir(), "site-shallow-"));
    try {
      git(clone, ["clone", "--quiet", "--depth", "1", `file://${repo}`, "."]);
      assert.equal(gitLastModified(clone, ["docs/user"]), undefined);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("gives none outside a git checkout", () => {
    repo = mkdtempSync(path.join(tmpdir(), "site-no-git-"));
    assert.equal(gitLastModified(repo, ["docs/user"]), undefined);
  });
});

describe("readHead and sitemapUrls", () => {
  it("read tags whose attributes hold > and entities", () => {
    const head = readHead(
      '<head><title>A &amp; B</title><meta name="description" content="x -> y &quot;z&quot;"><link rel="canonical" href="u"></head>',
    );
    assert.deepEqual(head.titles, ["A & B"]);
    assert.deepEqual(head.descriptions, ['x -> y "z"']);
    assert.deepEqual(head.canonicals, ["u"]);
    assert.deepEqual(sitemapUrls(sitemapOf(["", "a"])), [SITE_URL, `${SITE_URL}a`]);
  });
});

/** The built HTML file of a URL path on the site. */
function builtFile(page: string): string {
  return page === "" ? "index.html" : page.endsWith("/") ? `${page}index.html` : `${page}.html`;
}

describe("searchProblems (R-AX-17)", () => {
  let out = "";
  const pages = ["", "guides/a", "api/x/"];
  const expected: SearchExpectations = {
    version: "1.2.3",
    siteDescription: siteDescription("1.2.3"),
    verification: NONE,
  };

  beforeEach(() => {
    out = mkdtempSync(path.join(tmpdir(), "site-seo-"));
    writeFiles(out, {
      ...Object.fromEntries(
        pages.map((page) => [builtFile(page), builtPage(page, { home: page === "" })]),
      ),
      "404.html": "<head><title>404</title></head>",
      "sitemap.xml": sitemapOf(pages),
    });
    writeBrandFiles(out);
  });

  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it("passes a build where every page has its tags and the sitemap lists it", () => {
    assert.deepEqual(searchProblems(out, expected), []);
  });

  it("fails on a missing title, a shared title and a title too long", () => {
    writeFiles(out, {
      "guides/a.html": builtPage("guides/a", { title: "" }).replace("<title></title>", ""),
      "api/x/index.html": builtPage("api/x/", { title: "The page home | explorer-verify" }),
    });
    assert.deepEqual(searchProblems(out, expected), [
      "guides/a.html: has 0 titles; give it one (R-AX-17)",
      'api/x/index.html, index.html: share the title "The page home | explorer-verify"; give each its own (R-AX-17)',
    ]);
    writeFiles(out, {
      "guides/a.html": builtPage("guides/a", { title: `${"x".repeat(61)} | explorer-verify` }),
    });
    assert.match(
      searchProblems(out, expected).join("\n"),
      /guides\/a\.html: the title "x{61}" is longer than 60/,
    );
  });

  it("fails on a missing, shared, short, long or site-level description, with the page path", () => {
    writeFiles(out, {
      "guides/a.html": builtPage("guides/a").replace(/<meta name="description"[^>]*>/, ""),
    });
    assert.deepEqual(searchProblems(out, expected), [
      "guides/a.html: has 0 descriptions; give it one (R-AX-17)",
    ]);
    writeFiles(out, {
      "guides/a.html": builtPage("guides/a", { description: "x".repeat(39) }),
      "api/x/index.html": builtPage("api/x/", { description: "y".repeat(161) }),
    });
    assert.deepEqual(searchProblems(out, expected), [
      "api/x/index.html: the description has 161 characters; keep it between 40 and 160 (R-AX-17)",
      "guides/a.html: the description has 39 characters; keep it between 40 and 160 (R-AX-17)",
    ]);
    const shared = "The same description on two pages of the site.";
    writeFiles(out, {
      "guides/a.html": builtPage("guides/a", { description: shared }),
      "api/x/index.html": builtPage("api/x/", { description: shared }),
    });
    assert.deepEqual(searchProblems(out, expected), [
      `api/x/index.html, guides/a.html: share the description "${shared}"; give each its own (R-AX-17)`,
    ]);
    writeFiles(out, {
      "guides/a.html": builtPage("guides/a", { description: expected.siteDescription }),
      "api/x/index.html": builtPage("api/x/"),
    });
    assert.deepEqual(searchProblems(out, expected), [
      "guides/a.html: the description is the site's own; give the page its own (R-AX-17)",
    ]);
  });

  it("fails on no canonical link, two, or one that is not the sitemap URL", () => {
    writeFiles(out, {
      "guides/a.html": builtPage("guides/a").replace(/<link rel="canonical"[^>]*>/, ""),
    });
    assert.deepEqual(searchProblems(out, expected), [
      "guides/a.html: has 0 canonical links; give it one (R-AX-17)",
    ]);
    writeFiles(out, {
      "guides/a.html": builtPage("guides/a", {
        extra: `<link rel="canonical" href="${SITE_URL}guides/a">`,
      }),
    });
    assert.deepEqual(searchProblems(out, expected), [
      "guides/a.html: has 2 canonical links; give it one (R-AX-17)",
    ]);
    writeFiles(out, {
      "guides/a.html": builtPage("guides/a", { canonical: `${SITE_URL}guides/a.html` }),
    });
    assert.deepEqual(searchProblems(out, expected), [
      `guides/a.html: the canonical link ${SITE_URL}guides/a.html is not its sitemap URL ${SITE_URL}guides/a (R-AX-17)`,
    ]);
  });

  it("fails on a page without og:url, or with an og:url other than its canonical", () => {
    writeFiles(out, {
      "guides/a.html": builtPage("guides/a").replace(/<meta property="og:url"[^>]*>/, ""),
    });
    assert.deepEqual(searchProblems(out, expected), [
      "guides/a.html: needs one og:url tag (R-AX-17)",
    ]);
    writeFiles(out, { "guides/a.html": builtPage("guides/a", { ogUrl: `${SITE_URL}other` }) });
    assert.deepEqual(searchProblems(out, expected), [
      `guides/a.html: og:url ${SITE_URL}other is not its canonical URL ${SITE_URL}guides/a (R-AX-17)`,
    ]);
  });

  it("fails on a home page without JSON-LD, with invalid JSON, or with another version", () => {
    writeFiles(out, { "index.html": builtPage("", { extra: "" }) });
    assert.deepEqual(searchProblems(out, expected), [
      "index.html: has 0 JSON-LD blocks; give it one (R-AX-17)",
    ]);
    writeFiles(out, {
      "index.html": builtPage("", {
        extra: '<script type="application/ld+json">{"version":</script>',
      }),
    });
    assert.deepEqual(searchProblems(out, expected), [
      "index.html: the JSON-LD block is not JSON (R-AX-17)",
    ]);
    writeFiles(out, { "index.html": builtPage("", { home: true, version: "1.2.2" }) });
    assert.deepEqual(searchProblems(out, expected), [
      "index.html: the JSON-LD names version 1.2.2, not the core package's 1.2.3 (R-AX-17)",
    ]);
    writeFiles(out, {
      "index.html": builtPage("", {
        extra: '<script type="application/ld+json">{"version":"1.2.3"}</script>',
      }),
    });
    assert.deepEqual(searchProblems(out, expected), [
      "index.html: the JSON-LD block is not a SoftwareSourceCode (R-AX-17)",
    ]);
  });

  it("fails when the sitemap is missing, misses a page or lists an unbuilt, relative, .html or off-base URL", () => {
    rmSync(path.join(out, "sitemap.xml"));
    assert.deepEqual(searchProblems(out, expected), [
      "the built site has no sitemap.xml; set sitemap.hostname in the site config (R-AX-17)",
    ]);
    writeFiles(out, {
      "sitemap.xml": sitemapOf(["", "api/x/", "guides/gone"]).replace(
        "</urlset>",
        "<url><loc>/explorer-verify/guides/a</loc></url><url><loc>https://aelmanaa.github.io/guides/a</loc></url><url><loc>https://aelmanaa.github.io/explorer-verify/guides/a.html</loc></url></urlset>",
      ),
    });
    assert.deepEqual(searchProblems(out, expected), [
      `sitemap.xml lists ${SITE_URL}guides/gone, which is not a built page (R-AX-17)`,
      `sitemap.xml lists /explorer-verify/guides/a, which is not an absolute URL under ${SITE_URL} (R-AX-17)`,
      `sitemap.xml lists https://aelmanaa.github.io/guides/a, which is not an absolute URL under ${SITE_URL} (R-AX-17)`,
      `sitemap.xml lists ${SITE_URL}guides/a.html, which ends in .html (R-AX-17)`,
      "guides/a.html: sitemap.xml does not list it (R-AX-17)",
    ]);
  });

  it("fails on a page without a social image tag, or with a relative or other one (#373)", () => {
    writeFiles(out, {
      "guides/a.html": builtPage("guides/a")
        .replace(/<meta property="og:image" [^>]*>/, "")
        .replace(
          /<meta name="twitter:image"[^>]*>/,
          '<meta name="twitter:image" content="/explorer-verify/og-image.png">',
        ),
      "api/x/index.html": builtPage("api/x/")
        .replace('content="summary_large_image"', 'content="summary"')
        .replace('og:image:width" content="1280"', 'og:image:width" content="1200"')
        .replace(
          /<meta property="og:image:alt"[^>]*>/,
          '<meta property="og:image:alt" content="">',
        ),
    });
    assert.deepEqual(searchProblems(out, expected), [
      "api/x/index.html: og:image:width is 1200, not 1280 (#373)",
      "api/x/index.html: needs one og:image:alt tag (#373)",
      "api/x/index.html: twitter:card is summary, not summary_large_image (#373)",
      "guides/a.html: needs one og:image tag (#373)",
      `guides/a.html: twitter:image is /explorer-verify/og-image.png, not ${SITE_URL}og-image.png (#373)`,
    ]);
  });

  it("fails when an icon or the social image is not built, or a PNG has another size (#373)", () => {
    rmSync(path.join(out, "favicon.svg"));
    rmSync(path.join(out, "apple-touch-icon.png"));
    writeFiles(out, { "favicon-32.png": "not a png" });
    writeFileSync(path.join(out, "og-image.png"), pngHeader(1200, 630));
    assert.deepEqual(searchProblems(out, expected), [
      "the built site has no favicon.svg; keep it in site/static/ and render it with node site/render-images.ts (#373)",
      "favicon-32.png: is not a PNG, not 32×32 (#373)",
      "the built site has no apple-touch-icon.png; keep it in site/static/ and render it with node site/render-images.ts (#373)",
      "og-image.png: is 1200×630, not 1280×640 (#373)",
    ]);
  });

  it("fails when a robots.txt is built", () => {
    writeFiles(out, { "robots.txt": "User-agent: *\n" });
    assert.match(searchProblems(out, expected).join("\n"), /^the built site has robots\.txt/);
  });

  it("skips the static files, and checks the Google file and the search console tags", () => {
    const googleFile = "google0123.html";
    const verification = { google: "g-token", bing: "", googleFile };
    writeFiles(out, {
      [googleFile]: googleFileContent(googleFile),
      "index.html": builtPage("", {
        home: true,
        extra: `<meta name="google-site-verification" content="g-token"><script type="application/ld+json">{"@type":"SoftwareSourceCode","version":"1.2.3"}</script>`,
      }),
    });
    assert.deepEqual(
      searchProblems(out, { ...expected, verification, staticFiles: [googleFile] }),
      [],
    );
    writeFiles(out, { "index.html": builtPage("", { home: true }) });
    rmSync(path.join(out, googleFile));
    assert.deepEqual(
      searchProblems(out, { ...expected, verification, staticFiles: [googleFile] }),
      [
        'index.html: needs <meta name="google-site-verification"> with the token in site/verification.json (R-AX-17)',
        `the built site has no ${googleFile}, the Google verification file; keep it in site/static/ (R-AX-17)`,
      ],
    );
    // An empty token emits no tag, and the check passes.
    assert.deepEqual(searchProblems(out, expected), []);
  });
});

describe("page descriptions (R-AX-17)", () => {
  let root = "";
  beforeEach(() => {
    root = makeFixture();
  });
  afterEach(() => {
    removeFixture(root);
  });

  it("gives every user page of this repository one unique description of 40 to 160 characters", () => {
    assert.deepEqual(descriptionProblems(REPOSITORY), []);
    assert.ok(readPageDescriptions(REPOSITORY).size > 0);
  });

  it("reports a page without one, an entry for no page, a bad length and a shared one", () => {
    writeFiles(root, {
      "site/descriptions.json": JSON.stringify({
        "README.md": "The same text that two of the pages of the fixture share.",
        "gone.md": "The same text that two of the pages of the fixture share.",
        "img.md": "short",
      }),
    });
    assert.deepEqual(descriptionProblems(root), [
      "docs/user/guides/using-from-an-agent.md has no description; add one to site/descriptions.json (R-AX-17)",
      "site/descriptions.json names gone.md, which is not a page under docs/user/ (R-AX-17)",
      "site/descriptions.json: README.md and gone.md share a description (R-AX-17)",
      "site/descriptions.json names img.md, which is not a page under docs/user/ (R-AX-17)",
      "site/descriptions.json: img.md has 5 characters; keep it between 40 and 160 (R-AX-17)",
    ]);
  });

  it("refuses a file that is not an object of strings", () => {
    writeFiles(root, { "site/descriptions.json": "[]" });
    assert.throws(() => readPageDescriptions(root), /must be an object/);
    writeFiles(root, { "site/descriptions.json": '{"README.md": 1}' });
    assert.throws(() => readPageDescriptions(root), /is not a string/);
  });
});

describe("verificationFiles and verificationTags (R-AX-17)", () => {
  it("serve the Google file with its exact content, and list each tag with its token", () => {
    assert.deepEqual(verificationFiles(NONE), {});
    assert.deepEqual(verificationFiles({ ...NONE, googleFile: "google1.html" }), {
      "google1.html": "google-site-verification: google1.html\n",
    });
    assert.deepEqual(verificationTags({ google: "g", bing: "b", googleFile: "" }), {
      "google-site-verification": "g",
      "msvalidate.01": "b",
    });
  });

  it("add the Bing tag to the home page when its token is set", () => {
    const tags = searchHead({
      page: "index.md",
      title: "T",
      description: "D",
      facts: FACTS,
      verification: { google: "", bing: "b-token", googleFile: "" },
    });
    assert.ok(
      tags.some(([, attrs]) => attrs.name === "msvalidate.01" && attrs.content === "b-token"),
    );
    assert.equal(
      tags.some(([, attrs]) => attrs.name === "google-site-verification"),
      false,
    );
  });
});

describe("searchProblems on a build without a home page or with stray tags (R-AX-17)", () => {
  let out = "";
  beforeEach(() => {
    out = mkdtempSync(path.join(tmpdir(), "site-seo-home-"));
    writeBrandFiles(out);
  });
  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it("reports a build without index.html", () => {
    writeFiles(out, { "a.html": builtPage("a"), "sitemap.xml": sitemapOf(["a"]) });
    assert.deepEqual(
      searchProblems(out, { version: "1.2.3", siteDescription: "x", verification: NONE }),
      ["the built site has no index.html (R-AX-17)"],
    );
  });

  it("reports a verification tag the config does not set, and a JSON-LD without a version", () => {
    writeFiles(out, {
      "index.html": builtPage("", {
        extra:
          '<meta name="msvalidate.01" content="old"><script type="application/ld+json">{"@type":"SoftwareSourceCode"}</script>',
      }),
      "sitemap.xml": sitemapOf([""]),
    });
    assert.deepEqual(
      searchProblems(out, { version: "1.2.3", siteDescription: "x", verification: NONE }),
      [
        "index.html: the JSON-LD names version undefined, not the core package's 1.2.3 (R-AX-17)",
        'index.html: has <meta name="msvalidate.01"> but site/verification.json sets none (R-AX-17)',
      ],
    );
  });

  it("reports a page with two titles or two descriptions, and a missing og tag", () => {
    writeFiles(out, {
      "index.html": builtPage("", {
        home: true,
        extra:
          '<title>Two</title><meta name="description" content="Another description that is long enough.">',
      }).replace(/<meta property="og:title"[^>]*>/, ""),
      "sitemap.xml": sitemapOf([""]),
    });
    assert.deepEqual(
      searchProblems(out, { version: "1.2.3", siteDescription: "x", verification: NONE }),
      [
        "index.html: has 2 titles; give it one (R-AX-17)",
        "index.html: has 2 descriptions; give it one (R-AX-17)",
        "index.html: needs one og:title tag (R-AX-17)",
        "index.html: has 0 JSON-LD blocks; give it one (R-AX-17)",
      ],
    );
  });
});

describe("readPageDescriptions without a file", () => {
  it("gives none", () => {
    const root = makeFixture();
    try {
      assert.equal(readPageDescriptions(root).size, 0);
    } finally {
      removeFixture(root);
    }
  });
});

describe("site-seo edge cases", () => {
  it("reads an empty head, a meta tag without content and a canonical without href", () => {
    assert.deepEqual(readHead("<p>no head</p>").titles, []);
    const head = readHead('<head><meta name="x"><link rel="canonical"></head>');
    assert.deepEqual(head.meta.get("x"), [""]);
    assert.deepEqual(head.canonicals, [""]);
  });

  it("refuses a verification file that is not an object, and a repository field that is not one", () => {
    const root = makeFixture();
    try {
      writeFiles(root, { "site/verification.json": "1" });
      assert.throws(() => readVerification(root), /must be a token string/);
      writeFiles(root, {
        "packages/explorer-verify/package.json": JSON.stringify({
          name: "x",
          version: "1.2.3",
          description: "d",
          license: "MIT",
          repository: "github:aelmanaa/explorer-verify",
        }),
      });
      assert.throws(() => packageFacts(root), /has no repository\.url/);
    } finally {
      removeFixture(root);
    }
  });

  it("gives no lastmod in a repository without commits", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "site-empty-git-"));
    try {
      git(empty, ["init", "--quiet"]);
      assert.equal(gitLastModified(empty, ["docs/user"]), undefined);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("measures a title without the site suffix as it is", () => {
    const out = mkdtempSync(path.join(tmpdir(), "site-seo-title-"));
    try {
      writeFiles(out, {
        "index.html": builtPage("", { home: true, title: "y".repeat(61) }),
        "sitemap.xml": sitemapOf([""]),
      });
      writeBrandFiles(out);
      assert.deepEqual(
        searchProblems(out, { version: "1.2.3", siteDescription: "x", verification: NONE }),
        [`index.html: the title "${"y".repeat(61)}" is longer than 60 characters (R-AX-17)`],
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("the icons and the social image (#373)", () => {
  it("links the SVG icon, a PNG fallback and the touch icon under the base", () => {
    assert.deepEqual(iconHead(), [
      ["link", { rel: "icon", href: "/explorer-verify/favicon.svg", type: "image/svg+xml" }],
      [
        "link",
        { rel: "icon", href: "/explorer-verify/favicon-32.png", type: "image/png", sizes: "32x32" },
      ],
      ["link", { rel: "apple-touch-icon", href: "/explorer-verify/apple-touch-icon.png" }],
    ]);
  });

  it("reads a PNG's size and refuses a short file or another signature", () => {
    assert.deepEqual(pngSize(pngHeader(1280, 640)), [1280, 640]);
    assert.equal(pngSize(pngHeader(1, 1).subarray(0, 20)), undefined);
    assert.equal(pngSize(Buffer.from("GIF89a".padEnd(24, "x"))), undefined);
  });

  it("holds in this repository: every file is in site/static, each PNG at its size", () => {
    const files = siteStaticFiles(REPOSITORY);
    for (const file of BRAND_FILES) {
      assert.ok(files.includes(file), `site/static/${file} is missing`);
    }
    const sizeOf = (file: string): [number, number] | undefined =>
      pngSize(readFileSync(path.join(REPOSITORY, "site/static", file)));
    assert.deepEqual(sizeOf("og-image.png"), [1280, 640]);
    assert.deepEqual(sizeOf("apple-touch-icon.png"), [180, 180]);
    assert.deepEqual(sizeOf("favicon-32.png"), [32, 32]);
  });

  it("names the site in lower case, as the logo does", () => {
    assert.equal(SITE_NAME, "explorer-verify");
    assert.ok(SOCIAL_IMAGE_ALT.startsWith(`${SITE_NAME}:`));
  });
});
