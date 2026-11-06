import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  BACKEND_NAMES,
  ERROR_CODES,
  ERROR_EXIT_CODES,
  ExplorerVerifyError,
  exitCodeOf,
  toEnvelope,
} from "../../src/index.ts";
import type {
  Envelope,
  EnvelopeOptions,
  ErrorCode,
  ErrorDetails,
  ExitCode,
  Handle,
  VerifyOutcome,
  VerifyResult,
} from "../../src/index.ts";
import { compileStrict, envelopeSchema, objectOf, validateEnvelope } from "./envelope-schema.ts";

// A fake key. Never a real one (R-SEC-1). It is 33 characters, so only the `secrets` option or a
// key-like parameter name redacts it, not the bare-key rule.
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const LEAKY_URL = `https://api.example.org/v2/api?chainid=1&apikey=${DUMMY_KEY}&module=contract`;
const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const VERIFIED_URL = `https://repo.sourcify.dev/11155111/${ADDRESS}`;
const PACKAGE = new URL("../../", import.meta.url);

const schema = envelopeSchema;

/**
 * `toEnvelope`, checked on every call: the envelope validates against the shipped schema, its keys
 * follow the schema's order, and it survives a JSON round trip unchanged. Every envelope this file
 * produces goes through here (R-AX-5, R-AX-12).
 */
function envelope(
  outcome: VerifyOutcome | ExplorerVerifyError,
  options?: EnvelopeOptions,
): Envelope {
  const value = options === undefined ? toEnvelope(outcome) : toEnvelope(outcome, options);
  assert.deepEqual(validateEnvelope(value), [], "the envelope breaks envelope.schema.json");
  assert.deepEqual(outOfOrderKeys(schema, value), [], "keys are not in the schema's order");
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  return value;
}

/** The `properties` order of the `oneOf` branch for `value`: success, failure or error. */
function propertyOrder(schemaValue: unknown, value: unknown): string[] {
  const fields = objectOf(value);
  const index = fields?.get("ok") === true ? 0 : fields?.has("error") === true ? 2 : 1;
  const branches = objectOf(schemaValue)?.get("oneOf");
  const branch: unknown = Array.isArray(branches) ? branches[index] : undefined;
  return [...(objectOf(objectOf(branch)?.get("properties"))?.keys() ?? [])];
}

/** Object keys in `value` that appear out of the order the schema lists them in. */
function outOfOrderKeys(schemaValue: unknown, value: unknown): string[] {
  const envelopeKeys = Object.keys(objectOf(value) ?? {});
  const problems = inOrder(envelopeKeys, propertyOrder(schemaValue, value), "$");
  const defs = objectOf(objectOf(schemaValue)?.get("$defs"));
  const fields = objectOf(value);
  for (const [field, def] of [
    ["result", fields?.get("ok") === true ? "success" : "failure"],
    ["error", "error"],
  ] as const) {
    const inner = objectOf(fields?.get(field));
    if (inner !== undefined) {
      const order = [...(objectOf(objectOf(defs?.get(def))?.get("properties"))?.keys() ?? [])];
      problems.push(...inOrder([...inner.keys()], order, `$.${field}`));
    }
  }
  return problems;
}

function inOrder(keys: string[], order: string[], path: string): string[] {
  const positions = keys.map((key) => order.indexOf(key));
  return positions.some((position, index) => position < (positions[index - 1] ?? -1))
    ? [`${path}: ${keys.join(", ")} is not in the order ${order.join(", ")}`]
    : [];
}

function handle(jobId = "550e8400-e29b-41d4-a716-446655440000"): Handle {
  return { version: 1, backend: "sourcify", chainId: 11155111, address: ADDRESS, jobId };
}

const VERIFIED: VerifyResult = {
  status: "verified",
  backend: "sourcify",
  match: "exact",
  explorerUrl: VERIFIED_URL,
};
const ALREADY_VERIFIED: VerifyResult = {
  status: "already-verified",
  backend: "blockscout",
  match: "partial",
};
const FAILED: VerifyResult = {
  status: "failed",
  backend: "etherscan-v2",
  reason: "Fail - Unable to verify. Compiled contract deployment bytecode does NOT match",
};

// One result per status, and the exit code R-AX-7 gives it. A status missing here fails to compile.
const RESULTS: Record<VerifyResult["status"], { result: VerifyResult; exitCode: ExitCode }> = {
  verified: { result: VERIFIED, exitCode: 0 },
  "already-verified": { result: ALREADY_VERIFIED, exitCode: 0 },
  failed: { result: FAILED, exitCode: 1 },
};

// Details for every code. A code missing here fails to compile.
const SAMPLE_DETAILS: Record<ErrorCode, ErrorDetails> = {
  "invalid-input": { code: "invalid-input", issues: [{ field: "chainId", message: "bad" }] },
  "not-confirmed": { code: "not-confirmed", handle: handle() },
  "unsupported-chain": { code: "unsupported-chain", chainId: 999_999, backend: "sourcify" },
  network: { code: "network", backend: "sourcify", attempts: 3 },
  "rate-limited": { code: "rate-limited", backend: "sourcify", retryAfterMs: 1_000 },
  timeout: { code: "timeout", backend: "sourcify", timeoutMs: 120_000 },
  "unexpected-response": {
    code: "unexpected-response",
    backend: "sourcify",
    status: 502,
    excerpt: "<html>Bad gateway</html>",
  },
  "in-progress": { code: "in-progress", backend: "sourcify" },
  "unknown-state": { code: "unknown-state", handle: handle(), excerpt: '{"status":"weird"}' },
  "job-not-found": { code: "job-not-found", handle: handle() },
  cancelled: { code: "cancelled", handle: handle() },
  "incomplete-input": { code: "incomplete-input", field: "compilerVersion", candidates: [] },
  "insufficient-artifact": { code: "insufficient-artifact", field: "input" },
  "unsupported-compiler": { code: "unsupported-compiler", field: "compilerType" },
  "verification-inconclusive": {
    code: "verification-inconclusive",
    backend: "sourcify",
    reason: "internal_error: The server encountered an unexpected error.",
  },
  "source-mismatch": {
    code: "source-mismatch",
    path: "src/Greeter.sol",
    expected: `0x${"a".repeat(64)}`,
    actual: `0x${"b".repeat(64)}`,
  },
  "missing-api-key": { code: "missing-api-key", backend: "etherscan-v2" },
  "api-key-rejected": { code: "api-key-rejected", backend: "etherscan-v2" },
  "quota-exceeded": { code: "quota-exceeded", backend: "etherscan-v2" },
  "internal-error": { code: "internal-error" },
  "no-metadata-hash": { code: "no-metadata-hash", found: "no-metadata" },
  "metadata-unavailable": {
    code: "metadata-unavailable",
    hash: `ipfs:${LEAKY_URL}`,
    attempts: [{ source: "sourcify", outcome: "hash-mismatch", status: 200 }],
  },
  "constructor-args-unavailable": {
    code: "constructor-args-unavailable",
    reason: "bad-length",
  },
  "proxy-link-pending": { code: "proxy-link-pending", backend: "etherscan-v2" },
  "proxy-link-unknown-state": {
    code: "proxy-link-unknown-state",
    backend: "etherscan-v2",
    excerpt: LEAKY_URL,
  },
  "handler-refused": {
    code: "handler-refused",
    backend: "etherscan-v2",
    status: 403,
    handlerCode: "chain-not-allowed",
    excerpt: LEAKY_URL,
  },
};

function errorFor(code: ErrorCode): ExplorerVerifyError {
  return new ExplorerVerifyError(SAMPLE_DETAILS[code], `Sample ${code} error.`, { secrets: [] });
}

/** Every outcome: one result per status, then one error per code. */
function everyOutcome(): (VerifyOutcome | ExplorerVerifyError)[] {
  return [
    ...Object.values(RESULTS).map(({ result }) => result),
    ...ERROR_CODES.map((code) => errorFor(code)),
  ];
}

function byName(left: string, right: string): number {
  return left.localeCompare(right);
}

function thrownBy(run: () => unknown): ExplorerVerifyError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ExplorerVerifyError, "expected an ExplorerVerifyError");
  return caught;
}

describe("exitCodeOf (R-AX-7)", () => {
  it("gives 0 for verified and already-verified and 1 for failed", () => {
    for (const { result, exitCode } of Object.values(RESULTS)) {
      assert.equal(exitCodeOf(result), exitCode, result.status);
    }
  });

  it("gives every catalogue error its ERROR_EXIT_CODES entry", () => {
    for (const code of ERROR_CODES) {
      assert.equal(exitCodeOf(errorFor(code)), ERROR_EXIT_CODES[code], code);
    }
  });

  it("never gives an error 0 or 1: those belong to results", () => {
    for (const code of ERROR_CODES) {
      assert.ok(exitCodeOf(errorFor(code)) > 1, code);
    }
  });

  it("separates unknown-state (6) from network (5) and not-confirmed (4) (R-AX-5, R-FLOW-4)", () => {
    assert.equal(exitCodeOf(errorFor("unknown-state")), 6);
    assert.equal(exitCodeOf(errorFor("network")), 5);
    assert.equal(exitCodeOf(errorFor("not-confirmed")), 4);
    assert.equal(exitCodeOf(errorFor("cancelled")), 130);
  });

  it("rejects a result with a status outside the union with invalid-input", () => {
    const error = thrownBy(() => exitCodeOf(bypass({ ...VERIFIED, status: DUMMY_KEY })));
    assert.equal(error.code, "invalid-input");
    assert.ok(!JSON.stringify(error).includes(DUMMY_KEY));
    assert.ok(!JSON.stringify(error.details).includes(DUMMY_KEY));
    assert.ok(!error.message.includes(DUMMY_KEY));
  });

  it("checks a result as toEnvelope does, not only its status", () => {
    for (const broken of [
      { ...VERIFIED, backend: "nowhere" },
      { ...VERIFIED, match: "none" },
      { ...FAILED, reason: 42 },
    ]) {
      assert.equal(thrownBy(() => exitCodeOf(bypass(broken))).code, "invalid-input");
    }
  });
});

describe("toEnvelope (R-AX-5)", () => {
  it("wraps a verified result with ok: true", () => {
    assert.deepEqual(envelope(VERIFIED), { schemaVersion: 1, ok: true, result: VERIFIED });
  });

  it("wraps an already-verified result without an explorer link with ok: true", () => {
    assert.deepEqual(envelope(ALREADY_VERIFIED), {
      schemaVersion: 1,
      ok: true,
      result: ALREADY_VERIFIED,
    });
  });

  it("wraps a failed result with ok: false, the result and no error", () => {
    const value = envelope(FAILED);
    assert.deepEqual(value, { schemaVersion: 1, ok: false, result: FAILED });
    assert.ok(!("error" in value));
  });

  it("wraps an error as ok: false with its toJSON() and no result", () => {
    for (const code of ERROR_CODES) {
      const error = errorFor(code);
      const value = envelope(error);
      const json = error.toJSON();
      // toEnvelope keeps a metadata hash only in the shape of one; the sample's is a URL.
      const expected =
        json.code === "metadata-unavailable"
          ? { ...json, details: { ...json.details, hash: "" } }
          : json;
      assert.deepEqual(value, { schemaVersion: 1, ok: false, error: expected }, code);
      assert.ok(!("result" in value), code);
    }
  });

  it("carries the handle in its one-line form for not-confirmed", () => {
    const value = envelope(errorFor("not-confirmed"));
    assert.ok("error" in value);
    assert.equal(value.error.handle, `ev1:sourcify:11155111:${ADDRESS}:${handle().jobId}`);
  });

  it("sets ok to true exactly when the exit code is 0, for every status and error code", () => {
    for (const outcome of everyOutcome()) {
      assert.equal(envelope(outcome).ok, exitCodeOf(outcome) === 0);
    }
  });

  it("always sets schemaVersion 1", () => {
    for (const outcome of everyOutcome()) {
      assert.equal(envelope(outcome).schemaVersion, 1);
    }
  });

  it("copies only the declared result fields, and later changes to the input do not reach it", () => {
    const result: VerifyResult = { ...FAILED };
    Reflect.set(result, "url", LEAKY_URL);
    Reflect.set(result, "apiKey", DUMMY_KEY);
    const value = envelope(result);
    assert.deepEqual(value, { schemaVersion: 1, ok: false, result: FAILED });
    Reflect.set(result, "reason", "changed");
    assert.ok("result" in value);
    assert.deepEqual(value.result, FAILED);
  });

  it("drops undeclared fields from a verified result too", () => {
    const result: VerifyResult = { ...VERIFIED };
    Reflect.set(result, "url", LEAKY_URL);
    Reflect.set(result, "apiKey", DUMMY_KEY);
    const value = envelope(result);
    assert.ok("result" in value);
    assert.deepEqual(Object.keys(value.result), ["status", "backend", "match", "explorerUrl"]);
    assert.ok(!JSON.stringify(value).includes(DUMMY_KEY));
  });

  it("leaves out an explorerUrl that is present but undefined", () => {
    const result: VerifyResult = { ...ALREADY_VERIFIED };
    Reflect.set(result, "explorerUrl", undefined);
    const value = envelope(result);
    assert.ok("result" in value);
    assert.deepEqual(Object.keys(value.result), ["status", "backend", "match"]);
  });
});

describe("toEnvelope output is deterministic (R-AX-12)", () => {
  it("gives byte-identical JSON for the same outcome on every call", () => {
    for (const outcome of everyOutcome()) {
      assert.equal(JSON.stringify(envelope(outcome)), JSON.stringify(envelope(outcome)));
    }
  });

  it("orders keys as the schema does, whatever order the result was built in", () => {
    const reordered: VerifyResult = {
      explorerUrl: VERIFIED_URL,
      match: "exact",
      backend: "sourcify",
      status: "verified",
    };
    assert.equal(JSON.stringify(envelope(reordered)), JSON.stringify(envelope(VERIFIED)));
    assert.equal(
      JSON.stringify(envelope(VERIFIED)),
      '{"schemaVersion":1,"ok":true,"result":{"status":"verified","backend":"sourcify","match":"exact",' +
        `"explorerUrl":"${VERIFIED_URL}"}}`,
    );
  });

  it("orders error keys as code, message, hint, docsUrl, retryable, handle, details", () => {
    const value = envelope(errorFor("job-not-found"));
    assert.ok("error" in value);
    assert.deepEqual(Object.keys(value), ["schemaVersion", "ok", "error"]);
    assert.deepEqual(Object.keys(value.error), [
      "code",
      "message",
      "hint",
      "docsUrl",
      "retryable",
      "handle",
      "details",
    ]);
  });
});

describe("toEnvelope never outputs a key (R-AX-9, R-SEC-1)", () => {
  it("redacts a key-like URL parameter in a result's reason and explorerUrl", () => {
    const failed: VerifyResult = { status: "failed", backend: "etherscan-v2", reason: LEAKY_URL };
    const verified: VerifyResult = {
      status: "verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: LEAKY_URL,
    };
    for (const result of [failed, verified]) {
      const json = JSON.stringify(envelope(result));
      assert.ok(!json.includes(DUMMY_KEY), json);
      assert.ok(json.includes("apikey=[redacted]"), json);
    }
  });

  it("redacts the keys passed in secrets from a result, wherever they appear", () => {
    const result: VerifyResult = {
      status: "failed",
      backend: "etherscan-v2",
      reason: `rejected for ${DUMMY_KEY}`,
    };
    const json = JSON.stringify(envelope(result, { secrets: [DUMMY_KEY] }));
    assert.ok(!json.includes(DUMMY_KEY), json);
    assert.ok(json.includes("rejected for [redacted]"), json);
  });

  it("redacts the keys passed in secrets from an error, too", () => {
    const error = new ExplorerVerifyError(
      { code: "network", backend: "sourcify", attempts: 1 },
      `request with ${DUMMY_KEY} failed`,
      { secrets: [], hint: `retry without ${DUMMY_KEY}` },
    );
    const json = JSON.stringify(envelope(error, { secrets: [DUMMY_KEY] }));
    assert.ok(!json.includes(DUMMY_KEY), json);
  });

  it("holds no key for any error code with a key planted in its message, details and cause", () => {
    for (const code of ERROR_CODES) {
      const details = SAMPLE_DETAILS[code];
      const planted: ErrorDetails =
        "handle" in details && details.handle !== undefined
          ? { ...details, handle: handle(DUMMY_KEY) }
          : details;
      const error = new ExplorerVerifyError(planted, `failed at ${LEAKY_URL} with ${DUMMY_KEY}`, {
        secrets: [DUMMY_KEY],
        hint: `do not paste ${DUMMY_KEY}`,
        cause: new Error(LEAKY_URL),
      });
      const json = JSON.stringify(envelope(error));
      assert.ok(!json.includes(DUMMY_KEY), `${code}: ${json}`);
    }
  });

  it("holds no key for any result status with a key in every string field", () => {
    const outcomes: VerifyResult[] = [
      { status: "verified", backend: "sourcify", match: "exact", explorerUrl: DUMMY_KEY },
      {
        status: "already-verified",
        backend: "routescan",
        match: "partial",
        explorerUrl: DUMMY_KEY,
      },
      { status: "failed", backend: "blockscout", reason: DUMMY_KEY },
    ];
    for (const outcome of outcomes) {
      const json = JSON.stringify(envelope(outcome, { secrets: [DUMMY_KEY] }));
      assert.ok(!json.includes(DUMMY_KEY), json);
    }
  });
});

describe("handle job id redaction (R-FLOW-5, R-SEC-1)", () => {
  // A valid job id with the shape of a bare Etherscan key: 34 upper-case letters and digits.
  const KEY_SHAPED_JOB = "JOB0123456789ABCDEFGHIJKLMNOPQRSTU";

  it("keeps a job id with the bare-key shape, so the handle can still be resumed", () => {
    assert.equal(KEY_SHAPED_JOB.length, 34);
    const error = new ExplorerVerifyError(
      { code: "not-confirmed", handle: handle(KEY_SHAPED_JOB) },
      "Still verifying.",
      { secrets: [] },
    );
    assert.ok(error.details.code === "not-confirmed");
    assert.equal(error.details.handle.jobId, KEY_SHAPED_JOB);
    const value = envelope(error);
    assert.ok("error" in value);
    assert.equal(value.error.handle, `ev1:sourcify:11155111:${ADDRESS}:${KEY_SHAPED_JOB}`);
  });

  it("still redacts a key-shaped text outside the job id", () => {
    const error = new ExplorerVerifyError(
      { code: "not-confirmed", handle: handle(KEY_SHAPED_JOB) },
      `Still verifying ${KEY_SHAPED_JOB}.`,
      { secrets: [] },
    );
    const value = envelope(error);
    assert.ok("error" in value);
    assert.equal(value.error.message, "Still verifying [redacted].");
    assert.equal(value.error.handle, `ev1:sourcify:11155111:${ADDRESS}:${KEY_SHAPED_JOB}`);
  });

  it("redacts a job id equal to a known secret, in the error and in the envelope", () => {
    const viaError = new ExplorerVerifyError(
      { code: "job-not-found", handle: handle(KEY_SHAPED_JOB) },
      "Gone.",
      { secrets: [KEY_SHAPED_JOB] },
    );
    assert.ok(viaError.details.code === "job-not-found");
    assert.equal(viaError.details.handle.jobId, "[redacted]");
    const value = envelope(viaError);
    assert.ok("error" in value);
    assert.equal(value.error.handle, `ev1:sourcify:11155111:${ADDRESS}:[redacted]`);
  });

  it("redacts a key-like parameter inside a job id", () => {
    const error = new ExplorerVerifyError(
      { code: "job-not-found", handle: handle(`job?apikey=${DUMMY_KEY}`) },
      "Gone.",
      { secrets: [] },
    );
    const value = envelope(error);
    assert.ok("error" in value);
    assert.equal(value.error.handle, `ev1:sourcify:11155111:${ADDRESS}:job?apikey=[redacted]`);
  });

  it("re-redacts only the job id of the handle with toEnvelope's secrets", () => {
    const error = new ExplorerVerifyError(
      { code: "not-confirmed", handle: handle(DUMMY_KEY) },
      "Still verifying.",
      { secrets: [] },
    );
    // Precondition: the error alone keeps the 33-character value, which no rule matches.
    assert.equal(error.toJSON().handle, `ev1:sourcify:11155111:${ADDRESS}:${DUMMY_KEY}`);
    const value = envelope(error, { secrets: [DUMMY_KEY] });
    assert.ok("error" in value);
    assert.equal(value.error.handle, `ev1:sourcify:11155111:${ADDRESS}:[redacted]`);
  });

  it("does not redact the handle's prefix, backend, chain or address with toEnvelope's secrets", () => {
    const error = errorFor("not-confirmed");
    const value = envelope(error, { secrets: ["sourcify:11155111", ADDRESS] });
    assert.ok("error" in value);
    assert.equal(value.error.handle, `ev1:sourcify:11155111:${ADDRESS}:${handle().jobId}`);
  });
});

/** Options typed as {@link EnvelopeOptions} without a cast, as code that bypasses the types passes. */
function looseOptions(value: unknown): EnvelopeOptions {
  const holder: { options: EnvelopeOptions } = { options: {} };
  Reflect.set(holder, "options", value);
  return holder.options;
}

describe("toEnvelope reads its options safely", () => {
  const cases: { name: string; field: string; options: unknown }[] = [
    { name: "options that are a string", field: "options", options: DUMMY_KEY },
    { name: "options that are null", field: "options", options: null },
    { name: "options that are an array", field: "options", options: [DUMMY_KEY] },
    {
      name: "secrets that are a string",
      field: "options.secrets",
      options: { secrets: DUMMY_KEY },
    },
    { name: "a secret that is a number", field: "options.secrets", options: { secrets: [42] } },
    {
      name: "secrets whose entries cannot be read",
      field: "options.secrets",
      options: {
        secrets: new Proxy([DUMMY_KEY], {
          get: () => {
            throw new Error(DUMMY_KEY);
          },
        }),
      },
    },
  ];
  for (const { name, field, options } of cases) {
    it(`throws invalid-input, never a TypeError, for ${name}`, () => {
      const error = thrownBy(() => toEnvelope(VERIFIED, looseOptions(options)));
      assert.equal(error.code, "invalid-input");
      assert.ok(error.details.code === "invalid-input");
      assert.deepEqual(
        error.details.issues.map((issue) => issue.field),
        [field],
      );
      assert.ok(!JSON.stringify(error.details).includes(DUMMY_KEY));
    });
  }

  it("accepts undefined options and options without secrets", () => {
    assert.deepEqual(toEnvelope(VERIFIED, looseOptions(undefined)), envelope(VERIFIED));
    assert.deepEqual(toEnvelope(VERIFIED, {}), envelope(VERIFIED));
  });
});

/**
 * An error from a second copy of the package: same name and `toJSON()`, another class, so
 * `instanceof` fails.
 */
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

describe("toEnvelope and exitCodeOf accept an error from another copy of the package", () => {
  const json = errorFor("not-confirmed").toJSON();

  it("uses the toJSON() of an error named ExplorerVerifyError that instanceof misses", () => {
    const other = bypass(new OtherCopyError({ ...json }));
    assert.ok(!(other instanceof ExplorerVerifyError));
    assert.deepEqual(envelope(other), { schemaVersion: 1, ok: false, error: json });
    assert.equal(exitCodeOf(other), 4);
  });

  it("rejects a key planted in any field of the other copy's handle before the job id", () => {
    const planted = [
      `ev1:${DUMMY_KEY}:11155111:${ADDRESS}:job`,
      `ev1:sourcify:${DUMMY_KEY}:${ADDRESS}:job`,
      `ev1:sourcify:11155111:0x${DUMMY_KEY}:job`,
      `ev1:sourcify:11155111:${ADDRESS}:job:${DUMMY_KEY}`,
      `ev1:sourcify:11155111:${ADDRESS}:job?apikey=${DUMMY_KEY}`,
      `ev1:sourcify:0:${ADDRESS}:job`,
      `ev1:sourcify:011155111:${ADDRESS}:job`,
      `ev1:sourcify:9007199254740993:${ADDRESS}:job`,
      `ev1:sourcify:11155111:${ADDRESS}:`,
    ];
    for (const value of planted) {
      const other = bypass(new OtherCopyError({ ...json, handle: value }));
      for (const run of [
        () => toEnvelope(other, { secrets: [DUMMY_KEY] }),
        () => exitCodeOf(other),
      ]) {
        const error = thrownBy(run);
        assert.ok(error.details.code === "invalid-input", value);
        assert.deepEqual(
          error.details.issues.map((issue) => issue.field),
          ["outcome.handle"],
          value,
        );
        assert.ok(!JSON.stringify(error.details).includes(DUMMY_KEY));
      }
    }
  });

  it("accepts a valid handle from the other copy and redacts its job id when it is a secret", () => {
    const secretJob = "JOBSECRET0123456789";
    const valid = `ev1:sourcify:11155111:${ADDRESS}:${secretJob}`;
    const other = bypass(new OtherCopyError({ ...json, handle: valid }));
    const plain = envelope(other);
    assert.ok("error" in plain);
    assert.equal(plain.error.handle, valid);
    const redacted = envelope(other, { secrets: [secretJob] });
    assert.ok("error" in redacted);
    assert.equal(redacted.error.handle, `ev1:sourcify:11155111:${ADDRESS}:[redacted]`);
  });

  it("accepts a job id the other copy already redacted", () => {
    const value = `ev1:sourcify:11155111:${ADDRESS}:[redacted]`;
    const result = envelope(bypass(new OtherCopyError({ ...json, handle: value })));
    assert.ok("error" in result);
    assert.equal(result.error.handle, value);
  });

  it("redacts the strings of the other copy's error and drops its extra fields", () => {
    const other = bypass(
      new OtherCopyError({ ...json, message: `failed at ${LEAKY_URL}`, extra: DUMMY_KEY }),
    );
    const value = envelope(other, { secrets: [DUMMY_KEY] });
    assert.ok("error" in value);
    assert.ok(!JSON.stringify(value).includes(DUMMY_KEY));
    assert.deepEqual(Object.keys(value.error), Object.keys(json));
  });

  const broken: { name: string; field: string; json: () => unknown }[] = [
    { name: "an unknown code", field: "outcome.code", json: () => ({ ...json, code: DUMMY_KEY }) },
    {
      name: "a message that is not a string",
      field: "outcome.message",
      json: () => ({ ...json, message: 1 }),
    },
    { name: "an empty hint", field: "outcome.hint", json: () => ({ ...json, hint: "" }) },
    {
      name: "a docsUrl that is not https",
      field: "outcome.docsUrl",
      json: () => ({ ...json, docsUrl: "http://x" }),
    },
    {
      name: "a retryable that is not a boolean",
      field: "outcome.retryable",
      json: () => ({ ...json, retryable: "yes" }),
    },
    {
      name: "a handle not in its one-line form",
      field: "outcome.handle",
      json: () => ({ ...json, handle: DUMMY_KEY }),
    },
    {
      name: "a handle with too few fields",
      field: "outcome.handle",
      json: () => ({ ...json, handle: `ev1:sourcify:1:${DUMMY_KEY}` }),
    },
    {
      name: "a handle that is not a string",
      field: "outcome.handle",
      json: () => ({ ...json, handle: 42 }),
    },
    { name: "a toJSON() that returns a string", field: "outcome", json: () => DUMMY_KEY },
  ];
  for (const { name, field, json: build } of broken) {
    it(`throws invalid-input for ${name}`, () => {
      const other = bypass(new OtherCopyError(build()));
      for (const run of [() => toEnvelope(other), () => exitCodeOf(other)]) {
        const error = thrownBy(run);
        assert.equal(error.code, "invalid-input");
        assert.ok(error.details.code === "invalid-input");
        assert.ok(
          error.details.issues.some((issue) => issue.field === field),
          JSON.stringify(error.details),
        );
        assert.ok(!JSON.stringify(error.details).includes(DUMMY_KEY));
      }
    });
  }

  it("throws invalid-input when toJSON() throws", () => {
    class Throwing extends OtherCopyError {
      override toJSON(): unknown {
        throw new Error(DUMMY_KEY);
      }
    }
    const error = thrownBy(() => toEnvelope(bypass(new Throwing(json))));
    assert.equal(error.code, "invalid-input");
    assert.ok(!JSON.stringify(error.details).includes(DUMMY_KEY));
  });

  it("treats an object whose name cannot be read as a result, and rejects it", () => {
    const hostile = {};
    Object.defineProperty(hostile, "name", {
      get: () => {
        throw new Error(DUMMY_KEY);
      },
    });
    const error = thrownBy(() => exitCodeOf(bypass(hostile)));
    assert.ok(error.details.code === "invalid-input");
    assert.ok(error.details.issues.some((issue) => issue.field === "outcome.status"));
    assert.ok(!JSON.stringify(error.details).includes(DUMMY_KEY));
  });

  it("treats an object named ExplorerVerifyError without toJSON() as a result, and rejects it", () => {
    const named = { name: "ExplorerVerifyError", code: "network" };
    const error = thrownBy(() => toEnvelope(bypass(named)));
    assert.ok(error.details.code === "invalid-input");
    assert.ok(error.details.issues.some((issue) => issue.field === "outcome.status"));
  });
});

describe("toEnvelope and exitCodeOf reject a value outside their types (decision 0009)", () => {
  // Each case breaks one field with the key as its value; the error names the field and never the
  // value, in its message or its details.
  const cases: { name: string; field: string; build: () => unknown }[] = [
    {
      name: "a status outside the union",
      field: "outcome.status",
      build: () => ({ ...VERIFIED, status: DUMMY_KEY }),
    },
    {
      name: "a failed result's backend outside BACKEND_NAMES",
      field: "outcome.backend",
      build: () => ({ ...FAILED, backend: DUMMY_KEY }),
    },
    {
      name: "a verified result's backend outside BACKEND_NAMES",
      field: "outcome.backend",
      build: () => ({ ...VERIFIED, backend: DUMMY_KEY }),
    },
    {
      name: "a match other than exact or partial",
      field: "outcome.match",
      build: () => ({ ...VERIFIED, match: DUMMY_KEY }),
    },
    {
      name: "a reason that is not a string",
      field: "outcome.reason",
      build: () => ({ ...FAILED, reason: { toString: () => DUMMY_KEY } }),
    },
    {
      name: "an explorerUrl that is not a string",
      field: "outcome.explorerUrl",
      build: () => ({ ...VERIFIED, explorerUrl: 42 }),
    },
    { name: "null", field: "outcome", build: () => null },
    { name: "a string", field: "outcome", build: () => DUMMY_KEY },
    { name: "a plain Error", field: "outcome.status", build: () => new Error(DUMMY_KEY) },
  ];

  for (const { name, field, build } of cases) {
    it(`throws invalid-input for ${name}`, () => {
      const outcome = bypass(build());
      for (const run of [() => toEnvelope(outcome), () => exitCodeOf(outcome)]) {
        const error = thrownBy(run);
        assert.equal(error.code, "invalid-input");
        assert.ok(
          error.details.code === "invalid-input" &&
            error.details.issues.some((issue) => issue.field === field),
          JSON.stringify(error.details),
        );
        assert.ok(!JSON.stringify(error).includes(DUMMY_KEY));
        assert.ok(!JSON.stringify(error.details).includes(DUMMY_KEY));
        assert.ok(!error.message.includes(DUMMY_KEY));
      }
    });
  }

  it("throws invalid-input when reading the result throws, as a hostile getter does", () => {
    const outcome: VerifyResult = { ...FAILED };
    Object.defineProperty(outcome, "reason", {
      enumerable: true,
      get: () => {
        throw new Error(DUMMY_KEY);
      },
    });
    const error = thrownBy(() => toEnvelope(outcome));
    assert.equal(error.code, "invalid-input");
    assert.ok(!JSON.stringify(error).includes(DUMMY_KEY));
    assert.ok(!JSON.stringify(error.details).includes(DUMMY_KEY));
  });
});

/** `value` typed as an outcome without a cast, as code that bypasses the types passes it. */
function bypass(value: unknown): VerifyOutcome {
  const holder: { outcome: VerifyOutcome } = { outcome: VERIFIED };
  Reflect.set(holder, "outcome", value);
  return holder.outcome;
}

// The pattern every error code and backend name follows; the schema accepts any value of this form
// so that a newer release can add one (R-AX-5).
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("envelope.schema.json (R-AX-5, R-AX-16)", () => {
  const defs = objectOf(objectOf(schema)?.get("$defs"));
  function nodeAt(...path: string[]): Map<string, unknown> | undefined {
    let node: unknown = defs?.get(path[0] ?? "");
    for (const step of path.slice(1)) {
      node = objectOf(node)?.get(step);
    }
    return objectOf(node);
  }
  function enumOf(...path: string[]): unknown {
    const node = nodeAt(...path);
    return node?.get("enum") ?? [node?.get("const")];
  }
  /** The values listed after "Known values in this release: " in a description. */
  function knownValues(...path: string[]): string[] {
    const description = String(nodeAt(...path)?.get("description"));
    const match = /Known values in this release: ([^.]+)\./.exec(description);
    return (match?.[1] ?? "").split(", ");
  }

  it("compiles in ajv's strict mode for JSON Schema 2020-12", () => {
    assert.doesNotThrow(() => compileStrict(schema));
    assert.equal(objectOf(schema)?.get("$schema"), "https://json-schema.org/draft/2020-12/schema");
  });

  it("accepts any error code and backend of the code form, so a release can add one", () => {
    assert.equal(nodeAt("error", "properties", "code")?.get("pattern"), SLUG.source);
    assert.equal(nodeAt("backend")?.get("pattern"), SLUG.source);
    for (const name of [...ERROR_CODES, ...BACKEND_NAMES]) {
      assert.match(name, SLUG);
    }
  });

  it("lists exactly the catalogue's error codes as the known values, in catalogue order", () => {
    assert.deepEqual(knownValues("error", "properties", "code"), [...ERROR_CODES]);
  });

  it("lists exactly the backend names as the known values", () => {
    assert.deepEqual(knownValues("backend"), [...BACKEND_NAMES]);
  });

  it("pins the match values to exact and partial", () => {
    assert.deepEqual(enumOf("success", "properties", "match"), ["exact", "partial"]);
  });

  it("lists every result status in exactly one branch, as success or failure", () => {
    const success = enumOf("success", "properties", "status");
    const failure = enumOf("failure", "properties", "status");
    assert.deepEqual(
      [success, failure].flat().map(String).toSorted(byName),
      Object.keys(RESULTS).toSorted(byName),
    );
    for (const [status, { exitCode }] of Object.entries(RESULTS)) {
      const list = exitCode === 0 ? success : failure;
      assert.ok(Array.isArray(list) && list.includes(status), status);
    }
  });

  it("accepts what a later release may add: a new error code, a new backend, a new field", () => {
    const accepted: Record<string, unknown> = {
      "a new error code": {
        schemaVersion: 1,
        ok: false,
        error: { ...errorFor("network").toJSON(), code: "key-rejected" },
      },
      "a new backend": {
        schemaVersion: 1,
        ok: true,
        result: { ...VERIFIED, backend: "new-explorer-2" },
      },
      "a new field": { schemaVersion: 1, ok: true, result: VERIFIED, durationMs: 1 },
      "a new result field": {
        schemaVersion: 1,
        ok: false,
        result: { ...FAILED, details: "more" },
      },
    };
    for (const [name, value] of Object.entries(accepted)) {
      assert.deepEqual(validateEnvelope(value), [], name);
    }
  });

  it("rejects envelopes that break the contract", () => {
    const networkError = errorFor("network").toJSON();
    const broken: Record<string, unknown> = {
      "ok true with a failed result": { schemaVersion: 1, ok: true, result: FAILED },
      "ok false with a verified result": { schemaVersion: 1, ok: false, result: VERIFIED },
      "both result and error": {
        schemaVersion: 1,
        ok: false,
        result: FAILED,
        error: networkError,
      },
      "both a success result and error": {
        schemaVersion: 1,
        ok: true,
        result: VERIFIED,
        error: networkError,
      },
      "schemaVersion 2": { schemaVersion: 2, ok: true, result: VERIFIED },
      "an error without schemaVersion": { ok: false, error: networkError },
      "an error code that is not of the code form": {
        schemaVersion: 1,
        ok: false,
        error: { ...networkError, code: "Teapot!" },
      },
      "an empty error code": { schemaVersion: 1, ok: false, error: { ...networkError, code: "" } },
      "a backend that is not of the code form": {
        schemaVersion: 1,
        ok: true,
        result: { ...VERIFIED, backend: "Sourcify Server" },
      },
      "an error without a hint": {
        schemaVersion: 1,
        ok: false,
        error: { code: "network", message: "m", docsUrl: "https://x", retryable: true },
      },
      "an empty hint": { schemaVersion: 1, ok: false, error: { ...networkError, hint: "" } },
      "an error without retryable": {
        schemaVersion: 1,
        ok: false,
        error: { code: "network", message: "m", hint: "h", docsUrl: "https://x" },
      },
      "a retryable that is a string": {
        schemaVersion: 1,
        ok: false,
        error: { ...networkError, retryable: "yes" },
      },
      "a message that is not a string": {
        schemaVersion: 1,
        ok: false,
        error: { ...networkError, message: 1 },
      },
      "a docsUrl that is not a string": {
        schemaVersion: 1,
        ok: false,
        error: { ...networkError, docsUrl: 1 },
      },
      "a docsUrl over http": {
        schemaVersion: 1,
        ok: false,
        error: { ...networkError, docsUrl: "http://example.org" },
      },
      "a handle not in its one-line form": {
        schemaVersion: 1,
        ok: false,
        error: { ...errorFor("not-confirmed").toJSON(), handle: "job" },
      },
      "a handle of another version": {
        schemaVersion: 1,
        ok: false,
        error: { ...errorFor("not-confirmed").toJSON(), handle: `ev2:sourcify:1:${ADDRESS}:job` },
      },
      "a verified result without match": {
        schemaVersion: 1,
        ok: true,
        result: { status: "verified", backend: "sourcify" },
      },
      "a match outside exact and partial": {
        schemaVersion: 1,
        ok: true,
        result: { ...VERIFIED, match: "none" },
      },
      "a failed result without reason": {
        schemaVersion: 1,
        ok: false,
        result: { status: "failed", backend: "sourcify" },
      },
      "a failed result with another status": {
        schemaVersion: 1,
        ok: false,
        result: { ...FAILED, status: "rejected" },
      },
      "a result that is a string": { schemaVersion: 1, ok: true, result: "verified" },
      "a result without ok": { schemaVersion: 1, result: VERIFIED },
      "an array": [],
    };
    for (const [name, value] of Object.entries(broken)) {
      assert.notDeepEqual(validateEnvelope(value), [], name);
    }
  });

  it("ships in the package as explorer-verify/envelope.schema.json", () => {
    const manifest: unknown = JSON.parse(readFileSync(new URL("package.json", PACKAGE), "utf8"));
    const fields = objectOf(manifest);
    const exportsMap = objectOf(fields?.get("exports"));
    assert.equal(exportsMap?.get("./envelope.schema.json"), "./schema/envelope.schema.json");
    const files = fields?.get("files");
    assert.ok(Array.isArray(files) && files.includes("schema/"));
  });
});

describe("the strict ajv set-up the tests rely on", () => {
  // Each check proves the validator reports a broken value for one keyword, so a passing envelope
  // test is not vacuous.
  const cases: { keyword: string; schema: object; good: unknown; bad: unknown }[] = [
    { keyword: "type", schema: { type: "string" }, good: "a", bad: 1 },
    { keyword: "const", schema: { const: 1 }, good: 1, bad: 2 },
    { keyword: "enum", schema: { enum: ["a", "b"] }, good: "b", bad: "c" },
    { keyword: "pattern", schema: { type: "string", pattern: "^ev1:" }, good: "ev1:x", bad: "ev2" },
    { keyword: "minLength", schema: { type: "string", minLength: 1 }, good: "a", bad: "" },
    {
      keyword: "required",
      schema: { type: "object", properties: { a: {} }, required: ["a"] },
      good: { a: 1 },
      bad: {},
    },
    {
      keyword: "not",
      schema: { type: "object", not: { properties: { a: {} }, required: ["a"] } },
      good: {},
      bad: { a: 1 },
    },
    {
      keyword: "oneOf (exactly one branch)",
      schema: { oneOf: [{ type: "integer" }, { type: "number" }] },
      good: 1.5,
      bad: 1,
    },
    {
      keyword: "$ref",
      schema: { $ref: "#/$defs/s", $defs: { s: { type: "string" } } },
      good: "a",
      bad: 1,
    },
  ];
  for (const { keyword, schema: small, good, bad } of cases) {
    it(`reports a value that breaks ${keyword}`, () => {
      const check = compileStrict(small);
      assert.deepEqual(check(good), []);
      assert.notDeepEqual(check(bad), []);
    });
  }

  it("refuses a schema with an unknown keyword", () => {
    assert.throws(() => compileStrict({ type: "string", minLenght: 1 }), /unknown keyword/);
  });

  it("refuses a required name that properties does not declare", () => {
    assert.throws(
      () => compileStrict({ type: "object", required: ["error"] }),
      /strictRequired|required/,
    );
  });
});

describe("JSON output reference page (R-AX-5, R-AX-7)", () => {
  const page = readFileSync(
    new URL("../../../../docs/user/reference/json-output.md", import.meta.url),
    "utf8",
  );
  // Rows of the outcome table: | `name` | ok | exit code |
  const rows = new Map(
    [
      ...page.matchAll(/^\| `([a-z-]+)` +\| (?:Result|Error) +\| `(true|false)` +\| (\d+) +\|/gm),
    ].map((match) => [match[1] ?? "", { ok: match[2] === "true", exitCode: Number(match[3]) }]),
  );

  it("lists every result status with its ok value and exit code", () => {
    for (const [status, { exitCode }] of Object.entries(RESULTS)) {
      assert.deepEqual(rows.get(status), { ok: exitCode === 0, exitCode }, status);
    }
  });

  it("lists every error code with ok false and its exit code", () => {
    for (const code of ERROR_CODES) {
      assert.deepEqual(rows.get(code), { ok: false, exitCode: ERROR_EXIT_CODES[code] }, code);
    }
  });

  it("lists nothing that is not a status or an error code", () => {
    assert.equal(rows.size, Object.keys(RESULTS).length + ERROR_CODES.length);
  });
});
