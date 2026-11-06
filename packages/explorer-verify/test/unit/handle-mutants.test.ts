// Tests added when parseHandle() joined mutation testing (#202; R-FLOW-5, R-SEC-2): each one fails
// on a code change in src/flow/handle.ts that the other handle tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "../../src/errors.ts";
import { parseHandle } from "../../src/flow/handle.ts";

const PREFIX = "ev1:sourcify:11155111:0x5FbDB2315678afecb367f032d93F642f64180aa3:";

/** The fields an `invalid-input` error of parseHandle names. */
function issueFields(value: unknown): string[] {
  try {
    parseHandle(value);
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError, String(error));
    const { details } = error;
    return details.code === "invalid-input" ? details.issues.map((issue) => issue.field) : [];
  }
  return assert.fail("parseHandle accepted the value");
}

describe("parseHandle reads a one-line handle up to 512 characters (R-FLOW-5, R-SEC-2)", () => {
  it("checks the fields of a 512-character line, and refuses a 513-character one whole", () => {
    const long = `${PREFIX}${"a".repeat(512 - PREFIX.length)}`;
    assert.equal(long.length, 512);
    assert.deepEqual(issueFields(long), ["jobId"]);
    assert.deepEqual(issueFields(`${long}a`), ["handle"]);
  });
});
