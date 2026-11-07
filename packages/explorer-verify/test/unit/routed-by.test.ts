// How a route's backend was chosen (#212, decision 0043): `Route.routedBy` and `Route.skipped`,
// their copy in `verify.routed` and in `DryRunResult`, and the shipped schemas. No request.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { toEnvelope } from "../../src/envelope.ts";
import { ExplorerVerifyError } from "../../src/index.ts";
import type { DryRunResult, VerifyEvent } from "../../src/index.ts";
import { redactEvent } from "../../src/observe.ts";
import { resolveRoute } from "../helpers/route.ts";
import { compileStrict, validateEnvelope } from "./envelope-schema.ts";

const KEY = "dummyroutedbykey0123456789";
const SEPOLIA = 11155111;
const validateEvent = compileStrict(
  JSON.parse(readFileSync(new URL("../../schema/event.schema.json", import.meta.url), "utf8")),
);

describe("Route.routedBy and Route.skipped (R-RT-1, R-RT-2, R-RT-3)", () => {
  it("table: skips etherscan-v2 without its key, in table order", () => {
    const route = resolveRoute(SEPOLIA);
    assert.equal(route.backend, "sourcify");
    assert.equal(route.routedBy, "table");
    assert.deepEqual(route.skipped, ["etherscan-v2"]);
  });

  it("table: skips nothing when the first backend has its key", () => {
    const route = resolveRoute(SEPOLIA, undefined, { apiKeys: { "etherscan-v2": KEY } });
    assert.equal(route.backend, "etherscan-v2");
    assert.equal(route.routedBy, "table");
    assert.deepEqual(route.skipped, []);
  });

  it("table: skips nothing when no backend is usable, so the first one stays", () => {
    const table = {
      schemaVersion: 3,
      checked: "2026-11-05",
      chains: [
        {
          chainId: 7,
          backends: [
            { backend: "etherscan-v2" },
            { backend: "etherscan-compatible", api: "api.scan.example/api", needsKey: true },
          ],
        },
      ],
    };
    const route = resolveRoute(7, undefined, { table });
    assert.equal(route.backend, "etherscan-v2");
    assert.equal(route.routedBy, "table");
    assert.deepEqual(route.skipped, []);
  });

  it("caller: route.backend names the backend", () => {
    const route = resolveRoute(SEPOLIA, { backend: "blockscout" });
    assert.equal(route.routedBy, "caller");
    assert.deepEqual(route.skipped, []);
  });

  it("fallback: a chain without a row goes to Sourcify", () => {
    const route = resolveRoute(999_999, undefined, { allowSourcifyFallback: true });
    assert.equal(route.backend, "sourcify");
    assert.equal(route.routedBy, "fallback");
    assert.deepEqual(route.skipped, []);
  });

  it("api-url: route.apiUrl names the server, with or without route.backend", () => {
    assert.equal(resolveRoute(1, { apiUrl: "https://sourcify.example.org" }).routedBy, "api-url");
    assert.equal(
      resolveRoute(1, { backend: "blockscout", apiUrl: "https://eth.blockscout.com/api" }).routedBy,
      "api-url",
    );
  });
});

describe("verify.routed carries routedBy and skipped (R-DX-6)", () => {
  it("keeps both fields through redaction, and the schema accepts them", () => {
    const event: VerifyEvent = {
      type: "verify.routed",
      backend: "sourcify",
      apiHost: "sourcify.dev",
      routedBy: "table",
      skipped: "etherscan-v2,routescan",
    };
    const copy = redactEvent(event, [KEY]);
    assert.deepEqual(copy, event);
    assert.deepEqual(validateEvent(copy), []);
  });

  it("leaves both fields out when the event has none", () => {
    const event: VerifyEvent = {
      type: "verify.routed",
      backend: "sourcify",
      apiHost: "sourcify.dev",
    };
    assert.deepEqual(redactEvent(event, []), event);
  });

  it("the schema refuses an unknown routedBy and a skipped list that is not names", () => {
    const base = { type: "verify.routed", backend: "sourcify", apiHost: "sourcify.dev" };
    assert.notDeepEqual(validateEvent({ ...base, routedBy: "guess" }), []);
    const table = { ...base, routedBy: "table" };
    assert.notDeepEqual(validateEvent({ ...table, skipped: "etherscan-v2, routescan" }), []);
    assert.notDeepEqual(validateEvent({ ...table, skipped: "unknown-backend" }), []);
    assert.deepEqual(validateEvent({ ...table, skipped: "etherscan-v2,routescan" }), []);
    // skipped only with routedBy table.
    assert.notDeepEqual(validateEvent({ ...base, skipped: "etherscan-v2" }), []);
    assert.notDeepEqual(
      validateEvent({ ...base, routedBy: "caller", skipped: "etherscan-v2" }),
      [],
    );
  });
});

describe("DryRunResult.routedBy in the envelope (R-AX-5, R-AX-8)", () => {
  const result: DryRunResult = {
    status: "dry-run",
    backend: "sourcify",
    apiHost: "sourcify.dev",
    lookup: "none",
    routedBy: "table",
  };

  it("copies routedBy, and the schema accepts it", () => {
    const envelope = toEnvelope(result);
    assert.deepEqual(envelope, { schemaVersion: 1, ok: true, result });
    assert.deepEqual(validateEnvelope(envelope), []);
  });

  it("leaves routedBy out when the result has none", () => {
    const { routedBy: _routedBy, ...older } = result;
    assert.deepEqual(toEnvelope(older), { schemaVersion: 1, ok: true, result: older });
  });

  it("refuses a routedBy outside the four values", () => {
    const bad: unknown = { ...result, routedBy: "guess" };
    assert.throws(
      () => Reflect.apply(toEnvelope, undefined, [bad]),
      (error: unknown) =>
        error instanceof ExplorerVerifyError &&
        error.details.code === "invalid-input" &&
        error.details.issues.some((issue) => issue.field === "outcome.routedBy"),
    );
  });
});
