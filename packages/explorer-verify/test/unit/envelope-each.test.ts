// exitCodeOf() and toEnvelope() of a verifyEach() result (R-AX-5, R-AX-7, R-RT-4, decision
// 0034): the exit code rule for several outcomes, the envelope form and its schema, redaction, and
// the checks of a value that bypassed the types.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { exitCodeOf, toEnvelope } from "../../src/envelope.ts";
import { newError } from "../../src/error-hints.ts";
import { ERROR_EXIT_CODES, ExplorerVerifyError } from "../../src/errors.ts";
import type { ErrorCode, ErrorDetails, ErrorJson, ExitCode } from "../../src/errors.ts";
import type { BackendOutcome, Handle, VerifyEachResult } from "../../src/types.ts";
import { SAMPLE_DETAILS } from "../helpers/sample-details.ts";
import { validateEnvelope } from "./envelope-schema.ts";

const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const HANDLE = `ev1:sourcify:11155111:${ADDRESS}:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718`;
const PENDING_JOB: Handle = {
  version: 1,
  backend: "sourcify",
  chainId: 11155111,
  address: ADDRESS,
  jobId: "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718",
};
// A fake key. Never a real one (R-SEC-1).
const KEY = "dummy-envelope-each-key-5t7u";

const VERIFIED: BackendOutcome<ErrorJson> = {
  backend: "sourcify",
  ok: true,
  result: { status: "verified", backend: "sourcify", match: "exact" },
};
const ALREADY: BackendOutcome<ErrorJson> = {
  backend: "etherscan-v2",
  ok: true,
  result: {
    status: "already-verified",
    backend: "etherscan-v2",
    match: "partial",
    explorerUrl: `https://sepolia.etherscan.io/address/${ADDRESS}#code`,
  },
};
const FAILED: BackendOutcome<ErrorJson> = {
  backend: "routescan",
  ok: false,
  result: { status: "failed", backend: "routescan", reason: "Fail - Unable to verify" },
};

/** An error outcome of `code` as an envelope holds it: the error's toJSON(). */
function errorOutcome(code: ErrorCode): BackendOutcome<ErrorJson> {
  const details: ErrorDetails =
    code === "not-confirmed" ? { code, handle: PENDING_JOB } : SAMPLE_DETAILS[code];
  const error = newError(details, `The ${code} message`, { secrets: [] });
  return { backend: "sourcify", ok: false, error: error.toJSON() };
}

function each(...outcomes: BackendOutcome<ErrorJson>[]): VerifyEachResult<ErrorJson> {
  return { outcomes };
}

/** exitCodeOf() of a value the types refuse, or the error it throws. */
function untypedExit(value: unknown): unknown {
  try {
    const code: unknown = Reflect.apply(exitCodeOf, undefined, [value]);
    return code;
  } catch (error: unknown) {
    return error;
  }
}

describe("exitCodeOf() of a verifyEach() result (R-AX-7)", () => {
  it("is 0 only when every outcome is verified or already-verified", () => {
    assert.equal(exitCodeOf(each(VERIFIED, ALREADY)), 0);
    assert.equal(exitCodeOf(each(VERIFIED, FAILED)), 1);
  });

  const order: [ExitCode, ErrorCode][] = [
    [6, "unknown-state"],
    [4, "not-confirmed"],
    [3, "missing-api-key"],
    [2, "unsupported-chain"],
    [5, "network"],
  ];
  it("takes the first of 6, 4, 3, 2, 5, 1 that any outcome has: resumable work before fixes", () => {
    for (const [index, [code, error]] of order.entries()) {
      assert.equal(ERROR_EXIT_CODES[error], code);
      // Every code later in the order, and a failed result, lose to this one.
      const later = order.slice(index + 1).map(([, name]) => errorOutcome(name));
      assert.equal(exitCodeOf(each(VERIFIED, FAILED, ...later, errorOutcome(error))), code);
    }
    assert.equal(exitCodeOf(each(FAILED, VERIFIED)), 1);
  });

  it("agrees with ok in toEnvelope()", () => {
    for (const result of [
      each(VERIFIED),
      each(VERIFIED, FAILED),
      each(errorOutcome("not-confirmed")),
    ]) {
      assert.equal(toEnvelope(result).ok, exitCodeOf(result) === 0);
    }
  });
});

describe("toEnvelope() of a verifyEach() result (R-AX-5)", () => {
  it("writes an ExplorerVerifyError outcome as its toJSON(), as verifyEach() returns it", () => {
    const error = newError({ code: "not-confirmed", handle: PENDING_JOB }, `pending ${KEY}`, {
      secrets: [],
    });
    const result: VerifyEachResult = {
      outcomes: [{ backend: "sourcify", ok: false, error }],
    };
    assert.equal(exitCodeOf(result), 4);
    const envelope = toEnvelope(result, { secrets: [KEY] });
    assert.deepEqual(validateEnvelope(envelope), []);
    assert.ok("result" in envelope && "outcomes" in envelope.result);
    const [outcome] = envelope.result.outcomes;
    assert.ok(outcome !== undefined && "error" in outcome);
    assert.equal(outcome.error.handle, HANDLE);
    assert.ok(!JSON.stringify(envelope).includes(KEY));
  });

  it("copies each outcome in order, and matches the shipped schema", () => {
    const result = each(VERIFIED, ALREADY, FAILED, errorOutcome("not-confirmed"));
    const envelope = toEnvelope(result);
    assert.deepEqual(envelope, { schemaVersion: 1, ok: false, result });
    assert.notEqual(envelope.result, result);
    assert.deepEqual(validateEnvelope(envelope), []);
    assert.deepEqual(validateEnvelope(toEnvelope(each(VERIFIED))), []);
    assert.deepEqual(Object.keys(envelope), ["schemaVersion", "ok", "result"]);
  });

  it("keeps the handle of a not-confirmed outcome, so checkStatus() resumes it (R-FLOW-5)", () => {
    const envelope = toEnvelope(each(errorOutcome("not-confirmed")));
    assert.ok("result" in envelope && "outcomes" in envelope.result);
    const [outcome] = envelope.result.outcomes;
    assert.ok(outcome !== undefined && "error" in outcome);
    assert.equal(outcome.error.handle, HANDLE);
  });

  it("removes the keys passed in secrets from every outcome (R-SEC-1)", () => {
    const leaky: BackendOutcome<ErrorJson> = {
      backend: "routescan",
      ok: false,
      result: { status: "failed", backend: "routescan", reason: `bad key ${KEY}` },
    };
    const error = errorOutcome("network");
    const withKey: BackendOutcome<ErrorJson> =
      "error" in error ? { ...error, error: { ...error.error, message: `echo ${KEY}` } } : error;
    const text = JSON.stringify(toEnvelope(each(leaky, withKey), { secrets: [KEY] }));
    assert.ok(!text.includes(KEY), text);
  });

  it("the schema refuses an empty outcome list and an ok that disagrees with the result", () => {
    assert.notDeepEqual(
      validateEnvelope({ schemaVersion: 1, ok: true, result: { outcomes: [] } }),
      [],
    );
    assert.notDeepEqual(
      validateEnvelope({
        schemaVersion: 1,
        ok: true,
        result: { outcomes: [{ ...FAILED, ok: true }] },
      }),
      [],
    );
  });
});

describe("a verifyEach() result that bypassed the types throws invalid-input", () => {
  const cases: [string, unknown, string][] = [
    ["outcomes that are not an array", { outcomes: "x" }, "outcome.outcomes"],
    ["an empty list", { outcomes: [] }, "outcome.outcomes"],
    ["an outcome that is not an object", { outcomes: [1] }, "outcome.outcomes[0]"],
    ["an unknown backend", { outcomes: [{ ...VERIFIED, backend: "nope" }] }, "outcome.outcomes[0]"],
    [
      "an outcome with no ok",
      { outcomes: [{ backend: "sourcify", result: VERIFIED.ok ? VERIFIED.result : {} }] },
      "outcome.outcomes[0]",
    ],
    [
      "an error with ok true",
      { outcomes: [{ ...errorOutcome("network"), ok: true }] },
      "outcome.outcomes[0].ok",
    ],
    [
      "a failed result with ok true",
      { outcomes: [{ ...FAILED, ok: true }] },
      "outcome.outcomes[0].ok",
    ],
    [
      "a verified result with ok false",
      { outcomes: [{ ...VERIFIED, ok: false }] },
      "outcome.outcomes[0].ok",
    ],
    [
      "a result of another backend",
      { outcomes: [{ ...VERIFIED, backend: "routescan" }] },
      "outcome.outcomes[0].result",
    ],
    [
      "a dry-run result",
      {
        outcomes: [
          {
            backend: "sourcify",
            ok: true,
            result: {
              status: "dry-run",
              backend: "sourcify",
              apiHost: "sourcify.dev",
              lookup: "none",
            },
          },
        ],
      },
      "outcome.outcomes[0].result",
    ],
    [
      "an error object with an unknown code",
      { outcomes: [{ backend: "sourcify", ok: false, error: { code: "nope" } }] },
      "outcome.code",
    ],
  ];
  for (const [name, value, field] of cases) {
    it(`refuses ${name}, naming ${field}`, () => {
      const error = untypedExit(value);
      assert.ok(error instanceof ExplorerVerifyError, String(error));
      assert.equal(error.code, "invalid-input");
      assert.ok(error.details.code === "invalid-input");
      assert.ok(
        error.details.issues.some((issue) => issue.field === field),
        JSON.stringify(error.details.issues),
      );
    });
  }

  it("refuses an outcomes array whose entries cannot be read", () => {
    const hostile = new Proxy([VERIFIED], {
      get(): never {
        throw new Error("trap");
      },
    });
    const error = untypedExit({ outcomes: hostile });
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(error.code, "invalid-input");
  });
});

/** A cancelled error from another copy of the package, whose toJSON() gives `handles`. */
function foreignCancelled(handles: unknown): unknown {
  const own = newError({ code: "cancelled" }, "x", { secrets: [] }).toJSON();
  const json = { ...own, handles };
  return { name: "ExplorerVerifyError", toJSON: () => json };
}

describe("the handles of a cancelled run on several backends (R-AX-5)", () => {
  const otherJob: Handle = { ...PENDING_JOB, backend: "etherscan-v2", jobId: "guid0123456789" };

  it("toJSON() and toEnvelope() list each backend with its one-line handle, and the schema accepts it", () => {
    const error = newError(
      { code: "cancelled", handles: [PENDING_JOB, otherJob] },
      "The run was cancelled by SIGINT.",
      { secrets: [] },
    );
    const expected = [
      { backend: "sourcify", handle: HANDLE },
      { backend: "etherscan-v2", handle: `ev1:etherscan-v2:11155111:${ADDRESS}:guid0123456789` },
    ];
    assert.deepEqual(error.toJSON().handles, expected);
    const envelope = toEnvelope(error);
    assert.deepEqual(validateEnvelope(envelope), []);
    assert.ok("error" in envelope);
    assert.deepEqual(envelope.error.handles, expected);
    assert.equal(exitCodeOf(error), 130);
    assert.match(envelope.error.hint, /error\.handles/);
  });

  it("copies valid handles of another copy of the package", () => {
    const value = foreignCancelled([{ backend: "sourcify", handle: HANDLE }]);
    const envelope: unknown = Reflect.apply(toEnvelope, undefined, [value]);
    assert.deepEqual(validateEnvelope(envelope), []);
  });

  const bad: [string, unknown][] = [
    ["not an array", "x"],
    ["an empty list", []],
    ["an entry that is not an object", [1]],
    ["an unknown backend", [{ backend: "nope", handle: HANDLE }]],
    ["a handle of another backend", [{ backend: "routescan", handle: HANDLE }]],
    ["a handle that is not one", [{ backend: "sourcify", handle: "nope" }]],
  ];
  for (const [name, handles] of bad) {
    it(`refuses handles that are ${name}`, () => {
      const error = untypedExit(foreignCancelled(handles));
      assert.ok(error instanceof ExplorerVerifyError);
      assert.ok(error.details.code === "invalid-input");
      assert.ok(error.details.issues.some((issue) => issue.field === "outcome.handles"));
    });
  }

  it("refuses a handles list whose entries cannot be read", () => {
    const hostile = new Proxy([{ backend: "sourcify", handle: HANDLE }], {
      get(): never {
        throw new Error("trap");
      },
    });
    const error = untypedExit(foreignCancelled(hostile));
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(error.code, "invalid-input");
  });
});
