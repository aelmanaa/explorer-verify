// The packed CLI ships no test-only command (#137): the file list of `npm pack --dry-run` names no
// such file, no packed file mentions one, and the built bin refuses the old `simulate` command.
// `pnpm test` builds first, so dist/ holds what a release would pack.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { oneEnvelope } from "../helpers/schema.ts";
import { runBin } from "../helpers/spawn-bin.ts";

const PACKAGE_DIR = fileURLToPath(new URL("../../", import.meta.url));
const TIMEOUT = { timeout: 60_000 };

/**
 * Words that only test-only code uses: the removed `simulate` command, the command the in-process
 * tests add to their own table, and the variable the test preload reads.
 */
const TEST_ONLY = [/simulat/i, /\bscripted\b/i, /FAKE_CLI_BUG/];

/** The paths `npm pack --dry-run --json` lists for the CLI package. */
function packedPaths(): string[] {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed: unknown = JSON.parse(output);
  assert.ok(Array.isArray(parsed));
  const files: unknown = Reflect.get(Object(parsed[0]), "files");
  assert.ok(Array.isArray(files));
  return files.map((file: unknown) => String(Reflect.get(Object(file), "path")));
}

describe("the packed CLI has no test-only command (#137)", () => {
  it("packs the bin, and no file whose path or content names one", TIMEOUT, () => {
    const paths = packedPaths();
    assert.ok(paths.includes("dist/src/bin.js"), "the pack lacks the bin");
    assert.ok(paths.includes("dist/src/commands.js"), "the pack lacks the command table");
    for (const path of paths) {
      const content = readFileSync(join(PACKAGE_DIR, path), "utf8");
      for (const word of TEST_ONLY) {
        assert.doesNotMatch(path, word, path);
        assert.doesNotMatch(content, word, `${path} mentions ${String(word)}`);
      }
    }
  });

  it("refuses simulate on the built bin as an unknown command", TIMEOUT, async () => {
    for (const args of [["simulate"], ["help", "simulate"]]) {
      const result = await runBin([...args, "--json"]);
      assert.equal(result.code, 2, args.join(" "));
      const error = Object(oneEnvelope(result.stdout)["error"]);
      assert.equal(Reflect.get(error, "code"), "invalid-input");
      assert.match(
        String(Reflect.get(error, "message")),
        /is not known; give one of verify, status/,
      );
    }
  });
});
