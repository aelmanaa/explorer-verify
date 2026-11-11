// The details of an error in its JSON form (R-AX-5, R-SEC-1, R-AX-9, decision 0049): toJSON()
// keeps them, redacted, with each handle in its one-line form; toEnvelope() rebuilds them from an
// error object it did not build; the schema checks each code's fields.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toEnvelope } from "../../src/envelope.ts";
import { newError } from "../../src/error-hints.ts";
import { ERROR_CODES, ExplorerVerifyError, detailsFromJson } from "../../src/errors.ts";
import type { ErrorCode, ErrorDetails, ErrorDetailsJson, ErrorJson } from "../../src/errors.ts";
import { formatHandle } from "../../src/flow/format-handle.ts";
import type { Handle } from "../../src/types.ts";
import { SAMPLE_DETAILS } from "../helpers/sample-details.ts";
import { validateEnvelope } from "./envelope-schema.ts";

// A fake key in lower-case hex. Never a real one (R-SEC-1).
const DUMMY_KEY = "0123456789abcdef0123456789abcdef";
const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

function handle(jobId: string, backend: Handle["backend"] = "sourcify"): Handle {
  return { version: 1, backend, chainId: 11155111, address: ADDRESS, jobId };
}

/** The JSON form of `details`: each handle on one line. */
function expectedJson(details: ErrorDetails): unknown {
  const copy: Record<string, unknown> = { ...details };
  if ("handle" in details && details.handle !== undefined) {
    copy["handle"] = formatHandle(details.handle);
  }
  if (details.code === "cancelled" && details.handles !== undefined) {
    copy["handles"] = details.handles.map(formatHandle);
  }
  return copy;
}

/** An error object as a server handler or another copy sends it: plain data and a name. */
function foreign(json: unknown): unknown {
  return { name: "ExplorerVerifyError", toJSON: () => json };
}

/** toEnvelope() of a value outside the types. */
function envelopeOf(value: unknown, secrets: readonly string[] = []): unknown {
  return Reflect.apply(toEnvelope, undefined, [value, { secrets }]);
}

/** The error toEnvelope() throws for `value`. */
function refusal(value: unknown): ExplorerVerifyError {
  let caught: unknown;
  try {
    envelopeOf(value);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ExplorerVerifyError, "toEnvelope() accepted the value");
  return caught;
}

/** The fields of the issues of an `invalid-input` error. */
function fields(error: ExplorerVerifyError): string[] {
  return error.details.code === "invalid-input"
    ? error.details.issues.map((issue) => issue.field)
    : [];
}

/** The `error.details` of an envelope. */
function detailsOf(envelope: unknown): unknown {
  return Reflect.get(Object(Reflect.get(Object(envelope), "error")), "details");
}

// Details with the dummy key in every string field, for every code.
const LEAKY: { readonly [C in ErrorCode]: ErrorDetails } = {
  ...SAMPLE_DETAILS,
  "invalid-input": {
    code: "invalid-input",
    issues: [{ field: `x${DUMMY_KEY}`, message: `holds ${DUMMY_KEY}` }],
  },
  "not-confirmed": { code: "not-confirmed", handle: handle(DUMMY_KEY) },
  "unexpected-response": {
    code: "unexpected-response",
    backend: "sourcify",
    status: 500,
    excerpt: `{"k":"${DUMMY_KEY}"}`,
    attempts: 4,
  },
  "unknown-state": { code: "unknown-state", handle: handle(DUMMY_KEY), excerpt: DUMMY_KEY },
  "job-not-found": { code: "job-not-found", handle: handle(DUMMY_KEY) },
  cancelled: { code: "cancelled", handles: [handle(DUMMY_KEY), handle("job", "routescan")] },
  "incomplete-input": { code: "incomplete-input", field: "contract", candidates: [DUMMY_KEY] },
  "unsupported-compiler": { code: "unsupported-compiler", field: DUMMY_KEY },
  "verification-inconclusive": {
    code: "verification-inconclusive",
    backend: "sourcify",
    reason: DUMMY_KEY,
  },
  "source-mismatch": {
    code: "source-mismatch",
    path: `src/${DUMMY_KEY}.sol`,
    expected: `0x${"a".repeat(64)}`,
    actual: `0x${"b".repeat(64)}`,
  },
  "metadata-unavailable": { code: "metadata-unavailable", hash: `ipfs:${DUMMY_KEY}`, attempts: [] },
  "proxy-link-unknown-state": {
    code: "proxy-link-unknown-state",
    backend: "etherscan-v2",
    excerpt: DUMMY_KEY,
  },
  "handler-refused": {
    code: "handler-refused",
    backend: "etherscan-v2",
    status: 403,
    handlerCode: "chain-not-allowed",
    excerpt: `{"code":"chain-not-allowed","key":"${DUMMY_KEY}"}`,
  },
};

describe("toJSON() keeps the details (R-AX-5)", () => {
  for (const code of ERROR_CODES) {
    it(`${code}: details in their JSON form, valid against the schema`, () => {
      const error = newError(SAMPLE_DETAILS[code], "m", { secrets: [] });
      const json = error.toJSON();
      assert.deepEqual(json.details, expectedJson(error.details));
      assert.equal(json.details.code, code);
      assert.deepEqual(validateEnvelope(toEnvelope(error)), []);
    });
  }

  it("freezes the details, so no later edit changes what toJSON() prints (D1)", () => {
    const error = newError(
      { code: "invalid-input", issues: [{ field: "chainId", message: "m" }] },
      "m",
      { secrets: [] },
    );
    assert.ok(Object.isFrozen(error.details));
    assert.ok(error.details.code === "invalid-input");
    assert.ok(Object.isFrozen(error.details.issues));
    assert.ok(Object.isFrozen(error.details.issues[0]));
    assert.equal(Reflect.set(error.details, "issues", []), false);
    const json = error.toJSON();
    assert.ok(json.code === "invalid-input");
    assert.deepEqual(json.details.issues, [{ field: "chainId", message: "m" }]);
  });

  it("gives a cancelled run on several backends its handles in details too", () => {
    const error = newError(LEAKY.cancelled, "m", { secrets: [] });
    const json = error.toJSON();
    assert.ok(json.code === "cancelled");
    assert.deepEqual(
      json.details.handles,
      json.handles?.map((each) => each.handle),
    );
  });

  it("narrows details by code in TypeScript, as on the error", () => {
    const json: ErrorJson = newError(
      { code: "incomplete-input", field: "contract", candidates: ["a.sol:A"] },
      "m",
      { secrets: [] },
    ).toJSON();
    const candidates = json.code === "incomplete-input" ? json.details.candidates : [];
    assert.deepEqual(candidates, ["a.sol:A"]);
  });
});

describe("no key in the details of toJSON() and the envelope (R-SEC-1, R-AX-9)", () => {
  for (const code of ERROR_CODES) {
    it(`${code}: no lower-case hex dummy key`, () => {
      const error = newError(LEAKY[code], `m ${DUMMY_KEY}`, { secrets: [DUMMY_KEY] });
      for (const text of [
        JSON.stringify(error.toJSON()),
        JSON.stringify(error),
        JSON.stringify(toEnvelope(error)),
      ]) {
        assert.ok(!text.includes(DUMMY_KEY), `${code}: ${text}`);
      }
    });

    it(`${code}: toEnvelope() redacts plain details with its own secrets`, () => {
      // The error did not know the key; the envelope's secrets remove it from the details.
      const error = newError(LEAKY[code], "m", { secrets: [] });
      const plain: unknown = JSON.parse(JSON.stringify(error));
      const text = JSON.stringify(envelopeOf(foreign(plain), [DUMMY_KEY]));
      assert.ok(!text.includes(DUMMY_KEY), `${code}: ${text}`);
    });
  }
});

describe("toEnvelope() rebuilds the details of an error object it did not build (R-AX-5)", () => {
  for (const code of ERROR_CODES) {
    it(`${code}: gives the same envelope as the error itself`, () => {
      const error = newError(SAMPLE_DETAILS[code], "m", { secrets: [] });
      const plain: unknown = JSON.parse(JSON.stringify(error));
      assert.deepEqual(envelopeOf(foreign(plain)), toEnvelope(error));
    });
  }

  it("drops fields the code does not declare and replaces values of the wrong type", () => {
    const error = newError(SAMPLE_DETAILS["unexpected-response"], "m", { secrets: [] });
    const json = { ...error.toJSON() };
    const details = {
      code: "unexpected-response",
      backend: "nope",
      status: 500,
      excerpt: 42,
      retryAfterMs: "soon",
      attempts: Number.POSITIVE_INFINITY,
      extra: DUMMY_KEY,
    };
    const envelope = envelopeOf(foreign({ ...json, details }));
    assert.deepEqual(detailsOf(envelope), {
      code: "unexpected-response",
      backend: "etherscan-compatible",
      status: 500,
      excerpt: "",
    });
    assert.deepEqual(validateEnvelope(envelope), []);
  });

  it("coerces each code's fields from data of the wrong shape", () => {
    const cases: [ErrorCode, Record<string, unknown>, ErrorDetailsJson | undefined][] = [
      [
        "invalid-input",
        { issues: [{ field: 1 }, "x", { field: "a", message: "b", extra: 1 }] },
        {
          code: "invalid-input",
          issues: [
            { field: "", message: "" },
            { field: "", message: "" },
            { field: "a", message: "b" },
          ],
        },
      ],
      ["invalid-input", { issues: "x" }, { code: "invalid-input", issues: [] }],
      ["unsupported-chain", { chainId: "1", backend: "routescan" }, undefined],
      ["network", { backend: "sourcify", attempts: Number.NaN }, undefined],
      ["timeout", { backend: "sourcify", timeoutMs: Number.POSITIVE_INFINITY }, undefined],
      ["unexpected-response", { backend: "sourcify", status: "502", excerpt: "x" }, undefined],
      [
        "rate-limited",
        { backend: "sourcify", retryAfterMs: "12", attempts: Number.NaN },
        { code: "rate-limited", backend: "sourcify" },
      ],
      [
        "metadata-unavailable",
        { hash: "anything here", attempts: [] },
        { code: "metadata-unavailable", hash: "", attempts: [] },
      ],
      [
        "metadata-unavailable",
        { hash: `bzzr1:${"a".repeat(64)}`, attempts: [] },
        { code: "metadata-unavailable", hash: `bzzr1:${"a".repeat(64)}`, attempts: [] },
      ],
      [
        "network",
        { backend: "blockscout", attempts: 2 },
        { code: "network", backend: "blockscout", attempts: 2 },
      ],
      [
        "rate-limited",
        { backend: "sourcify", retryAfterMs: 5, attempts: 3 },
        { code: "rate-limited", backend: "sourcify", retryAfterMs: 5, attempts: 3 },
      ],
      ["rate-limited", { backend: "sourcify" }, { code: "rate-limited", backend: "sourcify" }],
      [
        "timeout",
        { backend: "sourcify", timeoutMs: 9 },
        { code: "timeout", backend: "sourcify", timeoutMs: 9 },
      ],
      ["in-progress", { backend: 1 }, { code: "in-progress", backend: "etherscan-compatible" }],
      [
        "incomplete-input",
        { field: "nope", candidates: ["a", 1] },
        { code: "incomplete-input", field: "input", candidates: ["a", ""] },
      ],
      [
        "incomplete-input",
        { field: "sources", candidates: {} },
        { code: "incomplete-input", field: "sources", candidates: [] },
      ],
      ["insufficient-artifact", { field: "x" }, { code: "insufficient-artifact", field: "input" }],
      ["unsupported-compiler", { field: 3 }, { code: "unsupported-compiler", field: "" }],
      [
        "verification-inconclusive",
        { backend: "sourcify", reason: "r" },
        { code: "verification-inconclusive", backend: "sourcify", reason: "r" },
      ],
      [
        "source-mismatch",
        { path: "a.sol", expected: "0x1", actual: `0x${"c".repeat(64)}` },
        { code: "source-mismatch", path: "a.sol", expected: "0x", actual: `0x${"c".repeat(64)}` },
      ],
      [
        "missing-api-key",
        { backend: "routescan" },
        { code: "missing-api-key", backend: "routescan" },
      ],
      [
        "api-key-rejected",
        { backend: "etherscan-v2" },
        { code: "api-key-rejected", backend: "etherscan-v2" },
      ],
      [
        "quota-exceeded",
        { backend: "etherscan-v2" },
        { code: "quota-exceeded", backend: "etherscan-v2" },
      ],
      ["internal-error", { extra: 1 }, { code: "internal-error" }],
      [
        "unexpected-response",
        { backend: "sourcify", status: 502, excerpt: "x", retryAfterMs: 5 },
        {
          code: "unexpected-response",
          backend: "sourcify",
          status: 502,
          excerpt: "x",
          retryAfterMs: 5,
        },
      ],
      [
        "unexpected-response",
        { backend: "sourcify", status: 502, excerpt: "x", attempts: 3 },
        {
          code: "unexpected-response",
          backend: "sourcify",
          status: 502,
          excerpt: "x",
          attempts: 3,
        },
      ],
      [
        "unexpected-response",
        { backend: "sourcify", status: 502, excerpt: "x", attempts: "3" },
        { code: "unexpected-response", backend: "sourcify", status: 502, excerpt: "x" },
      ],
      [
        "handler-refused",
        { backend: "etherscan-v2", status: 403, excerpt: "e", handlerCode: "chain-not-allowed" },
        {
          code: "handler-refused",
          backend: "etherscan-v2",
          status: 403,
          excerpt: "e",
          handlerCode: "chain-not-allowed",
        },
      ],
      [
        "handler-refused",
        { backend: "x", status: 403, excerpt: 1, handlerCode: "Not A Code" },
        {
          code: "handler-refused",
          backend: "etherscan-compatible",
          status: 403,
          excerpt: "",
          handlerCode: "",
        },
      ],
      ["handler-refused", { backend: "x", status: "403", excerpt: "", handlerCode: "" }, undefined],
      [
        "not-indexed",
        { backend: "routescan", submits: 4, elapsedMs: 9_000, extra: 1 },
        { code: "not-indexed", backend: "routescan", submits: 4, elapsedMs: 9_000 },
      ],
      ["not-indexed", { backend: "routescan", submits: "4", elapsedMs: 9_000 }, undefined],
      ["not-indexed", { backend: "routescan", submits: 4, elapsedMs: Number.NaN }, undefined],
      ["no-metadata-hash", { found: "no-code" }, { code: "no-metadata-hash", found: "no-code" }],
      [
        "no-metadata-hash",
        { found: "version-only" },
        { code: "no-metadata-hash", found: "version-only" },
      ],
      ["no-metadata-hash", { found: "x" }, { code: "no-metadata-hash", found: "no-metadata" }],
      [
        "metadata-unavailable",
        { hash: "ipfs:x", attempts: [{ source: "rpc", outcome: "timeout", status: 1 }, 2] },
        {
          code: "metadata-unavailable",
          hash: "ipfs:x",
          attempts: [
            { source: "rpc", outcome: "timeout", status: 1 },
            { source: "rpc", outcome: "unavailable" },
          ],
        },
      ],
      [
        "constructor-args-unavailable",
        { reason: "bad-length" },
        { code: "constructor-args-unavailable", reason: "bad-length" },
      ],
      [
        "constructor-args-unavailable",
        { reason: "x" },
        { code: "constructor-args-unavailable", reason: "prefix-mismatch" },
      ],
      [
        "proxy-link-pending",
        { backend: "etherscan-v2" },
        { code: "proxy-link-pending", backend: "etherscan-v2" },
      ],
      [
        "proxy-link-unknown-state",
        { backend: "etherscan-v2", excerpt: "e" },
        { code: "proxy-link-unknown-state", backend: "etherscan-v2", excerpt: "e" },
      ],
    ];
    const top = { handle: undefined, handles: undefined };
    for (const [code, value, expected] of cases) {
      assert.deepEqual(detailsFromJson(code, { ...value, code }, [], top), expected, code);
    }
  });

  it("takes the handles from the checked top-level fields, never from the details", () => {
    const line = formatHandle(handle("job-1"));
    const top = { handle: line, handles: undefined };
    const codes: readonly ("not-confirmed" | "job-not-found")[] = [
      "not-confirmed",
      "job-not-found",
    ];
    for (const code of codes) {
      assert.deepEqual(detailsFromJson(code, { code, handle: "ev1:evil" }, [], top), {
        code,
        handle: line,
      });
      assert.equal(
        detailsFromJson(code, { code, handle: line }, [], {
          handle: undefined,
          handles: undefined,
        }),
        undefined,
      );
    }
    assert.deepEqual(
      detailsFromJson("unknown-state", { code: "unknown-state", excerpt: "e" }, [], top),
      {
        code: "unknown-state",
        handle: line,
        excerpt: "e",
      },
    );
    assert.equal(
      detailsFromJson("unknown-state", { code: "unknown-state" }, [], {
        handle: undefined,
        handles: undefined,
      }),
      undefined,
    );
    assert.deepEqual(
      detailsFromJson("cancelled", { code: "cancelled", handles: ["x"] }, [], {
        handle: undefined,
        handles: [line],
      }),
      { code: "cancelled", handles: [line] },
    );
    assert.deepEqual(detailsFromJson("cancelled", { code: "cancelled" }, [], top), {
      code: "cancelled",
      handle: line,
    });
  });

  it("refuses details that are missing, of another code, or that throw when read", () => {
    const error = newError(SAMPLE_DETAILS.network, "m", { secrets: [] });
    const json = error.toJSON();
    const { details: _left, ...without } = json;
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(DUMMY_KEY);
        },
      },
    );
    const hostileList = {
      code: "invalid-input",
      issues: new Proxy([], {
        get: () => {
          throw new Error(DUMMY_KEY);
        },
      }),
    };
    const other = { code: "timeout", backend: "sourcify", attempts: 1, timeoutMs: 5 };
    for (const details of [undefined, null, "x", [], { code: "timeout" }, other, hostile]) {
      const value = details === undefined ? without : { ...json, details };
      const refused = refusal(foreign(value));
      assert.deepEqual(fields(refused), ["outcome.details"]);
      assert.ok(!JSON.stringify(refused).includes(DUMMY_KEY));
    }
    const invalid = newError(SAMPLE_DETAILS["invalid-input"], "m", { secrets: [] }).toJSON();
    assert.deepEqual(fields(refusal(foreign({ ...invalid, details: hostileList }))), [
      "outcome.details",
    ]);
  });

  it("refuses a not-confirmed error object without its handle", () => {
    const json = newError(SAMPLE_DETAILS["not-confirmed"], "m", { secrets: [] }).toJSON();
    const { handle: _left, ...without } = json;
    const refused = refusal(foreign(without));
    assert.deepEqual(fields(refused), ["outcome.details"]);
    assert.ok(refused.details.code === "invalid-input");
    assert.equal(
      refused.details.issues[0]?.message,
      "must be an object with the error's code and finite numbers, and the error must have a handle when its code needs one",
    );
  });

  it("adds no handle or handles key to an error object without them", () => {
    const error = newError(SAMPLE_DETAILS.network, "m", { secrets: [] });
    const plain: unknown = JSON.parse(JSON.stringify(error));
    const envelope = envelopeOf(foreign(plain));
    const json: unknown = Reflect.get(Object(envelope), "error");
    assert.ok(typeof json === "object" && json !== null);
    assert.deepEqual(Object.keys(json), [
      "code",
      "message",
      "hint",
      "docsUrl",
      "retryable",
      "details",
    ]);
  });

  it("names only the code problem when the code is unknown, and skips the details", () => {
    const json = newError(SAMPLE_DETAILS.network, "m", { secrets: [] }).toJSON();
    assert.deepEqual(fields(refusal(foreign({ ...json, code: "nope" }))), ["outcome.code"]);
  });
});

describe("the envelope schema checks the details (R-AX-5)", () => {
  const base = toEnvelope(newError(SAMPLE_DETAILS["incomplete-input"], "m", { secrets: [] }));
  assert.ok(base.error !== undefined);

  it("refuses an error without details", () => {
    const { details: _left, ...without } = base.error;
    assert.notDeepEqual(validateEnvelope({ ...base, error: without }), []);
  });

  it("refuses details whose code is not the error's", () => {
    const error = { ...base.error, details: { code: "network", backend: "sourcify", attempts: 1 } };
    assert.notDeepEqual(validateEnvelope({ ...base, error }), []);
  });

  it("refuses a known code's details without a field it needs", () => {
    const error = { ...base.error, details: { code: "incomplete-input", field: "contract" } };
    assert.notDeepEqual(validateEnvelope({ ...base, error }), []);
  });

  it("accepts an unknown code's details with only their code, and the CLI's nextCommand", () => {
    const error = { ...base.error, code: "later-code", details: { code: "later-code" } };
    assert.deepEqual(
      validateEnvelope({ ...base, error, nextCommand: ["explorer-verify", "status", "ev1:x"] }),
      [],
    );
    assert.notDeepEqual(validateEnvelope({ ...base, nextCommand: ["explorer-verify"] }), []);
  });
});

/** A foreign error object of `code` with `details`. */
function errorObject(code: string, details: unknown): unknown {
  return {
    code,
    message: "m",
    hint: "h",
    docsUrl: "https://example.org",
    retryable: true,
    details,
  };
}

describe("numbers that are not finite never reach the JSON (D1)", () => {
  it("drops an optional one, refuses a required one, and the schema accepts what is kept", () => {
    for (const retryAfterMs of [Number.NaN, Number.POSITIVE_INFINITY, "12"]) {
      const envelope = envelopeOf(
        foreign(
          errorObject("rate-limited", { code: "rate-limited", backend: "sourcify", retryAfterMs }),
        ),
      );
      assert.deepEqual(detailsOf(envelope), { code: "rate-limited", backend: "sourcify" });
      assert.deepEqual(validateEnvelope(envelope), []);
      assert.ok(!JSON.stringify(envelope).includes("null"));
    }
    for (const attempts of [Number.NaN, Number.NEGATIVE_INFINITY, "3", undefined]) {
      const refused = refusal(
        foreign(errorObject("network", { code: "network", backend: "sourcify", attempts })),
      );
      assert.deepEqual(fields(refused), ["outcome.details"]);
    }
  });

  it("drops a non-finite optional number when the error is built, and toEnvelope refuses a non-finite status", () => {
    for (const retryAfterMs of [Number.NaN, Number.POSITIVE_INFINITY, "12"]) {
      const details: ErrorDetails = { code: "rate-limited", backend: "sourcify" };
      Reflect.set(details, "retryAfterMs", retryAfterMs);
      Reflect.set(details, "attempts", retryAfterMs);
      const error = newError(details, "m", { secrets: [] });
      assert.deepEqual(error.details, { code: "rate-limited", backend: "sourcify" });
      assert.deepEqual(validateEnvelope(toEnvelope(error)), []);
    }
    const bad: ErrorDetails = { ...SAMPLE_DETAILS["unexpected-response"] };
    Reflect.set(bad, "status", Number.NaN);
    const error = newError(bad, "m", { secrets: [] });
    assert.throws(() => toEnvelope(error), ExplorerVerifyError);
  });
});

describe("the rebuild from JSON caps what it keeps (D4, D5, decision 9)", () => {
  const long = "a".repeat(5_000);

  it("keeps 50 items of a list and 1,000 characters of a string of a foreign error", () => {
    const issues = Array.from({ length: 60 }, () => ({ field: long, message: long }));
    const top = { handle: undefined, handles: undefined, foreign: true };
    const copy = detailsFromJson("invalid-input", { code: "invalid-input", issues }, [], top);
    assert.ok(copy !== undefined);
    assert.equal(copy.issues.length, 50);
    assert.equal(copy.issues[0]?.field.length, 1_000);
    const candidates = detailsFromJson(
      "incomplete-input",
      {
        code: "incomplete-input",
        field: "contract",
        candidates: Array.from({ length: 60 }, () => long),
      },
      [],
      top,
    );
    assert.equal(candidates?.candidates.length, 50);
    assert.equal(candidates?.candidates[0]?.length, 1_000);
  });

  it("keeps the full details of this copy's own error, so toJSON() equals the envelope (R-AX-5)", () => {
    const many = Array.from({ length: 300 }, (_, index) => `src/F${String(index)}.sol`);
    const error = newError({ code: "incomplete-input", field: "sources", candidates: many }, long, {
      hint: long,
      secrets: [],
    });
    const envelope = toEnvelope(error);
    assert.ok(envelope.error !== undefined);
    assert.deepEqual(envelope.error, error.toJSON());
    assert.ok(envelope.error.details.code === "incomplete-input");
    assert.equal(envelope.error.details.candidates.length, 300);
    assert.equal(envelope.error.message.length, 5_000);
  });

  it("cuts a foreign message and hint to 2,000 characters, and rebuilds docsUrl from the code", () => {
    const error = newError(SAMPLE_DETAILS.network, "m", { secrets: [] });
    const plain = {
      ...error.toJSON(),
      message: long,
      hint: long,
      docsUrl: "https://evil.example/x",
    };
    const envelope = envelopeOf(foreign(plain));
    const json: unknown = Reflect.get(Object(envelope), "error");
    assert.ok(typeof json === "object" && json !== null);
    assert.equal(String(Reflect.get(json, "message")).length, 2_000);
    assert.equal(String(Reflect.get(json, "hint")).length, 2_000);
    assert.equal(Reflect.get(json, "docsUrl"), error.docsUrl);
  });
});

describe("mutants of the error class (R-SEC-1)", () => {
  it("keeps a source-mismatch hash only when it starts with 0x", () => {
    const details: ErrorDetails = {
      code: "source-mismatch",
      path: "a.sol",
      expected: `0x${"a".repeat(64)}`,
      actual: `0x${"b".repeat(64)}`,
    };
    Reflect.set(details, "expected", `x0x${"a".repeat(64)}`);
    const error = newError(details, "m", { secrets: [] });
    assert.ok(error.details.code === "source-mismatch");
    assert.equal(error.details.expected, "0x");
  });

  it("does not recognise a function that carries the brand", () => {
    const error = newError(SAMPLE_DETAILS.network, "m", { secrets: [] });
    const brand = Object.getOwnPropertySymbols(error)[0];
    assert.ok(brand !== undefined);
    const fake = Object.assign(() => undefined, { code: "network" });
    Object.defineProperty(fake, brand, { value: true });
    assert.equal(ExplorerVerifyError.is(fake), false);
  });
});
