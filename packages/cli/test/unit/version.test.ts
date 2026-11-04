// The version read from package.json (R-AX-11): a broken file fails --version alone.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { packageVersion } from "../../src/version.ts";

describe("packageVersion", () => {
  it("returns the version of a package.json with a name and a version", () => {
    assert.equal(packageVersion('{"name":"@explorer-verify/cli","version":"1.2.3"}'), "1.2.3");
  });

  it("throws when the name or the version is missing, empty or not a string", () => {
    for (const text of [
      '{"name":"x"}',
      '{"version":"1.0.0"}',
      '{"name":"x","version":1}',
      '{"name":1,"version":"1.0.0"}',
      '{"name":"","version":"1.0.0"}',
      '{"name":"x","version":""}',
      "null",
      '"1.0.0"',
    ]) {
      assert.throws(() => packageVersion(text), /has no name or no version/, text);
    }
  });
});
