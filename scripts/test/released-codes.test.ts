import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatReleased,
  parseReleased,
  recordReleased,
  unreleasedCodes,
} from "../released-codes.ts";

describe("released codes (R-AX-10)", () => {
  it("parses an object that maps codes to versions", () => {
    assert.deepEqual(parseReleased('{"network":"0.1.0","timeout":"0.2.0-beta.1"}'), {
      network: "0.1.0",
      timeout: "0.2.0-beta.1",
    });
    assert.deepEqual(parseReleased("{}"), {});
  });

  it("rejects anything else", () => {
    for (const text of ["[]", "null", '"x"', "1"]) {
      assert.throws(() => parseReleased(text), /must hold an object/);
    }
    for (const text of ['{"network":1}', '{"network":"latest"}']) {
      assert.throws(() => parseReleased(text), /network has no version/);
    }
  });

  it("lists the codes of the catalogue the list lacks, in catalogue order", () => {
    assert.deepEqual(unreleasedCodes({ network: "0.1.0" }, ["timeout", "network", "cancelled"]), [
      "timeout",
      "cancelled",
    ]);
    assert.deepEqual(unreleasedCodes({ toString: "0.1.0" }, ["toString"]), []);
    assert.deepEqual(unreleasedCodes({}, ["toString"]), ["toString"]);
  });

  it("adds the missing codes at the version and keeps the recorded ones", () => {
    const released = { network: "0.1.0", gone: "0.1.0" };
    const next = recordReleased(released, ["timeout", "network"], "0.2.0");
    assert.deepEqual(next, { network: "0.1.0", gone: "0.1.0", timeout: "0.2.0" });
    assert.deepEqual(Object.keys(next), ["network", "gone", "timeout"]);
    assert.deepEqual(released, { network: "0.1.0", gone: "0.1.0" });
  });

  it("writes two-space JSON with a final newline", () => {
    assert.equal(formatReleased({}), "{}\n");
    assert.equal(formatReleased({ network: "0.1.0" }), '{\n  "network": "0.1.0"\n}\n');
  });
});
