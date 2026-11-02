import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_NAMES, ExplorerVerifyError, parseHandle } from "../../src/index.ts";
import type { Handle } from "../../src/index.ts";

const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const JOB_ID_MESSAGE =
  "must be 1 to 128 characters from A-Z, a-z, 0-9, '_' and '-', starting with a letter or digit";

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
    assert.ok(error instanceof ExplorerVerifyError, `parseHandle threw ${String(error)}`);
    return error;
  }
  return assert.fail("parseHandle accepted the value");
}

/** Asserts that `text` appears in none of the places an error can be printed from. */
function assertNotShown(error: ExplorerVerifyError, text: string): void {
  const places = [
    error.message,
    error.hint,
    String(error),
    error.stack ?? "",
    JSON.stringify(error),
    JSON.stringify(error.toJSON()),
    JSON.stringify(error.details),
  ];
  for (const place of places) {
    assert.ok(!place.includes(text), `shown in: ${place.slice(0, 120)}`);
  }
}

/** Asserts an invalid-input error naming exactly `fields`, with no key anywhere in it. */
function assertRejected(value: unknown, fields: string[]): ExplorerVerifyError {
  const error = rejection(value);
  assert.equal(error.code, "invalid-input");
  assert.equal(error.retryable, false);
  if (error.details.code !== "invalid-input") {
    return assert.fail("details do not match the code");
  }
  assert.deepEqual(
    error.details.issues.map((issue) => issue.field),
    fields,
  );
  assertNotShown(error, DUMMY_KEY);
  return error;
}

describe("parseHandle accepts", () => {
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

  it("accepts a Sourcify UUID and an Etherscan-style alphanumeric guid (R-FLOW-5)", () => {
    for (const jobId of [
      "550e8400-e29b-41d4-a716-446655440000",
      "ezq8ki7w1agqbwvvvxnjsicmz8yxkbjjvzzd7anblanbt2ztqf",
      "a",
      "A_b-9",
    ]) {
      assert.equal(parseHandle({ ...handle(), jobId }).jobId, jobId);
    }
  });

  it("accepts a job id of 128 characters and rejects 129 (R-FLOW-5)", () => {
    const longest = "a".repeat(128);
    assert.equal(parseHandle({ ...handle(), jobId: longest }).jobId, longest);
    assertRejected({ ...handle(), jobId: "a".repeat(129) }, ["jobId"]);
  });
});

describe("parseHandle rejects", () => {
  it("a job id that could become a URL, a path or a separator (R-SEC-2)", () => {
    for (const jobId of [
      "http:evil.example",
      "javascript:alert",
      ".",
      "..",
      "a/b",
      "a%2Fb",
      "a?b",
      "a#b",
      "a\\b",
      "a:b",
      "a.b",
      "-a",
      "_a",
      "a b",
      "",
    ]) {
      const error = assertRejected({ ...handle(), jobId }, ["jobId"]);
      if (error.details.code === "invalid-input") {
        assert.equal(error.details.issues[0]?.message, JOB_ID_MESSAGE);
      }
    }
  });

  it("a job id that is not a string (R-FLOW-5)", () => {
    for (const jobId of [7, null, undefined, [DUMMY_KEY]]) {
      assertRejected({ ...handle(), jobId }, ["jobId"]);
    }
  });

  it("any extra field, reported as one handle issue (R-SEC-2)", () => {
    for (const name of ["url", "apiUrl", "host", "explorerUrl", "endpoint"]) {
      const error = assertRejected({ ...handle(), [name]: "https://evil.example" }, ["handle"]);
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [{ field: "handle", message: "has 1 field that is not a handle field" }],
      });
    }
  });

  it("an extra field without echoing its name, even when it looks like a key (R-SEC-1)", () => {
    const error = assertRejected({ ...handle(), [DUMMY_KEY]: 1, [`apikey=${DUMMY_KEY}`]: 2 }, [
      "handle",
    ]);
    assert.equal(error.message, "The handle is invalid: handle.");
    if (error.details.code === "invalid-input") {
      assert.equal(error.details.issues[0]?.message, "has 2 fields that are not handle fields");
    }
  });

  it("200,000 extra fields with one issue and a short message (R-SEC-2)", () => {
    const value: Record<string, unknown> = { ...handle() };
    for (let index = 0; index < 200_000; index++) {
      value[`k${String(index)}`] = index;
    }
    const error = assertRejected(value, ["handle"]);
    assert.ok(error.message.length < 100);
    assert.ok(JSON.stringify(error).length < 1_000);
    if (error.details.code === "invalid-input") {
      assert.equal(
        error.details.issues[0]?.message,
        "has 200000 fields that are not handle fields",
      );
    }
  });

  it("a Proxy whose ownKeys throws, as invalid-input (R-FLOW-5)", () => {
    const hostile = new Proxy(handle(), {
      ownKeys: () => {
        throw new Error(`trap ${DUMMY_KEY}`);
      },
    });
    assertRejected(hostile, ["handle"]);
  });

  it("an object whose getter throws, as invalid-input (R-FLOW-5)", () => {
    const value = {
      ...handle(),
      get jobId(): string {
        throw new Error(`getter ${DUMMY_KEY}`);
      },
    };
    assertRejected(value, ["handle"]);
  });

  it("an unknown backend (R-FLOW-5)", () => {
    assertRejected({ ...handle(), backend: "oklink" }, ["backend"]);
    assertRejected({ ...handle(), backend: 1 }, ["backend"]);
  });

  it("an unknown or missing version (R-FLOW-5)", () => {
    assertRejected({ ...handle(), version: 2 }, ["version"]);
    assertRejected({ ...handle(), version: "1" }, ["version"]);
    const { version: _version, ...withoutVersion } = handle();
    assertRejected(withoutVersion, ["version"]);
  });

  it("a chain id that is not a positive safe integer (R-FLOW-5)", () => {
    for (const chainId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", Number.NaN]) {
      assertRejected({ ...handle(), chainId }, ["chainId"]);
    }
  });

  it("a bad address (R-FLOW-5)", () => {
    const hex40 = "5FbDB2315678afecb367f032d93F642f64180aa3";
    for (const address of [
      "0x1234",
      hex40,
      `0x${"g".repeat(40)}`,
      `0x${hex40.slice(1)}`,
      `0x${hex40}a`,
      `0x${hex40}00`,
      `junk0x${hex40}`,
      `0X${hex40}`,
      `0x${hex40}\n`,
      42,
    ]) {
      assertRejected({ ...handle(), address }, ["address"]);
    }
  });

  it("a value that is not a plain object (R-FLOW-5)", () => {
    for (const value of [null, undefined, "ev1:sourcify", 1, [handle()]]) {
      assertRejected(value, ["handle"]);
    }
  });

  it("a handle whose fields come from its prototype (R-FLOW-5)", () => {
    const value: unknown = Object.create(handle());
    assertRejected(value, ["version", "backend", "chainId", "address", "jobId"]);
  });
});

describe("parseHandle errors", () => {
  it("never repeat a bad value of any field (R-SEC-1, R-AX-9)", () => {
    for (const field of ["version", "backend", "chainId", "address", "jobId"]) {
      // A bare key would be a valid job id, so each value adds a character no field accepts.
      assertRejected({ ...handle(), [field]: `${DUMMY_KEY}!` }, [field]);
      assertRejected({ ...handle(), [field]: `0x${DUMMY_KEY}/` }, [field]);
    }
  });

  it("list every bad field in one error, with the exact message (R-FLOW-5, R-DX-3)", () => {
    const error = rejection({
      version: 0,
      backend: "x",
      chainId: 0,
      address: "0x",
      jobId: "",
      host: "h",
    });
    assert.equal(
      error.message,
      "The handle is invalid: version, backend, chainId, address, jobId, handle.",
    );
    assert.deepEqual(error.details, {
      code: "invalid-input",
      issues: [
        { field: "version", message: "must be 1" },
        { field: "backend", message: "must name a known backend" },
        { field: "chainId", message: "must be a positive integer" },
        { field: "address", message: "must be 0x followed by 40 hex digits" },
        { field: "jobId", message: JOB_ID_MESSAGE },
        { field: "handle", message: "has 1 field that is not a handle field" },
      ],
    });
  });

  it("give the handle hint (R-DX-3)", () => {
    const error = rejection({ ...handle(), chainId: 0 });
    assert.equal(error.message, "The handle is invalid: chainId.");
    assert.equal(
      error.hint,
      "Pass the handle exactly as verify() or a not-confirmed error returned it.",
    );
  });

  it("for a non-object say it must be a plain object (R-DX-3)", () => {
    assert.deepEqual(rejection("x").details, {
      code: "invalid-input",
      issues: [{ field: "handle", message: "must be a plain object" }],
    });
  });
});
