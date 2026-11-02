// Tests the random-order checks of scripts/node-test.ts, which decide whether a run with
// `--test-randomize` starts or is skipped on a Node that lacks the option.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asksRandomOrder, supportsRandomOrder } from "../node-test.ts";

describe("asksRandomOrder", () => {
  it("is true for --test-randomize", () => {
    assert.equal(asksRandomOrder(["--test-randomize", "test/**/*.test.ts"]), true);
  });

  it("is true for --test-random-seed with a value", () => {
    assert.equal(asksRandomOrder(["--test-random-seed=42", "test/**/*.test.ts"]), true);
  });

  it("is false without a random-order option", () => {
    assert.equal(asksRandomOrder(["--test-only", "test/--test-randomize.test.ts"]), false);
  });
});

describe("supportsRandomOrder", () => {
  it("is true when Node allows --test-randomize", () => {
    assert.equal(supportsRandomOrder(new Set(["--test", "--test-randomize"])), true);
  });

  it("is false when Node does not allow --test-randomize", () => {
    assert.equal(supportsRandomOrder(new Set(["--test", "--test-timeout"])), false);
  });
});
