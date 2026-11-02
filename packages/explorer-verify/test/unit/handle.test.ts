import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_NAMES, ExplorerVerifyError, parseHandle } from "../../src/index.ts";
import type { Handle } from "../../src/index.ts";

const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";

function handle(): Handle {
  return {
    version: 1,
    backend: "sourcify",
    chainId: 11155111,
    address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    jobId: "550e8400-e29b-41d4-a716-446655440000",
  };
}

/** Runs `parseHandle` on `value` and returns the error it throws. */
function rejection(value: unknown): ExplorerVerifyError {
  try {
    parseHandle(value);
  } catch (error) {
    assert.ok(error instanceof ExplorerVerifyError, "parseHandle threw something else");
    return error;
  }
  return assert.fail("parseHandle accepted the value");
}

/** Asserts an invalid-input error naming exactly `fields`, with no key anywhere in it. */
function assertRejected(value: unknown, fields: string[]): void {
  const error = rejection(value);
  assert.equal(error.code, "invalid-input");
  assert.equal(error.retryable, false);
  if (error.details.code !== "invalid-input") {
    assert.fail("details do not match the code");
  }
  assert.deepEqual(
    error.details.issues.map((issue) => issue.field),
    fields,
  );
  for (const issue of error.details.issues) {
    assert.ok(!issue.message.includes(DUMMY_KEY));
  }
  assert.ok(!error.message.includes(DUMMY_KEY));
  assert.ok(!String(error).includes(DUMMY_KEY));
  assert.ok(!JSON.stringify(error).includes(DUMMY_KEY));
}

describe("parseHandle", () => {
  it("round-trips a handle through JSON.stringify and JSON.parse (R-FLOW-5)", () => {
    const original = handle();
    const parsed = parseHandle(JSON.parse(JSON.stringify(original)));
    assert.deepEqual(parsed, original);
    assert.notEqual(parsed, original);
  });

  it("accepts every known backend (R-FLOW-5)", () => {
    for (const backend of BACKEND_NAMES) {
      assert.equal(parseHandle({ ...handle(), backend }).backend, backend);
    }
  });

  it("accepts an Etherscan-style guid and a job id of 128 characters (R-FLOW-5)", () => {
    const guid = "ezq8ki7w1agqbwvvvxnjsicmz8yxkbjjvzzd7anblanbt2ztqf";
    assert.equal(parseHandle({ ...handle(), jobId: guid }).jobId, guid);
    const longest = "a".repeat(128);
    assert.equal(parseHandle({ ...handle(), jobId: longest }).jobId, longest);
  });

  it("rejects a handle with an apiUrl field, so no host enters through a handle (R-SEC-2)", () => {
    assertRejected({ ...handle(), apiUrl: `https://evil.example/?apikey=${DUMMY_KEY}` }, [
      "apiUrl",
    ]);
  });

  it("rejects an extra field with an unsafe name without echoing the name (R-SEC-1, R-SEC-2)", () => {
    assertRejected({ ...handle(), [`url ${DUMMY_KEY}`]: "x" }, ["handle"]);
  });

  it("rejects an unknown backend (R-FLOW-5)", () => {
    assertRejected({ ...handle(), backend: "oklink" }, ["backend"]);
    assertRejected({ ...handle(), backend: 1 }, ["backend"]);
  });

  it("rejects an unknown or missing version (R-FLOW-5)", () => {
    assertRejected({ ...handle(), version: 2 }, ["version"]);
    assertRejected({ ...handle(), version: "1" }, ["version"]);
    const { version: _version, ...withoutVersion } = handle();
    assertRejected(withoutVersion, ["version"]);
  });

  it("rejects a chain id that is not a positive safe integer (R-FLOW-5)", () => {
    for (const chainId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", Number.NaN]) {
      assertRejected({ ...handle(), chainId }, ["chainId"]);
    }
  });

  it("rejects a bad address (R-FLOW-5)", () => {
    for (const address of [
      "0x1234",
      "5FbDB2315678afecb367f032d93F642f64180aa3",
      `0x${"g".repeat(40)}`,
      42,
    ]) {
      assertRejected({ ...handle(), address }, ["address"]);
    }
  });

  it("rejects an empty, too long or unsafe job id without echoing it (R-FLOW-5, R-SEC-1)", () => {
    for (const jobId of ["", "a".repeat(129), "a b", "$(rm -rf ~)", DUMMY_KEY + "&", 7]) {
      assertRejected({ ...handle(), jobId }, ["jobId"]);
    }
  });

  it("rejects a value that is not an object (R-FLOW-5)", () => {
    for (const value of [null, undefined, "ev1:sourcify", 1, [handle()]]) {
      assertRejected(value, ["handle"]);
    }
  });

  it("lists every bad field in one error (R-FLOW-5, R-DX-3)", () => {
    assertRejected({ version: 0, backend: "x", chainId: 0, address: "0x", jobId: "", host: "h" }, [
      "version",
      "backend",
      "chainId",
      "address",
      "jobId",
      "host",
    ]);
  });

  it("names the bad fields in the message and gives the handle hint (R-DX-3)", () => {
    const error = rejection({ ...handle(), chainId: 0 });
    assert.equal(error.message, "The handle is invalid: chainId.");
    assert.equal(
      error.hint,
      "Pass the handle exactly as verify() or a not-confirmed error returned it.",
    );
  });
});
