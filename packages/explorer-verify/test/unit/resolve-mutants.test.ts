// Tests added after the first full mutation run (#158; R-RT-1, R-RT-2, R-RT-3, R-SEC-1): each one
// fails on a code change in src/routing/resolve.ts that the other routing tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "../../src/errors.ts";
import { REDACTED } from "../../src/redact.ts";
import { routesFor } from "../../src/routing/load-table.ts";
import { routesWith, tableTarget, unsupported } from "../../src/routing/resolve.ts";
import type { RoutingTable, TableEntry } from "../../src/routing/resolve.ts";
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
    assert.equal(
      error.hint,
      "Fix the fields that the issues list (details.issues), then call again.",
    );
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

/** routesFor() with options of any shape, and what it resolved or rejected with. */
async function routesOf(chainId: number, options: unknown): Promise<unknown> {
  const pending: unknown = Reflect.apply(routesFor, undefined, [chainId, options]);
  return await Promise.resolve(pending).then(
    (result: unknown) => result,
    (error: unknown) => error,
  );
}

describe("routing mutants of the 0.2.0 run (#381, R-RT-1, R-RT-3, R-SEC-1)", () => {
  it("sends a blockscout-hosted route with route.apiUrl to that URL", () => {
    const route = resolveRoute(SEPOLIA, {
      backend: "blockscout-hosted",
      apiUrl: "https://proxy.example/api",
    });
    assert.equal(route.backend, "blockscout-hosted");
    assert.equal(route.apiBase, "https://proxy.example/api");
    assert.equal(route.requestUrl(""), "https://proxy.example/api");
    assert.equal(route.routedBy, "api-url");
  });

  it("routesFor() treats a key that is not a string as absent", async () => {
    const routes = await routesOf(SEPOLIA, { apiKeys: { "etherscan-v2": 123 } });
    assert.deepEqual(routes, await routesFor(SEPOLIA));
    assert.deepEqual(routes, {
      listed: ["etherscan-v2", "sourcify", "blockscout", "routescan"],
      pick: {
        backend: "sourcify",
        routedBy: "table",
        skipped: ["etherscan-v2"],
        keyMissing: false,
      },
    });
  });

  it("routesFor() keeps keyMissing for a non-string key when every backend needs one", async () => {
    const table: RoutingTable = {
      schemaVersion: 3,
      checked: "2026-11-12",
      chains: [{ chainId: SEPOLIA, backends: [{ backend: "etherscan-v2" }] }],
    };
    const pending: unknown = Reflect.apply(routesWith, undefined, [
      SEPOLIA,
      { apiKeys: { "etherscan-v2": 123 } },
      async () => await Promise.resolve(table),
    ]);
    assert.deepEqual(await pending, {
      listed: ["etherscan-v2"],
      pick: { backend: "etherscan-v2", routedBy: "table", skipped: [], keyMissing: true },
    });
  });

  it("routesFor() on a chain with no row names Sourcify and hints at the fallback", async () => {
    const { pick } = await routesFor(999_999);
    assert.ok(pick instanceof ExplorerVerifyError);
    assert.deepEqual(pick.details, {
      code: "unsupported-chain",
      chainId: 999_999,
      backend: "sourcify",
    });
    assert.equal(pick.message, "The routing table has no row for chain 999999.");
    assert.equal(
      pick.hint,
      "Set allowSourcifyFallback: true, or set route.apiUrl and route.backend.",
    );
  });

  it("routesWith() leaves out of listed a row entry it cannot route", async () => {
    const table: RoutingTable = {
      schemaVersion: 3,
      checked: "2026-11-12",
      chains: [
        {
          chainId: SEPOLIA,
          // A Routescan entry without a network has no URL.
          backends: [{ backend: "routescan" }, { backend: "sourcify" }],
        },
      ],
    };
    const { listed, pick } = await routesWith(
      SEPOLIA,
      {},
      async () => await Promise.resolve(table),
    );
    assert.deepEqual(listed, ["sourcify"]);
    assert.ok(!(pick instanceof ExplorerVerifyError));
    assert.equal(pick.backend, "sourcify");
  });

  it("routesFor() names field options for an unknown key that cannot be named", async () => {
    const error = await routesOf(SEPOLIA, { "a b": 1 });
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(error.code, "invalid-input");
    assert.equal(
      error.details.code === "invalid-input" && error.details.issues[0]?.field,
      "options",
    );
  });
});
