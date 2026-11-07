// README commands run against the built CLI and recorded explorer answers (#226, R-DX-4).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { shellExamples } from "../helpers/shell-examples.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";

const ROOT = new URL("../../../../", import.meta.url);

describe("README CLI quickstarts", () => {
  for (const file of [
    "README.md",
    "packages/explorer-verify/README.md",
    "packages/cli/README.md",
  ]) {
    const examples = shellExamples(readFileSync(new URL(file, ROOT), "utf8"), file);
    it(`${file} shows a dry run followed by an explicit verification`, () => {
      assert.equal(examples.length, 2);
      assert.ok(examples[0]?.args.includes("--dry-run"));
      assert.ok(!examples[1]?.args.includes("--dry-run"));
      assert.ok(examples.every(({ args }) => args.includes("--backend")));
    });
    for (const example of examples) {
      it(`${file}:${String(example.line)} prints the documented stdout`, async () => {
        const result = await runBin(example.args, { cwd: PROJECT, fake: { scenario: "verified" } });
        assert.equal(result.code, example.exitCode, result.stderr);
        assert.equal(result.stdout, example.stdout);
      });
    }
  }
});
