// The routing table loads on demand (R-RUN-3, R-RT-1, R-RT-2, R-RT-4, R-FLOW-6, decision 0040). A
// call whose route.apiUrl cannot be a URL the table lists loads no table; a call without a route
// loads it once, bounded by the signal and the budget, as a client is (decision 0031).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BackendName } from "../../src/backend-names.ts";
import type { Backend, ProxyLinker } from "../../src/backends/backend.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { DEFAULT_DEPENDENCIES } from "../../src/flow/defaults.ts";
import type { FlowDependencies } from "../../src/flow/verify.ts";
import { loadRoutingTable } from "../../src/routing/load-table.ts";
import {
  ETHERSCAN_API_URL,
  SOURCIFY_API_URL,
  checkRoute,
  readsTable,
  routeFrom,
  tableTarget,
} from "../../src/routing/resolve.ts";
import type { RoutingTable, TableLoader } from "../../src/routing/resolve.ts";
import { ROUTING_TABLE } from "../../src/routing/table.ts";
import type { RouteOverride, VerifyInput, VerifyOptions } from "../../src/types.ts";
import {
  runCheckStatus,
  runDryRun,
  runLinkProxy,
  runVerify,
  runVerifyEach,
} from "../helpers/defaults.ts";

const SEPOLIA = 11155111;
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const HANDLE = `ev1:sourcify:${String(SEPOLIA)}:${GREETER}:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718`;
const LOCAL = "http://127.0.0.1:5555";
const TABLE: RoutingTable = {
  schemaVersion: 2,
  checked: "2026-11-05",
  chains: [
    {
      chainId: SEPOLIA,
      backends: [
        { backend: "etherscan-v2", explorer: "sepolia.etherscan.io" },
        { backend: "sourcify" },
        { backend: "blockscout", instance: "eth-sepolia.blockscout.com" },
      ],
    },
  ],
};
const INPUT: VerifyInput = {
  chainId: SEPOLIA,
  address: GREETER,
  compiler: {
    kind: "solc",
    version: "0.8.24+commit.e11b9ed9",
    input: {
      language: "Solidity",
      sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
      settings: {},
    },
  },
  contractName: "contracts/Greeter.sol:Greeter",
};

/** A fetch that must not be called: the clients in these tests answer without one. */
const noFetch: typeof fetch = async () => {
  throw new Error("no request expected");
};

/** A client that answers every lookup and poll with an exact match and sends nothing. */
function exact(name: BackendName): Backend {
  return {
    ...sourcify,
    name,
    lookup: async () => ({ match: "exact" }),
    poll: async () => ({ state: "verified", match: "exact" }),
  };
}

/** Dependencies whose table loader records each run. A new loader per call: nothing is kept. */
function recording(table: RoutingTable | Promise<never> = TABLE): {
  dependencies: FlowDependencies;
  loads: () => number;
} {
  let count = 0;
  const loader: TableLoader = async () => {
    count += 1;
    return await table;
  };
  return {
    loads: () => count,
    dependencies: {
      backends: {
        sourcify: exact("sourcify"),
        "etherscan-v2": exact("etherscan-v2"),
        blockscout: exact("blockscout"),
      },
      table: loader,
      random: () => 0,
    },
  };
}

/** A promise that never settles, for a table chunk that never arrives. */
function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/**
 * Runs `work` with an interval that keeps the process alive. A load's deadline runs on
 * `AbortSignal.timeout`, which Node 22 does not count as keeping the event loop alive, and a hung
 * loader holds no handle: without the interval, the test runner sees an empty event loop and
 * cancels the test before the deadline fires.
 */
async function keptAlive<T>(work: () => Promise<T>): Promise<T> {
  const alive = setInterval(() => undefined, 1_000);
  try {
    return await work();
  } finally {
    clearInterval(alive);
  }
}

async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    (value: unknown) => ({ resolved: value }),
    (error: unknown) => error,
  );
}

const FULL: VerifyOptions = { fetch: noFetch, route: { backend: "sourcify", apiUrl: LOCAL } };

describe("a call whose route.apiUrl the table cannot list loads no table (decision 0040)", () => {
  it("verify(), dryRun() and checkStatus() with a full route", async () => {
    const { dependencies, loads } = recording(never());
    assert.equal((await runVerify(INPUT, FULL, dependencies)).status, "already-verified");
    assert.equal((await runDryRun(INPUT, FULL, dependencies)).status, "dry-run");
    assert.equal((await runCheckStatus(HANDLE, FULL, dependencies)).status, "verified");
    assert.equal(loads(), 0);
  });

  it("verifyEach() with every entry a full route (R-RT-4)", async () => {
    const { dependencies, loads } = recording(never());
    const result = await runVerifyEach(
      INPUT,
      {
        fetch: noFetch,
        backends: [
          { backend: "sourcify", apiUrl: LOCAL },
          {
            backend: "etherscan-v2",
            apiUrl: "https://proxy.example.org/api",
            apiKey: "proxy-route-key-217",
          },
        ],
      },
      dependencies,
    );
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.ok),
      [true, true],
    );
    assert.equal(loads(), 0);
  });

  it("linkProxy() with a full route (R-FLOW-8)", async () => {
    let count = 0;
    const linker: ProxyLinker = {
      request: async () => ({
        state: "linked",
        implementation: GREETER,
        implementationVerified: true,
      }),
      check: async () => ({ state: "pending" }),
    };
    const result = await runLinkProxy({ chainId: SEPOLIA, address: GREETER }, FULL, {
      linkers: { sourcify: linker },
      table: async () => {
        count += 1;
        return await never();
      },
    });
    assert.equal(result.status, "linked");
    assert.equal(count, 0);
  });

  it("an invalid route throws before the table loads", async () => {
    const { dependencies, loads } = recording();
    await assert.rejects(runVerify(INPUT, { route: { apiUrl: "ftp://x" } }, dependencies), {
      code: "invalid-input",
    });
    assert.equal(loads(), 0);
  });
});

describe("a call that reads the table loads it (decision 0040)", () => {
  it("verify(), dryRun() and checkStatus() without a route, and the row's page", async () => {
    const { dependencies, loads } = recording();
    const verified = await runVerify(INPUT, { fetch: noFetch }, dependencies);
    assert.deepEqual(verified, {
      status: "already-verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: `https://repo.sourcify.dev/${String(SEPOLIA)}/${GREETER}`,
    });
    assert.equal((await runDryRun(INPUT, { fetch: noFetch }, dependencies)).status, "dry-run");
    assert.equal(
      (await runCheckStatus(HANDLE, { fetch: noFetch }, dependencies)).status,
      "verified",
    );
    // Loaded once: the loader's table is kept for later calls, as a client is.
    assert.equal(loads(), 1);
  });

  it("a route with the row's own Etherscan or Blockscout API URL loads it for the page (R-FLOW-3)", async () => {
    const { dependencies, loads } = recording();
    const etherscanRoute: RouteOverride = {
      backend: "etherscan-v2",
      apiUrl: ETHERSCAN_API_URL,
      apiKey: "dummy-key-0001",
    };
    const onEtherscan = await runVerify(
      INPUT,
      { fetch: noFetch, route: etherscanRoute },
      dependencies,
    );
    assert.ok(onEtherscan.status !== "failed");
    assert.equal(onEtherscan.explorerUrl, `https://sepolia.etherscan.io/address/${GREETER}#code`);
    const blockscoutRoute: RouteOverride = {
      backend: "blockscout",
      apiUrl: "https://eth-sepolia.blockscout.com/api",
    };
    const onBlockscout = await runVerify(
      INPUT,
      { fetch: noFetch, route: blockscoutRoute },
      dependencies,
    );
    assert.ok(onBlockscout.status !== "failed");
    assert.equal(
      onBlockscout.explorerUrl,
      `https://eth-sepolia.blockscout.com/address/${GREETER}?tab=contract`,
    );
    assert.equal(loads(), 1);
  });

  it('verifyEach() with backends: "all" and linkProxy() without a route', async () => {
    const all = recording();
    const result = await runVerifyEach(
      INPUT,
      { fetch: noFetch, backends: "all" },
      all.dependencies,
    );
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.backend),
      ["sourcify", "blockscout"],
    );
    assert.equal(all.loads(), 1);
    let count = 0;
    const linker: ProxyLinker = {
      request: async () => ({
        state: "linked",
        implementation: GREETER,
        implementationVerified: true,
      }),
      check: async () => ({ state: "pending" }),
    };
    const linked = await runLinkProxy(
      { chainId: SEPOLIA, address: GREETER },
      { fetch: noFetch },
      {
        linkers: { sourcify: linker },
        table: async () => {
          count += 1;
          return await Promise.resolve(TABLE);
        },
      },
    );
    assert.equal(linked.backend, "sourcify");
    assert.equal(count, 1);
  });

  it("the default dependencies load the shipped table", async () => {
    const { table } = DEFAULT_DEPENDENCIES;
    assert.equal(table, loadRoutingTable);
    assert.deepEqual(await loadRoutingTable(), ROUTING_TABLE);
  });
});

describe("a table that fails to load maps as a client load failure (decision 0040)", () => {
  it("verify() rejects with network, and the next call loads again (decision 0054)", async () => {
    const chunkError = new TypeError("Failed to fetch dynamically imported module");
    let fail = true;
    let count = 0;
    const dependencies: FlowDependencies = {
      backends: { sourcify: exact("sourcify") },
      table: async () => {
        count += 1;
        if (fail) {
          throw chunkError;
        }
        return await Promise.resolve(TABLE);
      },
    };
    await assert.rejects(runVerify(INPUT, { fetch: noFetch }, dependencies), {
      code: "network",
      message: "Loading the routing table failed.",
      details: { code: "network", backend: "sourcify", attempts: 1 },
    });
    fail = false;
    assert.equal(
      (await runVerify(INPUT, { fetch: noFetch }, dependencies)).status,
      "already-verified",
    );
    assert.equal(count, 2);
  });

  it("a load that never ends throws timeout naming route.backend, or sourcify (R-FLOW-6)", async () => {
    await keptAlive(async () => {
      const { dependencies } = recording(never());
      const unnamed = await outcomeOf(
        runVerify(INPUT, { fetch: noFetch, timeoutMs: 5 }, dependencies),
      );
      assert.ok(unnamed instanceof ExplorerVerifyError);
      assert.deepEqual(unnamed.details, { code: "timeout", backend: "sourcify", timeoutMs: 5 });
      assert.equal(
        unnamed.message,
        "Loading the routing table did not finish within the 5 ms budget.",
      );
      const named = await outcomeOf(
        runVerify(
          INPUT,
          { fetch: noFetch, timeoutMs: 5, route: { backend: "blockscout" } },
          dependencies,
        ),
      );
      assert.ok(named instanceof ExplorerVerifyError);
      assert.deepEqual(named.details, { code: "timeout", backend: "blockscout", timeoutMs: 5 });
    });
  });

  it("an abort during the load rejects with signal.reason (R-FLOW-6)", async () => {
    await keptAlive(async () => {
      const { dependencies } = recording(never());
      const controller = new AbortController();
      const reason = new Error("stop");
      const call = runCheckStatus(
        HANDLE,
        { fetch: noFetch, signal: controller.signal },
        dependencies,
      );
      controller.abort(reason);
      await assert.rejects(call, reason);
      // verifyEach() with a list: an abort is never one entry's outcome.
      const second = new AbortController();
      const listed = runVerifyEach(
        INPUT,
        { fetch: noFetch, signal: second.signal, backends: ["sourcify"] },
        dependencies,
      );
      second.abort(reason);
      await assert.rejects(listed, reason);
    });
  });

  it("verifyEach() passes on an error that is not an ExplorerVerifyError, which only a bug causes", async () => {
    const bug = new TypeError("a bug");
    const backends = new Proxy(
      {},
      {
        get: () => {
          throw bug;
        },
      },
    );
    await assert.rejects(
      runVerifyEach(INPUT, { fetch: noFetch, backends: ["sourcify"] }, { backends }),
      bug,
    );
  });

  it("verifyEach(): each entry that reads the table gets the failure, a full route still runs (R-RT-4)", async () => {
    const chunkError = new TypeError("Failed to fetch dynamically imported module");
    const dependencies: FlowDependencies = {
      ...recording().dependencies,
      table: async () => {
        throw chunkError;
      },
    };
    const { outcomes } = await runVerifyEach(
      INPUT,
      {
        fetch: noFetch,
        backends: [
          "sourcify",
          {
            backend: "etherscan-v2",
            apiUrl: "https://proxy.example.org/api",
            apiKey: "proxy-route-key-217",
          },
        ],
      },
      dependencies,
    );
    const [first, second] = outcomes;
    assert.ok(first !== undefined && first.error !== undefined);
    assert.deepEqual(first.error.details, { code: "network", backend: "sourcify", attempts: 1 });
    assert.equal(first.error.message, "Loading the routing table failed.");
    // The cause is a redacted copy: a plain Error with the original name and message.
    assert.ok(first.error.cause instanceof Error);
    assert.equal(first.error.cause.name, "TypeError");
    assert.equal(first.error.cause.message, chunkError.message);
    assert.equal(second?.ok, true);
    // backends: "all" reads the row itself, so it throws the load's error, as verify() does.
    await assert.rejects(runVerifyEach(INPUT, { fetch: noFetch, backends: "all" }, dependencies), {
      code: "network",
      message: "Loading the routing table failed.",
    });
  });

  it("verifyEach(): the failure's cause hides every entry's route.apiKey (R-SEC-1)", async () => {
    const key = "dummy-key-0002";
    const dependencies: FlowDependencies = {
      ...recording().dependencies,
      table: async () => {
        throw new Error(`chunk at /x?k=${key} failed`);
      },
    };
    const { outcomes } = await runVerifyEach(
      INPUT,
      {
        fetch: noFetch,
        backends: [
          "sourcify",
          { backend: "etherscan-v2", apiUrl: "https://proxy.example.org/api", apiKey: key },
        ],
      },
      dependencies,
    );
    const [first] = outcomes;
    assert.ok(first !== undefined && first.error !== undefined);
    assert.ok(first.error.cause instanceof Error);
    assert.doesNotMatch(first.error.cause.message, new RegExp(key));
  });

  it("verifyEach(): a timeout or a failed load names each entry's backend", async () => {
    const { dependencies } = recording(never());
    const { outcomes } = await keptAlive(
      async () =>
        await runVerifyEach(
          INPUT,
          { fetch: noFetch, timeoutMs: 5, backends: ["sourcify", "blockscout"] },
          dependencies,
        ),
    );
    assert.deepEqual(
      outcomes.map((outcome) => (outcome.error !== undefined ? outcome.error.details : undefined)),
      [
        { code: "timeout", backend: "sourcify", timeoutMs: 5 },
        { code: "timeout", backend: "blockscout", timeoutMs: 5 },
      ],
    );
    const refused = new ExplorerVerifyError(
      { code: "network", backend: "sourcify", attempts: 2 },
      "The table server refused.",
      { secrets: [] },
    );
    const failing: FlowDependencies = {
      ...dependencies,
      table: async () => {
        throw refused;
      },
    };
    const again = await runVerifyEach(INPUT, { fetch: noFetch, backends: ["blockscout"] }, failing);
    const [only] = again.outcomes;
    assert.ok(only !== undefined && only.error !== undefined);
    // Any loader failure is a failed load, an ExplorerVerifyError included (decision 0054).
    assert.deepEqual(only.error.details, { code: "network", backend: "blockscout", attempts: 1 });
    assert.equal(only.error.message, "Loading the routing table failed.");
    assert.ok(only.error.cause instanceof Error);
    assert.equal(only.error.cause.message, refused.message);
  });
});

describe("standalone entries with the table loaded on demand (decisions 0039, 0040)", () => {
  const KEYLESS: RoutingTable = {
    schemaVersion: 3,
    checked: "2026-11-05",
    chains: [
      {
        chainId: SEPOLIA,
        backends: [
          {
            backend: "etherscan-compatible",
            api: "api.btrscan.com/scan/api",
            explorer: "www.btrscan.com",
          },
        ],
      },
    ],
  };
  const keyless = (): FlowDependencies => ({
    backends: { "etherscan-compatible": exact("etherscan-compatible") },
    table: async () => await Promise.resolve(KEYLESS),
  });

  it("verifyEach(): a route.apiKey the row refuses throws invalid-input naming the entry", async () => {
    await assert.rejects(
      runVerifyEach(
        INPUT,
        {
          fetch: noFetch,
          backends: [{ backend: "etherscan-compatible", apiKey: "dummy-key-0003" }],
        },
        keyless(),
      ),
      (error: unknown) =>
        error instanceof ExplorerVerifyError &&
        error.details.code === "invalid-input" &&
        error.details.issues[0]?.field === "backends[0].apiKey",
    );
  });

  it("a route at the row's own standalone API loads the table and keeps the row's page", async () => {
    const result = await runVerify(
      INPUT,
      {
        fetch: noFetch,
        route: { backend: "etherscan-compatible", apiUrl: "https://api.btrscan.com/scan/api" },
      },
      keyless(),
    );
    assert.ok(result.status !== "failed");
    assert.equal(result.explorerUrl, `https://www.btrscan.com/address/${GREETER}#code`);
  });
});

/** The API host each backend's route with route.apiUrl names in its hint (decision 0040). */
const FIXED_HOSTS = new Map<string, string>([
  ["sourcify", "sourcify.dev"],
  ["etherscan-v2", "api.etherscan.io"],
  ["routescan", "api.routescan.io"],
]);

/** Whether a Sepolia call with `override` needs the routing table. */
function reads(override?: RouteOverride): boolean {
  return readsTable(checkRoute(SEPOLIA, override));
}

describe("readsTable() (decision 0040)", () => {
  it("is true without route.apiUrl", () => {
    assert.equal(reads(), true);
    assert.equal(reads({ backend: "routescan" }), true);
  });

  it("is true only where the row decides the page of a route.apiUrl", () => {
    assert.equal(reads({ backend: "etherscan-v2", apiUrl: ETHERSCAN_API_URL }), true);
    assert.equal(reads({ backend: "etherscan-v2", apiUrl: `${ETHERSCAN_API_URL}/` }), true);
    assert.equal(
      reads({ backend: "blockscout", apiUrl: "https://eth-sepolia.blockscout.com/api" }),
      true,
    );
    assert.equal(
      reads({ backend: "etherscan-v2", apiUrl: "https://proxy.example.org/api" }),
      false,
    );
    // A standalone row names its API host and path, its page and needsKey (decision 0039).
    assert.equal(
      reads({ backend: "etherscan-compatible", apiUrl: "https://api.btrscan.com/scan/api" }),
      true,
    );
    assert.equal(
      reads({ backend: "etherscan-compatible", apiUrl: "http://127.0.0.1:5555/api" }),
      false,
    );
    assert.equal(reads({ backend: "blockscout", apiUrl: "http://127.0.0.1:5555/api" }), false);
    assert.equal(
      reads({ backend: "blockscout", apiUrl: "https://example.org/explorer/api" }),
      false,
    );
    assert.equal(reads({ backend: "sourcify", apiUrl: SOURCIFY_API_URL }), false);
    assert.equal(reads({ apiUrl: SOURCIFY_API_URL }), false);
    assert.equal(
      reads({
        backend: "routescan",
        apiUrl: "https://api.routescan.io/v2/network/testnet/evm/11155111/etherscan/api",
      }),
      false,
    );
  });

  it("every shipped entry: a route.apiUrl the table is not loaded for gets the same route", () => {
    // Guards the rule as rows and backends are added: if the row decides anything about a route
    // with route.apiUrl, readsTable must say so, or the call would lose it.
    for (const row of ROUTING_TABLE.chains) {
      for (const entry of row.backends) {
        const derived = tableTarget(row.chainId, entry);
        if (derived === undefined) {
          continue;
        }
        const checked = checkRoute(row.chainId, {
          backend: derived.backend,
          apiUrl: derived.apiUrl,
        });
        const withTable = routeFrom(row.chainId, checked, { table: ROUTING_TABLE });
        const withoutTable = routeFrom(row.chainId, checked, {});
        const page = (route: typeof withTable): string | undefined => route.explorerUrl?.(GREETER);
        const where = `${String(row.chainId)} ${derived.backend}`;
        // tableHost of a route with route.apiUrl is the backend's fixed host, whatever the row.
        assert.equal(withoutTable.tableHost, FIXED_HOSTS.get(derived.backend), where);
        if (readsTable(checked)) {
          // The table gives the row's own page to a route at the row's own API URL.
          assert.equal(page(withTable), derived.explorerUrl?.(GREETER), where);
        } else {
          assert.equal(
            page(withoutTable),
            page(withTable),
            `${String(row.chainId)} ${derived.backend}`,
          );
        }
      }
    }
  });

  it("routeFrom() throws a TypeError for a route without route.apiUrl and no table", () => {
    assert.throws(() => routeFrom(SEPOLIA, checkRoute(SEPOLIA), {}), {
      name: "TypeError",
      message:
        "The routing table is not loaded: pass choice.table for a route without route.apiUrl.",
    });
  });
});
