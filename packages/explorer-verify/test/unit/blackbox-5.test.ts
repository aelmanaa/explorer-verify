// Black-box tests for the machine contract (issue #5): exitCodeOf, toEnvelope and the shipped
// envelope schema, written from the docs and the public API only. The schema checks use the
// shared strict ajv set-up in envelope-schema.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ERROR_CODES,
  ERROR_EXIT_CODES,
  ExplorerVerifyError,
  exitCodeOf,
  toEnvelope,
} from "../../src/index.ts";
import type {
  Envelope,
  ErrorCode,
  ErrorDetails,
  ExitCode,
  Handle,
  VerifyResult,
} from "../../src/index.ts";
import { docsUrlOf } from "../helpers/docs-url.ts";
import { validateEnvelope } from "./envelope-schema.ts";

// Fake keys. Never real ones (R-SEC-1).
const BARE_KEY = "QWERTYUIOP1234567890ASDFGHJKLZXCVB"; // 34 chars, Etherscan-style
const OPAQUE_KEY = "bbtest-opaque-secret-value-xyz"; // matches no deny-list rule

// The documented table in docs/user/reference/json-output.md and errors/index.md (R-AX-7).
const ERROR_TABLE: Record<ErrorCode, { exit: ExitCode; retryable: boolean }> = {
  "invalid-input": { exit: 2, retryable: false },
  "not-confirmed": { exit: 4, retryable: true },
  "unsupported-chain": { exit: 2, retryable: false },
  network: { exit: 5, retryable: true },
  "rate-limited": { exit: 5, retryable: true },
  timeout: { exit: 5, retryable: true },
  "unexpected-response": { exit: 5, retryable: true },
  "in-progress": { exit: 5, retryable: true },
  "unknown-state": { exit: 6, retryable: false },
  "job-not-found": { exit: 6, retryable: false },
  cancelled: { exit: 130, retryable: false },
  "incomplete-input": { exit: 2, retryable: false },
  "insufficient-artifact": { exit: 2, retryable: false },
  "unsupported-compiler": { exit: 2, retryable: false },
  "verification-inconclusive": { exit: 4, retryable: true },
  "source-mismatch": { exit: 2, retryable: false },
  "missing-api-key": { exit: 3, retryable: false },
  "api-key-rejected": { exit: 3, retryable: false },
  "quota-exceeded": { exit: 3, retryable: false },
  "internal-error": { exit: 6, retryable: false },
  "no-metadata-hash": { exit: 2, retryable: false },
  "metadata-unavailable": { exit: 5, retryable: true },
  "constructor-args-unavailable": { exit: 2, retryable: false },
  "proxy-link-pending": { exit: 4, retryable: true },
  "proxy-link-unknown-state": { exit: 6, retryable: false },
  "handler-refused": { exit: 2, retryable: false },
};

const HANDLE: Handle = {
  version: 1,
  backend: "sourcify",
  chainId: 11155111,
  address: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  jobId: "550e8400-e29b-41d4-a716-446655440000",
};
const HANDLE_STRING =
  "ev1:sourcify:11155111:0x5fbdb2315678afecb367f032d93f642f64180aa3:550e8400-e29b-41d4-a716-446655440000";

type DetailsOf<C extends ErrorCode> = Extract<ErrorDetails, { code: C }>;

const DETAILS: { [C in ErrorCode]: (text: string) => DetailsOf<C> } = {
  "invalid-input": (text) => ({
    code: "invalid-input",
    issues: [{ field: "chainId", message: text }],
  }),
  "not-confirmed": () => ({ code: "not-confirmed", handle: HANDLE }),
  "unsupported-chain": () => ({ code: "unsupported-chain", chainId: 1, backend: "sourcify" }),
  network: () => ({ code: "network", backend: "etherscan-v2", attempts: 3 }),
  "rate-limited": () => ({ code: "rate-limited", backend: "etherscan-v2", retryAfterMs: 1000 }),
  timeout: () => ({ code: "timeout", backend: "blockscout", timeoutMs: 120000 }),
  "unexpected-response": (text) => ({
    code: "unexpected-response",
    backend: "routescan",
    status: 502,
    excerpt: text,
  }),
  "in-progress": () => ({ code: "in-progress", backend: "etherscan-v2" }),
  "unknown-state": (text) => ({ code: "unknown-state", handle: HANDLE, excerpt: text }),
  "job-not-found": () => ({ code: "job-not-found", handle: HANDLE }),
  cancelled: () => ({ code: "cancelled", handle: HANDLE }),
  "incomplete-input": (text) => ({
    code: "incomplete-input",
    field: "contract",
    candidates: [text],
  }),
  "insufficient-artifact": () => ({ code: "insufficient-artifact", field: "input" }),
  "unsupported-compiler": () => ({ code: "unsupported-compiler", field: "compilerType" }),
  "verification-inconclusive": (text) => ({
    code: "verification-inconclusive",
    backend: "sourcify",
    reason: `internal_error: ${text}`,
  }),
  "source-mismatch": (text) => ({
    code: "source-mismatch",
    path: `src/A.sol ${text}`,
    expected: `0x${"a".repeat(64)}`,
    actual: `0x${"b".repeat(64)}`,
  }),
  "missing-api-key": () => ({ code: "missing-api-key", backend: "etherscan-v2" }),
  "api-key-rejected": () => ({ code: "api-key-rejected", backend: "etherscan-v2" }),
  "quota-exceeded": () => ({ code: "quota-exceeded", backend: "etherscan-v2" }),
  "internal-error": () => ({ code: "internal-error" }),
  "no-metadata-hash": () => ({ code: "no-metadata-hash", found: "no-code" }),
  "metadata-unavailable": () => ({
    code: "metadata-unavailable",
    // A real CID: toEnvelope keeps a hash only in the shape of one.
    hash: "ipfs:QmQXfzJLPTjPUD1LWY6XQHqnWgqgDYEravjDpAMCtW4Uvb",
    attempts: [{ source: "rpc", outcome: "unavailable" }],
  }),
  "constructor-args-unavailable": () => ({
    code: "constructor-args-unavailable",
    reason: "bad-length",
  }),
  "proxy-link-pending": () => ({ code: "proxy-link-pending", backend: "sourcify" }),
  "proxy-link-unknown-state": (text) => ({
    code: "proxy-link-unknown-state",
    backend: "sourcify",
    excerpt: text,
  }),
  "handler-refused": (text) => ({
    code: "handler-refused",
    backend: "etherscan-v2",
    status: 403,
    handlerCode: text,
    excerpt: text,
  }),
};

function detailsFor(code: ErrorCode, text: string): ErrorDetails {
  return DETAILS[code](text);
}

function errorFor(code: ErrorCode): ExplorerVerifyError {
  return new ExplorerVerifyError(detailsFor(code, "plain text"), `A ${code} error.`, {
    secrets: [],
  });
}

const RESULTS: readonly VerifyResult[] = [
  { status: "verified", backend: "sourcify", match: "exact", explorerUrl: "https://x.example/a" },
  { status: "verified", backend: "blockscout", match: "partial" },
  { status: "already-verified", backend: "etherscan-v2", match: "exact" },
  {
    status: "already-verified",
    backend: "routescan",
    match: "partial",
    explorerUrl: "https://y.example",
  },
  { status: "failed", backend: "etherscan-compatible", reason: "Bytecode does not match" },
];

const RESULT_EXIT: Record<VerifyResult["status"], ExitCode> = {
  verified: 0,
  "already-verified": 0,
  failed: 1,
};

function assertValid(envelope: Envelope): void {
  assert.deepEqual(validateEnvelope(JSON.parse(JSON.stringify(envelope))), []);
}

describe("black box #5: catalogue matches the documented table", () => {
  it("ERROR_CODES holds exactly the documented codes", () => {
    assert.deepEqual([...ERROR_CODES].toSorted(), Object.keys(ERROR_TABLE).toSorted());
  });

  it("ERROR_EXIT_CODES matches the table", () => {
    for (const code of ERROR_CODES)
      assert.equal(ERROR_EXIT_CODES[code], ERROR_TABLE[code].exit, code);
    assert.deepEqual(Object.keys(ERROR_EXIT_CODES).toSorted(), [...ERROR_CODES].toSorted());
  });

  it("no error code uses exit code 0 or 1", () => {
    for (const code of ERROR_CODES) assert.ok(![0, 1].includes(ERROR_EXIT_CODES[code]), code);
  });

  it("exit code 3 holds exactly the key codes (R-AX-7, decision 0016)", () => {
    assert.deepEqual(
      ERROR_CODES.filter((code) => ERROR_EXIT_CODES[code] === 3),
      ["missing-api-key", "api-key-rejected", "quota-exceeded"],
    );
  });
});

describe("black box #5: results", () => {
  for (const result of RESULTS) {
    const label = `${result.status}/${result.backend}`;
    it(`${label}: exit code, envelope shape, key order, schema`, () => {
      const exit = exitCodeOf(result);
      assert.equal(exit, RESULT_EXIT[result.status]);
      const envelope = toEnvelope(result);
      assert.deepEqual(Object.keys(envelope), ["schemaVersion", "ok", "result"]);
      assert.equal(envelope.schemaVersion, 1);
      assert.equal(envelope.ok, exit === 0);
      assert.ok("result" in envelope);
      assert.ok(!("error" in envelope));
      assert.deepEqual(envelope.result, result);
      assert.notEqual(envelope.result, result, "envelope result is a new object");
      const expectedKeys =
        result.status === "failed"
          ? ["status", "backend", "reason"]
          : ["status", "backend", "match", ...("explorerUrl" in result ? ["explorerUrl"] : [])];
      assert.deepEqual(Object.keys(envelope.result), expectedKeys);
      assertValid(envelope);
    });
  }

  it("key order does not depend on the input's key order", () => {
    const shuffled: VerifyResult = {
      explorerUrl: "https://x.example/a",
      match: "exact",
      backend: "sourcify",
      status: "verified",
    };
    const shuffledFailed: VerifyResult = { reason: "nope", backend: "sourcify", status: "failed" };
    assert.equal(
      JSON.stringify(toEnvelope(shuffled)),
      '{"schemaVersion":1,"ok":true,"result":{"status":"verified","backend":"sourcify","match":"exact","explorerUrl":"https://x.example/a"}}',
    );
    assert.equal(
      JSON.stringify(toEnvelope(shuffledFailed)),
      '{"schemaVersion":1,"ok":false,"result":{"status":"failed","backend":"sourcify","reason":"nope"}}',
    );
  });

  it("drops fields the status does not declare", () => {
    const extra = { apiKey: BARE_KEY, reason: "x", url: OPAQUE_KEY };
    const result: VerifyResult = {
      status: "verified",
      backend: "sourcify",
      match: "exact",
      ...extra,
    };
    const envelope = toEnvelope(result, { secrets: [OPAQUE_KEY] });
    assert.ok("result" in envelope);
    assert.deepEqual(Object.keys(envelope.result), ["status", "backend", "match"]);
    const failedExtra = { match: "exact", explorerUrl: "https://x.example", token: OPAQUE_KEY };
    const failed: VerifyResult = {
      status: "failed",
      backend: "sourcify",
      reason: "r",
      ...failedExtra,
    };
    const failedEnvelope = toEnvelope(failed);
    assert.ok("result" in failedEnvelope);
    assert.deepEqual(Object.keys(failedEnvelope.result), ["status", "backend", "reason"]);
    assertValid(envelope);
    assertValid(failedEnvelope);
  });

  it("the same result gives the same bytes", () => {
    for (const result of RESULTS) {
      assert.equal(JSON.stringify(toEnvelope(result)), JSON.stringify(toEnvelope({ ...result })));
    }
  });
});

describe("black box #5: errors", () => {
  for (const code of ERROR_CODES) {
    it(`${code}: exit code, envelope = toJSON, key order, schema`, () => {
      const error = errorFor(code);
      const exit = exitCodeOf(error);
      assert.equal(exit, ERROR_TABLE[code].exit);
      const envelope = toEnvelope(error);
      assert.deepEqual(Object.keys(envelope), ["schemaVersion", "ok", "error"]);
      assert.equal(envelope.schemaVersion, 1);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.ok, exit === 0);
      assert.ok("error" in envelope);
      assert.ok(!("result" in envelope));
      assert.deepEqual(envelope.error, error.toJSON());
      assert.equal(JSON.stringify(envelope.error), JSON.stringify(error));
      const json = envelope.error;
      assert.equal(json.code, code);
      assert.equal(json.message, `A ${code} error.`);
      assert.ok(json.hint.trim().length > 0);
      assert.equal(json.docsUrl, docsUrlOf(code));
      assert.equal(json.retryable, ERROR_TABLE[code].retryable);
      const hasHandle = "handle" in detailsFor(code, "");
      const keys = [
        "code",
        "message",
        "hint",
        "docsUrl",
        "retryable",
        ...(hasHandle ? ["handle"] : []),
        "details",
      ];
      assert.deepEqual(Object.keys(json), keys);
      if (hasHandle) assert.equal(json.handle, HANDLE_STRING);
      assertValid(envelope);
    });
  }

  it("cancelled without a handle has no handle field", () => {
    const error = new ExplorerVerifyError({ code: "cancelled" }, "Cancelled.", { secrets: [] });
    const envelope = toEnvelope(error);
    assert.ok("error" in envelope);
    assert.deepEqual(Object.keys(envelope.error), [
      "code",
      "message",
      "hint",
      "docsUrl",
      "retryable",
      "details",
    ]);
    assert.equal(exitCodeOf(error), 130);
    assertValid(envelope);
  });

  it("a custom hint replaces the default and a blank one keeps it", () => {
    const custom = new ExplorerVerifyError(detailsFor("network", ""), "m", {
      secrets: [],
      hint: "Do X.",
    });
    const blank = new ExplorerVerifyError(detailsFor("network", ""), "m", {
      secrets: [],
      hint: "   ",
    });
    const custEnv = toEnvelope(custom);
    const blankEnv = toEnvelope(blank);
    assert.ok("error" in custEnv && "error" in blankEnv);
    assert.equal(custEnv.error.hint, "Do X.");
    assert.equal(blankEnv.error.hint, errorFor("network").hint);
    assertValid(blankEnv);
  });

  it("an error with an empty message still validates", () => {
    const error = new ExplorerVerifyError(detailsFor("timeout", ""), "", { secrets: [] });
    assertValid(toEnvelope(error));
  });

  it("the same error gives the same bytes", () => {
    for (const code of ERROR_CODES) {
      assert.equal(
        JSON.stringify(toEnvelope(errorFor(code))),
        JSON.stringify(toEnvelope(errorFor(code))),
      );
    }
  });

  it("the envelope holds no cause or stack, and keeps the details", () => {
    const error = new ExplorerVerifyError(detailsFor("network", ""), "m", {
      secrets: [],
      cause: new Error("inner cause text"),
    });
    const text = JSON.stringify(toEnvelope(error));
    for (const word of ["cause", "stack", "inner cause text"]) {
      assert.ok(!text.includes(word), word);
    }
    assert.ok(text.includes('"details":{"code":"network"'));
  });
});

describe("black box #5: values outside the types", () => {
  // Method syntax is bivariant, so this holder accepts the functions without a cast and lets the
  // test pass values only code that bypasses the types can pass.
  const loose: {
    exit(this: void, value: unknown): unknown;
    env(this: void, value: unknown): unknown;
  } = {
    exit: exitCodeOf,
    env: toEnvelope,
  };
  const bogus: unknown[] = [
    null,
    undefined,
    42,
    "verified",
    {},
    { status: "pending", backend: "sourcify" },
    new Error("plain"),
  ];
  for (const value of bogus) {
    const label = value instanceof Error ? "plain Error" : (JSON.stringify(value) ?? "undefined");
    it(`exitCodeOf and toEnvelope throw invalid-input for ${label}`, () => {
      for (const fn of [loose.exit, loose.env]) {
        assert.throws(
          () => fn(value),
          (error: unknown) =>
            error instanceof ExplorerVerifyError && error.code === "invalid-input",
        );
      }
    });
  }
});

const leakyTexts = (key: string): string[] => [
  key,
  `prefix ${key} suffix`,
  `https://api.example.org/api?module=contract&apikey=${key}`,
  `https://api.example.org/api?chainid=1&api_key=${encodeURIComponent(key)}#token=${key}`,
  `Authorization: Bearer ${key}`,
  `{"apiKey":"${key}"}`,
  `https://user:${key}@api.example.org/`,
  `apikey: ${key}`,
  key.toLowerCase(),
];

function assertNoKey(envelope: Envelope, keys: readonly string[]): void {
  const text = JSON.stringify(envelope);
  for (const key of keys) {
    assert.ok(!text.includes(key), `key leaked: ${text}`);
    assert.ok(!text.includes(encodeURIComponent(key)), `encoded key leaked: ${text}`);
    assert.ok(!text.toLowerCase().includes(key.toLowerCase()), `key leaked in other case: ${text}`);
  }
  assertValid(envelope);
}

describe("black box #5: no key in the envelope (R-AX-9, R-SEC-1)", () => {
  it("bare Etherscan-style key in every error path, with no secrets passed anywhere", () => {
    for (const code of ERROR_CODES) {
      for (const text of leakyTexts(BARE_KEY).filter((t) => t !== BARE_KEY.toLowerCase())) {
        const error = new ExplorerVerifyError(detailsFor(code, text), `Failed: ${text}`, {
          secrets: [],
          hint: `Retry ${text}`,
          cause: new Error(text),
        });
        assertNoKey(toEnvelope(error), [BARE_KEY]);
      }
    }
  });

  it("opaque key in every error path, secrets passed to the error", () => {
    for (const code of ERROR_CODES) {
      for (const text of leakyTexts(OPAQUE_KEY)) {
        const error = new ExplorerVerifyError(detailsFor(code, text), `Failed: ${text}`, {
          secrets: [OPAQUE_KEY],
          hint: `Retry ${text}`,
          cause: new Error(text),
        });
        assertNoKey(toEnvelope(error), [OPAQUE_KEY]);
      }
    }
  });

  it("opaque key in every error path, secrets passed only to toEnvelope", () => {
    for (const code of ERROR_CODES) {
      for (const text of leakyTexts(OPAQUE_KEY)) {
        const error = new ExplorerVerifyError(detailsFor(code, text), `Failed: ${text}`, {
          secrets: [],
          hint: `Retry ${text}`,
          cause: new Error(text),
        });
        assertNoKey(toEnvelope(error, { secrets: [OPAQUE_KEY] }), [OPAQUE_KEY]);
      }
    }
  });

  it("key with URL-special characters, secrets passed only to toEnvelope", () => {
    const key = "bb+key/with=chars&more";
    for (const text of [
      key,
      encodeURIComponent(key),
      `x?q=${encodeURIComponent(key).replaceAll("%20", "+")}`,
    ]) {
      const error = new ExplorerVerifyError(
        detailsFor("unexpected-response", text),
        `Failed: ${text}`,
        {
          secrets: [],
        },
      );
      assertNoKey(toEnvelope(error, { secrets: [key] }), [key]);
    }
  });

  it("key as a handle jobId is not printed when passed in secrets", () => {
    const handle: Handle = { ...HANDLE, jobId: BARE_KEY };
    const viaError = new ExplorerVerifyError({ code: "not-confirmed", handle }, "m", {
      secrets: [BARE_KEY],
    });
    assertNoKey(toEnvelope(viaError), [BARE_KEY]);
    const viaEnvelope = new ExplorerVerifyError({ code: "job-not-found", handle }, "m", {
      secrets: [],
    });
    assertNoKey(toEnvelope(viaEnvelope, { secrets: [BARE_KEY] }), [BARE_KEY]);
  });

  it("extra details fields carrying a key never reach the envelope", () => {
    const details = {
      code: "network" as const,
      backend: "sourcify" as const,
      attempts: 1,
      url: OPAQUE_KEY,
    };
    const error = new ExplorerVerifyError(details, "m", { secrets: [] });
    assertNoKey(toEnvelope(error), [OPAQUE_KEY]);
  });

  it("key in every result field, with and without secrets", () => {
    for (const key of [BARE_KEY, OPAQUE_KEY]) {
      for (const text of leakyTexts(key)) {
        const results: VerifyResult[] = [
          { status: "verified", backend: "sourcify", match: "exact", explorerUrl: text },
          {
            status: "already-verified",
            backend: "blockscout",
            match: "partial",
            explorerUrl: text,
          },
          { status: "failed", backend: "etherscan-v2", reason: text },
        ];
        for (const result of results) {
          assertNoKey(toEnvelope(result, { secrets: [key] }), [key]);
          if (key === BARE_KEY && text !== key.toLowerCase()) {
            assertNoKey(toEnvelope(result), [key]);
          }
        }
      }
    }
  });

  it("toEnvelope does not mutate the outcome", () => {
    const result: VerifyResult = {
      status: "failed",
      backend: "sourcify",
      reason: `x ${OPAQUE_KEY}`,
    };
    const before = JSON.stringify(result);
    toEnvelope(result, { secrets: [OPAQUE_KEY] });
    assert.equal(JSON.stringify(result), before);
  });
});
