// Runs the agent-docs scripts as child processes against a fixture tree, the way `pnpm run
// check`, the package build and `pkg:check` run them on the repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT, edit, makeFixture, read, README, removeFixture } from "./fixture.ts";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON = "packages/explorer-verify/package.json";

let root = "";

function run(
  script: string,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
  root = makeFixture();
});

afterEach(() => {
  removeFixture(root);
});

describe("check-agent-docs.ts", () => {
  it("exits 0 on a tree that follows every rule", () => {
    const result = run("check-agent-docs.ts", root);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /llms\.txt, 2 user pages and the links of 4 docs pages pass/);
  });

  it("exits 1 and names the file and line of each problem", () => {
    edit(root, AGENT, "explorer-verify 1.2.3", "explorer-verify 1.0.0");
    const result = run("check-agent-docs.ts", root);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^docs\/user\/guides\/using-from-an-agent\.md:3: states version 1\.0\.0/,
    );
  });

  it("sets the version lines with --write-versions", () => {
    edit(root, README, "explorer-verify 1.2.3", "explorer-verify 1.0.0");
    const result = run("check-agent-docs.ts", "--write-versions", root);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "agent docs: version line updated in 1 pages\n");
    assert.match(read(root, README), /^Version: explorer-verify 1\.2\.3$/m);
  });
});

describe("package-docs.ts and check-packed-files.ts", () => {
  it("copies the docs into the package, and the tarball holds them", () => {
    const built = run("package-docs.ts", root);
    assert.equal(built.status, 0);
    assert.equal(built.stdout, "package docs: wrote 4 files to packages/explorer-verify\n");
    const checked = run("check-packed-files.ts", root);
    assert.equal(checked.stderr, "");
    assert.equal(checked.status, 0);
    assert.match(checked.stdout, /llms\.txt and 3 docs files are in the tarball/);
  });

  it("exits 1 when the tarball lacks the docs", () => {
    run("package-docs.ts", root);
    edit(root, PACKAGE_JSON, '"docs/",', "");
    const result = run("check-packed-files.ts", root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^The packed tarball lacks docs\/README\.md\./m);
    assert.match(result.stderr, /lacks docs\/img\/logo\.png\./);
  });

  it("exits 1 when a packaged link points outside the tarball", () => {
    run("package-docs.ts", root);
    edit(root, "packages/explorer-verify/llms.txt", "docs/README.md", "docs/gone.md");
    const result = run("check-packed-files.ts", root);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "llms.txt:7: link docs/gone.md points to docs/gone.md, which is not in the tarball (R-AX-2)\n",
    );
  });
});
