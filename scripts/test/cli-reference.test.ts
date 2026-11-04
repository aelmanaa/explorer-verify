// Runs scripts/generate-cli-reference.ts the way `pnpm run check` runs it (R-AX-2): `--check`
// passes on the committed page and fails on a stale one; without it, the script rewrites the page.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PAGE = "docs/user/reference/cli.md";
const committed = readFileSync(path.join(repository, PAGE), "utf8");

let root = "";

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      path.join(repository, "scripts/generate-cli-reference.ts"),
      ...args,
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function page(): string {
  return readFileSync(path.join(root, PAGE), "utf8");
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cli-reference-"));
  mkdirSync(path.join(root, path.dirname(PAGE)), { recursive: true });
  writeFileSync(path.join(root, PAGE), committed);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("generate-cli-reference.ts (R-AX-2)", () => {
  it("passes --check on the committed page", () => {
    const result = run("--check", root);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /matches the CLI's help/);
  });

  it("fails --check when a description in the page differs from the help, and writes nothing", () => {
    const stale = committed.replace("Show only errors on stderr.", "Show errors only.");
    assert.notEqual(stale, committed);
    writeFileSync(path.join(root, PAGE), stale);
    const result = run("--check", root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /differs from the CLI's help\. Run node scripts\/generate-cli-reference\.ts/,
    );
    assert.equal(page(), stale);
  });

  it("rewrites the generated part, and keeps the text around it", () => {
    const stale = committed
      .replace("Show only errors on stderr.", "Show errors only.")
      .replace("## stdout", "## stdout\n\nA line someone added.");
    writeFileSync(path.join(root, PAGE), stale);
    const result = run(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /written/);
    assert.equal(page(), committed.replace("## stdout", "## stdout\n\nA line someone added."));
  });

  it("fails when the page lost a marker", () => {
    writeFileSync(path.join(root, PAGE), "# CLI\n");
    const result = run("--check", root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /each marker of the generated part once/);
  });
});
