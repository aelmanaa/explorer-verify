// Tests added after a mutation review of the verify flow (#109; R-DX-3, R-FLOW-3, R-FLOW-4,
// R-FLOW-6, R-SEC-1): each one fails on a code change that the other flow tests let pass. The
// tests after the second mutation pass of #158 (R-DX-5, R-FLOW-2, R-FLOW-5) follow at the end.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";

import type { Backend, Target } from "../../src/backends/backend.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import {
  bounded,
  checkRouteOf,
  openCall,
  routeWith,
  settingsOf,
  settle,
} from "../../src/flow/verify.ts";
import type { Call, FlowDependencies } from "../../src/flow/verify.ts";
import { ROUTING_TABLE } from "../../src/routing/table.ts";
import type { Handle, LogFields, Logger, VerifyInput, VerifyOptions } from "../../src/types.ts";
import { runVerify } from "../helpers/defaults.ts";

const SEPOLIA = 11155111;
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const GREETER_JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const TARGET: Target = { chainId: SEPOLIA, address: GREETER };
const HANDLE: Handle = {
  version: 1,
  backend: "sourcify",
  chainId: SEPOLIA,
  address: GREETER,
  jobId: GREETER_JOB,
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
const MESSAGE_START = `sourcify job ${GREETER_JOB} found the contract already verified, but`;

/** A fetch that must not be called: the backends in these tests answer without one. */
const noFetch: typeof fetch = async () => {
  throw new Error("no request expected");
};

/** Sourcify's client, whose poll says "already verified" without the grade, and `lookup`. */
function gradeUnknown(lookup: Backend["lookup"]): Backend {
  return { ...sourcify, poll: async () => ({ state: "already-verified" }), lookup };
}

function callWith(backend: Backend, options: VerifyOptions = {}): Call {
  const settings = settingsOf({ fetch: noFetch, ...options });
  const dependencies: FlowDependencies = { backends: { sourcify: backend }, random: () => 0 };
  const route = routeWith(
    SEPOLIA,
    checkRouteOf(SEPOLIA, settings, dependencies),
    settings,
    dependencies,
    ROUTING_TABLE,
  );
  return openCall(settings, route, TARGET, dependencies);
}

async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    (value: unknown) => ({ resolved: value }),
    (error: unknown) => error,
  );
}

function errorOf(outcome: unknown, code: string): ExplorerVerifyError {
  assert.ok(outcome instanceof ExplorerVerifyError, `expected an error, got ${String(outcome)}`);
  assert.equal(outcome.code, code, outcome.message);
  return outcome;
}

function networkError(): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "network", backend: "sourcify", attempts: 5 },
    "no answer",
    { secrets: [] },
  );
}

describe("settle(): the grade lookup after an already-verified job (R-FLOW-3, R-FLOW-4)", () => {
  it("says the lookup found the contract not verified, with no cause", async () => {
    const call = callWith(gradeUnknown(async () => undefined));
    const error = errorOf(await outcomeOf(settle(call, HANDLE, 0)), "unknown-state");
    assert.equal(
      error.message,
      `${MESSAGE_START} the lookup says it is not verified; the match is not known.`,
    );
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(error.details.code === "unknown-state" && error.details.excerpt, "");
  });

  it("says the lookup failed, with the lookup error as the cause", async () => {
    const call = callWith(
      gradeUnknown(async () => {
        throw networkError();
      }),
    );
    const error = errorOf(await outcomeOf(settle(call, HANDLE, 0)), "unknown-state");
    assert.equal(
      error.message,
      `${MESSAGE_START} the lookup to read its match failed; the match is not known.`,
    );
    assert.equal(Object.hasOwn(error, "cause"), true);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, "no answer");
  });

  it("keeps an excerpt only from an unexpected-response cause", async () => {
    const call = callWith(
      gradeUnknown(async () => {
        throw new ExplorerVerifyError(
          { code: "unknown-state", handle: HANDLE, excerpt: "an excerpt of another error" },
          "another error",
          { secrets: [] },
        );
      }),
    );
    const error = errorOf(await outcomeOf(settle(call, HANDLE, 0)), "unknown-state");
    assert.equal(error.details.code === "unknown-state" && error.details.excerpt, "");
  });

  it("rethrows an error that is not an ExplorerVerifyError unchanged", async () => {
    const thrown = new TypeError("a bug in the client");
    const call = callWith(
      gradeUnknown(async () => {
        throw thrown;
      }),
    );
    assert.equal(await outcomeOf(settle(call, HANDLE, 0)), thrown);
  });

  it("maps a lookup error to unknown-state while the caller's signal has not aborted (R-FLOW-6)", async () => {
    const controller = new AbortController();
    const call = callWith(
      gradeUnknown(async () => {
        throw networkError();
      }),
      { signal: controller.signal },
    );
    errorOf(await outcomeOf(settle(call, HANDLE, 0)), "unknown-state");
  });

  it("rethrows a lookup error unchanged once the caller's signal aborted (R-FLOW-6)", async () => {
    const controller = new AbortController();
    const thrown = networkError();
    const call = callWith(
      gradeUnknown(async () => {
        controller.abort(new Error("stopped by the caller"));
        throw thrown;
      }),
      { signal: controller.signal },
    );
    assert.equal(await outcomeOf(settle(call, HANDLE, 0)), thrown);
  });
});

describe("settingsOf(): options of the wrong kind (R-DX-3)", () => {
  for (const value of ["fast", 5, true]) {
    it(`throws invalid-input for options set to ${JSON.stringify(value)}`, () => {
      // `Reflect.apply` takes untyped arguments, so a JavaScript caller's value needs no cast.
      assert.throws(
        () => Reflect.apply(settingsOf, undefined, [value]),
        (error: unknown) => {
          const checked = errorOf(error, "invalid-input");
          assert.deepEqual(checked.details.code === "invalid-input" && checked.details.issues, [
            { field: "options", message: "must be an object" },
          ]);
          return true;
        },
      );
    });
  }

  it("says what a duration option must be", () => {
    const options: VerifyOptions = {};
    Reflect.set(options, "timeoutMs", "100");
    assert.throws(
      () => settingsOf(options),
      (error: unknown) => {
        const checked = errorOf(error, "invalid-input");
        assert.deepEqual(checked.details.code === "invalid-input" && checked.details.issues, [
          { field: "timeoutMs", message: "must be a positive number of milliseconds" },
        ]);
        return true;
      },
    );
  });
});

describe("verify(): which values of the route's query are secrets (R-SEC-1)", () => {
  it("redacts each value of 8 characters or more that is not all digits, and keeps the rest", async () => {
    const values = {
      letters: "abcdefghij",
      leadingDigits: "12345678abcd",
      trailingDigits: "abcd12345678",
      eight: "exactly8",
      digits: "987654321",
    };
    const query = new URLSearchParams(values).toString();
    const echo = Object.values(values).join(" ");
    const fetch: typeof globalThis.fetch = async () => new Response(echo, { status: 500 });
    const input: VerifyInput = {
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
    const outcome = await outcomeOf(
      runVerify(
        input,
        { fetch, route: { apiUrl: `https://sourcify.example.org/server?${query}` } },
        { backends: { sourcify }, random: () => 0 },
      ),
    );
    const error = errorOf(outcome, "unexpected-response");
    assert.equal(
      error.details.code === "unexpected-response" && error.details.excerpt,
      "[redacted] [redacted] [redacted] [redacted] 987654321",
    );
  });
});

// --- Added after the second mutation pass (#158) -------------------------------------------------

type Line = [level: string, message: string, fields?: LogFields];

function recorder(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push(fields === undefined ? [level, message] : [level, message, fields]);
    };
  return {
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    lines,
  };
}

/** Sourcify's client with `lookup` and `poll` replaced, so no request is sent. */
function scripted(poll: Backend["poll"], lookup: Backend["lookup"]): Backend {
  return { ...sourcify, poll, lookup };
}

/**
 * Runs `promise` on mock timers, ticking one second at a time until it settles, and returns what
 * it resolved to or the error it threw.
 */
async function onClock(t: TestContext, promise: Promise<unknown>): Promise<unknown> {
  const state = { done: false };
  const outcome = outcomeOf(promise).finally(() => {
    state.done = true;
  });
  for (let round = 0; round < 1_000 && !state.done; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    t.mock.timers.tick(1_000);
  }
  assert.ok(state.done, "the call did not settle");
  return await outcome;
}

function timeoutError(): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "timeout", backend: "sourcify", timeoutMs: 30_000 },
    "the request ran out of budget",
    { secrets: [] },
  );
}

const NOT_CONFIRMED = `The verification of job ${GREETER_JOB} on sourcify is not confirmed:`;

describe("settle(): why polling stopped, in the error and the log (R-FLOW-2, R-FLOW-5, R-DX-5)", () => {
  it("logs each failed poll, says when it gives up, and names the failures in the error", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { logger, lines } = recorder();
    const call = callWith(
      scripted(
        async () => {
          throw networkError();
        },
        async () => undefined,
      ),
      { logger, pollIntervalMs: 1_000, timeoutMs: 60_000 },
    );
    const error = errorOf(await onClock(t, settle(call, HANDLE, 0)), "not-confirmed");
    assert.equal(
      error.message,
      `${NOT_CONFIRMED} 3 status polls in a row failed before the job ended, and a last lookup found no match.`,
    );
    assert.deepEqual(
      lines.filter(([level]) => level === "warn"),
      [1, 2, 3].map((attempt) => [
        "warn",
        `sourcify status poll ${String(attempt)} for job ${GREETER_JOB} failed (network); ${attempt < 3 ? "polling again" : "giving up polling"}`,
        { backend: "sourcify", attempt, code: "network", failures: attempt },
      ]),
    );
    assert.deepEqual(
      lines.find(([, message]) => message.startsWith("Polling ")),
      [
        "debug",
        `Polling sourcify job ${GREETER_JOB} stopped (failures); looking the contract up once more`,
        { backend: "sourcify" },
      ],
    );
  });

  it("says the budget ran out when a poll times out, and that the last lookup failed", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { logger, lines } = recorder();
    const call = callWith(
      scripted(
        async () => {
          throw timeoutError();
        },
        async () => {
          throw networkError();
        },
      ),
      { logger, pollIntervalMs: 1_000, timeoutMs: 60_000 },
    );
    const error = errorOf(await onClock(t, settle(call, HANDLE, 0)), "not-confirmed");
    assert.equal(
      error.message,
      `${NOT_CONFIRMED} the 60 s budget ran out before the job ended, and a last lookup failed.`,
    );
    // The poll's timeout error is the cause, not the lookup's network error.
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, "the request ran out of budget");
    assert.ok(lines.some(([, message]) => message.includes(`job ${GREETER_JOB} stopped (budget)`)));
  });

  it("logs each pending poll, and has no cause when no poll failed", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { logger, lines } = recorder();
    const call = callWith(
      scripted(
        async () => ({ state: "pending" }),
        async () => undefined,
      ),
      { logger, pollIntervalMs: 1_000, timeoutMs: 2_000 },
    );
    const error = errorOf(await onClock(t, settle(call, HANDLE, 0)), "not-confirmed");
    assert.equal(
      error.message,
      `${NOT_CONFIRMED} the 2 s budget ran out before the job ended, and a last lookup found no match.`,
    );
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.deepEqual(
      lines.find(([, message]) => message.includes("is pending")),
      [
        "debug",
        `sourcify job ${GREETER_JOB} is pending (poll 1)`,
        { backend: "sourcify", attempt: 1 },
      ],
    );
  });

  it("logs the lookup it makes for a job the explorer no longer knows", async () => {
    const { logger, lines } = recorder();
    const call = callWith(
      scripted(
        async () => {
          throw new ExplorerVerifyError({ code: "job-not-found", handle: HANDLE }, "gone", {
            secrets: [],
          });
        },
        async () => ({ match: "exact" }),
      ),
      { logger },
    );
    const result = await settle(call, HANDLE, 0);
    assert.equal(result.status, "verified");
    assert.deepEqual(
      lines.find(([, message]) => message.includes("looking the contract up instead")),
      [
        "debug",
        `sourcify does not know job ${GREETER_JOB}; looking the contract up instead`,
        { backend: "sourcify" },
      ],
    );
  });
});

describe("verify(): the route and result lines of the log (R-DX-5)", () => {
  it("logs where it verifies and the match it found", async () => {
    const { logger, lines } = recorder();
    const result = await runVerify(
      INPUT,
      { fetch: noFetch, logger },
      {
        backends: {
          sourcify: scripted(
            () => Promise.reject(new Error("no poll expected")),
            async () => ({ match: "partial" }),
          ),
        },
        random: () => 0,
      },
    );
    assert.equal(result.status, "already-verified");
    const messages = lines.map(([level, message]) => `${level} ${message}`);
    assert.ok(messages.includes(`debug Verifying ${GREETER} on chain ${String(SEPOLIA)}`));
    assert.ok(messages.includes("info Result: already-verified (partial) on sourcify"));
  });

  it("logs a failed result without a match", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { logger, lines } = recorder();
    const call = callWith(
      scripted(
        async () => ({ state: "failed", reason: "bytecode does not match" }),
        async () => undefined,
      ),
      { logger },
    );
    const result = await onClock(t, settle(call, HANDLE, 0));
    assert.deepEqual(result, {
      resolved: { status: "failed", backend: "sourcify", reason: "bytecode does not match" },
    });
    assert.deepEqual(
      lines.filter(([level]) => level === "info"),
      [["info", "Result: failed on sourcify", { backend: "sourcify", status: "failed" }]],
    );
  });
});

/** The invalid-input error settingsOf() throws for `options`. */
function issuesOf(options: VerifyOptions): ExplorerVerifyError {
  let thrown: unknown;
  try {
    settingsOf(options);
  } catch (error: unknown) {
    thrown = error;
  }
  return errorOf(thrown, "invalid-input");
}

describe("settingsOf(): the invalid-input error for bad options (R-DX-3, R-SEC-1)", () => {
  it("says what each option of the wrong kind must be, and names them all", () => {
    const options: VerifyOptions = {};
    const bad: [keyof VerifyOptions, unknown][] = [
      ["signal", {}],
      ["fetch", "fetch"],
      ["logger", 42],
      ["onEvent", null],
    ];
    for (const [name, value] of bad) {
      Reflect.set(options, name, value);
    }
    const error = issuesOf(options);
    assert.deepEqual(error.details.code === "invalid-input" && error.details.issues, [
      { field: "signal", message: "must be an AbortSignal" },
      { field: "fetch", message: "must be a function" },
      { field: "logger", message: "must be an object" },
      { field: "onEvent", message: "must be a function" },
    ]);
    assert.equal(error.message, "The options are invalid: signal, fetch, logger, onEvent.");
    assert.match(
      error.hint,
      /^Pass options as a plain object: timeoutMs, pollIntervalMs and indexWaitMs/,
    );
  });

  for (const value of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
    it(`refuses a timeoutMs of ${String(value)}`, () => {
      const error = issuesOf({ timeoutMs: value });
      assert.deepEqual(error.details.code === "invalid-input" && error.details.issues, [
        { field: "timeoutMs", message: "must be a positive number of milliseconds" },
      ]);
    });
  }

  it("removes the apiKeys values from the error", () => {
    // The key is the name of the bad option, so it reaches the message: it is removed from the
    // message only if the error gets the call's keys.
    const error = issuesOf({ apiKeys: { "etherscan-v2": "pollIntervalMs" }, pollIntervalMs: -1 });
    assert.equal(error.message, "The options are invalid: [redacted].");
  });
});

describe("bounded(): the listeners of a load (R-FLOW-6)", () => {
  it("removes its listeners from the caller's signal and from the deadline once the load ends", async (t) => {
    const deadlines: AbortSignal[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      const signal = timeout(ms);
      deadlines.push(signal);
      return signal;
    });
    const controller = new AbortController();
    const loaded = await bounded(
      async () => ({ ready: true }),
      new WeakMap(),
      "the test code",
      "sourcify",
      settingsOf({ signal: controller.signal }),
      { deadline: Date.now() + 60_000, timeoutMs: 60_000 },
    );
    assert.deepEqual(loaded, { ready: true });
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(deadlines.length, 1);
    const [deadline] = deadlines;
    assert.ok(deadline !== undefined);
    assert.equal(getEventListeners(deadline, "abort").length, 0);
  });
});
