// Runs the docs site scripts as child processes against a fixture tree, the way `pnpm run
// site:build`, pull request CI and the deploy workflow run them (R-AX-10, R-AX-17, decision 0015).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CORE_ENTRY, RAW_MAIN } from "../agent-docs.ts";
import { SITE_OUT, SITE_URL } from "../site-docs.ts";
import {
  builtPage,
  edit,
  makeFixture,
  removeFixture,
  sitemapOf,
  writeBrandFiles,
  writeFiles,
} from "./fixture.ts";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODE_PAGE = "docs/user/reference/errors/boom.md";

// A built core with one code. Its errors carry the docsUrl of that code on the site.
const CORE = `export const ERROR_CODES = ["boom"];
export function parseHandle(line) { return { line }; }
export class ExplorerVerifyError {
  constructor(details) { this.docsUrl = "${SITE_URL}reference/errors/" + details.code; }
}
`;

let root = "";

/** Runs a script with `node` and resolves with its exit status and output. */
function run(
  script: string,
  ...args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", path.join(scripts, script), ...args],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          status: error === null ? 0 : error.code === undefined ? null : Number(error.code),
          stdout,
          stderr,
        });
      },
    );
  });
}

/** The pages VitePress builds for the fixture, by their URL path on the site. */
const PAGES = ["", "guides/using-from-an-agent", "reference/errors/boom"];

/**
 * Writes the HTML pages VitePress would build for the fixture's pages, each with its title,
 * description, canonical link and Open Graph tags, the first with the JSON-LD block, and the
 * sitemap that lists them.
 */
function writeHtml(pages: readonly string[] = PAGES): void {
  writeFiles(root, {
    ...Object.fromEntries(
      pages.map((page, index) => [
        `${SITE_OUT}/${page === "" ? "index" : page}.html`,
        builtPage(page, { home: index === 0, version: "1.2.3" }),
      ]),
    ),
    [`${SITE_OUT}/404.html`]: "",
    [`${SITE_OUT}/sitemap.xml`]: sitemapOf(pages),
  });
  writeBrandFiles(path.join(root, SITE_OUT));
}

beforeEach(() => {
  root = makeFixture();
  writeFiles(root, {
    [CORE_ENTRY]: CORE,
    "site/verification.json": JSON.stringify({ google: "", bing: "", googleFile: "" }),
    "site/descriptions.json": JSON.stringify({
      "README.md": "The index of the fixture's user docs, with every page listed.",
      "guides/using-from-an-agent.md": "Which calls an agent may run alone in the fixture's docs.",
      "reference/errors/boom.md": "Error boom: the fixture's only error code, and how to fix it.",
    }),
    [CODE_PAGE]:
      "# boom\n\nVersion: explorer-verify 1.2.3\n\nAgents: [llms.txt](../../../../llms.txt).\n",
  });
  edit(
    root,
    "llms.txt",
    "- [Skill]",
    `- [boom](${RAW_MAIN}${CODE_PAGE}): the code page\n- [Skill]`,
  );
});

afterEach(() => {
  removeFixture(root);
});

describe("site-copies.ts", () => {
  it("writes the Markdown copies and llms.txt into the build output", async () => {
    const result = await run("site-copies.ts", root);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "site copies: wrote 6 files to site/dist\n");
    assert.match(
      readFileSync(path.join(root, SITE_OUT, "llms.txt"), "utf8"),
      /\(https:\/\/aelmanaa\.github\.io\/explorer-verify\/reference\/errors\/boom\.md\)/,
    );
  });
});

describe("check-site.ts (test 3)", () => {
  it("exits 0 when every docsUrl maps to a page and its copy", async () => {
    await run("site-copies.ts", root);
    writeHtml();
    const result = await run("check-site.ts", root);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout,
      "site: the docsUrl of 1 error codes, llms.txt, the Markdown copies, the sidebar, the sitemap and the search tags resolve in site/dist\n",
    );
  });

  it("exits 1 when a user page is in no sidebar group", async () => {
    writeFiles(root, { "docs/user/guides/unlisted.md": "# Unlisted\n" });
    await run("site-copies.ts", root);
    writeHtml([...PAGES, "guides/unlisted"]);
    const result = await run("check-site.ts", root);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "docs/user/guides/unlisted.md is in no sidebar group; add it to SIDEBAR in scripts/site-docs.ts\ndocs/user/guides/unlisted.md has no description; add one to site/descriptions.json (R-AX-17)\nllms.txt does not list guides/unlisted.md (R-AX-17)\n",
    );
  });

  it("accepts the site-only pages without a Markdown copy", async () => {
    writeFiles(root, { "site/pages/index.md": "---\nlayout: home\n---\n" });
    await run("site-copies.ts", root);
    writeHtml([...PAGES, "overview"]);
    const result = await run("check-site.ts", root);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
  });

  it("copies the files of site/static as they are and fails without the Google file (R-AX-17)", async () => {
    const file = "google0123456789abcdef.html";
    writeFiles(root, {
      "site/verification.json": JSON.stringify({ google: "", bing: "", googleFile: file }),
      [`site/static/${file}`]: `google-site-verification: ${file}\n`,
    });
    await run("site-copies.ts", root);
    writeHtml();
    assert.equal(
      readFileSync(path.join(root, SITE_OUT, file), "utf8"),
      `google-site-verification: ${file}\n`,
    );
    const passing = await run("check-site.ts", root);
    assert.equal(passing.stderr, "");
    assert.equal(passing.status, 0);
    writeFiles(root, { [`${SITE_OUT}/${file}`]: "<!doctype html><title>x</title>" });
    const failing = await run("check-site.ts", root);
    assert.equal(failing.status, 1);
    assert.equal(
      failing.stderr,
      `${file}: the content is not "google-site-verification: ${file}" (R-AX-17)\n`,
    );
  });

  it("exits 1 when the sitemap is missing or a page lacks its search tags (R-AX-17)", async () => {
    await run("site-copies.ts", root);
    writeHtml();
    writeFiles(root, { [`${SITE_OUT}/guides/using-from-an-agent.html`]: "<head></head>" });
    rmSync(path.join(root, SITE_OUT, "sitemap.xml"));
    const result = await run("check-site.ts", root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^the built site has no sitemap\.xml/m);
    assert.match(result.stderr, /^guides\/using-from-an-agent\.html: has 0 titles/m);
  });

  it("exits 1 and names the file a docsUrl lacks", async () => {
    await run("site-copies.ts", root);
    writeHtml();
    writeFiles(root, {
      [CORE_ENTRY]: CORE.replace('["boom"]', '["boom", "gone"]'),
    });
    const result = await run("check-site.ts", root);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `docsUrl ${SITE_URL}reference/errors/gone: the built site has no reference/errors/gone.html (R-AX-10)\ndocsUrl ${SITE_URL}reference/errors/gone: the built site has no reference/errors/gone.md (R-AX-10)\n`,
    );
  });
});

describe("smoke-site.ts (test 4)", () => {
  let server: Server;
  let site = "";
  const missing = new Set<string>();

  beforeEach(async () => {
    await run("site-copies.ts", root);
    writeFiles(root, { [`${SITE_OUT}/sitemap.xml`]: sitemapOf(PAGES) });
    missing.clear();
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const file = url.pathname.replace(/^\//, "");
      if (missing.has(file)) {
        response.writeHead(404).end();
        return;
      }
      // A file in the build output is served as it is; any other path is a page with no body.
      const built = path.join(root, SITE_OUT, file);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(file !== "" && existsSync(built) ? readFileSync(built) : "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    site = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("exits 0 when every URL returns 200", async () => {
    const result = await run("smoke-site.ts", "--url", site, root);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout,
      `site smoke: ${site}/ serves the page and Markdown copy of 1 error codes, 1 other files, llms.txt, every page it lists and the sitemap\n`,
    );
  });

  it("fetches each file under docs/user that is not a page, and parses a JSON file", async () => {
    writeFiles(root, { "docs/user/start/sample.json": '{"chainId":11155111}\n' });
    await run("site-copies.ts", root);
    const passing = await run("smoke-site.ts", "--url", site, "--attempts", "1", root);
    assert.equal(passing.stderr, "");
    assert.equal(passing.status, 0);
    missing.add("img/logo.png");
    writeFiles(root, { [`${SITE_OUT}/start/sample.json`]: "<!doctype html>" });
    const failing = await run("smoke-site.ts", "--url", site, "--attempts", "1", root);
    assert.equal(failing.status, 1);
    assert.equal(
      failing.stderr,
      `${site}/img/logo.png: status 404\n${site}/start/sample.json: the body is not JSON\n`,
    );
  });

  it("tries again, then exits 1 with the problems of the last attempt", async () => {
    missing.add("reference/errors/boom.md");
    const result = await run(
      "smoke-site.ts",
      "--url",
      `${site}/`,
      "--attempts",
      "2",
      "--delay",
      "0",
      root,
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `site smoke: attempt 1 of 2 found 1 problems; trying again in 0 s\n${site}/reference/errors/boom.md: status 404\n`,
    );
  });

  it("exits 1 when the site serves the docs of another version", async () => {
    edit(root, "packages/explorer-verify/package.json", '"1.2.3"', '"1.2.4"');
    const result = await run("smoke-site.ts", "--url", site, "--attempts", "1", root);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      `${site}/llms.txt: does not say "This site holds the docs of explorer-verify 1.2.4."\n`,
    );
  });

  it("exits 2 on a bad --attempts or --delay", async () => {
    for (const args of [
      ["--attempts", "0"],
      ["--attempts", "1.5"],
      ["--delay=-1"],
      ["--delay", "soon"],
    ]) {
      const result = await run("smoke-site.ts", ...args, root);
      assert.equal(result.status, 2, args.join(" "));
      assert.equal(
        result.stderr,
        "--attempts must be a positive integer and --delay a number of seconds\n",
      );
    }
  });
});
