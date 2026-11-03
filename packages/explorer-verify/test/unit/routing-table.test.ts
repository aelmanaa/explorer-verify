// Tests for the routing table and the resolver (#59): the table's format and its checks, the
// backend selection, the Sourcify fallback, and the route fields the key rule reads (R-RT-1 to
// R-RT-3, R-SEC-2, decision 0016). The resolver tests pass their own table; the table tests run
// on the shipped file and on broken copies of it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { BackendName } from "../../src/backend-names.ts";
import type { Backend } from "../../src/backends/backend.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { DEFAULT_DEPENDENCIES, runVerify } from "../../src/flow/verify.ts";
import { keyFor, requireKey } from "../../src/http/api-keys.ts";
import type { ApiKeys } from "../../src/http/api-keys.ts";
import { ROUTING_TABLE, SOURCIFY_API_URL, resolveRoute } from "../../src/routing/resolve.ts";
import type { RouteChoice, RoutingTable, TableEntry, TableRow } from "../../src/routing/resolve.ts";
import type { Hex, RouteOverride, VerifyInput, VerifyOptions } from "../../src/types.ts";
import { tableProblems } from "../helpers/routing-table.ts";

// Made-up keys. Never real ones (R-SEC-1).
const ETHERSCAN_KEY = "etherscan-dummy-key-59a1";
const ROUTESCAN_KEY = "routescan-dummy-key-59b2";
const ROUTE_KEY = "standalone-dummy-key-59c3";
const ADDRESS: Hex = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const FUJI = 43113;
const SEPOLIA = 11155111;
const ETHERSCAN_API = "https://api.etherscan.io/v2/api";
const ROUTESCAN_API = `https://api.routescan.io/v2/network/testnet/evm/${String(FUJI)}/etherscan/api`;

const ETHERSCAN: TableEntry = {
  backend: "etherscan-v2",
  apiUrl: ETHERSCAN_API,
  explorerUrl: "https://sepolia.etherscan.io/address/{address}#code",
};
const ROUTESCAN: TableEntry = {
  backend: "routescan",
  apiUrl: ROUTESCAN_API,
  explorerUrl: `https://routescan.io/address/{address}?chainid=${String(FUJI)}`,
};

function sourcifyEntry(chainId: number): TableEntry {
  return {
    backend: "sourcify",
    apiUrl: SOURCIFY_API_URL,
    explorerUrl: `https://repo.sourcify.dev/${String(chainId)}/{address}`,
  };
}

function row(chainId: number, backends: TableEntry[]): TableRow {
  return { chainId, name: `Chain ${String(chainId)}`, checked: "2026-11-03", backends };
}

/** A table in the format the M2 rows will use: Etherscan, Routescan and Sourcify. */
const TABLE: RoutingTable = {
  schemaVersion: 1,
  checked: "2026-11-03",
  chains: [
    row(FUJI, [ROUTESCAN, sourcifyEntry(FUJI)]),
    row(SEPOLIA, [ETHERSCAN, sourcifyEntry(SEPOLIA)]),
  ],
};

function resolve(chainId: number, override?: RouteOverride, choice: RouteChoice = {}) {
  return resolveRoute(chainId, override, { table: TABLE, ...choice });
}

function thrown(run: () => unknown): ExplorerVerifyError {
  try {
    run();
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError, `threw ${String(error)}`);
    return error;
  }
  return assert.fail("no error thrown");
}

function explorerLink(route: ReturnType<typeof resolve>): (address: Hex) => string {
  return route.explorerUrl ?? assert.fail("the route has no explorer link");
}

describe("resolveRoute: backend selection (R-RT-1)", () => {
  it("resolves the first usable backend of a row (R-RT-1)", () => {
    const fuji = resolve(FUJI);
    assert.equal(fuji.backend, "routescan");
    assert.equal(fuji.apiBase, ROUTESCAN_API);
    const keyed = resolve(SEPOLIA, undefined, { apiKeys: { "etherscan-v2": ETHERSCAN_KEY } });
    assert.equal(keyed.backend, "etherscan-v2");
    assert.equal(keyed.apiBase, ETHERSCAN_API);
  });

  it("skips a keyed backend without a key (R-RT-1)", () => {
    for (const apiKeys of [undefined, {}, { routescan: ROUTESCAN_KEY }] satisfies (
      | ApiKeys
      | undefined
    )[]) {
      const route = resolve(SEPOLIA, undefined, apiKeys === undefined ? {} : { apiKeys });
      assert.equal(route.backend, "sourcify");
      assert.equal(route.apiBase, SOURCIFY_API_URL);
    }
  });

  it("falls back to the first backend when none is usable, so the flow reports the missing key (R-RT-1)", () => {
    const table: RoutingTable = { ...TABLE, chains: [row(SEPOLIA, [ETHERSCAN])] };
    const route = resolveRoute(SEPOLIA, undefined, { table });
    assert.equal(route.backend, "etherscan-v2");
    const error = thrown(() => {
      requireKey({ route }, false, []);
    });
    assert.equal(error.code, "missing-api-key");
    assert.equal(
      error.message,
      "etherscan-v2 needs an API key and none is set for api.etherscan.io: set apiKeys.etherscan-v2.",
    );
  });

  it("ignores a row entry whose backend is not a known name", () => {
    const table: RoutingTable = {
      ...TABLE,
      chains: [row(SEPOLIA, [{ ...ETHERSCAN, backend: "etherscan" }, sourcifyEntry(SEPOLIA)])],
    };
    const route = resolveRoute(SEPOLIA, undefined, {
      table,
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
    });
    // The whole entry is dropped, its URL and host too, not only its name.
    assert.equal(route.backend, "sourcify");
    assert.equal(route.apiBase, SOURCIFY_API_URL);
    assert.equal(route.tableHost, "sourcify.dev");
  });

  it("picks the first backend with a client in this version (R-RT-1)", () => {
    const table: RoutingTable = {
      ...TABLE,
      chains: [row(SEPOLIA, [ETHERSCAN, { ...ROUTESCAN }, sourcifyEntry(SEPOLIA)])],
    };
    const route = resolveRoute(SEPOLIA, undefined, {
      table,
      clients: ["sourcify"],
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
    });
    assert.equal(route.backend, "sourcify");
    // With no client for any backend of the row, the first stays, and the flow reports it.
    const none = resolveRoute(SEPOLIA, undefined, { table, clients: [] });
    assert.equal(none.backend, "routescan");
  });

  it("gives the contract page from the row's template (R-FLOW-3)", () => {
    const keyed = resolve(SEPOLIA, undefined, { apiKeys: { "etherscan-v2": ETHERSCAN_KEY } });
    assert.equal(
      explorerLink(keyed)(ADDRESS),
      `https://sepolia.etherscan.io/address/${ADDRESS}#code`,
    );
    assert.equal(
      explorerLink(resolve(FUJI))(ADDRESS),
      `https://routescan.io/address/${ADDRESS}?chainid=${String(FUJI)}`,
    );
  });
});

describe("resolveRoute: route.backend and route.apiUrl (R-RT-2)", () => {
  it("route.backend picks another backend listed for the chain (R-RT-2)", () => {
    const route = resolve(FUJI, { backend: "sourcify" });
    assert.equal(route.backend, "sourcify");
    assert.equal(route.apiBase, SOURCIFY_API_URL);
    assert.equal(
      explorerLink(route)(ADDRESS),
      `https://repo.sourcify.dev/${String(FUJI)}/${ADDRESS}`,
    );
    // A keyed backend named without a key is still the caller's choice; the flow reports the key.
    assert.equal(resolve(SEPOLIA, { backend: "etherscan-v2" }).backend, "etherscan-v2");
  });

  it("route.backend that the row does not list throws unsupported-chain naming the chain and the backend (R-RT-2)", () => {
    const error = thrown(() => resolve(SEPOLIA, { backend: "routescan" }));
    assert.deepEqual(error.details, {
      code: "unsupported-chain",
      chainId: SEPOLIA,
      backend: "routescan",
    });
    assert.equal(
      error.message,
      `The routing table lists no routescan API for chain ${String(SEPOLIA)}.`,
    );
    assert.match(error.hint, /route\.backend/);
    assert.match(error.hint, /route\.apiUrl/);
  });

  it("accepts every backend name with route.apiUrl, for any chain (R-RT-2)", () => {
    for (const backend of [
      "etherscan-v2",
      "etherscan-compatible",
      "blockscout",
      "routescan",
    ] as const) {
      const route = resolve(999_999, { backend, apiUrl: "https://explorer.example.org/api" });
      assert.equal(route.backend, backend);
      assert.equal(route.apiBase, "https://explorer.example.org/api");
      assert.equal(route.explorerUrl, undefined);
      assert.equal(route.overridden, true);
      assert.equal(route.tableHost, undefined);
    }
  });

  it("takes sourcify as the backend of a route.apiUrl without route.backend (R-RT-2)", () => {
    const route = resolve(FUJI, { apiUrl: "http://127.0.0.1:5555" });
    assert.equal(route.backend, "sourcify");
    assert.equal(route.explorerUrl, undefined);
  });

  it("keeps the row's page when route.apiUrl names the row's own API (R-FLOW-3)", () => {
    const route = resolve(FUJI, { backend: "routescan", apiUrl: `${ROUTESCAN_API}/` });
    assert.equal(route.apiBase, ROUTESCAN_API);
    assert.equal(
      explorerLink(route)(ADDRESS),
      `https://routescan.io/address/${ADDRESS}?chainid=${String(FUJI)}`,
    );
  });

  it("refuses a route.backend that has no client in this version, before the table (R-RT-2)", () => {
    const error = thrown(() => resolve(FUJI, { backend: "routescan" }, { clients: ["sourcify"] }));
    assert.deepEqual(error.details, {
      code: "invalid-input",
      issues: [{ field: "route.backend", message: "has no client in this version" }],
    });
    assert.equal(error.hint, "Leave out route.backend, or name one of: sourcify.");
  });

  it("lists every backend name in the hint when no client list is given", () => {
    const override = {};
    Reflect.set(override, "backend", "etherscan");
    const error = thrown(() => resolveRoute(1, override));
    assert.equal(
      error.hint,
      "Leave out route.backend, or name one of: etherscan-v2, etherscan-compatible, blockscout, sourcify, routescan.",
    );
  });
});

describe("resolveRoute: chains missing from the table (R-RT-3)", () => {
  it("an unknown chain throws unsupported-chain naming the chain and the fallback option (R-RT-3)", () => {
    for (const override of [undefined, { backend: "sourcify" }] satisfies (
      | RouteOverride
      | undefined
    )[]) {
      const error = thrown(() => resolve(999_999, override));
      assert.deepEqual(error.details, {
        code: "unsupported-chain",
        chainId: 999_999,
        backend: "sourcify",
      });
      assert.equal(error.message, "The routing table has no row for chain 999999.");
      assert.equal(
        error.hint,
        "Set allowSourcifyFallback: true, or set route.apiUrl and route.backend.",
      );
      assert.equal(error.retryable, false);
    }
  });

  it("an unknown chain resolves to Sourcify when allowSourcifyFallback is true (R-RT-3)", () => {
    const route = resolve(999_999, undefined, { allowSourcifyFallback: true });
    assert.equal(route.backend, "sourcify");
    assert.equal(route.apiBase, SOURCIFY_API_URL);
    assert.equal(route.overridden, false);
    assert.equal(route.tableHost, "sourcify.dev");
    assert.equal(explorerLink(route)(ADDRESS), `https://repo.sourcify.dev/999999/${ADDRESS}`);
    assert.equal(
      resolve(999_999, { backend: "sourcify" }, { allowSourcifyFallback: true }).backend,
      "sourcify",
    );
  });

  it("names the backend when the fallback cannot serve the one the caller named (R-RT-3)", () => {
    const error = thrown(() =>
      resolve(999_999, { backend: "routescan" }, { allowSourcifyFallback: true }),
    );
    assert.deepEqual(error.details, {
      code: "unsupported-chain",
      chainId: 999_999,
      backend: "routescan",
    });
    // The chain has no row; the Sourcify fallback serves only Sourcify.
    assert.equal(error.message, "The routing table has no row for chain 999999.");
    assert.match(error.hint, /route\.apiUrl and route\.backend/);
  });

  it("the fallback does not apply to a chain the table lists (R-RT-3)", () => {
    const route = resolve(SEPOLIA, undefined, {
      allowSourcifyFallback: true,
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
    });
    assert.equal(route.backend, "etherscan-v2");
  });
});

describe("resolveRoute: request URLs (R-RT-1)", () => {
  it("a Routescan route keeps the row's full URL (R-RT-1)", () => {
    const route = resolve(FUJI);
    assert.equal(route.requestUrl(""), ROUTESCAN_API);
    assert.equal(route.redactedApiUrl, ROUTESCAN_API);
  });

  it("an Etherscan route adds chainid in one place (R-RT-1)", () => {
    const route = resolve(SEPOLIA, undefined, { apiKeys: { "etherscan-v2": ETHERSCAN_KEY } });
    const url = new URL(route.requestUrl(""));
    assert.equal(url.href, `${ETHERSCAN_API}?chainid=${String(SEPOLIA)}`);
    assert.deepEqual(url.searchParams.getAll("chainid"), [String(SEPOLIA)]);
    assert.equal(route.apiBase, ETHERSCAN_API);
    assert.equal(route.redactedApiUrl, ETHERSCAN_API);
    // A caller's query comes first, and the route's chainid comes last.
    const proxy = resolve(SEPOLIA, {
      backend: "etherscan-v2",
      apiUrl: "https://proxy.example.org/api?team=abcdefgh",
    });
    assert.equal(
      proxy.requestUrl(""),
      `https://proxy.example.org/api?team=abcdefgh&chainid=${String(SEPOLIA)}`,
    );
    assert.equal(proxy.redactedApiUrl, "https://proxy.example.org/api?REDACTED");
  });

  it("an Etherscan route drops the caller's chainid in any letter case, so a submit never goes to another chain (R-RT-1)", () => {
    for (const query of [
      "chainid=1",
      "ChainId=1",
      "CHAINID=1&team=abcdefgh",
      "team=abcdefgh&chainId=1&chainid=10",
      "chain%49d=1",
      "chainid",
      "&&chainid=1&",
    ]) {
      const route = resolve(SEPOLIA, {
        backend: "etherscan-v2",
        apiUrl: `https://proxy.example.org/api?${query}`,
      });
      const url = new URL(route.requestUrl(""));
      const chains = [...url.searchParams.entries()]
        .filter(([name]) => name.toLowerCase() === "chainid")
        .map(([, value]) => value);
      assert.deepEqual(chains, [String(SEPOLIA)], query);
      assert.equal(url.searchParams.get("team"), query.includes("team") ? "abcdefgh" : null);
    }
  });

  it("adds no chainid for other backends (R-RT-1)", () => {
    assert.equal(resolve(SEPOLIA).requestUrl("/v2/x"), `${SOURCIFY_API_URL}/v2/x`);
  });
});

describe("resolveRoute: the route fields of the key rule (R-SEC-2, #58)", () => {
  it("the route records overridden and the table host (R-SEC-2, #58)", () => {
    const fromTable = resolve(SEPOLIA, undefined, { apiKeys: { "etherscan-v2": ETHERSCAN_KEY } });
    assert.equal(fromTable.overridden, false);
    assert.equal(fromTable.tableHost, "api.etherscan.io");
    assert.equal(resolve(FUJI).tableHost, "api.routescan.io");
    assert.equal(resolve(SEPOLIA).tableHost, "sourcify.dev");

    const moved = resolve(SEPOLIA, {
      backend: "etherscan-v2",
      apiUrl: "https://proxy.example.org/api",
    });
    assert.equal(moved.overridden, true);
    assert.equal(moved.tableHost, "api.etherscan.io");
    const same = resolve(SEPOLIA, { backend: "etherscan-v2", apiUrl: ETHERSCAN_API });
    assert.equal(same.overridden, true);
  });

  it("sends a key from apiKeys only to the table host of an unchanged route (R-SEC-2)", () => {
    const apiKeys: ApiKeys = { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY };
    const keys = () => apiKeys;
    const ether = resolve(SEPOLIA, undefined, { apiKeys });
    assert.equal(
      keyFor({ route: ether, apiKeys: keys }, "etherscan-v2", ether.requestUrl("")),
      ETHERSCAN_KEY,
    );
    const routescan = resolve(FUJI, undefined, { apiKeys });
    assert.equal(
      keyFor({ route: routescan, apiKeys: keys }, "routescan", routescan.requestUrl("")),
      ROUTESCAN_KEY,
    );
    // The caller's apiUrl, even on the table's own host, gets no key from apiKeys.
    for (const apiUrl of [ETHERSCAN_API, "https://proxy.example.org/api"]) {
      const route = resolve(SEPOLIA, { backend: "etherscan-v2", apiUrl }, { apiKeys });
      assert.equal(
        keyFor({ route, apiKeys: keys }, "etherscan-v2", route.requestUrl("")),
        undefined,
      );
      const error = thrown(() => {
        requireKey({ route, apiKeys: keys }, false, []);
      });
      assert.equal(error.code, "missing-api-key");
      assert.match(error.message, /apiKeys\.etherscan-v2 is sent only to api\.etherscan\.io/);
    }
    // A Sourcify route never gets a key.
    const sourcify = resolve(SEPOLIA, undefined, {});
    assert.equal(
      keyFor({ route: sourcify, apiKeys: keys }, "sourcify", sourcify.requestUrl("/x")),
      undefined,
    );
  });

  it("sends route.apiKey only with route.apiUrl, to that host (R-SEC-2)", () => {
    const route = resolve(999_999, {
      backend: "etherscan-compatible",
      apiUrl: "https://explorer.example.org/api",
      apiKey: ROUTE_KEY,
    });
    assert.equal(keyFor({ route }, "etherscan-compatible", route.requestUrl("")), ROUTE_KEY);
    assert.equal(keyFor({ route }, "etherscan-compatible", ETHERSCAN_API), undefined);
    const error = thrown(() => resolve(SEPOLIA, { backend: "etherscan-v2", apiKey: ROUTE_KEY }));
    assert.deepEqual(error.details, {
      code: "invalid-input",
      issues: [
        { field: "route.apiKey", message: "needs route.apiUrl: the key is sent only to that host" },
      ],
    });
    assert.ok(!JSON.stringify([error.message, error.toJSON()]).includes(ROUTE_KEY));
  });

  it("names the routing table's host in the missing-key message when the table lists none", () => {
    const route = resolve(999_999, {
      backend: "etherscan-v2",
      apiUrl: "https://proxy.example.org/api",
    });
    const error = thrown(() => {
      requireKey({ route }, false, []);
    });
    assert.equal(
      error.message,
      "etherscan-v2 needs an API key and none is set for proxy.example.org: apiKeys.etherscan-v2 is sent only to the routing table's host; set route.apiKey for proxy.example.org.",
    );
  });
});

/** A fetch for calls that must send nothing. */
const noRequest: typeof globalThis.fetch = async () => assert.fail("no request expected");

/** A client that answers every lookup with a match and records the route it was given. */
function matchingClient(name: BackendName, seen: string[]): Backend {
  return {
    name,
    lookup: async (_target, ctx) => {
      seen.push(`${ctx.route.backend} ${ctx.route.requestUrl("")}`);
      return "exact";
    },
    submit: () => Promise.reject(new Error("no submit expected")),
    poll: () => Promise.reject(new Error("no poll expected")),
    explorerUrl: () => undefined,
  };
}

function input(chainId: number): VerifyInput {
  return {
    chainId,
    address: ADDRESS,
    contractName: "src/A.sol:A",
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "src/A.sol": { content: "contract A {}" } },
        settings: {},
      },
    },
  };
}

describe("verify(): routing options (R-RT-3)", () => {
  it("throws unsupported-chain before any request for a chain missing from the table (R-RT-3)", async () => {
    let sent = 0;
    const fetch: typeof globalThis.fetch = async () => {
      sent += 1;
      return new Response("{}", { status: 500 });
    };
    await assert.rejects(runVerify(input(999_999), { fetch }, DEFAULT_DEPENDENCIES), (error) => {
      assert.ok(error instanceof ExplorerVerifyError);
      assert.equal(error.code, "unsupported-chain");
      assert.match(error.hint, /allowSourcifyFallback/);
      return true;
    });
    assert.equal(sent, 0);
  });

  it("passes the caller's keys to the routing table, so a keyed backend is chosen only with its key (R-RT-1)", async () => {
    const seen: string[] = [];
    const dependencies = {
      table: TABLE,
      backends: {
        "etherscan-v2": matchingClient("etherscan-v2", seen),
        sourcify: matchingClient("sourcify", seen),
      },
    };
    const fetch = noRequest;
    const keyed = await runVerify(
      input(SEPOLIA),
      { fetch, apiKeys: { "etherscan-v2": ETHERSCAN_KEY } },
      dependencies,
    );
    assert.equal(keyed.backend, "etherscan-v2");
    const keyless = await runVerify(input(SEPOLIA), { fetch }, dependencies);
    assert.equal(keyless.backend, "sourcify");
    assert.deepEqual(seen, [
      `etherscan-v2 ${ETHERSCAN_API}?chainid=${String(SEPOLIA)}`,
      `sourcify ${SOURCIFY_API_URL}`,
    ]);
  });

  it("refuses allowSourcifyFallback that is not a boolean", async () => {
    for (const value of ["true", 1, null]) {
      const options: VerifyOptions = { fetch: async () => assert.fail("no request expected") };
      Reflect.set(options, "allowSourcifyFallback", value);
      await assert.rejects(runVerify(input(1), options, DEFAULT_DEPENDENCIES), (error) => {
        assert.ok(error instanceof ExplorerVerifyError);
        assert.deepEqual(error.details, {
          code: "invalid-input",
          issues: [{ field: "allowSourcifyFallback", message: "must be a boolean" }],
        });
        return true;
      });
    }
  });
});

describe("routing table: the shipped file (R-RT-1, R-SEC-2)", () => {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../../src/routing/table.json", import.meta.url), "utf8"),
  );

  it("passes every check", () => {
    assert.deepEqual(tableProblems(raw), []);
  });

  it("is the table the resolver reads", () => {
    assert.deepEqual(ROUTING_TABLE, raw);
  });

  it("lists only backends with a client in this release (R-RT-1)", () => {
    const clients = Object.keys(DEFAULT_DEPENDENCIES.backends);
    for (const chain of ROUTING_TABLE.chains) {
      for (const entry of chain.backends) {
        assert.ok(clients.includes(entry.backend), `${String(chain.chainId)}: ${entry.backend}`);
      }
    }
  });

  it("dates the table with its newest row (R-RT-1)", () => {
    const newest = ROUTING_TABLE.chains
      .map((chain) => chain.checked)
      .toSorted()
      .at(-1);
    assert.equal(ROUTING_TABLE.checked, newest);
  });
});

function brokenTable(...chains: unknown[]): unknown {
  return { schemaVersion: 1, checked: "2026-11-03", chains };
}

function brokenRow(chainId: unknown, ...backends: unknown[]): Record<string, unknown> {
  return { chainId, name: "Chain", checked: "2026-11-03", backends };
}

describe("routing table: the checks fail on a broken table (R-RT-1, R-SEC-2)", () => {
  const sourcify = sourcifyEntry(1);

  it("accepts a table with Etherscan, Routescan and Sourcify rows", () => {
    assert.deepEqual(tableProblems(TABLE), []);
  });

  const broken: [string, unknown, RegExp][] = [
    [
      "a duplicate chain id",
      brokenTable(brokenRow(1, sourcify), brokenRow(1, sourcify)),
      /chain 1: chain ids must be unique and ascending/,
    ],
    [
      "chain ids out of order",
      brokenTable(brokenRow(5, sourcify), brokenRow(1, sourcify)),
      /chain 1: chain ids must be unique and ascending/,
    ],
    [
      "an http: URL",
      brokenTable(brokenRow(1, { ...sourcify, apiUrl: "http://sourcify.dev/server" })),
      /apiUrl must use https:/,
    ],
    [
      "a query string",
      brokenTable(brokenRow(1, { ...sourcify, apiUrl: "https://sourcify.dev/server?x=1" })),
      /apiUrl must not hold a query string/,
    ],
    [
      "an empty query string",
      brokenTable(brokenRow(1, { ...sourcify, apiUrl: "https://sourcify.dev/server?" })),
      /apiUrl must not hold a query string/,
    ],
    [
      "a fragment",
      brokenTable(brokenRow(1, { ...sourcify, apiUrl: "https://sourcify.dev/server#" })),
      /apiUrl must not hold a fragment/,
    ],
    [
      "a user name",
      brokenTable(brokenRow(1, { ...sourcify, apiUrl: "https://u@sourcify.dev/server" })),
      /user name or password/,
    ],
    [
      "a trailing slash",
      brokenTable(brokenRow(1, { ...sourcify, apiUrl: "https://sourcify.dev/server/" })),
      /no trailing slash/,
    ],
    [
      "an upper-case host",
      brokenTable(brokenRow(1, { ...sourcify, apiUrl: "https://Sourcify.dev/server" })),
      /written as origin and path/,
    ],
    [
      "a Routescan URL whose chain id differs from the row",
      brokenTable(
        brokenRow(FUJI, { ...ROUTESCAN, apiUrl: ROUTESCAN_API.replace(String(FUJI), "43114") }),
      ),
      /apiUrl path must match/,
    ],
    [
      "a Routescan URL with another network segment",
      brokenTable(
        brokenRow(FUJI, { ...ROUTESCAN, apiUrl: ROUTESCAN_API.replace("testnet", "devnet") }),
      ),
      /apiUrl path must match/,
    ],
    [
      "an etherscan-v2 row on another host",
      brokenTable(
        brokenRow(1, { ...ETHERSCAN, apiUrl: "https://api.etherscan.io.evil.example/v2/api" }),
      ),
      /apiUrl host must be api\.etherscan\.io/,
    ],
    [
      "an etherscan-v2 row on a port",
      brokenTable(brokenRow(1, { ...ETHERSCAN, apiUrl: "https://api.etherscan.io:8443/v2/api" })),
      /apiUrl host must be api\.etherscan\.io/,
    ],
    [
      "an etherscan-v2 row on the v1 path",
      brokenTable(brokenRow(1, { ...ETHERSCAN, apiUrl: "https://api.etherscan.io/api" })),
      /apiUrl path must match/,
    ],
    [
      "a sourcify row on another host",
      brokenTable(brokenRow(1, { ...sourcify, apiUrl: "https://sourcify.example.org/server" })),
      /apiUrl host must be sourcify\.dev/,
    ],
    [
      "an explorer template without {address}",
      brokenTable(brokenRow(1, { ...sourcify, explorerUrl: "https://repo.sourcify.dev/1/" })),
      /exactly one \{address\}/,
    ],
    [
      "an explorer template with two {address}",
      brokenTable(
        brokenRow(1, { ...sourcify, explorerUrl: "https://repo.sourcify.dev/{address}/{address}" }),
      ),
      /exactly one \{address\}/,
    ],
    [
      "an http: explorer template",
      brokenTable(
        brokenRow(1, { ...sourcify, explorerUrl: "http://repo.sourcify.dev/1/{address}" }),
      ),
      /explorerUrl must be an https: URL/,
    ],
    [
      "an explorer template with a user name",
      brokenTable(
        brokenRow(1, { ...sourcify, explorerUrl: "https://u:p@repo.sourcify.dev/1/{address}" }),
      ),
      /explorerUrl must not hold a user name/,
    ],
    [
      "an explorer template that is not text",
      brokenTable(brokenRow(1, { ...sourcify, explorerUrl: 1 })),
      /explorerUrl must be a string/,
    ],
    [
      "an unknown backend",
      brokenTable(brokenRow(1, { ...sourcify, backend: "etherscan" })),
      /backend must be a name in BACKEND_NAMES/,
    ],
    [
      "a backend with no host rule yet",
      brokenTable(brokenRow(1, { ...sourcify, backend: "blockscout" })),
      /blockscout has no host rule yet/,
    ],
    [
      "a backend listed twice",
      brokenTable(brokenRow(1, sourcify, sourcify)),
      /sourcify is listed twice/,
    ],
    [
      "an apiUrl that is not a URL",
      brokenTable(brokenRow(1, { ...sourcify, apiUrl: "sourcify" })),
      /apiUrl is not an absolute URL/,
    ],
    ["a row without backends", brokenTable(brokenRow(1)), /backends must be a non-empty list/],
    [
      "a backend entry that is not an object",
      brokenTable(brokenRow(1, "sourcify")),
      /must be an object/,
    ],
    [
      "an unknown entry field",
      brokenTable(brokenRow(1, { ...sourcify, apiKey: "x" })),
      /apiKey is not a known field/,
    ],
    [
      "a missing row field",
      brokenTable({ chainId: 1, backends: [sourcify], checked: "2026-11-03" }),
      /name is missing/,
    ],
    [
      "a blank name",
      brokenTable({ ...brokenRow(1, sourcify), name: " " }),
      /name must be a non-empty string/,
    ],
    [
      "a zero chain id",
      brokenTable(brokenRow(0, sourcify)),
      /chainId must be a positive safe integer/,
    ],
    [
      "a chain id given as text",
      brokenTable(brokenRow("1", sourcify)),
      /chainId must be a positive safe integer/,
    ],
    ["a row that is not an object", brokenTable(null), /chains\[0\]: must be an object/],
    [
      "a date that does not exist",
      brokenTable({ ...brokenRow(1, sourcify), checked: "2026-02-30" }),
      /checked must be a YYYY-MM-DD date/,
    ],
    [
      "a row checked after the table",
      brokenTable({ ...brokenRow(1, sourcify), checked: "2026-11-04" }),
      /must not be after the table's date/,
    ],
    [
      "a bad table date",
      { schemaVersion: 1, checked: "03/11/2026", chains: [] },
      /table: checked must be a YYYY-MM-DD date/,
    ],
    [
      "another schema version",
      { schemaVersion: 2, checked: "2026-11-03", chains: [] },
      /schemaVersion must be 1/,
    ],
    [
      "chains that are not a list",
      { schemaVersion: 1, checked: "2026-11-03", chains: {} },
      /chains must be a list/,
    ],
    [
      "an unknown table field",
      { schemaVersion: 1, checked: "2026-11-03", chains: [], extra: 1 },
      /extra is not a known field/,
    ],
    ["a table that is not an object", [], /the table must be an object/],
    [
      "a value shaped like a key",
      brokenTable({ ...brokenRow(1, sourcify), name: "Chain apikey=abcdefgh12345678" }),
      /matches a key pattern/,
    ],
  ];
  for (const [label, value, problem] of broken) {
    it(`fails on ${label}`, () => {
      const problems = tableProblems(value);
      assert.ok(
        problems.some((text) => problem.test(text)),
        `expected ${String(problem)} in ${JSON.stringify(problems)}`,
      );
    });
  }
});
