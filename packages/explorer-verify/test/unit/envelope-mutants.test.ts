// Tests added when the envelope joined mutation testing (#202; R-AX-5, R-AX-7, R-AX-9, R-SEC-1):
// each one fails on a code change in src/envelope.ts that the other envelope tests let pass. They
// pin the issues of each value that bypassed the types, one bad field at a time.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { exitCodeOf, toEnvelope } from "../../src/envelope.ts";
import type { EnvelopeOptions, VerifyOutcome } from "../../src/envelope.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import type { InputIssue } from "../../src/errors.ts";

const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const HANDLE = `ev1:sourcify:11155111:${ADDRESS}:job-1`;
const VERIFIED = { status: "verified", backend: "sourcify", match: "exact" };
const DRY_RUN = { status: "dry-run", backend: "sourcify", apiHost: "sourcify.dev", lookup: "none" };
const ERROR_JSON = new ExplorerVerifyError(
  { code: "network", backend: "sourcify", attempts: 1 },
  "Sample network error.",
  { secrets: [] },
).toJSON();

/** `value` typed as an outcome without a cast, as code that bypasses the types passes it. */
function bypass(value: unknown): VerifyOutcome {
  const holder: { outcome: VerifyOutcome } = {
    outcome: { status: "verified", backend: "sourcify", match: "exact" },
  };
  Reflect.set(holder, "outcome", value);
  return holder.outcome;
}

/** `value` typed as options without a cast. */
function looseOptions(value: unknown): EnvelopeOptions {
  const holder: { options: EnvelopeOptions } = { options: {} };
  Reflect.set(holder, "options", value);
  return holder.options;
}

/** An error from another copy of the package: same name and toJSON(), another class. */
class OtherCopyError extends Error {
  readonly json: unknown;
  constructor(json: unknown) {
    super("other copy");
    this.json = json;
  }
  override get name(): string {
    return "ExplorerVerifyError";
  }
  toJSON(): unknown {
    return this.json;
  }
}

function thrownBy(run: () => unknown): ExplorerVerifyError {
  try {
    run();
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError, String(error));
    return error;
  }
  return assert.fail("did not throw");
}

/** The issues toEnvelope and exitCodeOf both give for `value`. */
function issuesOf(value: unknown): readonly InputIssue[] {
  const outcome = bypass(value);
  const first = thrownBy(() => toEnvelope(outcome));
  const second = thrownBy(() => exitCodeOf(outcome));
  assert.ok(first.details.code === "invalid-input");
  assert.deepEqual(second.details, first.details);
  return first.details.issues;
}

describe("toEnvelope says what is wrong with an outcome that bypassed the types (R-AX-5)", () => {
  it("gives the outcome message and hint for a value that is not an object", () => {
    const error = thrownBy(() => toEnvelope(bypass(5)));
    assert.equal(
      error.message,
      "The value is not a VerifyResult, a DryRunResult, a VerifyEachResult, a LinkProxyResult or an ExplorerVerifyError.",
    );
    assert.equal(
      error.hint,
      "Pass the result that verify(), checkStatus(), verifyEach() or linkProxy() returned, or the ExplorerVerifyError it threw.",
    );
    assert.deepEqual(issuesOf(5), [
      { field: "outcome", message: "must be an object whose fields can be read" },
    ]);
  });

  it("names the status, backend and match of an empty result", () => {
    assert.deepEqual(issuesOf({}), [
      {
        field: "outcome.status",
        message: "must be verified, already-verified, failed or dry-run",
      },
      { field: "outcome.backend", message: "must be one of BACKEND_NAMES" },
      { field: "outcome.match", message: "must be exact or partial" },
    ]);
  });

  it("names the reason of a failed result and the explorerUrl of a verified one", () => {
    assert.deepEqual(issuesOf({ status: "failed", backend: "sourcify" }), [
      { field: "outcome.reason", message: "must be a string" },
    ]);
    assert.deepEqual(issuesOf({ ...VERIFIED, explorerUrl: 5 }), [
      { field: "outcome.explorerUrl", message: "must be a string when present" },
    ]);
  });

  it("refuses a dry-run result with any one bad field", () => {
    const cases: [Record<string, unknown>, InputIssue][] = [
      [{ backend: "nope" }, { field: "outcome.backend", message: "must be one of BACKEND_NAMES" }],
      [{ apiHost: 5 }, { field: "outcome.apiHost", message: "must be a string" }],
      [
        { lookup: "maybe" },
        { field: "outcome.lookup", message: "must be exact, partial, none or skipped" },
      ],
      [
        { explorerUrl: 5 },
        { field: "outcome.explorerUrl", message: "must be a string when present" },
      ],
      [
        { routedBy: "guess" },
        {
          field: "outcome.routedBy",
          message: "must be caller, table, fallback or api-url when present",
        },
      ],
    ];
    for (const [change, issue] of cases) {
      assert.deepEqual(issuesOf({ ...DRY_RUN, ...change }), [issue], issue.field);
    }
  });

  // R-FLOW-3, decision 0063.
  it("refuses a storedContract that is not an object of strings", () => {
    const issue = {
      field: "outcome.storedContract",
      message: "must be an object whose name and compilerVersion are strings when present",
    };
    const already = { ...VERIFIED, status: "already-verified", match: "partial" };
    for (const storedContract of ["SimpleStorage", null, { name: 5 }, { compilerVersion: 8 }]) {
      assert.deepEqual(issuesOf({ ...already, storedContract }), [issue]);
      assert.deepEqual(issuesOf({ ...DRY_RUN, lookup: "partial", storedContract }), [issue]);
    }
  });

  it("copies storedContract's two fields, redacted, and only on already-verified and dry-run", () => {
    const secret = "DUMMYSECRETstored293key";
    const storedContract = { name: `A${secret}`, compilerVersion: "v0.8.33", extra: "dropped" };
    const options = { secrets: [secret] };
    const already = { ...VERIFIED, status: "already-verified", match: "partial", storedContract };
    assert.deepEqual(toEnvelope(bypass(already), options).result, {
      ...VERIFIED,
      status: "already-verified",
      match: "partial",
      storedContract: { name: "A[redacted]", compilerVersion: "v0.8.33" },
    });
    assert.deepEqual(toEnvelope(bypass({ ...VERIFIED, storedContract })).result, VERIFIED);
    assert.deepEqual(toEnvelope(bypass({ ...DRY_RUN, storedContract: {} })).result, {
      ...DRY_RUN,
      storedContract: {},
    });
    assert.deepEqual(
      toEnvelope(bypass({ ...DRY_RUN, storedContract: { compilerVersion: secret } }), options)
        .result,
      { ...DRY_RUN, storedContract: { compilerVersion: "[redacted]" } },
    );
  });

  it("reads a result that has its own toJSON() as a result", () => {
    const result = { ...VERIFIED, toJSON: () => ({}) };
    assert.deepEqual(toEnvelope(bypass(result)), {
      schemaVersion: 1,
      ok: true,
      result: VERIFIED,
    });
  });

  it("reads a function named ExplorerVerifyError as no error", () => {
    const fn = Object.defineProperty(() => undefined, "name", { value: "ExplorerVerifyError" });
    const named = Object.assign(fn, { toJSON: () => ERROR_JSON });
    assert.deepEqual(issuesOf(named), [
      { field: "outcome", message: "must be an object whose fields can be read" },
    ]);
  });
});

describe("toEnvelope says what is wrong with an error object (R-AX-5, R-SEC-1)", () => {
  it("names a toJSON() that gives no object", () => {
    assert.deepEqual(issuesOf(new OtherCopyError("text")), [
      { field: "outcome", message: "must have a toJSON() that returns an object" },
    ]);
  });

  it("names every bad field of the error object, in order", () => {
    const json = {
      code: "nope",
      message: 1,
      hint: "",
      docsUrl: "http://x",
      retryable: "yes",
      handle: 5,
      handles: 5,
    };
    assert.deepEqual(issuesOf(new OtherCopyError(json)), [
      { field: "outcome.code", message: "must be one of ERROR_CODES" },
      { field: "outcome.message", message: "must be a string" },
      { field: "outcome.hint", message: "must be a non-empty string" },
      { field: "outcome.docsUrl", message: "must be an https URL" },
      { field: "outcome.retryable", message: "must be a boolean" },
      { field: "outcome.handle", message: "must be a handle in its one-line form" },
      { field: "outcome.handles", message: "must be a list of backends and one-line handles" },
    ]);
  });

  it("names a missing hint", () => {
    const { hint: _hint, ...json } = ERROR_JSON;
    assert.deepEqual(issuesOf(new OtherCopyError(json)), [
      { field: "outcome.hint", message: "must be a non-empty string" },
    ]);
  });

  it("refuses a handle of the other copy that is not in the ev1 form or has a bad chain id", () => {
    for (const handle of [
      `ev2:sourcify:11155111:${ADDRESS}:job`,
      `ev1:sourcify:1e3:${ADDRESS}:job`,
      `ev1:sourcify:1x:${ADDRESS}:job`,
    ]) {
      assert.deepEqual(
        issuesOf(new OtherCopyError({ ...ERROR_JSON, handle })),
        [{ field: "outcome.handle", message: "must be a handle in its one-line form" }],
        handle,
      );
    }
  });

  it("refuses handles that are not an array, not in the ev1 form, or of another backend", () => {
    const lists: unknown[] = [
      new Set([{ backend: "sourcify", handle: HANDLE }]),
      [{ backend: "sourcify", handle: `ev2:sourcify:11155111:${ADDRESS}:job` }],
      [{ backend: "etherscan-v2", handle: HANDLE }],
    ];
    for (const handles of lists) {
      assert.deepEqual(issuesOf(new OtherCopyError({ ...ERROR_JSON, handles })), [
        { field: "outcome.handles", message: "must be a list of backends and one-line handles" },
      ]);
    }
  });
});

describe("toEnvelope says what is wrong with a verifyEach() result (R-AX-5, R-RT-4)", () => {
  it("names each bad outcome with its index", () => {
    const failed = { status: "failed", backend: "sourcify", reason: "bad" };
    const cases: [unknown[], InputIssue][] = [
      [[], { field: "outcome.outcomes", message: "must be a non-empty array" }],
      [
        [1],
        {
          field: "outcome.outcomes[0]",
          message: "must be an object with a known backend and a boolean ok",
        },
      ],
      [
        [{ backend: "sourcify", ok: true, error: ERROR_JSON }],
        { field: "outcome.outcomes[0].ok", message: "must be false for an error" },
      ],
      [
        [{ backend: "etherscan-v2", ok: true, result: VERIFIED }],
        {
          field: "outcome.outcomes[0].result",
          message: "must be a VerifyResult of the outcome's backend",
        },
      ],
      [
        [{ backend: "sourcify", ok: true, result: failed }],
        { field: "outcome.outcomes[0].ok", message: "must be false for a failed result" },
      ],
      [
        [{ backend: "sourcify", ok: false, result: VERIFIED }],
        { field: "outcome.outcomes[0].ok", message: "must be true for a verified result" },
      ],
    ];
    for (const [outcomes, issue] of cases) {
      assert.deepEqual(issuesOf({ outcomes }), [issue], issue.message);
    }
  });

  it("checks the handle of a branded error from another copy strictly (decision 0044)", () => {
    const other = new OtherCopyError({
      ...ERROR_JSON,
      handle: `ev1:nope:11155111:${ADDRESS}:job`,
    });
    Object.defineProperty(other, Symbol.for("explorer-verify.error"), { value: true });
    assert.deepEqual(issuesOf(other), [
      { field: "outcome.handle", message: "must be a handle in its one-line form" },
    ]);
  });

  it("checks the handle of a plain error object as strictly as another copy's", () => {
    const error = { ...ERROR_JSON, handle: `ev1:nope:11155111:${ADDRESS}:job` };
    assert.deepEqual(issuesOf({ outcomes: [{ backend: "sourcify", ok: false, error }] }), [
      { field: "outcome.handle", message: "must be a handle in its one-line form" },
    ]);
  });

  it("refuses a chain id above 2^53 in a foreign handle", () => {
    const handle = `ev1:sourcify:9007199254740993:${ADDRESS}:job`;
    assert.deepEqual(issuesOf(new OtherCopyError({ ...ERROR_JSON, handle })), [
      { field: "outcome.handle", message: "must be a handle in its one-line form" },
    ]);
  });

  it("names only the bad handles, not the details, when both are wrong (decision 0049)", () => {
    const { details: _left, ...without } = ERROR_JSON;
    assert.deepEqual(issuesOf(new OtherCopyError({ ...without, handles: "x" })), [
      { field: "outcome.handles", message: "must be a list of backends and one-line handles" },
    ]);
  });
});

describe("toEnvelope checks its options (R-AX-9)", () => {
  it("gives the options message and hint, and names the bad field", () => {
    const cases: [unknown, InputIssue][] = [
      [5, { field: "options", message: "must be an object" }],
      [{ secrets: "x" }, { field: "options.secrets", message: "must be an array of strings" }],
    ];
    for (const [options, issue] of cases) {
      const error = thrownBy(() => toEnvelope(bypass(VERIFIED), looseOptions(options)));
      assert.equal(error.message, "The options are invalid.");
      assert.equal(error.hint, "Pass options as { secrets: string[] }, or leave them out.");
      assert.deepEqual(error.details, { code: "invalid-input", issues: [issue] });
    }
  });
});
