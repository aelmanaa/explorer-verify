// Each backend client loads only when a call is routed to it (#136, decision 0031; R-RUN-3,
// R-FLOW-1, R-FLOW-5, R-AX-8). The browser smoke test checks the same rule on the bundled chunks.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";

import type { BackendName } from "../../src/backend-names.ts";
import type { Backend, Target } from "../../src/backends/backend.ts";
import { blockscout } from "../../src/backends/blockscout.ts";
import { etherscanCompatible } from "../../src/backends/etherscan-compatible.ts";
import { etherscan } from "../../src/backends/etherscan.ts";
import { routescan } from "../../src/backends/routescan.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { runDryRun } from "../../src/flow/dry-run.ts";
import { runCheckStatus } from "../../src/flow/status.ts";
import {
  DEFAULT_DEPENDENCIES,
  openCall,
  routeOf,
  runVerify,
  settingsOf,
  startBudget,
  withClient,
} from "../../src/flow/verify.ts";
import type { Client, FlowDependencies } from "../../src/flow/verify.ts";
import { MAX_TIMER_MS } from "../../src/http/fetch.ts";
import type { RoutingTable } from "../../src/routing/resolve.ts";
import type { VerifyInput, VerifyOptions } from "../../src/types.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const SEPOLIA = 11155111;
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const TARGET: Target = { chainId: SEPOLIA, address: GREETER };
const TABLE: RoutingTable = {
  schemaVersion: 2,
  checked: "2026-11-04",
  chains: [{ chainId: SEPOLIA, backends: [{ backend: "sourcify" }] }],
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
const HANDLE = `ev1:sourcify:${String(SEPOLIA)}:${GREETER}:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718`;

/** A fetch that must not be called: the clients in these tests answer without one. */
const noFetch: typeof fetch = async () => {
  throw new Error("no request expected");
};

/** Sourcify's client, answering every lookup and poll with an exact match and no request. */
const exactSourcify: Backend = {
  ...sourcify,
  lookup: async () => "exact",
  poll: async () => ({ state: "verified", match: "exact" }),
};

/**
 * Loaders for all four backends that record which ones ran. Sourcify's gives `exactSourcify`;
 * every other one fails the test if a call loads it.
 */
function recordingLoaders(): { dependencies: FlowDependencies; loaded: BackendName[] } {
  const loaded: BackendName[] = [];
  const loader =
    (name: BackendName, backend: Backend): Client =>
    async () => {
      loaded.push(name);
      return backend;
    };
  return {
    loaded,
    dependencies: {
      backends: {
        sourcify: loader("sourcify", exactSourcify),
        "etherscan-v2": loader("etherscan-v2", etherscan),
        routescan: loader("routescan", routescan),
        blockscout: loader("blockscout", blockscout),
      },
      table: TABLE,
      random: () => 0,
    },
  };
}

describe("the shipped clients load on first use (decision 0031)", () => {
  it("each default loader gives its backend's client", async () => {
    const want: Record<BackendName, Backend | undefined> = {
      sourcify,
      "etherscan-v2": etherscan,
      routescan,
      blockscout,
      "etherscan-compatible": etherscanCompatible,
    };
    for (const [name, client] of Object.entries(DEFAULT_DEPENDENCIES.backends)) {
      assert.equal(typeof client, "function", name);
      const backend = typeof client === "function" ? await client() : client;
      assert.equal(backend, Reflect.get(want, name), name);
      assert.equal(backend?.name, name);
    }
    assert.deepEqual(Object.keys(DEFAULT_DEPENDENCIES.backends), [
      "sourcify",
      "etherscan-v2",
      "etherscan-compatible",
      "routescan",
      "blockscout",
    ]);
  });

  it("verify() on a Sourcify route loads the Sourcify client only (R-FLOW-1)", async () => {
    const { dependencies, loaded } = recordingLoaders();
    const result = await runVerify(INPUT, { fetch: noFetch }, dependencies);
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: `https://repo.sourcify.dev/${String(SEPOLIA)}/${GREETER}`,
    });
    assert.deepEqual(loaded, ["sourcify"]);
  });

  it("checkStatus() on a Sourcify handle loads the Sourcify client only (R-FLOW-5)", async () => {
    const { dependencies, loaded } = recordingLoaders();
    const result = await runCheckStatus(HANDLE, { fetch: noFetch }, dependencies);
    assert.deepEqual(result, {
      status: "verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: `https://repo.sourcify.dev/${String(SEPOLIA)}/${GREETER}`,
    });
    assert.deepEqual(loaded, ["sourcify"]);
  });

  it("dryRun() on a Sourcify route loads the Sourcify client only (R-AX-8)", async () => {
    const { dependencies, loaded } = recordingLoaders();
    const result = await runDryRun(INPUT, { fetch: noFetch }, dependencies);
    assert.equal(result.lookup, "exact");
    assert.deepEqual(loaded, ["sourcify"]);
  });

  it("a route override loads the client it names, and no other", async () => {
    const { dependencies, loaded } = recordingLoaders();
    const settings = settingsOf({
      fetch: noFetch,
      route: {
        backend: "routescan",
        apiUrl: "https://api.routescan.io/v2/network/testnet/evm/11155111/etherscan/api",
      },
    });
    const route = await routeOf(SEPOLIA, settings, dependencies, startBudget(settings));
    const withRoutescan = await load(route, dependencies);
    assert.equal(withRoutescan.backends.routescan, routescan);
    assert.deepEqual(loaded, ["routescan"]);
  });

  it("a route that needs no client loads nothing before the error (R-RT-1)", async () => {
    const { dependencies, loaded } = recordingLoaders();
    await assert.rejects(
      runVerify({ ...INPUT, chainId: 999_999 }, { fetch: noFetch }, dependencies),
      { name: "ExplorerVerifyError", code: "unsupported-chain" },
    );
    assert.deepEqual(loaded, []);
  });

  it("a client that fails to load rejects the call with the loader's error and sends nothing", async () => {
    const chunkError = new TypeError("Failed to fetch dynamically imported module");
    const dependencies: FlowDependencies = {
      backends: {
        sourcify: async () => {
          throw chunkError;
        },
      },
      table: TABLE,
    };
    await assert.rejects(runVerify(INPUT, { fetch: noFetch }, dependencies), chunkError);
  });
});

describe("withClient() and openCall()", () => {
  it("leaves dependencies with the client already loaded unchanged", async () => {
    const dependencies: FlowDependencies = { backends: { sourcify }, table: TABLE };
    const route = await routeOf(SEPOLIA, settingsOf({}), dependencies, startBudget(settingsOf({})));
    assert.equal(await load(route, dependencies), dependencies);
  });

  it("leaves dependencies without the route's client unchanged, for openCall's error", async () => {
    const dependencies: FlowDependencies = { backends: { sourcify }, table: TABLE };
    const route = await routeOf(SEPOLIA, settingsOf({}), dependencies, startBudget(settingsOf({})));
    const without: FlowDependencies = { backends: {}, table: TABLE };
    assert.equal(await load(route, without), without);
    assert.throws(() => openCall(settingsOf({}), route, TARGET, without), {
      name: "ExplorerVerifyError",
      code: "unsupported-chain",
    });
  });

  it("keeps the other entries and the options of the dependencies", async () => {
    const { dependencies } = recordingLoaders();
    const route = await routeOf(SEPOLIA, settingsOf({}), dependencies, startBudget(settingsOf({})));
    const loaded = await load(route, dependencies);
    assert.equal(loaded.backends.sourcify, exactSourcify);
    assert.equal(loaded.backends.routescan, dependencies.backends.routescan);
    assert.equal(loaded.table, TABLE);
    assert.equal(loaded.random, dependencies.random);
  });

  it("openCall() refuses a client that is not loaded yet", async () => {
    const { dependencies } = recordingLoaders();
    const route = await routeOf(SEPOLIA, settingsOf({}), dependencies, startBudget(settingsOf({})));
    assert.throws(() => openCall(settingsOf({}), route, TARGET, dependencies), {
      name: "TypeError",
      message:
        "The sourcify client is not loaded: pass the dependencies through withClient() first.",
    });
  });
});

/** `withClient` with the budget of `settings`, started now. */
async function load(
  route: Parameters<typeof withClient>[0],
  dependencies: FlowDependencies,
  settings: ReturnType<typeof settingsOf> = settingsOf({}),
): Promise<FlowDependencies> {
  return await withClient(route, dependencies, settings, startBudget(settings));
}

/** Dependencies whose Sourcify client never loads. */
const HUNG: FlowDependencies = {
  backends: { sourcify: async () => await new Promise<never>(() => undefined) },
  table: TABLE,
};

/** Each entry point, run with `dependencies` and `options`. */
const RUNS: [
  string,
  (dependencies: FlowDependencies, options: VerifyOptions) => Promise<unknown>,
][] = [
  ["verify()", async (dependencies, options) => await runVerify(INPUT, options, dependencies)],
  [
    "checkStatus()",
    async (dependencies, options) => await runCheckStatus(HANDLE, options, dependencies),
  ],
  ["dryRun()", async (dependencies, options) => await runDryRun(INPUT, options, dependencies)],
];

/** Lets the pending promise jobs run, so the call reaches the client load. */
async function settleJobs(): Promise<void> {
  await new Promise<void>((resolve) => {
    realImmediate(resolve);
  });
}

/** `setImmediate` as the runtime gives it, kept before any test mocks it. */
const realImmediate = setImmediate;

/**
 * Options with a budget that real time cannot spend during a test. The load's deadline is a real
 * `AbortSignal.timeout`, and on a loaded machine thousands of real turns can take seconds (#163).
 * The tests that turn many times check the mock clock, not the real deadline. The 5 ms test below
 * checks that the real deadline ends a load that never settles.
 */
const UNBOUNDED: VerifyOptions = { fetch: noFetch, timeoutMs: MAX_TIMER_MS };

/** What `promise` settles with: `{ resolved }` or the rejection reason. */
async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    (resolved: unknown) => ({ resolved }),
    (error: unknown) => error,
  );
}

describe("a client load is bounded by the signal and the budget (R-FLOW-6, decision 0031)", () => {
  for (const [name, run] of RUNS) {
    // The load's deadline runs on AbortSignal.timeout, which fake timers do not drive, so this
    // test waits for real: 5 ms.
    it(`${name}: a load that never ends throws timeout when the budget runs out`, async () => {
      // Node does not keep a process alive for AbortSignal.timeout, and the hung loader holds no
      // handle; this interval keeps the test process running until the deadline.
      const alive = setInterval(() => undefined, 1_000);
      const error = await outcomeOf(run(HUNG, { fetch: noFetch, timeoutMs: 5 })).finally(() => {
        clearInterval(alive);
      });
      assert.ok(error instanceof ExplorerVerifyError, String(error));
      assert.deepEqual(error.details, { code: "timeout", backend: "sourcify", timeoutMs: 5 });
      assert.equal(
        error.message,
        "Loading the sourcify client did not finish within the 5 ms budget.",
      );
    });

    for (const apis of [
      ["setTimeout", "Date"],
      ["setTimeout", "setImmediate", "Date"],
    ] as const) {
      it(`${name}: fake ${apis.join(", ")} run all at once do not end a load that settles a few turns later`, async (t: TestContext) => {
        t.mock.timers.enable({ apis: [...apis], now: 0 });
        // A fresh loader, so nothing is cached: it settles after five real event-loop turns, as
        // a first dynamic import does on Node 24.0.0.
        const dependencies: FlowDependencies = {
          backends: {
            sourcify: async () => {
              for (let turn = 0; turn < 5; turn += 1) {
                await settleJobs();
              }
              return exactSourcify;
            },
          },
          table: TABLE,
        };
        const state = { settled: false };
        const pending = outcomeOf(run(dependencies, UNBOUNDED)).finally(() => {
          state.settled = true;
        });
        while (!state.settled) {
          t.mock.timers.runAll();
          await settleJobs();
        }
        const outcome = await pending;
        assert.ok(!(outcome instanceof Error), String(outcome));
      });
    }

    it(`${name}: driveMockClock keeps the mock clock still while a load takes 2,000 turns`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      // A first dynamic import on a loaded CI runner took more turns than a driver that moved
      // the clock 500 ms per turn had budget for: 240 turns spent 120 seconds (#155).
      const clock: number[] = [];
      const dependencies: FlowDependencies = {
        backends: {
          sourcify: async () => {
            for (let turn = 0; turn < 2_000; turn += 1) {
              await settleJobs();
            }
            clock.push(Date.now());
            return exactSourcify;
          },
        },
        table: TABLE,
      };
      const pending = outcomeOf(run(dependencies, UNBOUNDED));
      await driveMockClock(pending, () => {
        t.mock.timers.runAll();
      });
      const outcome = await pending;
      assert.ok(!(outcome instanceof Error), String(outcome));
      // The mock clock when the load ends, and after the call: a driver that moves it during the
      // load fails here.
      assert.deepEqual(clock, [0]);
      assert.equal(Date.now(), 0);
    });

    it(`${name}: a load that never ends rejects with signal.reason when the signal aborts`, async () => {
      const controller = new AbortController();
      const outcome = outcomeOf(run(HUNG, { fetch: noFetch, signal: controller.signal }));
      await settleJobs();
      const reason = new Error("caller abort");
      controller.abort(reason);
      assert.equal(await outcome, reason);
    });

    it(`${name}: an abort during the load wins over the loader's own error`, async () => {
      const controller = new AbortController();
      const reason = new Error("caller abort");
      const dependencies: FlowDependencies = {
        backends: {
          sourcify: async () => {
            controller.abort(reason);
            throw new TypeError("Failed to fetch dynamically imported module");
          },
        },
        table: TABLE,
      };
      assert.equal(
        await outcomeOf(run(dependencies, { fetch: noFetch, signal: controller.signal })),
        reason,
      );
    });

    it(`${name}: a load that ends in time removes its abort listener`, async (t: TestContext) => {
      const controller = new AbortController();
      const removed = t.mock.method(controller.signal, "removeEventListener");
      const { dependencies } = recordingLoaders();
      await run(dependencies, { fetch: noFetch, signal: controller.signal, timeoutMs: 1_000 });
      assert.ok(removed.mock.callCount() >= 1);
    });
  }

  it("a signal already aborted stops before the loader runs", async () => {
    const { dependencies, loaded } = recordingLoaders();
    const route = await routeOf(SEPOLIA, settingsOf({}), dependencies, startBudget(settingsOf({})));
    const reason = new Error("aborted before");
    const settings = settingsOf({ signal: AbortSignal.abort(reason) });
    await assert.rejects(withClient(route, dependencies, settings, startBudget(settings)), reason);
    assert.deepEqual(loaded, []);
  });

  it("openCall() takes the budget it is given", async () => {
    const dependencies: FlowDependencies = { backends: { sourcify }, table: TABLE };
    const settings = settingsOf({ fetch: noFetch });
    const route = await routeOf(SEPOLIA, settings, dependencies, startBudget(settings));
    const budget = { deadline: 123, timeoutMs: 456 };
    assert.equal(openCall(settings, route, TARGET, dependencies, true, budget).budget, budget);
  });
});

describe("a loaded client is kept (decision 0031)", () => {
  it("a second call with the same loader does not load again", async () => {
    let loads = 0;
    const loader = async (): Promise<Backend> => {
      loads += 1;
      return await Promise.resolve(exactSourcify);
    };
    const dependencies: FlowDependencies = { backends: { sourcify: loader }, table: TABLE };
    await runVerify(INPUT, { fetch: noFetch }, dependencies);
    await runVerify(INPUT, { fetch: noFetch }, dependencies);
    assert.equal(loads, 1);
  });

  it("a loader that failed loads again on the next call", async () => {
    let loads = 0;
    const loader = async (): Promise<Backend> => {
      loads += 1;
      if (loads === 1) {
        throw new TypeError("Failed to fetch dynamically imported module");
      }
      return await Promise.resolve(exactSourcify);
    };
    const dependencies: FlowDependencies = { backends: { sourcify: loader }, table: TABLE };
    await assert.rejects(runVerify(INPUT, { fetch: noFetch }, dependencies), TypeError);
    const result = await runVerify(INPUT, { fetch: noFetch }, dependencies);
    assert.equal(result.status, "already-verified");
    assert.equal(loads, 2);
  });
});
