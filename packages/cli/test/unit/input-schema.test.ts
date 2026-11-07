// The request fields the CLI reads with --input-json match the core's input.schema.json (R-AX-16):
// a field added to one and not the other fails here, so the unknown-property count and the schema
// cannot disagree.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ROUTE_FIELDS } from "../../src/request.ts";
import { STATUS_REQUEST } from "../../src/status.ts";
import { VERIFY_REQUEST } from "../../src/verify.ts";
import { inputProblems } from "../helpers/schema.ts";
import { PROJECT } from "../helpers/spawn-bin.ts";

const require = createRequire(import.meta.url);
const SCHEMA: unknown = JSON.parse(
  readFileSync(require.resolve("explorer-verify/input.schema.json"), "utf8"),
);

/** The value at `path` in the schema, each step an object key. */
function at(path: readonly string[]): unknown {
  let value: unknown = SCHEMA;
  for (const key of path) {
    assert.ok(typeof value === "object" && value !== null, path.join("."));
    const next: unknown = Reflect.get(value, key);
    value = next;
  }
  return value;
}

/** The property names of the schema object at `path`, in order. */
function properties(path: readonly string[]): string[] {
  const value = at([...path, "properties"]);
  assert.ok(typeof value === "object" && value !== null, path.join("."));
  return Object.keys(value);
}

/** The names without `route`, which every request may carry. */
function withoutRoute(names: readonly string[]): string[] {
  return names.filter((name) => name !== "route");
}

describe("input.schema.json and the CLI's request fields (R-AX-16)", () => {
  it("lists the verify fields the CLI reads, and route", () => {
    assert.deepEqual(withoutRoute(properties(["$defs", "verify"])), VERIFY_REQUEST.fields);
    assert.ok(properties(["$defs", "verify"]).includes("route"));
  });

  it("lists the compiler fields the CLI closes", () => {
    assert.deepEqual(
      properties(["$defs", "verify", "properties", "compiler"]),
      VERIFY_REQUEST.nested?.["compiler"],
    );
  });

  it("lists the status fields the CLI reads, and route", () => {
    assert.deepEqual(withoutRoute(properties(["$defs", "status"])), STATUS_REQUEST.fields);
    assert.ok(properties(["$defs", "status"]).includes("route"));
  });

  it("lists the route fields the CLI reads", () => {
    assert.deepEqual(
      properties(["$defs", "route"]),
      ROUTE_FIELDS.map(([name]) => name),
    );
  });

  it("accepts the fixture request the examples use", () => {
    const request: unknown = JSON.parse(readFileSync(join(PROJECT, "verify-input.json"), "utf8"));
    assert.deepEqual(inputProblems(request), []);
  });

  it("accepts a zksolc compiler with solcVersion, and refuses one without it (decision 0057)", () => {
    const input = { language: "Solidity", sources: { "A.sol": { content: "" } }, settings: {} };
    const request = (compiler: Record<string, unknown>): unknown => ({
      chainId: 324,
      address: `0x${"ab".repeat(20)}`,
      compiler: { version: "1.5.15", input, ...compiler },
      contractName: "A.sol:A",
    });
    const solcVersion = "0.8.24+commit.e11b9ed9";
    assert.deepEqual(inputProblems(request({ kind: "zksolc", solcVersion })), []);
    assert.deepEqual(
      inputProblems(request({ kind: "zksolc", solcVersion, solcFork: "1.0.2" })),
      [],
    );
    assert.notDeepEqual(inputProblems(request({ kind: "zksolc" })), []);
    assert.notDeepEqual(inputProblems(request({ kind: "vyper", solcVersion })), []);
    for (const field of ["solcVersion", "solcFork"]) {
      assert.notDeepEqual(inputProblems(request({ kind: "solc", [field]: solcVersion })), []);
    }
  });
});
