// Tests scripts/browser-smoke.ts itself: each broken page script, and each CORS header the replay
// server leaves out, must fail the smoke test with the check meant to catch it. Needs Chromium and
// a build, so the browser CI job runs it, not test:scripts.
//
// Usage: node scripts/test-browser/browser-smoke.test.ts [--executable-path <file>]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const smoke = path.resolve(here, "../browser-smoke.ts");
const broken = path.resolve(here, "../../packages/explorer-verify/test/browser/broken");
const at = process.argv.indexOf("--executable-path");
const executable = at === -1 ? [] : ["--executable-path", process.argv[at + 1] ?? ""];

/** Runs the smoke test with `args` and returns its exit status and output. */
function runSmoke(args: readonly string[]): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", smoke, ...args, ...executable],
    { encoding: "utf8", timeout: 180_000 },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const cases: [string, string[], RegExp][] = [
  [
    "an exchange nobody asked for",
    ["--entry", path.join(broken, "unused-poll.ts")],
    /Node: 1 exchanges unused/,
  ],
  [
    "a request to a path not recorded",
    ["--entry", path.join(broken, "wrong-url.ts")],
    /unexpected request GET \/v2\/verify\/job\//,
  ],
  [
    "an uncaught error on the page",
    ["--entry", path.join(broken, "page-error.ts")],
    /uncaught errors on the page/,
  ],
  [
    "a Chromium result that differs",
    ["--entry", path.join(broken, "browser-diverges.ts")],
    /the Chromium run/,
  ],
  [
    "a Node result that differs",
    ["--entry", path.join(broken, "node-diverges.ts")],
    /the Node run/,
  ],
  [
    "answers without access-control-allow-origin",
    ["--drop-response-header", "access-control-allow-origin"],
    /No 'Access-Control-Allow-Origin' header is present/,
  ],
  [
    "a preflight answer without access-control-allow-headers",
    ["--drop-response-header", "access-control-allow-headers"],
    /Request header field content-type is not allowed by Access-Control-Allow-Headers/,
  ],
];

describe("browser-smoke.ts fails on", () => {
  for (const [label, args, message] of cases) {
    it(label, () => {
      const { status, output } = runSmoke(args);
      assert.notEqual(status, 0, output);
      assert.match(output, message);
    });
  }

  it("--executable-path without a value", () => {
    const result = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", smoke, "--executable-path"],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--executable-path needs a value/);
  });
});
