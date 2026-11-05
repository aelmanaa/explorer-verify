// Tests added after the first full mutation run (#158; R-RT-1, R-RT-2, R-RT-3, R-SEC-1): each one
// fails on a code change in src/routing/resolve.ts that the other routing tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "../../src/errors.ts";
import { REDACTED } from "../../src/redact.ts";
import { tableTarget, unsupported } from "../../src/routing/resolve.ts";
import type { TableEntry } from "../../src/routing/resolve.ts";
import { resolveRoute } from "../helpers/route.ts";

const SEPOLIA = 11155111;
const STANDALONE_API = "https://explorer.example.org/api";

function thrown(run: () => unknown): ExplorerVerifyError {
  try {
    run();
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError, `expected an ExplorerVerifyError`);
    return error;
  }
  return assert.fail("expected an ExplorerVerifyError");
}

describe("tableTarget: entries it cannot route (#158, R-RT-1)", () => {
  it("returns undefined for a Routescan entry without a valid network", () => {
    const entry: TableEntry = { backend: "routescan", network: "devnet" };
    assert.equal(tableTarget(43113, entry), undefined);
    assert.equal(tableTarget(43113, { backend: "routescan" }), undefined);
  });

  it("returns undefined for a Blockscout entry without an instance, and for a backend without a template", () => {
    assert.equal(tableTarget(SEPOLIA, { backend: "blockscout" }), undefined);
    assert.equal(tableTarget(SEPOLIA, { backend: "etherscan-compatible" }), undefined);
  });

  it("reads `network` only for Routescan and `instance` only for Blockscout", () => {
    // Another backend's entry with these fields must not get a Routescan or Blockscout URL.
    const entries: TableEntry[] = [
      { backend: "etherscan-compatible", network: "testnet" },
      { backend: "etherscan-compatible", instance: "eth-sepolia.blockscout.com" },
    ];
    for (const entry of entries) {
      assert.equal(tableTarget(SEPOLIA, entry), undefined);
    }
    assert.equal(
      tableTarget(SEPOLIA, {
        backend: "blockscout",
        network: "testnet",
        instance: "eth-sepolia.blockscout.com",
      })?.apiUrl,
      "https://eth-sepolia.blockscout.com/api",
    );
  });
});

describe("resolveRoute: only a plain object is a route (#158, R-RT-2)", () => {
  it("refuses a function whose prototype is null or Object.prototype", () => {
    const fields = { backend: "etherscan-compatible", apiUrl: STANDALONE_API };
    for (const prototype of [null, Object.prototype]) {
      const route: unknown = Object.assign(
        Object.setPrototypeOf(function route() {}, prototype),
        fields,
      );
      const error = thrown(() => Reflect.apply(resolveRoute, undefined, [SEPOLIA, route]));
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [{ field: "route", message: "must be a plain object" }],
      });
    }
  });
});

// These tests pick a key equal to part of the message on purpose: the key is redacted from the
// message only when it reaches the error as a secret.
describe("resolveRoute: the route key is a secret of the error (#158, R-SEC-1)", () => {
  it("redacts route.apiKey from the message even when the key is refused", () => {
    // Without apiUrl the key is refused, and it still counts as a secret.
    const error = thrown(() => resolveRoute(0, { apiKey: "route.apiKey." }));
    assert.equal(error.message, `The route is invalid: chainId, ${REDACTED}`);
  });

  it("redacts route.apiKey from an error that has no hint of its own", () => {
    const error = thrown(() =>
      resolveRoute(0, {
        backend: "etherscan-compatible",
        apiUrl: STANDALONE_API,
        apiKey: "chainId.",
      }),
    );
    assert.equal(error.message, `The route is invalid: ${REDACTED}`);
    assert.equal(error.hint, "Fix the fields listed in details.issues, then call again.");
  });
});

describe("resolveRoute: the request URL (#158, R-RT-2)", () => {
  it("keeps a query part that holds no parameter name next to chainid", () => {
    const route = resolveRoute(SEPOLIA, {
      backend: "etherscan-v2",
      apiUrl: "https://proxy.example/api?a=1&?",
    });
    assert.equal(
      route.requestUrl(""),
      `https://proxy.example/api?a=1&?&chainid=${String(SEPOLIA)}`,
    );
  });

  it("names an invalid request path", () => {
    const route = resolveRoute(SEPOLIA, undefined, { allowSourcifyFallback: true });
    const error = thrown(() => route.requestUrl("?x"));
    assert.equal(error.message, "The request path is invalid: path.");
  });
});

describe("unsupported: the hint of each case (#158, R-RT-3)", () => {
  it("names the fallback only for a chain without a row", () => {
    assert.equal(
      unsupported(SEPOLIA, "sourcify", "row").hint,
      "Set allowSourcifyFallback: true, or set route.apiUrl and route.backend.",
    );
    const others: ("listed" | "client")[] = ["listed", "client"];
    for (const why of others) {
      assert.equal(
        unsupported(SEPOLIA, "etherscan-v2", why).hint,
        "Set route.backend to another backend the chain lists, or set route.apiUrl with it.",
      );
    }
  });
});
