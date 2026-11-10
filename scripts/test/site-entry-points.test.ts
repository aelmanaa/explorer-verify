// Runs the docs site scripts as child processes against a fixture tree, the way `pnpm run
// site:build`, pull request CI and the deploy workflow run them (R-AX-10, R-AX-17, decision 0015).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CORE_ENTRY, RAW_MAIN } from "../agent-docs.ts";
import { SITE_OUT, SITE_URL } from "../site-docs.ts";
import { edit, makeFixture, removeFixture, writeFiles } from "./fixture.ts";

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

/** Writes the HTML pages VitePress would build for the fixture's pages. */
function writeHtml(): void {
  writeFiles(root, {
    [`${SITE_OUT}/index.html`]: "",
    [`${SITE_OUT}/guides/using-from-an-agent.html`]: "",
    [`${SITE_OUT}/reference/errors/boom.html`]: "",
    [`${SITE_OUT}/404.html`]: "",
  });
}

beforeEach(() => {
  root = makeFixture();
  writeFiles(root, {
    [CORE_ENTRY]: CORE,
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
      "site: the docsUrl of 1 error codes, llms.txt, the Markdown copies and the sidebar resolve in site/dist\n",
    );
  });

  it("exits 1 when a user page is in no sidebar group", async () => {
    writeFiles(root, { "docs/user/guides/unlisted.md": "# Unlisted\n" });
    await run("site-copies.ts", root);
    writeHtml();
    writeFiles(root, { [`${SITE_OUT}/guides/unlisted.html`]: "" });
    const result = await run("check-site.ts", root);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "docs/user/guides/unlisted.md is in no sidebar group; add it to SIDEBAR in scripts/site-docs.ts\nllms.txt does not list guides/unlisted.md (R-AX-17)\n",
    );
  });

  it("accepts the site-only pages without a Markdown copy", async () => {
    writeFiles(root, { "site/pages/index.md": "---\nlayout: home\n---\n" });
    await run("site-copies.ts", root);
    writeHtml();
    writeFiles(root, { [`${SITE_OUT}/overview.html`]: "" });
    const result = await run("check-site.ts", root);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
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
      `site smoke: ${site}/ serves the page and Markdown copy of 1 error codes, 1 other files, llms.txt and every page it lists\n`,
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
