// The declaration gate catches IDs that reach consumers, including on nested declaration lines.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { declarationDocProblems } from "../declaration-docs.ts";

const SCRIPT = new URL("../check-declaration-docs.ts", import.meta.url);

describe("built declaration comments (#226)", () => {
  it("finds requirement and decision references on their exact lines", () => {
    assert.deepEqual(
      declarationDocProblems(
        "a.d.ts",
        "/** Public. */\n/** R-AX-2; decision 0057. */\n/** Decisions 0059 and 0057. */",
      ),
      [
        "a.d.ts:2: move contributor references to a source // comment",
        "a.d.ts:3: move contributor references to a source // comment",
      ],
    );
    assert.deepEqual(
      declarationDocProblems(
        "a.d.ts",
        "/** Verifies source. */\nexport declare function verify(): void;",
      ),
      [],
    );
  });

  it("accepts clean builds, rejects leaked IDs and rejects absent builds", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "declaration-docs-"));
    try {
      mkdirSync(path.join(root, "packages", "core", "dist"), { recursive: true });
      let result = spawnSync(process.execPath, [SCRIPT.pathname, root], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /No built declarations found/);
      const file = path.join(root, "packages", "core", "dist", "index.d.ts");
      writeFileSync(file, "/** Verifies source. */\nexport declare function verify(): void;\n");
      assert.match(
        execFileSync(process.execPath, [SCRIPT.pathname, root], { encoding: "utf8" }),
        /1 files contain no contributor IDs/,
      );
      writeFileSync(file, "/** Internal decision 0057. */\n");
      result = spawnSync(process.execPath, [SCRIPT.pathname, root], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /index\.d\.ts:1: move contributor references/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
