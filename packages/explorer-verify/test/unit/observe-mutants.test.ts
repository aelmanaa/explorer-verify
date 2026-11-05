// Tests added after the first full mutation run (#158; R-DX-6): each one fails on a code change in
// src/observe.ts that the other observer tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactEvent } from "../../src/observe.ts";

describe("redactEvent: cases from the first full mutation run (#158, R-DX-6)", () => {
  it("names an event of an unknown type in its TypeError", () => {
    // Only a caller without types can pass such an event.
    assert.throws(() => Reflect.apply(redactEvent, undefined, [{ type: "verify.unknown" }, []]), {
      name: "TypeError",
      message: 'Unknown event: {"type":"verify.unknown"}',
    });
  });
});
