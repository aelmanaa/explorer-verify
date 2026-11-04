// The stderr line that the agent page, docs/user/guides/using-from-an-agent.md, quotes for a
// submission accepted by the explorer, checked in-process against the fake explorer (R-AX-3,
// R-AX-14, R-AX-15). Waits run on mock timers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";

import { main } from "../../src/main.ts";
import { fakeExplorer } from "../helpers/fake-explorer.ts";
import { fakeIo } from "../helpers/fake-io.ts";
import { blocks } from "../helpers/shell-examples.ts";
import { PROJECT } from "../helpers/spawn-bin.ts";

const PAGE_NAME = "using-from-an-agent.md";
const PAGE = readFileSync(
  new URL(`../../../../docs/user/guides/${PAGE_NAME}`, import.meta.url),
  "utf8",
);
const VERIFY = ["verify", "--input-json", join(PROJECT, "verify-input.json")];

/**
 * Runs the CLI against a fake explorer that accepts the submission, ticking the mock clock until
 * the run ends, so a poll interval passes at once.
 */
async function run(
  t: TestContext,
  argv: readonly string[],
): Promise<{ code: number; stderr: string }> {
  t.mock.method(globalThis, "fetch", fakeExplorer("new"));
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fake = fakeIo(argv);
  const state = { done: false };
  const running = main(fake.io).finally(() => {
    state.done = true;
  });
  while (!state.done) {
    await setImmediate();
    t.mock.timers.tick(500);
  }
  const code = await running;
  t.mock.timers.reset();
  return { code, stderr: fake.stderr() };
}

describe("the handle on stderr, as the agent page quotes it (R-AX-3, R-AX-14)", () => {
  it("prints the quoted line when the explorer accepts the submission", async (t) => {
    const result = await run(t, VERIFY);
    assert.equal(result.code, 0, result.stderr);
    const line = result.stderr.split("\n").find((text) => text.startsWith("Submitted to "));
    assert.ok(line, "a Submitted line on stderr");
    const quoted = blocks(PAGE).filter(({ lang }) => lang === "text");
    assert.ok(
      quoted.some(({ code }) => code === `${line}\n`),
      `${PAGE_NAME} quotes the line: ${line}`,
    );
  });

  it("gives the handle a field of its own with --log-format json", async (t) => {
    const result = await run(t, [...VERIFY, "--log-format", "json"]);
    assert.equal(result.code, 0, result.stderr);
    const submitted = result.stderr
      .split("\n")
      .filter((text) => text.startsWith("{"))
      .map((text): unknown => JSON.parse(text))
      .find((value) => Object(value).type === "verify.submitted");
    assert.match(String(Object(submitted).handle), /^ev1:sourcify:11155111:0x/);
    assert.match(PAGE, /`type` is `verify\.submitted`/);
  });

  it("hides the line with --quiet, as the page warns (R-AX-15)", async (t) => {
    const result = await run(t, [...VERIFY, "--quiet"]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /ev1:/);
    assert.match(PAGE, /`--quiet` hides the line/);
  });
});
