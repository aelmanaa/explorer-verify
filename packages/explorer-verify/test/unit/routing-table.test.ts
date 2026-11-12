// Tests for the routing table and the resolver (#59, #60): the table's compact format and its
// checks, the backend selection, the Sourcify fallback, and the route fields the key rule reads
// (R-RT-1 to R-RT-3, R-SEC-2, decisions 0016 and 0024). The resolver tests pass their own table;
// the table tests run on the shipped file and on broken copies of it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { BackendName } from "../../src/backend-names.ts";
import type { Backend } from "../../src/backends/backend.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { DEFAULT_DEPENDENCIES } from "../../src/flow/defaults.ts";
import { keyFor, requireKey } from "../../src/http/api-keys.ts";
import type { CheckedKeys } from "../../src/http/api-keys.ts";
import { routingTableDate } from "../../src/routing/load-table.ts";
import { ETHERSCAN_API_URL, SOURCIFY_API_URL, tableTarget } from "../../src/routing/resolve.ts";
import type { RouteChoice, RoutingTable, TableEntry, TableRow } from "../../src/routing/resolve.ts";
import { ROUTING_TABLE } from "../../src/routing/table.ts";
import type { Hex, RouteOverride, VerifyInput, VerifyOptions } from "../../src/types.ts";
import { runVerify } from "../helpers/defaults.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import { resolveRoute } from "../helpers/route.ts";
import { apiUrlProblems, explorerUrlProblems, tableProblems } from "../helpers/routing-table.ts";

// Made-up keys. Never real ones (R-SEC-1).
const ETHERSCAN_KEY = "etherscan-dummy-key-59a1";
const ROUTESCAN_KEY = "routescan-dummy-key-59b2";
const ROUTE_KEY = "standalone-dummy-key-59c3";
const ADDRESS: Hex = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
// The Sepolia Greeter of the recorded Etherscan and Sourcify lookups.
const GREETER: Hex = "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC";
const FUJI = 43113;
const SEPOLIA = 11155111;
const ETHERSCAN_API = "https://api.etherscan.io/v2/api";
const ROUTESCAN_API = `https://api.routescan.io/v2/network/testnet/evm/${String(FUJI)}/etherscan/api`;

const ETHERSCAN: TableEntry = { backend: "etherscan-v2", explorer: "sepolia.etherscan.io" };
const ROUTESCAN: TableEntry = { backend: "routescan", network: "testnet" };
const SOURCIFY: TableEntry = { backend: "sourcify" };
const BLOCKSCOUT_HOST = "eth-sepolia.blockscout.com";
const BLOCKSCOUT: TableEntry = { backend: "blockscout", instance: BLOCKSCOUT_HOST };
const STANDALONE: TableEntry = {
  backend: "etherscan-compatible",
  api: "api.btrscan.com/scan/api",
  explorer: "www.btrscan.com",
};

function row(chainId: number, backends: TableEntry[]): TableRow {
  return { chainId, backends };
}

/** A table in the format the M2 rows will use: Etherscan, Routescan and Sourcify. */
const TABLE: RoutingTable = {
  schemaVersion: 3,
  checked: "2026-11-03",
  chains: [row(FUJI, [ROUTESCAN, SOURCIFY]), row(SEPOLIA, [ETHERSCAN, SOURCIFY])],
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
      | CheckedKeys
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
      "Etherscan needs an API key and none is set for api.etherscan.io: set apiKeys.etherscan-v2, or handlerUrl.",
    );
  });

  it("ignores a row entry whose backend is not a known name", () => {
    const table: RoutingTable = {
      ...TABLE,
      chains: [row(SEPOLIA, [{ ...ETHERSCAN, backend: "etherscan" }, SOURCIFY])],
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
      chains: [row(SEPOLIA, [ETHERSCAN, { ...ROUTESCAN }, SOURCIFY])],
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

  it("derives the contract page from the row (R-FLOW-3, decision 0024)", () => {
    const keyed = resolve(SEPOLIA, undefined, { apiKeys: { "etherscan-v2": ETHERSCAN_KEY } });
    assert.equal(
      explorerLink(keyed)(ADDRESS),
      `https://sepolia.etherscan.io/address/${ADDRESS}#code`,
    );
    // No page is derived for an Etherscan entry without an explorer host, nor for Routescan yet.
    const bare: RoutingTable = { ...TABLE, chains: [row(SEPOLIA, [{ backend: "etherscan-v2" }])] };
    assert.equal(resolveRoute(SEPOLIA, undefined, { table: bare }).explorerUrl, undefined);
    assert.equal(resolve(FUJI).explorerUrl, undefined);
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
      `The routing table lists no Routescan API for chain ${String(SEPOLIA)}.`,
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
      // The backend's one API host, read from no row, for the hint (decision 0040).
      const host = new Map([
        ["etherscan-v2", "api.etherscan.io"],
        ["routescan", "api.routescan.io"],
      ]).get(backend);
      assert.equal(route.tableHost, host);
    }
  });

  it("takes sourcify as the backend of a route.apiUrl without route.backend (R-RT-2)", () => {
    const route = resolve(FUJI, { apiUrl: "http://127.0.0.1:5555" });
    assert.equal(route.backend, "sourcify");
    assert.equal(route.explorerUrl, undefined);
  });

  it("keeps the row's page when route.apiUrl names the row's own API (R-FLOW-3)", () => {
    const route = resolve(SEPOLIA, { backend: "etherscan-v2", apiUrl: `${ETHERSCAN_API}/` });
    assert.equal(route.apiBase, ETHERSCAN_API);
    assert.equal(
      explorerLink(route)(ADDRESS),
      `https://sepolia.etherscan.io/address/${ADDRESS}#code`,
    );
    const routescan = resolve(FUJI, { backend: "routescan", apiUrl: `${ROUTESCAN_API}/` });
    assert.equal(routescan.apiBase, ROUTESCAN_API);
    assert.equal(routescan.tableHost, "api.routescan.io");
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
      "Leave out route.backend, or name one of: etherscan-v2, etherscan-compatible, blockscout, blockscout-hosted, sourcify, routescan.",
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
    const apiKeys: CheckedKeys = { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY };
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
    // The caller's apiUrl on Etherscan's own API takes the key (#244); on another host it does not.
    const own = resolve(SEPOLIA, { backend: "etherscan-v2", apiUrl: ETHERSCAN_API }, { apiKeys });
    assert.equal(
      keyFor({ route: own, apiKeys: keys }, "etherscan-v2", own.requestUrl("")),
      ETHERSCAN_KEY,
    );
    const moved = resolve(
      SEPOLIA,
      { backend: "etherscan-v2", apiUrl: "https://proxy.example.org/api" },
      { apiKeys },
    );
    assert.equal(
      keyFor({ route: moved, apiKeys: keys }, "etherscan-v2", moved.requestUrl("")),
      undefined,
    );
    const error = thrown(() => {
      requireKey({ route: moved, apiKeys: keys }, false, []);
    });
    assert.equal(error.code, "missing-api-key");
    assert.match(error.message, /apiKeys\.etherscan-v2 goes only to Etherscan's own API/);
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

  it("says where apiKeys goes in the missing-key message when the table lists none (decision 0040, #244)", () => {
    const route = resolve(999_999, {
      backend: "etherscan-v2",
      apiUrl: "https://proxy.example.org/api",
    });
    const error = thrown(() => {
      requireKey({ route }, false, []);
    });
    assert.equal(
      error.message,
      "Etherscan needs an API key and none is set for proxy.example.org: apiKeys.etherscan-v2 goes only to Etherscan's own API; set route.apiKey for this route.apiUrl.",
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
      return { match: "exact" };
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

  it("is dated (R-RT-1)", () => {
    assert.equal(ROUTING_TABLE.checked, "2026-11-05");
  });

  it("sends a call with an Etherscan key to api.etherscan.io, the key in the POST body only (R-RT-1, R-SEC-2, #122)", async () => {
    const fake = replay(loadFixture("etherscan", "2026-11-04-getsourcecode-sepolia-greeter"));
    const result = await runVerify(
      // The recorded lookup names Greeter, so the input names it too (decision 0063).
      { ...input(SEPOLIA), address: GREETER, contractName: "src/A.sol:Greeter" },
      { fetch: fake.fetch, apiKeys: { "etherscan-v2": ETHERSCAN_KEY } },
      DEFAULT_DEPENDENCIES,
    );
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: `https://sepolia.etherscan.io/address/${GREETER.toLowerCase()}#code`,
    });
    assert.equal(fake.calls.length, 1);
    const [call] = fake.calls;
    assert.equal(call?.method, "POST");
    assert.equal(call.url, `${ETHERSCAN_API}?chainid=${String(SEPOLIA)}`);
    assert.equal(new URLSearchParams(call.body).get("apikey"), ETHERSCAN_KEY);
    assert.ok(!call.url.includes(ETHERSCAN_KEY));
    assert.ok(![...call.headers.values()].some((value) => value.includes(ETHERSCAN_KEY)));
  });

  it("sends a call without a key to Sourcify on the same chain, with no key in the request (R-RT-1, #122)", async () => {
    const fake = replay(loadFixture("sourcify", "2026-11-02-lookup-exact-match"));
    const result = await runVerify(
      { ...input(SEPOLIA), address: GREETER },
      { fetch: fake.fetch },
      DEFAULT_DEPENDENCIES,
    );
    assert.equal(result.backend, "sourcify");
    assert.equal(fake.calls.length, 1);
    const [call] = fake.calls;
    assert.equal(
      call?.url,
      `${SOURCIFY_API_URL}/v2/contract/${String(SEPOLIA)}/${GREETER.toLowerCase()}?fields=compilation`,
    );
    assert.equal(call.body, undefined);
    assert.ok(!call.url.includes("apikey"));
    assert.deepEqual(
      [...call.headers.keys()].filter((name) => name.includes("key")),
      [],
    );
  });

  it("gives the table's date to routingTableDate(), which the CLI's --version --json prints (R-AX-11)", async () => {
    // It loads the table with a dynamic import(), so it returns a promise (decision 0040).
    const date = routingTableDate();
    assert.ok(date instanceof Promise);
    assert.equal(await date, ROUTING_TABLE.checked);
    assert.match(await date, /^\d{4}-\d{2}-\d{2}$/);
  });
});

function brokenTable(...chains: unknown[]): unknown {
  return { schemaVersion: 3, checked: "2026-11-03", chains };
}

function brokenRow(chainId: unknown, ...backends: unknown[]): Record<string, unknown> {
  return { chainId, backends };
}

describe("routing table: the checks fail on a broken table (R-RT-1, R-SEC-2)", () => {
  const sourcify = SOURCIFY;

  it("accepts a table with Etherscan, Routescan and Sourcify rows", () => {
    assert.deepEqual(tableProblems(TABLE), []);
    assert.deepEqual(
      tableProblems(brokenTable(brokenRow(1, { backend: "etherscan-v2" }, sourcify))),
      [],
    );
    assert.deepEqual(
      tableProblems(brokenTable(brokenRow(43114, { backend: "routescan", network: "mainnet" }))),
      [],
    );
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
      "an entry that still carries an apiUrl (schema 1)",
      brokenTable(brokenRow(1, { ...sourcify, apiUrl: "https://sourcify.dev/server" })),
      /apiUrl is not a known field/,
    ],
    [
      "an entry that still carries an explorerUrl (schema 1)",
      brokenTable(brokenRow(1, { ...sourcify, explorerUrl: "https://x.example/{address}" })),
      /explorerUrl is not a known field/,
    ],
    [
      "a Sourcify entry with a network",
      brokenTable(brokenRow(1, { ...sourcify, network: "mainnet" })),
      /network is not a known field/,
    ],
    [
      "an Etherscan entry with a network",
      brokenTable(brokenRow(1, { ...ETHERSCAN, network: "mainnet" })),
      /network is not a known field/,
    ],
    [
      "a Routescan entry with an explorer",
      brokenTable(brokenRow(FUJI, { ...ROUTESCAN, explorer: "testnet.snowtrace.io" })),
      /explorer is not a known field/,
    ],
    [
      "a Routescan entry without a network",
      brokenTable(brokenRow(FUJI, { backend: "routescan" })),
      /network is missing/,
    ],
    [
      "a Routescan entry with another network",
      brokenTable(brokenRow(FUJI, { ...ROUTESCAN, network: "devnet" })),
      /network must be mainnet or testnet/,
    ],
    [
      "a Routescan network given as a number",
      brokenTable(brokenRow(FUJI, { ...ROUTESCAN, network: 1 })),
      /network must be mainnet or testnet/,
    ],
    [
      "an explorer host with a scheme",
      brokenTable(brokenRow(1, { ...ETHERSCAN, explorer: "https://etherscan.io" })),
      /explorer must be a lowercase host name/,
    ],
    [
      "an explorer host with a path",
      brokenTable(brokenRow(1, { ...ETHERSCAN, explorer: "etherscan.io/x" })),
      /explorer must be a lowercase host name/,
    ],
    [
      "an explorer host with a port",
      brokenTable(brokenRow(1, { ...ETHERSCAN, explorer: "etherscan.io:8443" })),
      /explorer must be a lowercase host name/,
    ],
    [
      "an explorer host with a user name",
      brokenTable(brokenRow(1, { ...ETHERSCAN, explorer: "u@etherscan.io" })),
      /explorer must be a lowercase host name/,
    ],
    [
      "an upper-case explorer host",
      brokenTable(brokenRow(1, { ...ETHERSCAN, explorer: "Etherscan.io" })),
      /explorer must be a lowercase host name/,
    ],
    [
      "an explorer host without a dot",
      brokenTable(brokenRow(1, { ...ETHERSCAN, explorer: "localhost" })),
      /explorer must be a lowercase host name/,
    ],
    [
      "an explorer host that is not text",
      brokenTable(brokenRow(1, { ...ETHERSCAN, explorer: 1 })),
      /explorer must be a lowercase host name/,
    ],
    [
      "an unknown backend",
      brokenTable(brokenRow(1, { ...sourcify, backend: "etherscan" })),
      /backend must be a name in BACKEND_NAMES/,
    ],
    [
      "a backend name that is not text",
      brokenTable(brokenRow(1, { backend: 1 })),
      /backend must be a name in BACKEND_NAMES/,
    ],
    [
      "an etherscan-compatible entry without an api (#170)",
      brokenTable(brokenRow(1, { backend: "etherscan-compatible" })),
      /api is missing/,
    ],
    [
      "an etherscan-compatible api with a scheme (#170)",
      brokenTable(brokenRow(1, { ...STANDALONE, api: "https://api.btrscan.com/scan/api" })),
      /api must be a lowercase host name and path/,
    ],
    [
      "an etherscan-compatible api with a port (#170)",
      brokenTable(brokenRow(1, { ...STANDALONE, api: "api.btrscan.com:8443/scan/api" })),
      /api must be a lowercase host name and path/,
    ],
    [
      "an etherscan-compatible api with a trailing slash (#170)",
      brokenTable(brokenRow(1, { ...STANDALONE, api: "api.btrscan.com/scan/api/" })),
      /api must be a lowercase host name and path/,
    ],
    [
      "an etherscan-compatible api with a query (#170)",
      brokenTable(brokenRow(1, { ...STANDALONE, api: "api.btrscan.com/api?x=1" })),
      /api must be a lowercase host name and path/,
    ],
    [
      "an etherscan-compatible api with a dot segment (#170)",
      brokenTable(brokenRow(1, { ...STANDALONE, api: "api.btrscan.com/../api" })),
      /api must be a lowercase host name and path/,
    ],
    [
      "an etherscan-compatible api with a user name (#170)",
      brokenTable(brokenRow(1, { ...STANDALONE, api: "u@api.btrscan.com/api" })),
      /api must be a lowercase host name and path/,
    ],
    [
      "an upper-case etherscan-compatible api (#170)",
      brokenTable(brokenRow(1, { ...STANDALONE, api: "API.btrscan.com/api" })),
      /api must be a lowercase host name and path/,
    ],
    [
      "an etherscan-compatible api that is not text (#170)",
      brokenTable(brokenRow(1, { ...STANDALONE, api: 1 })),
      /api must be a lowercase host name and path/,
    ],
    [
      "an etherscan-compatible needsKey other than true (#170)",
      brokenTable(brokenRow(1, { ...STANDALONE, needsKey: false })),
      /needsKey must be true, or left out/,
    ],
    [
      "an etherscan-compatible explorer with a path (#170)",
      brokenTable(brokenRow(1, { ...STANDALONE, explorer: "www.btrscan.com/x" })),
      /explorer must be a lowercase host name/,
    ],
    [
      "an etherscan-compatible api on an IPv4 literal (#170)",
      brokenTable(brokenRow(1, { ...STANDALONE, api: "192.168.1.10/api" })),
      /api must be a lowercase host name and path/,
    ],
    [
      "an etherscan-compatible api on an IPv6 literal (#170)",
      brokenTable(brokenRow(1, { ...STANDALONE, api: "[::1]/api" })),
      /api must be a lowercase host name and path/,
    ],
    [
      "an explorer host that is an IPv4 literal (#170)",
      brokenTable(brokenRow(1, { ...ETHERSCAN, explorer: "10.0.0.1" })),
      /explorer must be a lowercase host name/,
    ],
    [
      "an explorer host that is an IPv6 literal (#170)",
      brokenTable(brokenRow(1, { ...ETHERSCAN, explorer: "[::1]" })),
      /explorer must be a lowercase host name/,
    ],
    [
      "a blockscout instance that is an IPv4 literal (#170)",
      brokenTable(brokenRow(1, { backend: "blockscout", instance: "127.0.0.1" })),
      /instance must be a lowercase host name/,
    ],
    [
      "a blockscout instance that is an IPv6 literal (#170)",
      brokenTable(brokenRow(1, { backend: "blockscout", instance: "[2001:db8::1]" })),
      /instance must be a lowercase host name/,
    ],
    [
      "an api field on another backend (#170)",
      brokenTable(brokenRow(1, { ...ETHERSCAN, api: "api.btrscan.com/scan/api" })),
      /api is not a known field/,
    ],
    [
      "a needsKey field on another backend (#170)",
      brokenTable(brokenRow(1, { ...ETHERSCAN, needsKey: true })),
      /needsKey is not a known field/,
    ],
    [
      "a blockscout entry without an instance (R-BE-3)",
      brokenTable(brokenRow(1, { backend: "blockscout" })),
      /instance is missing/,
    ],
    [
      "a blockscout instance with a scheme or path",
      brokenTable(
        brokenRow(1, { backend: "blockscout", instance: "https://x.blockscout.com/api" }),
      ),
      /instance must be a lowercase host name/,
    ],
    [
      "a blockscout instance that is not text",
      brokenTable(brokenRow(1, { backend: "blockscout", instance: 1 })),
      /instance must be a lowercase host name/,
    ],
    [
      "an instance field on another backend",
      brokenTable(brokenRow(1, { ...sourcify, instance: "x.blockscout.com" })),
      /instance is not a known field/,
    ],
    [
      "a backend listed twice",
      brokenTable(brokenRow(1, sourcify, sourcify)),
      /sourcify is listed twice/,
    ],
    ["a row without backends", brokenTable(brokenRow(1)), /backends must be a non-empty list/],
    [
      "a row whose backends are not a list",
      brokenTable({ chainId: 1, backends: sourcify }),
      /backends must be a non-empty list/,
    ],
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
      "a row that still carries a name (schema 1)",
      brokenTable({ ...brokenRow(1, sourcify), name: "Chain" }),
      /name is not a known field/,
    ],
    [
      "a row that still carries a date (schema 1)",
      brokenTable({ ...brokenRow(1, sourcify), checked: "2026-11-03" }),
      /checked is not a known field/,
    ],
    ["a missing row field", brokenTable({ chainId: 1 }), /backends is missing/],
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
      { schemaVersion: 3, checked: "2026-02-30", chains: [] },
      /table: checked must be a YYYY-MM-DD date/,
    ],
    [
      "a bad table date",
      { schemaVersion: 3, checked: "03/11/2026", chains: [] },
      /table: checked must be a YYYY-MM-DD date/,
    ],
    [
      "a table date that is not text",
      { schemaVersion: 3, checked: 20261103, chains: [] },
      /table: checked must be a YYYY-MM-DD date/,
    ],
    [
      "schema version 1",
      { schemaVersion: 1, checked: "2026-11-03", chains: [] },
      /schemaVersion must be 3/,
    ],
    [
      "schema version 2 in the shipped file (#170)",
      { schemaVersion: 2, checked: "2026-11-03", chains: [] },
      /schemaVersion must be 3/,
    ],
    [
      "chains that are not a list",
      { schemaVersion: 3, checked: "2026-11-03", chains: {} },
      /chains must be a list/,
    ],
    [
      "a table that keeps its source list (moved to the research data)",
      { schemaVersion: 3, checked: "2026-11-03", sources: [], chains: [] },
      /sources is not a known field/,
    ],
    [
      "an unknown table field",
      { schemaVersion: 3, checked: "2026-11-03", chains: [], extra: 1 },
      /extra is not a known field/,
    ],
    ["a table that is not an object", [], /the table must be an object/],
    [
      "a value shaped like a key",
      brokenTable(brokenRow(1, { ...ETHERSCAN, explorer: "apikey=abcdefgh12345678" })),
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

describe("routing table: the URL checks on derived URLs (R-SEC-2, #59)", () => {
  const urls: [string, BackendName, number, string, RegExp][] = [
    ["an http: URL", "sourcify", 1, "http://sourcify.dev/server", /apiUrl must use https:/],
    ["a query string", "sourcify", 1, "https://sourcify.dev/server?x=1", /query string/],
    ["an empty query string", "sourcify", 1, "https://sourcify.dev/server?", /query string/],
    ["a fragment", "sourcify", 1, "https://sourcify.dev/server#", /fragment/],
    ["a user name", "sourcify", 1, "https://u@sourcify.dev/server", /user name or password/],
    ["a trailing slash", "sourcify", 1, "https://sourcify.dev/server/", /no trailing slash/],
    ["an upper-case host", "sourcify", 1, "https://Sourcify.dev/server", /origin and path/],
    ["text that is not a URL", "sourcify", 1, "sourcify", /not an absolute URL/],
    [
      "a Routescan URL whose chain id differs from the row",
      "routescan",
      FUJI,
      ROUTESCAN_API.replace(String(FUJI), "43114"),
      /apiUrl path must match/,
    ],
    [
      "a Routescan URL with another network segment",
      "routescan",
      FUJI,
      ROUTESCAN_API.replace("testnet", "devnet"),
      /apiUrl path must match/,
    ],
    [
      "an etherscan-v2 URL on another host",
      "etherscan-v2",
      1,
      "https://api.etherscan.io.evil.example/v2/api",
      /apiUrl host must be api\.etherscan\.io/,
    ],
    [
      "an etherscan-v2 URL on a port",
      "etherscan-v2",
      1,
      "https://api.etherscan.io:8443/v2/api",
      /apiUrl host must be api\.etherscan\.io/,
    ],
    [
      "an etherscan-v2 URL on the v1 path",
      "etherscan-v2",
      1,
      "https://api.etherscan.io/api",
      /apiUrl path must match/,
    ],
    [
      "a sourcify URL on another host",
      "sourcify",
      1,
      "https://sourcify.example.org/server",
      /apiUrl host must be sourcify\.dev/,
    ],
    [
      "an etherscan-compatible URL without the entry's api (#170)",
      "etherscan-compatible",
      1,
      "https://explorer.example.org/api",
      /apiUrl host must be/,
    ],
    [
      "a blockscout URL without the entry's instance",
      "blockscout",
      1,
      "https://eth.blockscout.com/api",
      /apiUrl host must be/,
    ],
  ];
  for (const [label, backend, chainId, url, problem] of urls) {
    it(`fails on ${label}`, () => {
      const problems = apiUrlProblems(url, backend, chainId, "entry");
      assert.ok(
        problems.some((text) => problem.test(text)),
        `expected ${String(problem)} in ${JSON.stringify(problems)}`,
      );
    });
  }

  it("passes the URLs the resolver derives", () => {
    for (const [chainId, entry] of [
      [1, ETHERSCAN],
      [FUJI, ROUTESCAN],
      [SEPOLIA, SOURCIFY],
    ] satisfies [number, TableEntry][]) {
      const target = tableTarget(chainId, entry) ?? assert.fail("no target");
      assert.deepEqual(apiUrlProblems(target.apiUrl, target.backend, chainId, "entry"), []);
    }
    const blockscout = tableTarget(SEPOLIA, BLOCKSCOUT) ?? assert.fail("no target");
    assert.deepEqual(
      apiUrlProblems(blockscout.apiUrl, "blockscout", SEPOLIA, "entry", BLOCKSCOUT_HOST),
      [],
    );
    assert.ok(
      apiUrlProblems(
        `https://${BLOCKSCOUT_HOST}/api/v2`,
        "blockscout",
        SEPOLIA,
        "e",
        BLOCKSCOUT_HOST,
      ).length > 0,
    );
  });

  it("passes a table with a blockscout entry, the instance checked as a host (R-BE-3)", () => {
    const table: RoutingTable = { ...TABLE, chains: [row(SEPOLIA, [SOURCIFY, BLOCKSCOUT])] };
    assert.deepEqual(tableProblems(table), []);
  });

  it("passes a table with etherscan-compatible entries, the api checked as a host and path (#170)", () => {
    const table: RoutingTable = {
      ...TABLE,
      chains: [
        row(1116, [
          { backend: "etherscan-compatible", api: "openapi.coredao.org", needsKey: true },
        ]),
        row(200_901, [STANDALONE]),
      ],
    };
    assert.deepEqual(tableProblems(table), []);
    const target = tableTarget(200_901, STANDALONE) ?? assert.fail("no target");
    assert.deepEqual(
      apiUrlProblems(
        target.apiUrl,
        "etherscan-compatible",
        200_901,
        "e",
        "api.btrscan.com/scan/api",
      ),
      [],
    );
    assert.ok(
      apiUrlProblems(
        "https://api.btrscan.com/scan/apix",
        "etherscan-compatible",
        200_901,
        "e",
        "api.btrscan.com/scan/api",
      ).some((text) => /apiUrl path must match/.test(text)),
    );
    // A dot in the path matches only a dot.
    assert.ok(
      apiUrlProblems("https://x.example/a-b", "etherscan-compatible", 1, "e", "x.example/a.b")
        .length > 0,
    );
  });

  const pages: [string, string, RegExp][] = [
    ["an http: page", `http://etherscan.io/address/${ADDRESS}`, /must be an https: URL/],
    ["a page that is not a URL", "etherscan.io", /must be an https: URL/],
    [
      "a page with a user name",
      `https://u:p@etherscan.io/address/${ADDRESS}`,
      /must not hold a user name/,
    ],
    ["a page without the address", "https://etherscan.io/address/", /hold the address/],
  ];
  for (const [label, url, problem] of pages) {
    it(`fails on ${label}`, () => {
      const problems = explorerUrlProblems(url, "entry");
      assert.ok(
        problems.some((text) => problem.test(text)),
        `expected ${String(problem)} in ${JSON.stringify(problems)}`,
      );
    });
  }
});

describe("tableTarget: one place derives every URL (decision 0024)", () => {
  it("derives the API base and page of each backend", () => {
    const sourcify = tableTarget(SEPOLIA, SOURCIFY) ?? assert.fail("no target");
    assert.equal(sourcify.apiUrl, SOURCIFY_API_URL);
    assert.equal(
      sourcify.explorerUrl?.(ADDRESS),
      `https://repo.sourcify.dev/${String(SEPOLIA)}/${ADDRESS}`,
    );
    const etherscan = tableTarget(SEPOLIA, ETHERSCAN) ?? assert.fail("no target");
    assert.equal(etherscan.apiUrl, ETHERSCAN_API_URL);
    assert.equal(
      etherscan.explorerUrl?.(ADDRESS),
      `https://sepolia.etherscan.io/address/${ADDRESS}#code`,
    );
    assert.equal(tableTarget(SEPOLIA, { backend: "etherscan-v2" })?.explorerUrl, undefined);
    assert.equal(tableTarget(FUJI, ROUTESCAN)?.apiUrl, ROUTESCAN_API);
    assert.equal(
      tableTarget(43114, { backend: "routescan", network: "mainnet" })?.apiUrl,
      "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api",
    );
    const blockscout = tableTarget(SEPOLIA, BLOCKSCOUT) ?? assert.fail("no target");
    assert.equal(blockscout.backend, "blockscout");
    assert.equal(blockscout.apiUrl, `https://${BLOCKSCOUT_HOST}/api`);
    assert.equal(
      blockscout.explorerUrl?.("0x/a?b#c"),
      `https://${BLOCKSCOUT_HOST}/address/0x%2Fa%3Fb%23c?tab=contract`,
    );
  });

  it("routes a row's blockscout entry to the instance, with its page and host (R-BE-3, R-SEC-2)", () => {
    const table: RoutingTable = { ...TABLE, chains: [row(SEPOLIA, [BLOCKSCOUT, SOURCIFY])] };
    const route = resolveRoute(SEPOLIA, undefined, { table });
    assert.equal(route.backend, "blockscout");
    assert.equal(route.apiBase, `https://${BLOCKSCOUT_HOST}/api`);
    assert.equal(route.tableHost, BLOCKSCOUT_HOST);
    assert.equal(
      route.requestUrl(`/v2/smart-contracts/${ADDRESS}`),
      `https://${BLOCKSCOUT_HOST}/api/v2/smart-contracts/${ADDRESS}`,
    );
    assert.equal(
      explorerLink(route)(ADDRESS),
      `https://${BLOCKSCOUT_HOST}/address/${ADDRESS}?tab=contract`,
    );
  });

  it("percent-encodes the address in both page templates (R-FLOW-3)", () => {
    // Hex is `0x${string}`, so an odd address needs no cast. Without encodeURIComponent, the
    // slash, question mark and hash would change the page's path, query and fragment.
    const odd: Hex = "0x/a?b#c";
    const etherscan = tableTarget(1, ETHERSCAN)?.explorerUrl ?? assert.fail("no page");
    assert.equal(etherscan(odd), "https://sepolia.etherscan.io/address/0x%2Fa%3Fb%23c#code");
    const sourcify = tableTarget(SEPOLIA, SOURCIFY)?.explorerUrl ?? assert.fail("no page");
    assert.equal(sourcify(odd), `https://repo.sourcify.dev/${String(SEPOLIA)}/0x%2Fa%3Fb%23c`);
    // The fallback route of a chain without a row gets the same Sourcify page.
    const fallback = resolveRoute(999_999, undefined, {
      table: TABLE,
      allowSourcifyFallback: true,
    });
    assert.equal(explorerLink(fallback)(odd), "https://repo.sourcify.dev/999999/0x%2Fa%3Fb%23c");
    const dots: Hex = "0x/../?#";
    assert.equal(etherscan(dots), "https://sepolia.etherscan.io/address/0x%2F..%2F%3F%23#code");
  });

  it("derives nothing for an entry it cannot route", () => {
    for (const entry of [
      { backend: "routescan" },
      { backend: "routescan", network: "devnet" },
      { backend: "blockscout" },
      { backend: "etherscan-compatible" },
      { backend: "etherscan" },
    ] satisfies TableEntry[]) {
      assert.equal(tableTarget(1, entry), undefined, JSON.stringify(entry));
    }
  });

  it("drops a Routescan entry without a valid network from a row, so it gets no key", () => {
    const table: RoutingTable = {
      ...TABLE,
      chains: [row(FUJI, [{ backend: "routescan", network: "devnet" }, SOURCIFY])],
    };
    const route = resolveRoute(FUJI, undefined, { table });
    assert.equal(route.backend, "sourcify");
    assert.equal(route.tableHost, "sourcify.dev");
  });
});
