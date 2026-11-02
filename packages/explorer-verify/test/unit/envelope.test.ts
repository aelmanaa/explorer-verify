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
import { objectOf, validate } from "./json-schema.ts";

// A fake key. Never a real one (R-SEC-1). It is 33 characters, so only the `secrets` option or a
// key-like parameter name redacts it, not the bare-key rule.
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const LEAKY_URL = `https://api.example.org/v2/api?chainid=1&apikey=${DUMMY_KEY}&module=contract`;
const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const VERIFIED_URL = `https://repo.sourcify.dev/11155111/${ADDRESS}`;
const PACKAGE = new URL("../../", import.meta.url);

const schema: unknown = JSON.parse(
  readFileSync(new URL("schema/envelope.schema.json", PACKAGE), "utf8"),
);

/**
 * `toEnvelope`, checked on every call: the envelope validates against the shipped schema, its keys
 * follow the schema's order, and it survives a JSON round trip unchanged. Every envelope this file
 * produces goes through here (R-AX-5, R-AX-12).
 */
function envelope(outcome: VerifyOutcome, options?: EnvelopeOptions): Envelope {
  const value = options === undefined ? toEnvelope(outcome) : toEnvelope(outcome, options);
  assert.deepEqual(validate(schema, value), [], "the envelope breaks envelope.schema.json");
  assert.deepEqual(outOfOrderKeys(schema, value), [], "keys are not in the schema's order");
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  return value;
}

/** The `properties` of the subschema that `ref` names, or of the matching `oneOf` branch. */
function propertyOrder(schemaValue: unknown, value: unknown): string[] {
  const root = objectOf(schemaValue);
  const branches = root?.get("oneOf");
  const candidates = Array.isArray(branches) ? branches : [schemaValue];
  const branch = candidates.find((option) => validate(option, value, schemaValue).length === 0);
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
};

function errorFor(code: ErrorCode): ExplorerVerifyError {
  return new ExplorerVerifyError(SAMPLE_DETAILS[code], `Sample ${code} error.`, { secrets: [] });
}

/** Every outcome: one result per status, then one error per code. */
function everyOutcome(): VerifyOutcome[] {
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
    assert.ok(!error.message.includes(DUMMY_KEY));
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
      assert.deepEqual(value, { schemaVersion: 1, ok: false, error: error.toJSON() }, code);
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

  it("orders error keys as code, message, hint, docsUrl, retryable, handle", () => {
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

describe("toEnvelope rejects a value outside its types (decision 0009)", () => {
  // Each case breaks one field with the key as its value; the error names the field and never the
  // value.
  const cases: { name: string; field: string; build: () => unknown }[] = [
    {
      name: "a status outside the union",
      field: "outcome.status",
      build: () => ({ ...VERIFIED, status: DUMMY_KEY }),
    },
    {
      name: "a backend outside BACKEND_NAMES",
      field: "outcome.backend",
      build: () => ({ ...FAILED, backend: DUMMY_KEY }),
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
      const error = thrownBy(() => toEnvelope(outcome));
      assert.equal(error.code, "invalid-input");
      assert.ok(
        error.details.code === "invalid-input" &&
          error.details.issues.some((issue) => issue.field === field),
        JSON.stringify(error.details),
      );
      assert.ok(!JSON.stringify(error).includes(DUMMY_KEY));
      assert.ok(!error.message.includes(DUMMY_KEY));
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
  });
});

/** `value` typed as an outcome without a cast, as code that bypasses the types passes it. */
function bypass(value: unknown): VerifyOutcome {
  const holder: { outcome: VerifyOutcome } = { outcome: VERIFIED };
  Reflect.set(holder, "outcome", value);
  return holder.outcome;
}

describe("envelope.schema.json (R-AX-5, R-AX-16)", () => {
  const defs = objectOf(objectOf(schema)?.get("$defs"));
  function enumOf(...path: string[]): unknown {
    let node: unknown = defs?.get(path[0] ?? "");
    for (const step of path.slice(1)) {
      node = objectOf(node)?.get(step);
    }
    return objectOf(node)?.get("enum") ?? [objectOf(node)?.get("const")];
  }

  it("lists exactly the catalogue's error codes, in catalogue order", () => {
    assert.deepEqual(enumOf("error", "properties", "code"), [...ERROR_CODES]);
  });

  it("lists exactly the backend names", () => {
    assert.deepEqual(enumOf("backend"), [...BACKEND_NAMES]);
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

  it("rejects envelopes that break the contract", () => {
    const broken: Record<string, unknown> = {
      "ok true with a failed result": { schemaVersion: 1, ok: true, result: FAILED },
      "ok false with a verified result": { schemaVersion: 1, ok: false, result: VERIFIED },
      "both result and error": {
        schemaVersion: 1,
        ok: false,
        result: FAILED,
        error: errorFor("network").toJSON(),
      },
      "schemaVersion 2": { schemaVersion: 2, ok: true, result: VERIFIED },
      "an unknown error code": {
        schemaVersion: 1,
        ok: false,
        error: { ...errorFor("network").toJSON(), code: "teapot" },
      },
      "an error without a hint": {
        schemaVersion: 1,
        ok: false,
        error: { code: "network", message: "m", docsUrl: "https://x", retryable: true },
      },
      "a handle not in its one-line form": {
        schemaVersion: 1,
        ok: false,
        error: { ...errorFor("not-confirmed").toJSON(), handle: "job" },
      },
      "a result without ok": { schemaVersion: 1, result: VERIFIED },
      "an array": [],
    };
    for (const [name, value] of Object.entries(broken)) {
      assert.notDeepEqual(validate(schema, value), [], name);
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
