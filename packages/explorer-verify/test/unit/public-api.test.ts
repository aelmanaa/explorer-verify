import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as api from "../../src/index.ts";
import type { Handle, Logger, RouteOverride, VerifyOptions } from "../../src/index.ts";

describe("public entry point", () => {
  it("exports exactly the decided runtime values (decision 0009)", () => {
    assert.deepEqual(Object.keys(api).toSorted(), [
      "BACKEND_NAMES",
      "ERROR_CODES",
      "ExplorerVerifyError",
      "parseHandle",
      "toBackendName",
    ]);
  });

  it("lists the M1 error codes (R-DX-3)", () => {
    assert.deepEqual(api.ERROR_CODES, ["invalid-input", "not-confirmed"]);
  });

  it("accepts every VerifyOptions field, all optional (decision 0009)", () => {
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    const route: RouteOverride = { backend: "sourcify", apiUrl: "http://127.0.0.1:5555" };
    const empty: VerifyOptions = {};
    const full: VerifyOptions = {
      fetch: globalThis.fetch,
      signal: new AbortController().signal,
      timeoutMs: 120_000,
      pollIntervalMs: 3_000,
      logger,
      route,
    };
    assert.deepEqual(Object.keys(empty), []);
    assert.deepEqual(Object.keys(full), [
      "fetch",
      "signal",
      "timeoutMs",
      "pollIntervalMs",
      "logger",
      "route",
    ]);
  });

  it("has a Handle with exactly the decided fields and no URL (R-FLOW-5, R-SEC-2)", () => {
    const handle: Handle = {
      version: 1,
      backend: "sourcify",
      chainId: 1,
      address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      jobId: "job",
    };
    assert.deepEqual(Object.keys(api.parseHandle(handle)), [
      "version",
      "backend",
      "chainId",
      "address",
      "jobId",
    ]);
  });
});
