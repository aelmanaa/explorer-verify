// The Foundry and Hardhat guides, docs/user/guides/verify-from-a-foundry-project.md and
// verify-from-a-hardhat-project.md, against the built bin (R-AX-2, R-AX-3): each page's
// command-line examples are dry runs, and each prints what the page shows. The Foundry examples
// run in the CLI's Foundry fixture, the Hardhat examples in a copy of the Hardhat helper's
// Hardhat 3 fixture. Every run uses the fake explorer, so nothing reaches the network.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { shellExamples } from "../helpers/shell-examples.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";

const GUIDES = new URL("../../../../docs/user/guides/", import.meta.url);
const HARDHAT_FIXTURE = new URL(
  "../../../hardhat/test/fixtures/hardhat-3.21.2/artifacts",
  import.meta.url,
);
const TIMEOUT = { timeout: 30_000 };

/** A Hardhat 3 project after `npx hardhat build`: only its `artifacts` folder. */
const HARDHAT = mkdtempSync(join(tmpdir(), "explorer-verify-hardhat-guide-"));
cpSync(fileURLToPath(HARDHAT_FIXTURE), join(HARDHAT, "artifacts"), { recursive: true });
after(() => {
  rmSync(HARDHAT, { recursive: true, force: true });
});

const PAGES: readonly { name: string; flag: string; cwd: string }[] = [
  { name: "verify-from-a-foundry-project.md", flag: "--foundry", cwd: PROJECT },
  { name: "verify-from-a-hardhat-project.md", flag: "--hardhat", cwd: HARDHAT },
];

for (const { name, flag, cwd } of PAGES) {
  describe(`${name}: command-line examples (R-AX-3)`, () => {
    const examples = shellExamples(readFileSync(new URL(name, GUIDES), "utf8"), name);

    it(`has a dry run with ${flag}, and no submit`, () => {
      assert.ok(examples.length > 0);
      for (const { args } of examples) {
        assert.ok(args.includes("--dry-run"), args.join(" "));
        assert.ok(args.includes(flag), args.join(" "));
      }
    });

    for (const example of examples) {
      it(`${name} line ${String(example.line)}: ${example.args.join(" ")}`, TIMEOUT, async () => {
        const result = await runBin(example.args, { cwd, fake: {} });
        assert.equal(result.code, example.exitCode, `stderr:\n${result.stderr}`);
        assert.equal(result.stdout, example.stdout);
      });
    }
  });
}
