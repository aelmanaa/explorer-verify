// Runs the agent-docs scripts as child processes against a fixture tree, the way `pnpm run
// check`, the package build and `pkg:check` run them on the repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CORE_ENTRY, CORE_ERRORS } from "../agent-docs.ts";
import { CORE_SOURCE, RELEASED_CODES } from "../released-codes.ts";
import { AGENT, edit, makeFixture, read, README, removeFixture, writeFiles } from "./fixture.ts";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON = "packages/explorer-verify/package.json";

let root = "";

// Node 24.0 still warns that type stripping is experimental; the warning would land on
// stderr.
function run(
  script: string,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", path.join(scripts, script), ...args],
    {
      encoding: "utf8",
    },
  );
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

  it("checks the sources of decisions and research", () => {
    const passing = run("check-agent-docs.ts", root);
    assert.match(passing.stdout, /sources: 0 decision pages and 0 research pages pass/);
    writeFiles(root, { "docs/contributor/decisions/0001-bare.md": "# 0001: Bare\n" });
    const result = run("check-agent-docs.ts", root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /^docs\/contributor\/decisions\/0001-bare\.md: links no research note/m,
    );
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

  it("prints the density of each user page, and fails a page that breaks a style rule", () => {
    const passing = run("check-agent-docs.ts", root);
    assert.match(
      passing.stdout,
      /^docs style: words per paragraph, list item or quote\n {2}README\.md: 4 blocks, average 3 words, longest 7\n {2}guides\/using-from-an-agent\.md: .*, legacy\n/,
    );
    writeFiles(root, {
      "docs/user/tutorials/x.md": "# X\n\nRun it:\n\n```sh\nexplorer-verify --help\n```\n",
    });
    const result = run("check-agent-docs.ts", root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^docs\/user\/tutorials\/x\.md:6: a bare explorer-verify command/m);
    assert.match(result.stderr, /^docs\/user\/tutorials\/x\.md:1: a guide needs a "For:" line/m);
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
    assert.equal(built.stdout, "package docs: wrote 5 files to packages/explorer-verify\n");
    const checked = run("check-packed-files.ts", root);
    assert.equal(checked.stderr, "");
    assert.equal(checked.status, 0);
    assert.match(
      checked.stdout,
      /llms\.txt, 3 docs files \(the pages of 0 error codes among them\) and 1 skill files are in the tarball/,
    );
  });

  it("exits 1 when the tarball lacks the page of an error code", () => {
    run("package-docs.ts", root);
    writeFiles(root, { [CORE_ENTRY]: 'export const ERROR_CODES = ["gone"];\n' });
    const result = run("check-packed-files.ts", root);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "The packed tarball lacks docs/reference/errors/gone.md. Run the build, and check `files` in packages/explorer-verify/package.json (R-AX-10)\n",
    );
  });

  it("counts a code page the docs already hold once", () => {
    writeFiles(root, {
      [CORE_ENTRY]: 'export const ERROR_CODES = ["kept"];\n',
      "docs/user/reference/errors/kept.md": "# kept\n",
    });
    run("package-docs.ts", root);
    const result = run("check-packed-files.ts", root);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /4 docs files \(the pages of 1 error codes among them\)/);
  });

  it("exits 1 when the package is not built", () => {
    run("package-docs.ts", root);
    writeFiles(root, { [CORE_ENTRY]: "export const ERROR_CODES = [1];\n" });
    const result = run("check-packed-files.ts", root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exports no ERROR_CODES array of strings; run the build/);
  });

  it("exits 1 when the tarball lacks the docs", () => {
    run("package-docs.ts", root);
    edit(root, PACKAGE_JSON, '"docs/",', "");
    const result = run("check-packed-files.ts", root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^The packed tarball lacks docs\/README\.md\./m);
    assert.match(result.stderr, /lacks docs\/img\/logo\.png\./);
  });

  it("exits 1 when the tarball lacks the skill", () => {
    run("package-docs.ts", root);
    edit(root, PACKAGE_JSON, '"skills/",', "");
    const result = run("check-packed-files.ts", root);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "The packed tarball lacks skills/explorer-verify/SKILL.md. Run the build, and check `files` in packages/explorer-verify/package.json (R-AX-4)\n" +
        "llms.txt:9: link skills/explorer-verify/SKILL.md points to skills/explorer-verify/SKILL.md, which is not in the tarball (R-AX-2)\n",
    );
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

describe("check-packed-files.ts --release (R-AX-10)", () => {
  const SITE_ERRORS =
    'const url = "https://aelmanaa.github.io/explorer-verify/reference/errors/";\n';

  it("exits 0 when every code is released and docsUrl points at the site", () => {
    run("package-docs.ts", root);
    writeFiles(root, {
      [CORE_ENTRY]: 'export const ERROR_CODES = ["kept"];\n',
      [CORE_ERRORS]: SITE_ERRORS,
      [RELEASED_CODES]: '{ "kept": "0.1.0" }\n',
      "docs/user/reference/errors/kept.md": "# kept\n",
    });
    run("package-docs.ts", root);
    const result = run("check-packed-files.ts", "--release", root);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /every code is released and docsUrl points at the docs site\n$/);
  });

  it("exits 1 when a code is not released or docsUrl points at the default branch", () => {
    run("package-docs.ts", root);
    writeFiles(root, {
      [CORE_ENTRY]: 'export const ERROR_CODES = ["kept", "new-code"];\n',
      [CORE_ERRORS]: 'const url = "https://github.com/o/r/blob/main/docs/";\n',
      [RELEASED_CODES]: '{ "kept": "0.1.0" }\n',
      "docs/user/reference/errors/kept.md": "# kept\n",
      "docs/user/reference/errors/new-code.md": "# new-code\n",
    });
    run("package-docs.ts", root);
    const result = run("check-packed-files.ts", "--release", root);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      "packages/explorer-verify/released-error-codes.json does not list new-code; run pnpm run version-packages (R-AX-10)\n" +
        "packages/explorer-verify/dist/src/errors.js holds blob/main: docsUrl must point at the docs site before a release (R-AX-10, decision 0015)\n",
    );
  });

  it("does not check releases without the flag", () => {
    run("package-docs.ts", root);
    writeFiles(root, { [CORE_ERRORS]: 'const url = "blob/main";\n' });
    const result = run("check-packed-files.ts", root);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
  });
});

describe("record-released-codes.ts (R-AX-10)", () => {
  it("adds the missing codes at the package version, in catalogue order", () => {
    writeFiles(root, {
      [CORE_SOURCE]: 'export const ERROR_CODES = ["network", "timeout", "cancelled"];\n',
      [RELEASED_CODES]: '{ "timeout": "1.0.0" }\n',
    });
    const result = run("record-released-codes.ts", root);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout,
      "released codes: added 2 codes to packages/explorer-verify/released-error-codes.json: network, cancelled\n",
    );
    assert.equal(
      read(root, RELEASED_CODES),
      '{\n  "timeout": "1.0.0",\n  "network": "1.2.3",\n  "cancelled": "1.2.3"\n}\n',
    );
  });

  it("changes nothing when every code is listed", () => {
    writeFiles(root, {
      [CORE_SOURCE]: 'export const ERROR_CODES = ["network"];\n',
      [RELEASED_CODES]: '{\n  "network": "1.0.0"\n}\n',
    });
    const result = run("record-released-codes.ts", root);
    assert.equal(
      result.stdout,
      "released codes: added 0 codes to packages/explorer-verify/released-error-codes.json\n",
    );
    assert.equal(read(root, RELEASED_CODES), '{\n  "network": "1.0.0"\n}\n');
  });

  it("exits 1 when the sources export no codes", () => {
    writeFiles(root, {
      [CORE_SOURCE]: "export const ERROR_CODES = 1;\n",
      [RELEASED_CODES]: "{}\n",
    });
    const result = run("record-released-codes.ts", root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /packages\/explorer-verify\/src\/index\.ts exports no ERROR_CODES/);
  });
});
