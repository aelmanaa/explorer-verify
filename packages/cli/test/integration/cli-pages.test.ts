// The CLI reference, docs/user/reference/cli.md, and docs/user/reference/cli-output.md against the
// built bin (R-AX-2, R-AX-3): every `sh` example prints what the page shows, with its exit code.
// The examples run in a copy of the Foundry project that also holds the docs' sample request, with
// the fake explorer, so nothing reaches the network.
import assert from "node:assert/strict";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { JOB } from "../helpers/fake-explorer.ts";
import { blocks, shellExamples } from "../helpers/shell-examples.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";

const USER_DOCS = new URL("../../../../docs/user/", import.meta.url);
const SAMPLE = "greeter-sepolia.json";
const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const HANDLE = `ev1:sourcify:11155111:${ADDRESS}:${JOB}`;
const TIMEOUT = { timeout: 30_000 };
/** The widest line of a code block that does not scroll on the docs site at 1440 pixels. */
const WIDTH = 75;

/** The Foundry project, with the sample request next to its build. */
const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-cli-pages-"));
cpSync(PROJECT, DIR, { recursive: true });
copyFileSync(fileURLToPath(new URL(`start/${SAMPLE}`, USER_DOCS)), join(DIR, SAMPLE));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

for (const name of ["cli.md", "cli-output.md"]) {
  const page = readFileSync(new URL(`reference/${name}`, USER_DOCS), "utf8");
  // An example reads the address from `ADDRESS` and the handle from `HANDLE`, as a script does.
  const examples = shellExamples(
    page.replaceAll('"$HANDLE"', HANDLE).replaceAll('"$ADDRESS"', ADDRESS),
    name,
  );

  describe(`${name}: the command-line examples (R-AX-2)`, () => {
    it("start with npx and fit the page without scrolling", () => {
      assert.ok(examples.length > 0);
      for (const block of blocks(page).filter(({ lang }) => ["sh", "bash"].includes(lang))) {
        for (const line of block.code.split("\n")) {
          assert.ok(line.length <= WIDTH, `${name} line ${String(block.line)}: ${line}`);
          assert.doesNotMatch(line, /^explorer-verify /, `${name} line ${String(block.line)}`);
        }
      }
    });

    for (const example of examples) {
      it(`${name} line ${String(example.line)}: ${example.args.join(" ")}`, TIMEOUT, async () => {
        const result = await runBin(example.args, { cwd: DIR, fake: {} });
        assert.equal(result.code, example.exitCode, `stderr:\n${result.stderr}`);
        assert.equal(result.stdout, example.stdout);
      });
    }
  });
}

describe("cli.md: the examples (R-AX-3)", () => {
  const page = readFileSync(new URL("reference/cli.md", USER_DOCS), "utf8");
  const examples = shellExamples(
    page.replaceAll('"$HANDLE"', HANDLE).replaceAll('"$ADDRESS"', ADDRESS),
    "cli.md",
  );

  it("come before the generated part, and start with a dry run of the sample", () => {
    const generated = page.indexOf("<!-- Generated");
    assert.ok(examples.length >= 4);
    assert.ok(examples.every(({ line }) => line < page.slice(0, generated).split("\n").length));
    assert.deepEqual(examples[0]?.args.slice(0, 3), ["verify", "--input-json", SAMPLE]);
    assert.ok(examples[0]?.args.includes("--dry-run"));
  });

  it("include a run from build files and a status", () => {
    const lines = examples.map(({ args }) => args.join(" "));
    assert.ok(lines.some((line) => line.includes("--foundry .")));
    assert.ok(lines.some((line) => line.includes("--input build/")));
    assert.ok(lines.some((line) => line.startsWith("status ")));
  });
});
