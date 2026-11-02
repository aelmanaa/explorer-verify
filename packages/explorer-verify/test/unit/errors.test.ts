import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ERROR_CODES, ExplorerVerifyError } from "../../src/index.ts";
import type { ErrorDetails, ErrorJson, Handle } from "../../src/index.ts";

const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const DOCS = "https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/errors.md";

function handle(): Handle {
  return {
    version: 1,
    backend: "sourcify",
    chainId: 11155111,
    address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    jobId: "550e8400-e29b-41d4-a716-446655440000",
  };
}

function notConfirmed(): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "not-confirmed", handle: handle() },
    "Sourcify was still verifying when the time budget ran out.",
    { cause: new Error(`GET https://api.example.org/?apikey=${DUMMY_KEY} timed out`) },
  );
}

function invalidInput(): ExplorerVerifyError {
  return new ExplorerVerifyError(
    {
      code: "invalid-input",
      issues: [{ field: "chainId", message: "must be a positive integer" }],
    },
    "The input is invalid: chainId.",
  );
}

function assertNoKey(error: ExplorerVerifyError): void {
  assert.ok(!error.message.includes(DUMMY_KEY), "message holds the key");
  assert.ok(!String(error).includes(DUMMY_KEY), "String(error) holds the key");
  assert.ok(!JSON.stringify(error).includes(DUMMY_KEY), "JSON holds the key");
}

describe("ExplorerVerifyError", () => {
  it("is an Error named ExplorerVerifyError with code, hint, retryable, details and docsUrl (R-DX-3, R-AX-10)", () => {
    const error = invalidInput();
    assert.ok(error instanceof Error);
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(error.name, "ExplorerVerifyError");
    assert.equal(error.code, "invalid-input");
    assert.equal(error.details.code, "invalid-input");
    assert.equal(error.message, "The input is invalid: chainId.");
    assert.equal(error.hint, "Fix the fields listed in details.issues, then call again.");
    assert.equal(error.retryable, false);
    assert.equal(error.docsUrl, `${DOCS}#invalid-input`);
    assert.equal(String(error), "ExplorerVerifyError: The input is invalid: chainId.");
  });

  it("marks not-confirmed as retryable and links its docs entry (R-FLOW-4, R-AX-10)", () => {
    const error = notConfirmed();
    assert.equal(error.code, "not-confirmed");
    assert.equal(error.retryable, true);
    assert.equal(error.hint, "Call checkStatus with details.handle later to continue polling.");
    assert.equal(error.docsUrl, `${DOCS}#not-confirmed`);
  });

  it("gives every code a non-empty hint and a docs URL with the code as anchor (R-DX-3, R-AX-10)", () => {
    const details: Record<(typeof ERROR_CODES)[number], ErrorDetails> = {
      "invalid-input": { code: "invalid-input", issues: [] },
      "not-confirmed": { code: "not-confirmed", handle: handle() },
    };
    for (const code of ERROR_CODES) {
      const error = new ExplorerVerifyError(details[code], "message");
      assert.equal(error.code, code);
      assert.ok(error.hint.length > 0);
      assert.equal(error.docsUrl, `${DOCS}#${code}`);
    }
  });

  it("takes a specific hint in place of the code's default (R-DX-3)", () => {
    const error = new ExplorerVerifyError({ code: "invalid-input", issues: [] }, "message", {
      hint: "Use sourcify.",
    });
    assert.equal(error.hint, "Use sourcify.");
  });

  it("keeps cause as the standard ES2022 property, and has none when not given", () => {
    const cause = new Error("socket closed");
    const withCause = new ExplorerVerifyError({ code: "invalid-input", issues: [] }, "m", {
      cause,
    });
    assert.equal(withCause.cause, cause);
    assert.equal(Object.hasOwn(invalidInput(), "cause"), false);
  });

  it("narrows details on details.code without a cast (R-DX-3)", () => {
    const error: ExplorerVerifyError = notConfirmed();
    const details = error.details;
    switch (details.code) {
      case "not-confirmed":
        assert.equal(details.handle.jobId, "550e8400-e29b-41d4-a716-446655440000");
        break;
      case "invalid-input":
        assert.fail(`unexpected issues ${String(details.issues.length)}`);
    }
  });
});

describe("ExplorerVerifyError.toJSON", () => {
  it("returns exactly the error object of the CLI envelope, in a stable order (R-AX-5, R-AX-12)", () => {
    const expected: ErrorJson = {
      code: "invalid-input",
      message: "The input is invalid: chainId.",
      hint: "Fix the fields listed in details.issues, then call again.",
      docsUrl: `${DOCS}#invalid-input`,
      retryable: false,
    };
    const json = invalidInput().toJSON();
    assert.deepEqual(json, expected);
    assert.deepEqual(Object.keys(json), ["code", "message", "hint", "docsUrl", "retryable"]);
  });

  it("adds the handle in its one-line form for not-confirmed (R-AX-5, R-FLOW-5)", () => {
    const json = notConfirmed().toJSON();
    assert.deepEqual(Object.keys(json), [
      "code",
      "message",
      "hint",
      "docsUrl",
      "retryable",
      "handle",
    ]);
    assert.equal(
      json.handle,
      "ev1:sourcify:11155111:0x5FbDB2315678afecb367f032d93F642f64180aa3:550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("leaves out cause, stack and details, so JSON.stringify is safe to print (R-SEC-1, R-AX-9)", () => {
    const error = notConfirmed();
    const parsed: unknown = JSON.parse(JSON.stringify(error));
    assert.deepEqual(parsed, error.toJSON());
    const keys = Object.keys(error.toJSON());
    for (const left of ["cause", "stack", "details", "name"]) {
      assert.ok(!keys.includes(left), `toJSON() holds ${left}`);
    }
    assert.ok(!JSON.stringify(error).includes("timed out"), "the cause reached the JSON");
  });

  it("never shows a key held in the cause in message, String or JSON (R-SEC-1, R-AX-9)", () => {
    const error = notConfirmed();
    assert.ok(String(error.cause).includes(DUMMY_KEY), "the test key reached the cause");
    assertNoKey(error);
  });
});
