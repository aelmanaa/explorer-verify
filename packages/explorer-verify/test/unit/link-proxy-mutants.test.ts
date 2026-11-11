// Tests added when linkProxy() joined mutation testing (#194; R-FLOW-8, R-FLOW-4, R-DX-5): each
// one fails on a code change in src/flow/link-proxy.ts that the other linkProxy() tests let pass.
// The proxy-link code is a fake passed in; checks and waits run on mock timers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { LinkStep, LinkVerdict, ProxyLinker } from "../../src/backends/backend.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import type { LinkDependencies } from "../../src/flow/link-proxy.ts";
import type { Hex, VerifyOptions } from "../../src/types.ts";
import { runLinkProxy } from "../helpers/defaults.ts";
import { keptAlive } from "../helpers/kept-alive.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const SEPOLIA = 11155111;
const PROXY: Hex = "0xed5b8413e605598ef86cd7617f12701f74ca255c";
const BOX: Hex = "0x75038a8c55f5ec7196b54384fdbcffb1f2ce9920";
const GREETER: Hex = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const SOURCIFY: VerifyOptions = { route: { backend: "sourcify" } };

/** One step of a fake check: a verdict, or an error it throws. */
type CheckStep = LinkVerdict | { readonly throws: unknown };

/** A linker whose request gives `first` and whose checks follow `checks`, the last one repeated. */
function linker(
  first: LinkStep,
  checks: CheckStep[] = [],
  verified?: boolean,
): {
  linker: ProxyLinker;
  checked: number[];
} {
  const checked: number[] = [];
  const fake: ProxyLinker = {
    request: async () => await Promise.resolve(first),
    check: async (): Promise<LinkVerdict> => {
      checked.push(Date.now());
      const step = checks[Math.min(checked.length, checks.length) - 1];
      assert.ok(step !== undefined, "no check expected");
      if ("throws" in step) {
        const thrown: unknown = step.throws;
        return await Promise.reject(thrown);
      }
      return await Promise.resolve(step);
    },
    ...(verified === undefined ? {} : { verified: async () => await Promise.resolve(verified) }),
  };
  return { linker: fake, checked };
}

interface Run {
  readonly outcome: unknown;
  readonly lines: [string, string, unknown][];
  /** The mock clock's time when the call settled. */
  readonly ended: number;
}

/** Runs runLinkProxy() on mock timers until it settles. */
async function run(
  t: TestContext,
  dependencies: LinkDependencies,
  options: VerifyOptions = SOURCIFY,
  target: unknown = { chainId: SEPOLIA, address: PROXY },
): Promise<Run> {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const lines: [string, string, unknown][] = [];
  const record =
    (level: string) =>
    (message: string, fields?: unknown): void => {
      lines.push([level, message, fields]);
    };
  const call = runLinkProxy(
    target,
    {
      timeoutMs: 20_000,
      pollIntervalMs: 3_000,
      logger: {
        debug: record("debug"),
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
      },
      ...options,
    },
    dependencies,
  );
  // A call that keeps checking past its budget fails the test here, fast, instead of running on.
  await driveMockClock(
    call,
    () => {
      t.mock.timers.runAll();
    },
    { maxTurns: 1_000 },
  );
  const outcome = await call.then(
    (value: unknown) => value,
    (error: unknown) => error,
  );
  return { outcome, lines, ended: Date.now() };
}

function errorOf(outcome: unknown, code: string): ExplorerVerifyError {
  assert.ok(
    outcome instanceof ExplorerVerifyError,
    `expected an error, got ${JSON.stringify(outcome)}`,
  );
  assert.equal(outcome.code, code, outcome.message);
  return outcome;
}

/** The `status` of a result, or `undefined` for anything else. */
function statusOf(outcome: unknown): unknown {
  return typeof outcome === "object" && outcome !== null
    ? Reflect.get(outcome, "status")
    : undefined;
}

function network(): ExplorerVerifyError {
  return new ExplorerVerifyError({ code: "network", backend: "sourcify", attempts: 1 }, "down", {
    secrets: [],
  });
}

function rateLimited(): ExplorerVerifyError {
  return new ExplorerVerifyError({ code: "rate-limited", backend: "sourcify" }, "slow down", {
    secrets: [],
  });
}

/** A proxy-link loader that never settles. */
async function never(): Promise<ProxyLinker> {
  return await new Promise<ProxyLinker>(() => undefined);
}

const SUBMITTED: LinkStep = { state: "submitted", jobId: "job1" };
const LINKED: LinkVerdict = { state: "linked", implementation: BOX };

describe("linkProxy(): what it logs (R-DX-5)", () => {
  it("logs the link, the accepted request, each pending check and the result", async (t) => {
    const fake = linker(SUBMITTED, [{ state: "pending" }, LINKED]);
    const r = await run(t, { linkers: { sourcify: fake.linker } });
    assert.equal(statusOf(r.outcome), "linked");
    assert.deepEqual(r.lines, [
      [
        "debug",
        `Linking proxy ${PROXY} on chain ${String(SEPOLIA)} on sourcify`,
        { backend: "sourcify", chainId: SEPOLIA, api: "https://sourcify.dev/server" },
      ],
      ["info", "sourcify accepted the proxy link request (job job1)", { backend: "sourcify" }],
      ["debug", "sourcify proxy link is pending (check 1)", { backend: "sourcify", attempt: 1 }],
      [
        "info",
        `Result: linked to ${BOX} (implementation not verified) on sourcify`,
        { backend: "sourcify", status: "linked" },
      ],
    ]);
  });

  it("logs a verified implementation without the note", async (t) => {
    const fake = linker(LINKED, [], true);
    const r = await run(t, { linkers: { sourcify: fake.linker } });
    assert.deepEqual(r.lines.at(-1), [
      "info",
      `Result: linked to ${BOX} on sourcify`,
      { backend: "sourcify", status: "linked" },
    ]);
  });

  it("logs a mismatch, with or without the implementation the explorer holds", async (t) => {
    const target = { chainId: SEPOLIA, address: PROXY, expectedImplementation: GREETER };
    const unnamed = await run(
      t,
      { linkers: { sourcify: linker({ state: "mismatch", implementation: undefined }).linker } },
      SOURCIFY,
      target,
    );
    assert.deepEqual(unnamed.lines.at(-1), [
      "info",
      `Result: the proxy points at another implementation, not ${GREETER}, on sourcify`,
      { backend: "sourcify", status: "mismatch" },
    ]);
    const named = await run(t, { linkers: { sourcify: linker(LINKED).linker } }, SOURCIFY, target);
    assert.deepEqual(named.lines.at(-1), [
      "info",
      `Result: the proxy points at ${BOX}, not ${GREETER}, on sourcify`,
      { backend: "sourcify", status: "mismatch" },
    ]);
  });

  it("logs not-linked", async (t) => {
    const r = await run(t, {
      linkers: { sourcify: linker({ state: "not-linked", reason: "no proxy" }).linker },
    });
    assert.deepEqual(r.lines.at(-1), [
      "info",
      "Result: not linked on sourcify",
      { backend: "sourcify", status: "not-linked" },
    ]);
  });
});

describe("linkProxy(): failed checks (R-FLOW-4)", () => {
  it("checks again after network and rate-limited, and gives up after three in a row", async (t) => {
    const fake = linker(SUBMITTED, [
      { throws: network() },
      { throws: rateLimited() },
      { throws: network() },
    ]);
    const r = await run(t, { linkers: { sourcify: fake.linker } });
    const error = errorOf(r.outcome, "proxy-link-pending");
    assert.equal(
      error.message,
      `The link of proxy ${PROXY} on sourcify is not confirmed: 3 status checks in a row failed before the explorer finished.`,
    );
    assert.equal(fake.checked.length, 3);
    assert.deepEqual(
      r.lines.filter(([level]) => level === "warn"),
      [
        [
          "warn",
          "sourcify proxy link check 1 failed (network); checking again",
          { backend: "sourcify", attempt: 1, code: "network", failures: 1 },
        ],
        [
          "warn",
          "sourcify proxy link check 2 failed (rate-limited); checking again",
          { backend: "sourcify", attempt: 2, code: "rate-limited", failures: 2 },
        ],
        [
          "warn",
          "sourcify proxy link check 3 failed (network); giving up",
          { backend: "sourcify", attempt: 3, code: "network", failures: 3 },
        ],
      ],
    );
  });

  it("links after a rate-limited check", async (t) => {
    const fake = linker(SUBMITTED, [{ throws: rateLimited() }, LINKED]);
    const r = await run(t, { linkers: { sourcify: fake.linker } });
    assert.equal(statusOf(r.outcome), "linked");
  });

  it("rejects with the abort reason when a check fails after an abort, and logs no failed check (R-FLOW-6)", async (t) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const aborting: ProxyLinker = {
      request: async () => await Promise.resolve(SUBMITTED),
      check: async (): Promise<LinkVerdict> => {
        controller.abort(reason);
        return await Promise.reject(network());
      },
    };
    const r = await run(
      t,
      { linkers: { sourcify: aborting } },
      {
        ...SOURCIFY,
        signal: controller.signal,
      },
    );
    assert.equal(r.outcome, reason);
    assert.deepEqual(
      r.lines.filter(([level]) => level === "warn"),
      [],
    );
  });

  it("passes on a thrown value that is not an Error, unchanged", async (t) => {
    const fake = linker(SUBMITTED, [{ throws: null }]);
    const r = await run(t, { linkers: { sourcify: fake.linker } });
    assert.equal(r.outcome, null);
  });

  it("says the budget ran out when a check throws timeout, with the timeout as cause", async (t) => {
    const timeout = new ExplorerVerifyError(
      { code: "timeout", backend: "sourcify", timeoutMs: 20_000 },
      "late",
      { secrets: [] },
    );
    const r = await run(t, {
      linkers: { sourcify: linker(SUBMITTED, [{ throws: timeout }]).linker },
    });
    const error = errorOf(r.outcome, "proxy-link-pending");
    assert.equal(
      error.message,
      `The link of proxy ${PROXY} on sourcify is not confirmed: the time budget ran out before the explorer finished.`,
    );
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, "late");
  });
});

describe("linkProxy(): the time budget (R-FLOW-8)", () => {
  it("waits only the rest of the budget, and checks no more once it is spent", async (t) => {
    const fake = linker(SUBMITTED, [{ state: "pending" }]);
    const r = await run(
      t,
      { linkers: { sourcify: fake.linker } },
      { ...SOURCIFY, timeoutMs: 4_000 },
    );
    const error = errorOf(r.outcome, "proxy-link-pending");
    assert.equal(
      error.message,
      `The link of proxy ${PROXY} on sourcify is not confirmed: the time budget ran out before the explorer finished.`,
    );
    // One check at 3 s; the next wait is the 1 s left, and no check runs at 4 s.
    assert.deepEqual(fake.checked, [3_000]);
    assert.equal(r.ended, 4_000);
    assert.equal(Object.hasOwn(error, "cause"), false);
  });

  it("names the proxy-link code that did not load within the budget", async () => {
    const error = await keptAlive(
      async () =>
        await runLinkProxy(
          { chainId: SEPOLIA, address: PROXY },
          { ...SOURCIFY, timeoutMs: 5 },
          { linkers: { sourcify: never } },
        ).then(
          (value: unknown) => value,
          (thrown: unknown) => thrown,
        ),
    );
    assert.equal(
      errorOf(error, "timeout").message,
      "Loading the sourcify proxy-link code did not finish within the 5 ms budget.",
    );
  });
});

describe("linkProxy(): the target and the route (R-FLOW-8, R-IN-6)", () => {
  const HINT =
    "Pass chainId as a positive integer, address and expectedImplementation as 0x and 40 hex digits.";

  it("names every bad field of the target, with its message and the hint", async (t) => {
    const r = await run(t, { linkers: {} }, SOURCIFY, {
      chainId: 0,
      address: "0x12",
      expectedImplementation: "box",
    });
    const error = errorOf(r.outcome, "invalid-input");
    assert.equal(
      error.message,
      "The proxy target is invalid: chainId, address, expectedImplementation.",
    );
    assert.equal(error.hint, HINT);
    assert.deepEqual(error.details.code === "invalid-input" && error.details.issues, [
      { field: "chainId", message: "must be a positive integer" },
      { field: "address", message: "must be 0x followed by 40 hex digits" },
      { field: "expectedImplementation", message: "must be 0x followed by 40 hex digits" },
    ]);
  });

  it("refuses a target that is only missing its chain id, or is not an object", async (t) => {
    const chain = await run(t, { linkers: {} }, SOURCIFY, { address: PROXY });
    assert.equal(
      errorOf(chain.outcome, "invalid-input").message,
      "The proxy target is invalid: chainId.",
    );
    const none = await run(t, { linkers: {} }, SOURCIFY, "proxy");
    assert.deepEqual(errorOf(none.outcome, "invalid-input").details, {
      code: "invalid-input",
      issues: [{ field: "target", message: "must be an object" }],
    });
  });

  it("refuses a named backend that cannot link before it reads the routing table", async (t) => {
    // Chain 999999 has no row: routing would throw unsupported-chain.
    const r = await run(
      t,
      { linkers: { sourcify: linker(LINKED).linker } },
      { route: { backend: "routescan" } },
      { chainId: 999_999, address: PROXY },
    );
    const error = errorOf(r.outcome, "invalid-input");
    assert.equal(error.message, "This version cannot link a proxy on routescan.");
    assert.deepEqual(error.details.code === "invalid-input" && error.details.issues, [
      { field: "route.backend", message: "routescan cannot link a proxy" },
    ]);
  });

  it("links on Sourcify for a chain without a row when allowSourcifyFallback is set", async (t) => {
    const r = await run(
      t,
      { linkers: { sourcify: linker(LINKED).linker } },
      { allowSourcifyFallback: true },
      { chainId: 999_999, address: PROXY },
    );
    assert.equal(statusOf(r.outcome), "linked");
  });

  it("names the mismatch of a call that expected no implementation", async (t) => {
    const r = await run(t, {
      linkers: { sourcify: linker({ state: "mismatch", implementation: undefined }).linker },
    });
    const error = errorOf(r.outcome, "proxy-link-unknown-state");
    assert.equal(
      error.message,
      "sourcify refused the link for another implementation than expected, but this call expected none.",
    );
    assert.deepEqual(error.details, {
      code: "proxy-link-unknown-state",
      backend: "sourcify",
      excerpt: "mismatch: the explorer refused for another implementation than expected",
    });
  });
});
