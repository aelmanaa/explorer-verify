// Black-box tests for issue #11: VerifyOptions, Handle and the error shape. They use only the
// public entry point and the promises in the issue, decision 0009, requirements.md and
// docs/user/reference/errors/. Cases the other unit tests already cover are left out.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKEND_NAMES, ExplorerVerifyError, parseHandle } from "../../src/index.ts";
import type {
  ApiKeys,
  BackendName,
  ErrorCode,
  KeyedBackendName,
  ErrorDetails,
  ErrorJson,
  Handle,
  HandleString,
  Logger,
  RouteOverride,
  VerifyOptions,
} from "../../src/index.ts";
import { docsUrlOf } from "../helpers/docs-url.ts";

// --- type-level helpers -------------------------------------------------------------------------

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Each constant only compiles when its type is `true`; the runtime assertion keeps it used.
const verifyOptionKeys: Equals<
  keyof VerifyOptions,
  | "fetch"
  | "signal"
  | "timeoutMs"
  | "pollIntervalMs"
  | "indexWaitMs"
  | "logger"
  | "onEvent"
  | "route"
  | "apiKeys"
  | "allowSourcifyFallback"
  | "rpcUrl"
  | "handlerUrl"
  | "submitOverPartial"
> = true;
const verifyOptionsAllOptional: Equals<Required<VerifyOptions>, VerifyOptions> = false;
const verifyOptionsEmptyOk: Partial<VerifyOptions> extends VerifyOptions ? true : false = true;
const noApiKey: "apiKey" extends keyof VerifyOptions ? false : true = true;
// Decision 0009 planned `apiKeys` keyed by backend name for M2; #58 adds it. Decision 0046 narrows
// it to the backends that take a key there, so `apiKeys: { sourcify: "..." }` does not compile.
const apiKeysType: Equals<
  VerifyOptions["apiKeys"],
  { [B in KeyedBackendName]?: string | undefined } | undefined
> = true;
const apiKeysExported: Equals<VerifyOptions["apiKeys"], ApiKeys | undefined> = true;
const apiKeysNames: Equals<keyof NonNullable<VerifyOptions["apiKeys"]>, KeyedBackendName> = true;
const keyedNames: Equals<KeyedBackendName, "etherscan-v2" | "routescan" | "blockscout-hosted"> =
  true;
const noSourcifyKey: "sourcify" extends keyof NonNullable<VerifyOptions["apiKeys"]> ? false : true =
  true;
const noBlockscoutKey: Extract<
  BackendName,
  "blockscout" | "etherscan-compatible"
> extends keyof NonNullable<VerifyOptions["apiKeys"]>
  ? false
  : true = true;
const handlerUrlType: Equals<VerifyOptions["handlerUrl"], string | undefined> = true;
const noAbort: "abort" extends keyof VerifyOptions ? false : true = true;
const signalType: Equals<VerifyOptions["signal"], AbortSignal | undefined> = true;
const fetchType: Equals<VerifyOptions["fetch"], typeof fetch | undefined> = true;
const loggerKeys: Equals<keyof Logger, "debug" | "info" | "warn" | "error"> = true;
const routeKeys: Equals<keyof RouteOverride, "backend" | "apiUrl" | "apiKey" | "explorerUrl"> =
  true;
const handleKeys: Equals<
  keyof Handle,
  "version" | "backend" | "chainId" | "address" | "jobId" | "overPartial"
> = true;
const errorJsonKeys: Equals<
  keyof ErrorJson,
  "code" | "message" | "hint" | "docsUrl" | "retryable" | "handle" | "handles" | "details"
> = true;
const errorJsonHandleIsLine: Equals<ErrorJson["handle"], HandleString | undefined> = true;
const toJsonReturns: Equals<ReturnType<ExplorerVerifyError["toJSON"]>, ErrorJson> = true;
const detailsCodes: Equals<ErrorDetails["code"], ErrorCode> = true;
const consoleIsLogger: typeof console extends Logger ? true : false = true;

// `Exact<T, U>` is false when U has a key T does not.
type Exact<T, U extends T> = Exclude<keyof U, keyof T> extends never ? true : false;
const extraFieldRejected: Exact<VerifyOptions, { timeoutMs: 1; apiKey: string }> = false;
const documentedFieldsAccepted: Exact<
  VerifyOptions,
  { timeoutMs: 1; pollIntervalMs: 2; signal: AbortSignal; route: { backend: "sourcify" } }
> = true;

// --- fixtures -----------------------------------------------------------------------------------

const DUMMY_KEY = "DUMMYKEY1234567890ABCDEFGHIJKLMN";

function validHandle(): Handle {
  return {
    version: 1,
    backend: "sourcify",
    chainId: 11155111,
    address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    jobId: "550e8400-e29b-41d4-a716-446655440000",
  };
}

function catchError(run: () => unknown): ExplorerVerifyError {
  let caught: unknown;
  let threw = false;
  try {
    run();
  } catch (error) {
    caught = error;
    threw = true;
  }
  assert.ok(threw, "expected a throw");
  assert.ok(caught instanceof ExplorerVerifyError, `expected ExplorerVerifyError`);
  return caught;
}

function expectInvalid(value: unknown, field?: string): ExplorerVerifyError {
  const error = catchError(() => parseHandle(value));
  assert.equal(error.code, "invalid-input");
  assert.equal(error.details.code, "invalid-input");
  if (error.details.code === "invalid-input") {
    assert.ok(error.details.issues.length > 0, "issues must not be empty");
    for (const issue of error.details.issues) {
      assert.ok(issue.message.length > 0);
    }
    if (field !== undefined) {
      assert.ok(
        error.details.issues.some((issue) => issue.field === field),
        `expected an issue for ${field}, got ${JSON.stringify(error.details.issues)}`,
      );
    }
  }
  return error;
}

function assertNoKey(error: ExplorerVerifyError): void {
  const surfaces = [
    error.message,
    error.hint,
    error.docsUrl,
    JSON.stringify(error),
    JSON.stringify(error.toJSON()),
    String(error),
    error.stack ?? "",
    JSON.stringify(error.details),
  ];
  for (const surface of surfaces) {
    assert.ok(!surface.includes(DUMMY_KEY), `key leaked in: ${surface.slice(0, 200)}`);
  }
}

// --- tests --------------------------------------------------------------------------------------

describe("blackbox #11: type-level contract (compiles only when true)", () => {
  it("VerifyOptions, Handle, Logger, RouteOverride and ErrorJson have exactly the documented fields", () => {
    for (const check of [
      verifyOptionKeys,
      verifyOptionsEmptyOk,
      noApiKey,
      apiKeysType,
      apiKeysNames,
      apiKeysExported,
      keyedNames,
      noSourcifyKey,
      noBlockscoutKey,
      handlerUrlType,
      noAbort,
      signalType,
      fetchType,
      loggerKeys,
      routeKeys,
      handleKeys,
      errorJsonKeys,
      errorJsonHandleIsLine,
      toJsonReturns,
      detailsCodes,
      consoleIsLogger,
      documentedFieldsAccepted,
    ]) {
      assert.equal(check, true);
    }
    assert.equal(verifyOptionsAllOptional, false);
    assert.equal(extraFieldRejected, false);
  });

  it("console is a Logger in a full VerifyOptions", () => {
    const full: VerifyOptions = {
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
      timeoutMs: 1,
      pollIntervalMs: 1,
      logger: console,
      route: { backend: "sourcify", apiUrl: "http://localhost:5555" },
    };
    assert.equal(Object.keys(full).length, 6);
  });
});

describe("blackbox #11: parseHandle output (R-FLOW-5)", () => {
  it("round-trips for every backend name", () => {
    for (const backend of BACKEND_NAMES) {
      const handle: Handle = { ...validHandle(), backend };
      assert.deepEqual(parseHandle(JSON.parse(JSON.stringify(handle))), handle);
    }
  });

  it("returns a copy: mutating the input afterwards does not change it", () => {
    const input = validHandle();
    const parsed = parseHandle(input);
    input.jobId = "changed";
    assert.equal(parsed.jobId, "550e8400-e29b-41d4-a716-446655440000");
  });

  it("is plain JSON: survives a structuredClone and stringify gives no URL", () => {
    const text = JSON.stringify(parseHandle(structuredClone(validHandle())));
    assert.ok(!/https?:/.test(text));
    assert.ok(text.includes('"version":1'));
  });
});

describe("blackbox #11: parseHandle rejects bad input (R-FLOW-5, R-SEC-2)", () => {
  it("rejects URL-carrying fields as one handle issue", () => {
    for (const name of ["url", "host", "baseUrl", "route", "extra"]) {
      expectInvalid({ ...validHandle(), [name]: "https://evil.example" }, "handle");
    }
  });

  it("rejects a backend that differs only in case, or is not listed", () => {
    expectInvalid({ ...validHandle(), backend: "etherscan" }, "backend");
    expectInvalid({ ...validHandle(), backend: "Sourcify" }, "backend");
  });

  it("rejects infinite, null and huge chain ids", () => {
    for (const chainId of [Number.POSITIVE_INFINITY, null, 2 ** 64]) {
      expectInvalid({ ...validHandle(), chainId }, "chainId");
    }
  });

  it("rejects an empty, too long, wrong-case-hex or null address", () => {
    for (const address of [
      "0x",
      "0x5FbDB2315678afecb367f032d93F642f64180aa3ff",
      "0xZZbDB2315678afecb367f032d93F642f64180aa3",
      null,
    ]) {
      expectInvalid({ ...validHandle(), address }, "address");
    }
  });

  it("rejects a job id with a URL scheme or a path", () => {
    for (const jobId of ["https:evil.example", "../admin", "a/../b"]) {
      expectInvalid({ ...validHandle(), jobId }, "jobId");
    }
  });

  it("rejects booleans, empty arrays and the JSON string itself", () => {
    for (const value of [true, [], JSON.stringify(validHandle())]) {
      expectInvalid(value, "handle");
    }
  });
});

describe("blackbox #11: error object (R-DX-3, R-AX-10)", () => {
  it("docsUrl is an https URL to the code's own page, with no fragment", () => {
    const errors = [
      expectInvalid({ ...validHandle(), chainId: -1 }),
      new ExplorerVerifyError({ code: "not-confirmed", handle: validHandle() }, "Still pending.", {
        secrets: [],
      }),
    ];
    for (const error of errors) {
      const url = new URL(error.docsUrl);
      assert.equal(url.protocol, "https:");
      assert.equal(error.docsUrl, docsUrlOf(error.code));
      assert.equal(url.hash, "");
    }
  });

  it("an error with no cause has cause undefined", () => {
    const error = expectInvalid({});
    assert.equal(error.cause, undefined);
    assert.equal(Object.hasOwn(error.toJSON(), "cause"), false);
  });

  it("works through a Promise rejection and keeps instanceof", async () => {
    await assert.rejects(
      async () => parseHandle({ ...validHandle(), apiUrl: "x" }),
      (error: unknown) => error instanceof ExplorerVerifyError && error.code === "invalid-input",
    );
  });
});

describe("blackbox #11: no API key leaks from parseHandle (R-SEC-1, R-AX-9)", () => {
  const cases: Array<[string, unknown]> = [
    ["apiKey field", { ...validHandle(), apiKey: DUMMY_KEY }],
    [
      "key in apiUrl query",
      { ...validHandle(), apiUrl: `https://x.example/api?apikey=${DUMMY_KEY}` },
    ],
    ["key as address with 0x", { ...validHandle(), address: `0x${DUMMY_KEY}` }],
    ["key as jobId wrong type", { ...validHandle(), jobId: [DUMMY_KEY] }],
    ["key as jobId with a scheme", { ...validHandle(), jobId: `apikey:${DUMMY_KEY}` }],
    ["key as the whole value", DUMMY_KEY],
    ["key nested in an unknown field", { ...validHandle(), extra: { apikey: DUMMY_KEY } }],
    ["key as an unknown field name", { ...validHandle(), [DUMMY_KEY]: 1 }],
  ];
  for (const [name, value] of cases) {
    it(`does not repeat the value: ${name}`, () => {
      assertNoKey(expectInvalid(value));
    });
  }
});
