import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_NAMES, toBackendName } from "../../src/index.ts";

describe("toBackendName", () => {
  it("returns every listed backend unchanged", () => {
    for (const name of BACKEND_NAMES) {
      assert.equal(toBackendName(name), name);
    }
  });

  it("returns undefined for an unknown name", () => {
    assert.equal(toBackendName("oklink"), undefined);
  });
});
