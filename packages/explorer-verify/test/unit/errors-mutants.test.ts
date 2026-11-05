// Tests added after the first full mutation run (#158; R-SEC-1, R-FLOW-5): each one fails on a
// code change in src/errors.ts that the other error tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "../../src/index.ts";
import type { Handle } from "../../src/index.ts";
import { SAMPLE_DETAILS } from "../helpers/sample-details.ts";

function handle(address: `0x${string}`): Handle {
  return {
    version: 1,
    backend: "sourcify",
    chainId: 11155111,
    address,
    jobId: "550e8400-e29b-41d4-a716-446655440000",
  };
}

describe("ExplorerVerifyError: cases from the first full mutation run (#158)", () => {
  it("keeps one 0x on a handle address that is not 40 hex digits (R-FLOW-5)", () => {
    const error = new ExplorerVerifyError(
      { code: "job-not-found", handle: handle("0xnot-an-address") },
      "m",
      { secrets: [] },
    );
    assert.ok(error.details.code === "job-not-found");
    assert.equal(error.details.handle.address, "0xnot-an-address");
  });

  it("keeps a Firefox frame whose line and column have several digits (R-SEC-1)", () => {
    const cause = new Error("boom");
    const firefox = "fetchJson@https://app.example/main.js:120:34";
    cause.stack = ["Error: boom", firefox].join("\n");
    const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", { cause, secrets: [] });
    assert.ok(error.cause instanceof Error);
    assert.deepEqual(error.cause.stack?.split("\n"), ["Error: boom", firefox]);
  });

  it("collapses each run of whitespace in an AggregateError summary to one space (R-SEC-1)", () => {
    const cause = new AggregateError([new Error("a  b\n\n\tc"), "d   e"], "all failed");
    const error = new ExplorerVerifyError(SAMPLE_DETAILS.network, "m", { cause, secrets: [] });
    assert.ok(error.cause instanceof Error);
    assert.equal(Reflect.get(error.cause, "errors"), "2 errors: Error: a b c; d e");
  });
});
