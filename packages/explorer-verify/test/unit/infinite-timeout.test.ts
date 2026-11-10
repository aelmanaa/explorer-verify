// Tests for `timeoutMs: Infinity` (#289, R-FLOW-2): every function that takes `timeoutMs` lowers
// Infinity to MAX_TIMER_MS, as it lowers any larger finite value.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";

import type { Backend } from "../../src/backends/backend.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { settingsOf } from "../../src/flow/verify.ts";
import { MAX_TIMER_MS } from "../../src/http/fetch.ts";
import { buildVerifyInputFromBytecode } from "../../src/input/resolvers/bytecode.ts";
import { ROUTING_TABLE } from "../../src/routing/table.ts";
import type { Handle, VerifyInput, VerifyOptions } from "../../src/types.ts";
import {
  runCheckStatus,
  runDryRun,
  runLinkProxy,
  runVerify,
  runVerifyEach,
} from "../helpers/defaults.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const SEPOLIA = 11155111;
const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const INPUT: VerifyInput = {
  chainId: SEPOLIA,
  address: ADDRESS,
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
const HANDLE: Handle = {
  version: 1,
  backend: "sourcify",
  chainId: SEPOLIA,
  address: ADDRESS,
  jobId: "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718",
};
const OPTIONS: VerifyOptions = {
  timeoutMs: Number.POSITIVE_INFINITY,
  route: { backend: "sourcify" },
  fetch: async () => await Promise.reject(new Error("no request expected")),
};
// Runtime code that is only a CBOR trailer: an IPFS hash of 32 zero bytes, solc 0.8.24.
const RUNTIME = `0xa2646970667358221220${"00".repeat(32)}64736f6c63430008180033`;
const BUDGET_TEXT = `${String(MAX_TIMER_MS / 1_000)} s`;

/** A client loader that never settles, so the call ends on its load deadline. */
const never = async (): Promise<Backend> => await new Promise<Backend>(() => undefined);

/**
 * Freezes `Date` at 0 and replaces `AbortSignal.timeout`, which bounds each client load, with one
 * that records its delay and fires on the next turn. Returns the recorded delays.
 */
function deadlines(t: TestContext): number[] {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const seen: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    seen.push(ms);
    const controller = new AbortController();
    setImmediate(() => {
      controller.abort(new DOMException("The deadline passed.", "TimeoutError"));
    });
    return controller.signal;
  });
  return seen;
}

/** Asserts `error` is the load-deadline timeout of a 2147483647 ms budget. */
function assertClamped(error: unknown, seen: readonly number[]): void {
  assert.ok(error instanceof ExplorerVerifyError, `expected an error, got ${String(error)}`);
  assert.equal(error.code, "timeout");
  assert.deepEqual(error.details, {
    code: "timeout",
    backend: "sourcify",
    timeoutMs: MAX_TIMER_MS,
  });
  // The JSON form, which a CLI prints, holds the finite budget too.
  const { details } = error.toJSON();
  assert.ok(details.code === "timeout" && Number.isFinite(details.timeoutMs));
  assert.ok(error.message.endsWith(`within the ${BUDGET_TEXT} budget.`), error.message);
  assert.ok(!error.message.includes("Infinity"), error.message);
  assert.deepEqual(seen, [MAX_TIMER_MS]);
}

async function rejection(call: Promise<unknown>): Promise<unknown> {
  return await call.then(
    () => assert.fail("expected a rejection"),
    (error: unknown) => error,
  );
}

describe("timeoutMs: Infinity is the longest budget (#289, R-FLOW-2)", () => {
  it("settingsOf() lowers Infinity to 2147483647 and keeps pollIntervalMs finite", () => {
    assert.equal(settingsOf({ timeoutMs: Number.POSITIVE_INFINITY }).timeoutMs, MAX_TIMER_MS);
    assert.throws(
      () => settingsOf({ pollIntervalMs: Number.POSITIVE_INFINITY }),
      (error: unknown) => {
        assert.ok(error instanceof ExplorerVerifyError);
        assert.deepEqual(error.details.code === "invalid-input" && error.details.issues, [
          { field: "pollIntervalMs", message: "must be a positive finite number of milliseconds" },
        ]);
        return true;
      },
    );
  });

  for (const value of [Number.NEGATIVE_INFINITY, Number.NaN, 0]) {
    it(`settingsOf() refuses a timeoutMs of ${String(value)}`, () => {
      assert.throws(
        () => settingsOf({ timeoutMs: value }),
        (error: unknown) => {
          assert.ok(error instanceof ExplorerVerifyError);
          assert.deepEqual(error.details.code === "invalid-input" && error.details.issues, [
            { field: "timeoutMs", message: "must be a positive number of milliseconds" },
          ]);
          return true;
        },
      );
    });
  }

  it("verify() runs on a 2147483647 ms budget", async (t) => {
    const seen = deadlines(t);
    const error = await rejection(
      runVerify(INPUT, OPTIONS, { backends: { sourcify: never }, table: ROUTING_TABLE }),
    );
    assertClamped(error, seen);
  });

  it("dryRun() runs on a 2147483647 ms budget", async (t) => {
    const seen = deadlines(t);
    const error = await rejection(
      runDryRun(INPUT, OPTIONS, { backends: { sourcify: never }, table: ROUTING_TABLE }),
    );
    assertClamped(error, seen);
  });

  it("checkStatus() runs on a 2147483647 ms budget", async (t) => {
    const seen = deadlines(t);
    const error = await rejection(
      runCheckStatus(HANDLE, OPTIONS, { backends: { sourcify: never }, table: ROUTING_TABLE }),
    );
    assertClamped(error, seen);
  });

  it("linkProxy() runs on a 2147483647 ms budget", async (t) => {
    const seen = deadlines(t);
    const error = await rejection(
      runLinkProxy({ chainId: SEPOLIA, address: ADDRESS }, OPTIONS, {
        linkers: { sourcify: async () => await new Promise(() => undefined) },
        table: ROUTING_TABLE,
      }),
    );
    assertClamped(error, seen);
  });

  it("verifyEach() runs on a 2147483647 ms budget", async (t) => {
    const seen = deadlines(t);
    const result = await runVerifyEach(
      INPUT,
      {
        fetch: OPTIONS.fetch,
        timeoutMs: Number.POSITIVE_INFINITY,
        backends: [{ backend: "sourcify", apiUrl: "https://sourcify.dev/server" }],
      },
      { backends: { sourcify: never }, table: ROUTING_TABLE },
    );
    const [outcome] = result.outcomes;
    assert.ok(outcome !== undefined && !outcome.ok);
    assertClamped(outcome.error, seen);
  });

  it("buildVerifyInputFromBytecode() runs on a 2147483647 ms budget", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const urls: string[] = [];
    // The first request moves the clock to 1 ms before the clamped deadline: the second request
    // still starts, then ends when the budget runs out at 2147483647 ms.
    const fetch = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      urls.push(
        request instanceof Request ? request.url : request instanceof URL ? request.href : request,
      );
      if (urls.length === 1) {
        t.mock.timers.setTime(MAX_TIMER_MS - 1);
        return new Response("not found", { status: 404 });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    };
    const call = buildVerifyInputFromBytecode(
      { chainId: SEPOLIA, address: ADDRESS },
      {
        bytecode: RUNTIME,
        ipfsGateway: "https://ipfs.example",
        fetch,
        timeoutMs: Number.POSITIVE_INFINITY,
      },
    ).then(
      () => assert.fail("expected a rejection"),
      (error: unknown) => error,
    );
    await driveMockClock(call, () => {
      t.mock.timers.runAll();
    });
    const error = await call;
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(error.code, "metadata-unavailable");
    assert.equal(Date.now(), MAX_TIMER_MS);
    assert.equal(urls.length, 2);
    assert.ok(!error.message.includes("Infinity"), error.message);
    assert.deepEqual(
      error.details.code === "metadata-unavailable" && error.details.attempts.at(-1),
      { source: "ipfs", outcome: "timeout" },
    );
  });

  for (const value of [Number.NEGATIVE_INFINITY, Number.NaN, 0]) {
    it(`buildVerifyInputFromBytecode() refuses a timeoutMs of ${String(value)}`, async () => {
      const error = await rejection(
        buildVerifyInputFromBytecode(
          { chainId: SEPOLIA, address: ADDRESS },
          { rpcUrl: "https://rpc.example/", timeoutMs: value },
        ),
      );
      assert.ok(error instanceof ExplorerVerifyError);
      assert.deepEqual(error.details.code === "invalid-input" && error.details.issues, [
        { field: "timeoutMs", message: "must be a positive number of milliseconds" },
      ]);
    });
  }
});
