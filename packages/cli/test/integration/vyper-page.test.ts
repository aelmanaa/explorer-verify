// The Vyper guide, docs/user/guides/verify-a-vyper-contract.md, against the built bin (R-AX-2,
// R-AX-3): each command-line example is a dry run and prints what the page shows. The examples run
// in a folder that holds the Standard JSON input of the Vyper 0.4.3 Scoreboard on Sepolia, the live
// check's Sourcify target, with the fake explorer's `vyper` scenario, so nothing reaches the network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { shellExamples } from "../helpers/shell-examples.ts";
import { runBin } from "../helpers/spawn-bin.ts";

const PAGE = "verify-a-vyper-contract.md";
const GUIDE = new URL(`../../../../docs/user/guides/${PAGE}`, import.meta.url);
const LIVE_INPUT = new URL(
  "../../../../test/live/sourcify-sepolia-vyper-input.json",
  import.meta.url,
);
const TIMEOUT = { timeout: 30_000 };

/** The folder the reader runs the command in: the Scoreboard's Standard JSON input. */
const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-vyper-guide-"));
const live: { compiler: { input: unknown } } = JSON.parse(readFileSync(LIVE_INPUT, "utf8"));
writeFileSync(join(DIR, "Scoreboard.input.json"), JSON.stringify(live.compiler.input));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe(`${PAGE}: command-line examples (R-AX-3)`, () => {
  const examples = shellExamples(readFileSync(GUIDE, "utf8"), PAGE);

  it("has a dry run of a Vyper input, and no submit", () => {
    assert.ok(examples.length > 0);
    for (const { args } of examples) {
      assert.ok(args.includes("--dry-run"), args.join(" "));
      assert.ok(args.includes("--input"), args.join(" "));
    }
  });

  for (const example of examples) {
    it(`${PAGE} line ${String(example.line)}: ${example.args.join(" ")}`, TIMEOUT, async () => {
      const result = await runBin(example.args, { cwd: DIR, fake: { scenario: "vyper" } });
      assert.equal(result.code, example.exitCode, `stderr:\n${result.stderr}`);
      assert.equal(result.stdout, example.stdout);
    });
  }
});
