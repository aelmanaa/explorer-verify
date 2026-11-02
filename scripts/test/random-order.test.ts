// Tests scripts/random-order.ts, which decides whether a `node --test` run that asks for a random
// order starts, is skipped or fails.
import assert from "node:assert/strict";
import process from "node:process";
import { describe, it } from "node:test";

import {
  asksRandomOrder,
  decideRandomOrder,
  RANDOM_ORDER_SINCE,
  supportsRandomOrder,
} from "../random-order.ts";

const WITH = new Set(["--test", "--test-randomize", "--test-random-seed"]);
const WITHOUT = new Set(["--test", "--test-timeout"]);
const FILES = "test/**/*.test.ts";

/** Whether Node `version` has `--test-randomize`, or `undefined` for a line the docs do not list. */
function expectedSupport(version: string): boolean | undefined {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major === 24) return minor >= 16;
  if (major === 26) return minor >= 1;
  if (major > 26) return true;
  if (major < 24) return false;
  return undefined;
}

describe("asksRandomOrder", () => {
  it("is true for --test-randomize", () => {
    assert.equal(asksRandomOrder(["--test-randomize", FILES]), true);
  });

  it("is true for --test-random-seed with a value", () => {
    assert.equal(asksRandomOrder(["--test-random-seed=42", FILES]), true);
  });

  it("is true for a bare --test-random-seed followed by its value", () => {
    assert.equal(asksRandomOrder(["--test-random-seed", "42", FILES]), true);
  });

  it("is false without a random-order option", () => {
    assert.equal(asksRandomOrder(["--test-only", "test/--test-randomize.test.ts"]), false);
  });
});

describe("supportsRandomOrder", () => {
  it("is true when Node allows --test-randomize", () => {
    assert.equal(supportsRandomOrder(WITH), true);
  });

  it("is false when Node does not allow --test-randomize", () => {
    assert.equal(supportsRandomOrder(WITHOUT), false);
  });

  const expected = expectedSupport(process.versions.node);
  it(
    `matches the running Node ${process.versions.node}`,
    { skip: expected === undefined ? "Node line not listed in the docs" : false },
    () => {
      assert.equal(supportsRandomOrder(), expected);
    },
  );
});

describe("decideRandomOrder", () => {
  it("runs a run that does not ask for a random order, even without support", () => {
    assert.deepEqual(decideRandomOrder([FILES], { flags: WITHOUT, env: {} }), { action: "run" });
  });

  it("runs a random-order run on a Node that supports it", () => {
    const env = { REQUIRE_RANDOM_ORDER: "1" };
    assert.deepEqual(decideRandomOrder(["--test-randomize", FILES], { flags: WITH, env }), {
      action: "run",
    });
  });

  it("skips a random-order run on a Node that lacks the option", () => {
    const decision = decideRandomOrder(["--test-randomize", FILES], {
      flags: WITHOUT,
      env: {},
      version: "22.18.0",
    });
    assert.equal(decision.action, "skip");
    assert.equal(
      "message" in decision ? decision.message : "",
      `node-test: Node 22.18.0 has no --test-randomize (added in ${RANDOM_ORDER_SINCE}); skipping the random-order run\n`,
    );
  });

  it("fails a random-order run on a Node that lacks the option with REQUIRE_RANDOM_ORDER=1", () => {
    const decision = decideRandomOrder(["--test-random-seed", "7", FILES], {
      flags: WITHOUT,
      env: { REQUIRE_RANDOM_ORDER: "1" },
      version: "26.0.0",
    });
    assert.equal(decision.action, "fail");
    assert.equal(
      "message" in decision ? decision.message : "",
      `node-test: Node 26.0.0 has no --test-randomize (added in ${RANDOM_ORDER_SINCE}), and REQUIRE_RANDOM_ORDER=1 requires the random-order run\n`,
    );
  });

  it("skips when REQUIRE_RANDOM_ORDER has another value", () => {
    const decision = decideRandomOrder(["--test-randomize"], {
      flags: WITHOUT,
      env: { REQUIRE_RANDOM_ORDER: "0" },
    });
    assert.equal(decision.action, "skip");
  });

  it("reads the running process when no context is given", () => {
    assert.deepEqual(decideRandomOrder([FILES]), { action: "run" });
  });

  it("names the running Node version when only the flags are given", () => {
    const decision = decideRandomOrder(["--test-randomize"], { flags: WITHOUT });
    assert.notEqual(decision.action, "run");
    assert.match(
      "message" in decision ? decision.message : "",
      new RegExp(`Node ${process.versions.node.replaceAll(".", "\\.")} has no`),
    );
  });
});
