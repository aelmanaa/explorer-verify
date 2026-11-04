// The constructor argument derivation loads as a client does (R-IN-3, R-FLOW-6, decisions 0031
// and 0032): only when a call derives, bounded by the caller's signal and the time budget, and
// kept once loaded. The derivation is injected through FlowDependencies.derivation, so no request
// is sent.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { Backend } from "../../src/backends/backend.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { runVerify } from "../../src/flow/verify.ts";
import type { DeriveLoader, FlowDependencies } from "../../src/flow/verify.ts";
import type { VerifyInput, VerifyOptions } from "../../src/types.ts";
import { driveMockClock, turnUntil } from "../helpers/mock-clock.ts";

const ROUTE = { backend: "blockscout", apiUrl: "https://blockscout.example.org/api" } as const;
const INPUT: VerifyInput = {
  chainId: 84532,
  address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
  compiler: {
    kind: "solc",
    version: "0.8.24+commit.e11b9ed9",
    input: {
      language: "Solidity",
      sources: { "src/A.sol": { content: "contract A {}" } },
      settings: {},
    },
  },
  contractName: "src/A.sol:A",
  creationBytecode: "0x6080",
};
const DERIVED = "0x000000000000000000000000000000000000000000000000000000000000002a";

/** A `fetch` that fails the test if a request is sent: the client below sends none. */
const noFetch: typeof fetch = async () => await Promise.reject(new Error("no request expected"));

/** A Blockscout-like client that records what it submits and reports it verified. */
function recordingClient(submitted: VerifyInput[]): Backend {
  return {
    name: "blockscout",
    takesConstructorArgs: true,
    lookup: async () => await Promise.resolve(undefined),
    submit: async (input) => {
      submitted.push(input);
      return await Promise.resolve({ state: "already-verified", match: "exact" });
    },
    poll: async () => await Promise.resolve({ state: "pending" }),
    explorerUrl: () => undefined,
  };
}

/** A derivation that sets the arguments to {@link DERIVED}. */
const settingArgs: DeriveLoader = async () =>
  await Promise.resolve(
    async (_call, input) => await Promise.resolve({ ...input, constructorArgs: DERIVED }),
  );

/** Dependencies with the recording client and `derivation`. */
function dependenciesOf(derivation: DeriveLoader, submitted: VerifyInput[] = []): FlowDependencies {
  return { backends: { blockscout: recordingClient(submitted) }, derivation };
}

/** Runs `verify()` with the Blockscout route and `options`. */
async function run(dependencies: FlowDependencies, options: VerifyOptions = {}): Promise<unknown> {
  return await runVerify(INPUT, { route: ROUTE, fetch: noFetch, ...options }, dependencies);
}

/** A loader that never settles. */
const hung: DeriveLoader = async () => await new Promise<never>(() => undefined);

/** `setImmediate` as the runtime gives it, kept before any test mocks it. */
const realImmediate = setImmediate;

/** Lets the pending promise jobs run, so the call reaches the load. */
async function settleJobs(): Promise<void> {
  await new Promise<void>((resolve) => {
    realImmediate(resolve);
  });
}

/** What `promise` settles with: `{ resolved }` or the rejection reason. */
async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    (resolved: unknown) => ({ resolved }),
    (error: unknown) => error,
  );
}

/**
 * A new loader that settles after five real event-loop turns, as a first dynamic import does.
 * Each call gives a new function, so no earlier load is kept for it.
 */
function slowLoader(): DeriveLoader {
  return async () => {
    for (let turn = 0; turn < 5; turn += 1) {
      await settleJobs();
    }
    return await settingArgs();
  };
}

describe("the derivation load is bounded by the signal and the budget (R-FLOW-6, decision 0031)", () => {
  // The load's deadline runs on AbortSignal.timeout, which fake timers do not drive, so this
  // test waits for real: 5 ms.
  it("a load that never ends throws timeout when the budget runs out", async () => {
    // Node does not keep a process alive for AbortSignal.timeout; this interval does.
    const alive = setInterval(() => undefined, 1_000);
    const error = await outcomeOf(run(dependenciesOf(hung), { timeoutMs: 5 })).finally(() => {
      clearInterval(alive);
    });
    assert.ok(error instanceof ExplorerVerifyError, String(error));
    assert.deepEqual(error.details, { code: "timeout", backend: "blockscout", timeoutMs: 5 });
    assert.equal(
      error.message,
      "Loading the constructor argument code did not finish within the 5 ms budget.",
    );
  });

  it("a load that never ends rejects with signal.reason when the signal aborts", async () => {
    const controller = new AbortController();
    let loading = false;
    const watched: DeriveLoader = async () => {
      loading = true;
      return await hung();
    };
    const outcome = outcomeOf(run(dependenciesOf(watched), { signal: controller.signal }));
    // Abort once the derivation load has started, however many turns the call takes to get there.
    await turnUntil(() => loading);
    const reason = new Error("caller abort");
    controller.abort(reason);
    assert.equal(await outcome, reason);
  });

  it("an abort during the load wins over the loader's own error", async () => {
    const controller = new AbortController();
    const reason = new Error("caller abort");
    const failing: DeriveLoader = async () => {
      controller.abort(reason);
      throw new TypeError("Failed to fetch dynamically imported module");
    };
    assert.equal(
      await outcomeOf(run(dependenciesOf(failing), { signal: controller.signal })),
      reason,
    );
  });

  for (const apis of [
    ["setTimeout", "Date"],
    ["setTimeout", "setImmediate", "Date"],
  ] as const) {
    it(`fake ${apis.join(", ")} run all at once do not end a first load that settles a few turns later`, async (t: TestContext) => {
      t.mock.timers.enable({ apis: [...apis], now: 0 });
      // A fresh loader, so nothing is kept.
      const slow = slowLoader();
      const submitted: VerifyInput[] = [];
      const pending = outcomeOf(run(dependenciesOf(slow, submitted)));
      await driveMockClock(pending, () => {
        t.mock.timers.runAll();
      });
      const outcome = await pending;
      assert.ok(!(outcome instanceof Error), String(outcome));
      assert.equal(submitted[0]?.constructorArgs, DERIVED);
    });
  }
});

describe("the derivation loads only when a call derives, and is kept (decision 0031)", () => {
  it("a call with constructorArgs does not load it", async () => {
    let loads = 0;
    const counting: DeriveLoader = async () => {
      loads += 1;
      return await settingArgs();
    };
    await runVerify(
      { ...INPUT, constructorArgs: "0x" },
      { route: ROUTE, fetch: noFetch },
      dependenciesOf(counting),
    );
    assert.equal(loads, 0);
  });

  it("a second call with the same loader does not load again", async () => {
    let loads = 0;
    const counting: DeriveLoader = async () => {
      loads += 1;
      return await settingArgs();
    };
    const submitted: VerifyInput[] = [];
    await run(dependenciesOf(counting, submitted));
    await run(dependenciesOf(counting, submitted));
    assert.equal(loads, 1);
    assert.deepEqual(
      submitted.map((input) => input.constructorArgs),
      [DERIVED, DERIVED],
    );
  });

  it("a loader that failed loads again on the next call", async () => {
    let loads = 0;
    const flaky: DeriveLoader = async () => {
      loads += 1;
      if (loads === 1) {
        throw new TypeError("Failed to fetch dynamically imported module");
      }
      return await settingArgs();
    };
    const first = await outcomeOf(run(dependenciesOf(flaky)));
    assert.ok(first instanceof TypeError);
    const submitted: VerifyInput[] = [];
    await run(dependenciesOf(flaky, submitted));
    assert.equal(loads, 2);
    assert.equal(submitted[0]?.constructorArgs, DERIVED);
  });

  it("a signal already aborted stops before the loader runs", async () => {
    let loads = 0;
    const counting: DeriveLoader = async () => {
      loads += 1;
      return await settingArgs();
    };
    const controller = new AbortController();
    const reason = new Error("already aborted");
    controller.abort(reason);
    assert.equal(
      await outcomeOf(run(dependenciesOf(counting), { signal: controller.signal })),
      reason,
    );
    assert.equal(loads, 0);
  });
});
