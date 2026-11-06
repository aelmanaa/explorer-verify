import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as api from "../../src/index.ts";
import type {
  Handle,
  Logger,
  RouteOverride,
  VerifyOptions,
  VerifyResult,
} from "../../src/index.ts";

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Each object literal must list exactly the type's keys: a missing key and an extra key both fail
// to compile, so adding, removing or renaming a field breaks this test.
const handleKeys: Record<keyof Handle, true> = {
  version: true,
  backend: true,
  chainId: true,
  address: true,
  jobId: true,
};
const optionKeys: Record<keyof VerifyOptions, true> = {
  fetch: true,
  signal: true,
  timeoutMs: true,
  pollIntervalMs: true,
  logger: true,
  onEvent: true,
  route: true,
  apiKeys: true,
  allowSourcifyFallback: true,
  rpcUrl: true,
  handlerUrl: true,
};
const routeKeys: Record<keyof RouteOverride, true> = { backend: true, apiUrl: true, apiKey: true };
const emptyRoute: RouteOverride = {};
// A success without an explorer link must compile: a self-hosted Sourcify server has no public page.
const successesWithoutLink: VerifyResult[] = [
  { status: "verified", backend: "sourcify", match: "exact" },
  { status: "already-verified", backend: "sourcify", match: "partial" },
];
const versionIsOne: Equal<Handle["version"], 1> = true;

describe("public types", () => {
  it("Handle has exactly version, backend, chainId, address and jobId (R-FLOW-5, R-SEC-2)", () => {
    assert.deepEqual(Object.keys(handleKeys), [
      "version",
      "backend",
      "chainId",
      "address",
      "jobId",
    ]);
    assert.equal(versionIsOne, true);
  });

  it("VerifyOptions has the M1 fields, apiKeys, allowSourcifyFallback, rpcUrl and handlerUrl (decisions 0009, 0010, 0016 and 0046, R-RT-3, R-IN-3)", () => {
    assert.deepEqual(Object.keys(optionKeys), [
      "fetch",
      "signal",
      "timeoutMs",
      "pollIntervalMs",
      "logger",
      "onEvent",
      "route",
      "apiKeys",
      "allowSourcifyFallback",
      "rpcUrl",
      "handlerUrl",
    ]);
  });

  it("VerifyResult successes have an optional explorerUrl (R-FLOW-3)", () => {
    assert.deepEqual(
      successesWithoutLink.map((result) => "explorerUrl" in result),
      [false, false],
    );
  });

  it("RouteOverride has backend, apiUrl and apiKey, all optional (decisions 0009 and 0016)", () => {
    assert.deepEqual(Object.keys(routeKeys), ["backend", "apiUrl", "apiKey"]);
    assert.deepEqual(emptyRoute, {});
  });
});

describe("public entry point", () => {
  it("exports exactly the decided runtime values (decisions 0009, 0043 and 0044, R-AX-5, R-AX-7, R-RT-4)", () => {
    assert.deepEqual(Object.keys(api).toSorted(), [
      "BACKEND_NAMES",
      "ERROR_CODES",
      "ERROR_EXIT_CODES",
      "ERROR_HINTS",
      "ExplorerVerifyError",
      "buildVerifyInput",
      "checkStatus",
      "dryRun",
      "exitCodeOf",
      "formatHandle",
      "linkLibraries",
      "linkProxy",
      "parseHandle",
      "routesFor",
      "routingTableDate",
      "toBackendName",
      "toEnvelope",
      "validateInput",
      "verify",
      "verifyEach",
    ]);
  });

  it("lists the error codes, the two from decision 0009 first and new codes last (R-DX-3)", () => {
    assert.deepEqual(api.ERROR_CODES, [
      "invalid-input",
      "not-confirmed",
      "unsupported-chain",
      "network",
      "rate-limited",
      "timeout",
      "unexpected-response",
      "in-progress",
      "unknown-state",
      "job-not-found",
      "cancelled",
      "incomplete-input",
      "insufficient-artifact",
      "unsupported-compiler",
      "verification-inconclusive",
      "source-mismatch",
      "missing-api-key",
      "api-key-rejected",
      "quota-exceeded",
      "internal-error",
      "no-metadata-hash",
      "metadata-unavailable",
      "constructor-args-unavailable",
      "proxy-link-pending",
      "proxy-link-unknown-state",
    ]);
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
      onEvent: () => undefined,
      route,
    };
    assert.deepEqual(Object.keys(empty), []);
    assert.deepEqual(Object.keys(full), [
      "fetch",
      "signal",
      "timeoutMs",
      "pollIntervalMs",
      "logger",
      "onEvent",
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
