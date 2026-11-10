// Runs scripts/generate-cli-reference.ts the way `pnpm run check` runs it (R-AX-2): `--check`
// passes on the committed pages and fails on a stale one; without it, the script rewrites them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PAGE = "docs/user/reference/cli.md";
const OUTPUT = "docs/user/reference/cli-output.md";
const committed = readFileSync(path.join(repository, PAGE), "utf8");
const committedOutput = readFileSync(path.join(repository, OUTPUT), "utf8");

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

function read(name: string): string {
  return readFileSync(path.join(root, name), "utf8");
}

function write(name: string, text: string): void {
  writeFileSync(path.join(root, name), text);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cli-reference-"));
  mkdirSync(path.join(root, path.dirname(PAGE)), { recursive: true });
  write(PAGE, committed);
  write(OUTPUT, committedOutput);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("generate-cli-reference.ts (R-AX-2)", () => {
  it("passes --check on the committed pages", () => {
    const result = run("--check", root);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /cli\.md matches the CLI's help/);
    assert.match(result.stdout, /cli-output\.md matches the CLI's help/);
  });

  for (const [name, original, from, to] of [
    [PAGE, committed, "The address of a linked library.", "A linked library."],
    [OUTPUT, committedOutput, "Show only errors on stderr.", "Show errors only."],
  ] as const) {
    it(`fails --check when ${path.basename(name)} differs from the help, and writes nothing`, () => {
      const stale = original.replace(from, to);
      assert.notEqual(stale, original);
      write(name, stale);
      const result = run("--check", root);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        new RegExp(
          `${path.basename(name).replace(".", "\\.")} differs from the CLI's help\\. Run node scripts/generate-cli-reference\\.ts`,
        ),
      );
      assert.equal(read(name), stale);
    });
  }

  it("rewrites the generated parts, and keeps the text around them", () => {
    write(
      PAGE,
      committed
        .replace("The address of a linked library.", "A linked library.")
        .replace("## Where verify submits", "## Where verify submits\n\nA line someone added."),
    );
    write(
      OUTPUT,
      committedOutput
        .replace("Show only errors on stderr.", "Show errors only.")
        .replace("## stdout", "## stdout\n\nA line someone added."),
    );
    const result = run(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /cli\.md written/);
    assert.match(result.stdout, /cli-output\.md written/);
    assert.equal(
      read(PAGE),
      committed.replace(
        "## Where verify submits",
        "## Where verify submits\n\nA line someone added.",
      ),
    );
    assert.equal(
      read(OUTPUT),
      committedOutput.replace("## stdout", "## stdout\n\nA line someone added."),
    );
  });

  it("fails when a page lost a marker", () => {
    write(OUTPUT, "# CLI output\n");
    const result = run("--check", root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /each marker of the generated part once/);
  });
});
