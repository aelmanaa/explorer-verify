// R-IN-6: the copy of the core's unknown-key rule. The core tests the same code through its public
// functions and checks that this copy matches it; these cases reach the branches the helper's own
// options do not.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ownKeys, unknownKeys } from "../../src/known-keys.ts";

describe("unknownKeys() (R-IN-6)", () => {
  it("keeps the shortest of two matching names, then the first", () => {
    assert.deepEqual(unknownKeys(["abc"], ["abcde", "abce", "abcf"], "", "options"), [
      { field: "abc", message: "is not a known option; did you mean abce?" },
    ]);
  });

  it("puts the prefix before the key, and names the prefix for a key it does not repeat", () => {
    assert.deepEqual(unknownKeys(["roo", "1x"], ["root"], "nested.", "nested"), [
      { field: "nested.roo", message: "is not a known option; did you mean root?" },
      { field: "nested", message: "is not a known option" },
    ]);
  });
});

describe("ownKeys() (R-IN-6)", () => {
  it("lists own enumerable keys, and gives undefined for a non-object, an array or a Proxy that throws", () => {
    assert.deepEqual(ownKeys({ a: 1 }), ["a"]);
    for (const value of [
      undefined,
      null,
      "x",
      [],
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("trap");
          },
        },
      ),
    ]) {
      assert.equal(ownKeys(value), undefined);
    }
  });
});
