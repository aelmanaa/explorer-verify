// The log level of stderr (R-AX-15).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { effectiveLevel, environmentLevel, LOG_LEVELS, shows } from "../../src/log-level.ts";

describe("log level (R-AX-15)", () => {
  it("reads every level from EXPLORER_VERIFY_LOG", () => {
    for (const level of LOG_LEVELS) {
      assert.deepEqual(environmentLevel(level), { level, invalid: false });
    }
  });

  it("treats an unset or empty variable as unset", () => {
    assert.deepEqual(environmentLevel(undefined), { invalid: false });
    assert.deepEqual(environmentLevel(""), { invalid: false });
  });

  it("marks any other value invalid, case included", () => {
    assert.deepEqual(environmentLevel("DEBUG"), { invalid: true });
    assert.deepEqual(environmentLevel("trace"), { invalid: true });
  });

  it("lets --quiet and --verbose win over the variable, with info as the default", () => {
    assert.equal(effectiveLevel({ quiet: true, verbose: false }, "debug"), "error");
    assert.equal(effectiveLevel({ quiet: false, verbose: true }, "off"), "debug");
    assert.equal(effectiveLevel({ quiet: false, verbose: false }, "warn"), "warn");
    assert.equal(effectiveLevel({ quiet: false, verbose: false }, undefined), "info");
  });

  it("shows a line at its level and at every more verbose level", () => {
    assert.equal(shows("info", "debug"), true);
    assert.equal(shows("info", "info"), true);
    assert.equal(shows("info", "warn"), false);
    assert.equal(shows("error", "error"), true);
    assert.equal(shows("error", "off"), false);
  });
});
