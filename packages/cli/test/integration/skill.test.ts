// The skill's command-line examples run against the built bin (R-AX-4): each `sh` block of
// skills/explorer-verify/SKILL.md holds one `explorer-verify` command line and a `# exit code N`
// comment, and the `text` block after it holds what the command prints on stdout.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { shellExamples } from "../helpers/shell-examples.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";

const SKILL = readFileSync(
  new URL("../../../../skills/explorer-verify/SKILL.md", import.meta.url),
  "utf8",
);

describe("the skill's command-line examples (R-AX-4)", () => {
  const examples = shellExamples(SKILL, "SKILL.md");

  it("has at least one", () => {
    assert.ok(examples.length > 0);
  });

  for (const example of examples) {
    it(`SKILL.md line ${String(example.line)}: explorer-verify ${example.args.join(" ")}`, async () => {
      // In a Foundry project, against the fake explorer: nothing reaches the network.
      const result = await runBin(example.args, { cwd: PROJECT, fake: {} });
      assert.equal(result.code, example.exitCode, `stderr:\n${result.stderr}`);
      assert.equal(result.stdout, example.stdout);
    });
  }
});
