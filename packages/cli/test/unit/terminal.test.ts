// Colour and spinner per stream (R-AX-6). The CLI has no pager.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { painter, terminalPolicy } from "../../src/terminal.ts";
import type { TerminalInputs } from "../../src/terminal.ts";

const BASE: TerminalInputs = {
  color: "auto",
  env: {},
  stdoutIsTerminal: true,
  stderrIsTerminal: true,
  logFormat: "text",
  level: "info",
};

function policy(changes: Partial<TerminalInputs>) {
  return terminalPolicy({ ...BASE, ...changes });
}

describe("terminalPolicy (R-AX-6)", () => {
  it("colours and spins on two terminals by default, and has no pager", () => {
    assert.deepEqual(policy({}), {
      colorStdout: true,
      colorStderr: true,
      spinner: true,
    });
  });

  it("decides colour per stream from that stream's terminal state", () => {
    const piped = policy({ stdoutIsTerminal: false });
    assert.equal(piped.colorStdout, false);
    assert.equal(piped.colorStderr, true);
    const redirected = policy({ stderrIsTerminal: false });
    assert.equal(redirected.colorStdout, true);
    assert.equal(redirected.colorStderr, false);
    assert.equal(redirected.spinner, false);
  });

  it("turns colour off with a non-empty NO_COLOR or TERM=dumb, and ignores an empty NO_COLOR", () => {
    for (const env of [{ NO_COLOR: "1" }, { NO_COLOR: "0" }, { TERM: "dumb" }]) {
      const result = policy({ env });
      assert.equal(result.colorStdout, false, JSON.stringify(env));
      assert.equal(result.colorStderr, false, JSON.stringify(env));
    }
    assert.equal(policy({ env: { NO_COLOR: "" } }).colorStdout, true);
  });

  it("lets --color=always win over NO_COLOR and pipes, and --color=never win over terminals", () => {
    const always = policy({
      color: "always",
      env: { NO_COLOR: "1", TERM: "dumb" },
      stdoutIsTerminal: false,
      stderrIsTerminal: false,
    });
    assert.equal(always.colorStdout, true);
    assert.equal(always.colorStderr, true);
    const never = policy({ color: "never" });
    assert.equal(never.colorStdout, false);
    assert.equal(never.colorStderr, false);
  });

  it("shows no spinner when CI is set, and one when CI is empty", () => {
    const ci = policy({ env: { CI: "true" } });
    assert.equal(ci.spinner, false);
    const empty = policy({ env: { CI: "" } });
    assert.equal(empty.spinner, true);
  });

  it("shows no spinner with TERM=dumb, which cannot redraw a line", () => {
    assert.equal(policy({ env: { TERM: "dumb" } }).spinner, false);
    assert.equal(policy({ env: { TERM: "xterm" } }).spinner, true);
  });

  it("shows no spinner with --log-format json, or at level error or off", () => {
    assert.equal(policy({ logFormat: "json" }).spinner, false);
    assert.equal(policy({ level: "error" }).spinner, false);
    assert.equal(policy({ level: "off" }).spinner, false);
    assert.equal(policy({ level: "debug" }).spinner, true);
  });
});

describe("painter", () => {
  it("wraps text in ANSI codes only when enabled", () => {
    assert.equal(painter(false)("red", "x"), "x");
    assert.equal(painter(true)("red", "x"), "\u001B[31mx\u001B[0m");
  });
});
