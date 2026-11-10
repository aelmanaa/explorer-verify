// Tests for verify() when a status poll answers that the explorer no longer knows the job (#75):
// one lookup in the grace window decides, as in checkStatus(). Every request goes to a fake fetch
// that replays recorded Sourcify answers, every wait runs on mock timers, and the backoff jitter is
// fixed, so each run is deterministic.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";

import type { Backend } from "../../src/backends/backend.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { exitCodeOf, toEnvelope } from "../../src/envelope.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { REQUEST_TIMEOUT_MS } from "../../src/http/fetch.ts";
import type {
  Handle,
  Logger,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/index.ts";
import { ROUTING_TABLE } from "../../src/routing/table.ts";
import { runCheckStatus, runVerify } from "../helpers/defaults.ts";
import { loadFixture, responseOf } from "../helpers/fake-fetch.ts";
import type { Fixture } from "../helpers/fake-fetch.ts";
import { compileStrict, validateEnvelope } from "./envelope-schema.ts";

const SEPOLIA = 11155111;
// The Greeter deployed on Sepolia on 2026-11-02, whose responses the fixtures recorded.
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const GREETER_JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const GREETER_PAGE = `https://repo.sourcify.dev/${String(SEPOLIA)}/${GREETER}`;
const LOOKUP_URL = `https://sourcify.dev/server/v2/contract/${String(SEPOLIA)}/${GREETER}?fields=compilation`;
const SUBMIT_URL = `https://sourcify.dev/server/v2/verify/${String(SEPOLIA)}/${GREETER}`;
const POLL_URL = `https://sourcify.dev/server/v2/verify/${GREETER_JOB}`;
const LINE = `ev1:sourcify:${String(SEPOLIA)}:${GREETER}:${GREETER_JOB}`;
const HANDLE: Handle = {
  version: 1,
  backend: "sourcify",
  chainId: SEPOLIA,
  address: GREETER,
  jobId: GREETER_JOB,
};
const AGAIN_HINT =
  "Call verify() again: the job is gone and the contract is not verified, so a new submission is needed.";
const LOOKING_UP = `sourcify does not know job ${GREETER_JOB}; looking the contract up instead`;

const eventSchema: unknown = JSON.parse(
  readFileSync(new URL("../../schema/event.schema.json", import.meta.url), "utf8"),
);
const validateEvent = compileStrict(eventSchema);

function fixture(name: string): Fixture {
  return loadFixture("sourcify", `2026-11-02-${name}`);
}

const INPUT: VerifyInput = {
  chainId: SEPOLIA,
  address: GREETER,
  compiler: {
    kind: "solc",
    version: "0.8.24+commit.e11b9ed9",
    input: {
      language: "Solidity",
      sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
      settings: { optimizer: { enabled: true, runs: 200 } },
    },
  },
  contractName: "contracts/Greeter.sol:Greeter",
};

/** One answer of the fake fetch: a fixture, or a request that never ends. */
type Step = Fixture | "hang";

/** A fake fetch that plays `steps` in order. A request after the last step rejects. */
function script(steps: readonly Step[]): { fetch: typeof fetch; sent: string[] } {
  const sent: string[] = [];
  const fake = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    sent.push(`${init?.method ?? "GET"} ${url}`);
    const step = steps[sent.length - 1];
    if (step === undefined) {
      throw new Error(`unexpected request ${String(sent.length)}`);
    }
    if (step === "hang") {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    }
    return responseOf(step);
  };
  return { fetch: fake, sent };
}

interface Line {
  readonly level: keyof Logger;
  readonly message: string;
}

interface Use {
  readonly options?: VerifyOptions;
  readonly backend?: Backend;
  /** Called after each round of timers, with the requests so far. */
  readonly onRound?: (sent: readonly string[]) => void;
}

interface Run {
  readonly outcome: unknown;
  readonly events: VerifyEvent[];
  readonly lines: Line[];
  readonly sent: string[];
  /** Milliseconds on the mock clock from the call to its end. */
  readonly elapsed: number;
}

type Start = (options: VerifyOptions, backend: Backend) => Promise<VerifyResult>;

// The table is passed loaded: run() below gives the call a fixed number of real turns, and a
// table import that outlasts them leaves the call unsettled (decision 0040).
const startVerify: Start = async (options, backend) =>
  await runVerify(INPUT, options, {
    random: () => 0,
    backends: { sourcify: backend },
    table: ROUTING_TABLE,
  });

const startCheckStatus: Start = async (options, backend) =>
  await runCheckStatus(LINE, options, {
    random: () => 0,
    backends: { sourcify: backend },
    table: ROUTING_TABLE,
  });

/**
 * Runs `start` on mock timers until it settles, with a logger and onEvent that record every line
 * and event. Every event must fit the shipped event schema, checked by strict ajv (R-DX-6).
 */
async function run(
  t: TestContext,
  start: Start,
  steps: readonly Step[],
  use: Use = {},
): Promise<Run> {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { fetch, sent } = script(steps);
  const lines: Line[] = [];
  const at =
    (level: keyof Logger) =>
    (message: string): void => {
      lines.push({ level, message });
    };
  const events: VerifyEvent[] = [];
  const options: VerifyOptions = {
    fetch,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    ...use.options,
    onEvent: (event) => {
      events.push(event);
      return use.options?.onEvent?.(event);
    },
  };
  const state = { done: false };
  const tracked = start(options, use.backend ?? sourcify)
    .then(
      (result: VerifyResult): unknown => result,
      (error: unknown): unknown => error,
    )
    .finally(() => {
      state.done = true;
    });
  for (let round = 0; round < 500 && !state.done; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    use.onRound?.(sent);
    if (!state.done) {
      t.mock.timers.runAll();
    }
  }
  assert.ok(state.done, "the call did not settle");
  const outcome = await tracked;
  for (const event of events) {
    assert.deepEqual(
      validateEvent(event),
      [],
      `breaks event.schema.json: ${JSON.stringify(event)}`,
    );
  }
  return { outcome, events, lines, sent, elapsed: Date.now() };
}

/** The lookup, the accepted submit, `pending` pending polls, then a job-not-found poll. */
function forgotten(pending = 0): Fixture[] {
  return [
    fixture("lookup-not-verified"),
    fixture("submit-accepted"),
    ...Array.from({ length: pending }, () => fixture("job-pending")),
    fixture("job-not-found"),
  ];
}

function jobNotFound(outcome: unknown): ExplorerVerifyError {
  assert.ok(outcome instanceof ExplorerVerifyError, `expected an error, got ${String(outcome)}`);
  assert.equal(outcome.code, "job-not-found", outcome.message);
  return outcome;
}

/** Fails unless the error's envelope fits the schema, keeps the handle and maps to exit code 6 (R-AX-7). */
function assertJobNotFoundEnvelope(error: ExplorerVerifyError): void {
  assert.deepEqual(error.details, { code: "job-not-found", handle: HANDLE });
  const envelope = toEnvelope(error);
  assert.deepEqual(validateEnvelope(envelope), []);
  assert.equal(envelope.ok, false);
  assert.equal(error.toJSON().handle, LINE);
  assert.equal(error.retryable, false);
  assert.equal(exitCodeOf(error), 6);
}

function causeCode(error: ExplorerVerifyError): unknown {
  return error.cause instanceof Error ? Reflect.get(error.cause, "code") : undefined;
}

function networkError(): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "network", backend: "sourcify", attempts: 5 },
    "Sourcify could not be reached.",
    { secrets: [] },
  );
}

/** Sourcify's client, except that every lookup after the first runs `later`. */
function laterLookups(later: () => Promise<undefined>): Backend {
  const seen = { lookups: 0 };
  return {
    ...sourcify,
    lookup: async (target, ctx) => {
      seen.lookups += 1;
      return seen.lookups === 1 ? await sourcify.lookup(target, ctx) : await later();
    },
  };
}

/** Sourcify's client whose job-not-found poll answer arrives at `atMs` on the mock clock. */
function lateNotFound(t: TestContext, atMs: number): Backend {
  return {
    ...sourcify,
    poll: async (handle, ctx) => {
      try {
        return await sourcify.poll(handle, ctx);
      } catch (error: unknown) {
        t.mock.timers.tick(atMs - Date.now());
        throw error;
      }
    },
  };
}

// --- outcomes -------------------------------------------------------------------------------------

describe("verify(): a job the explorer no longer knows (#75)", () => {
  it("returns verified when the lookup finds an exact match after job_not_found (R-FLOW-3, R-FLOW-5, R-AX-7)", async (t) => {
    const r = await run(t, startVerify, [...forgotten(1), fixture("lookup-exact-match")]);
    const expected: VerifyResult = {
      status: "verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: GREETER_PAGE,
    };
    assert.deepEqual(r.outcome, expected);
    const envelope = toEnvelope(expected);
    assert.deepEqual(validateEnvelope(envelope), []);
    assert.equal(envelope.ok, true);
    assert.equal(exitCodeOf(expected), 0);
    assert.deepEqual(r.sent, [
      `GET ${LOOKUP_URL}`,
      `POST ${SUBMIT_URL}`,
      `GET ${POLL_URL}`,
      `GET ${POLL_URL}`,
      `GET ${LOOKUP_URL}`,
    ]);
    // The lookup follows the job-not-found poll at once: two intervals in all.
    assert.equal(r.elapsed, 6_000);
    assert.ok(r.lines.some((line) => line.level === "debug" && line.message === LOOKING_UP));
    assert.ok(!r.lines.some((line) => line.level === "error"));
  });

  it("throws job-not-found with the handle and the hint to call verify() again when the lookup finds no match (R-FLOW-5, R-AX-7)", async (t) => {
    const r = await run(t, startVerify, [...forgotten(), fixture("lookup-not-verified")]);
    const error = jobNotFound(r.outcome);
    assertJobNotFoundEnvelope(error);
    assert.equal(error.hint, AGAIN_HINT);
    assert.equal(
      error.message,
      `sourcify does not know job ${GREETER_JOB}, and a lookup found the contract not verified.`,
    );
    // The cause is the poll's own job-not-found error.
    assert.equal(causeCode(error), "job-not-found");
    assert.equal(r.sent.length, 4);
    assert.equal(r.sent[3], `GET ${LOOKUP_URL}`);
    assert.ok(!r.events.some((event) => event.type === "verify.result"));
  });

  it("throws job-not-found with the lookup's error as cause and the catalogue hint when the lookup fails (R-FLOW-5, R-AX-7)", async (t) => {
    const backend = laterLookups(async () => {
      throw networkError();
    });
    const r = await run(t, startVerify, forgotten(), { backend });
    const error = jobNotFound(r.outcome);
    assertJobNotFoundEnvelope(error);
    assert.notEqual(error.hint, AGAIN_HINT);
    assert.ok(error.hint.startsWith("Do not retry automatically."), error.hint);
    assert.equal(
      error.message,
      `sourcify does not know job ${GREETER_JOB}, and the lookup of the contract failed.`,
    );
    assert.equal(causeCode(error), "network");
  });

  it("rethrows an error that is not an ExplorerVerifyError from that lookup unchanged (R-FLOW-5)", async (t) => {
    const bug = new RangeError("bug");
    const backend = laterLookups(async () => {
      throw bug;
    });
    const r = await run(t, startVerify, forgotten(), { backend });
    assert.equal(r.outcome, bug);
  });

  it("does not catch a poll error other than job-not-found (R-FLOW-4)", async (t) => {
    const lookups = { count: 0 };
    const unknown = new ExplorerVerifyError(
      { code: "unknown-state", handle: HANDLE, excerpt: "" },
      "a final state the library cannot classify",
      { secrets: [] },
    );
    const backend: Backend = {
      ...laterLookups(async () => {
        lookups.count += 1;
        return await Promise.resolve(undefined);
      }),
      poll: async () => {
        throw unknown;
      },
    };
    const r = await run(t, startVerify, forgotten().slice(0, 2), { backend });
    assert.equal(r.outcome, unknown);
    assert.equal(lookups.count, 0);
  });
});

describe("verify(): only the library's job-not-found starts the lookup (R-FLOW-5)", () => {
  it("rethrows a plain Error whose code is job-not-found unchanged, with no lookup (R-FLOW-5, R-AX-7)", async (t) => {
    const lookups = { count: 0 };
    const impostor = Object.assign(new Error("not ours"), { code: "job-not-found" });
    const backend: Backend = {
      ...laterLookups(async () => {
        lookups.count += 1;
        return await Promise.resolve(undefined);
      }),
      poll: async () => {
        throw impostor;
      },
    };
    const r = await run(t, startVerify, forgotten().slice(0, 2), { backend });
    assert.equal(r.outcome, impostor);
    assert.equal(lookups.count, 0);
  });
});

// --- abort ----------------------------------------------------------------------------------------

describe("verify(): abort around a forgotten job (R-FLOW-6, R-FLOW-5)", () => {
  it("rejects with the reason, unchanged, when aborted during the lookup (R-FLOW-6, R-FLOW-5)", async (t) => {
    const controller = new AbortController();
    // A reason that looks like the flow's own error, so a mapping would show.
    const reason = new ExplorerVerifyError(
      { code: "job-not-found", handle: HANDLE },
      "the reason",
      {
        secrets: [],
      },
    );
    const backend = laterLookups(async () => {
      controller.abort(reason);
      throw reason;
    });
    const r = await run(t, startVerify, forgotten(), {
      options: { signal: controller.signal },
      backend,
    });
    assert.equal(r.outcome, reason);
  });

  it("checkStatus() rejects with the reason, not the lookup's error, when the signal aborts during that lookup (R-FLOW-6, R-FLOW-5)", async (t) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const backend: Backend = {
      ...sourcify,
      lookup: async () => {
        controller.abort(reason);
        throw networkError();
      },
    };
    const r = await run(t, startCheckStatus, [fixture("job-not-found")], {
      options: { signal: controller.signal },
      backend,
    });
    assert.equal(r.outcome, reason);
  });

  it("rejects with the reason when the signal aborts while the lookup request hangs (R-FLOW-6, R-FLOW-5)", async (t) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const r = await run(t, startVerify, [...forgotten(), "hang"], {
      options: { signal: controller.signal },
      onRound: (sent) => {
        if (sent.length === 4) {
          controller.abort(reason);
        }
      },
    });
    assert.equal(r.outcome, reason);
    assert.equal(r.sent.length, 4);
  });

  it("rejects with the reason, and looks nothing up, when the signal aborts as the job-not-found answer arrives (R-FLOW-6, R-FLOW-5)", async (t) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const lookups = { count: 0 };
    const backend: Backend = {
      ...laterLookups(async () => {
        lookups.count += 1;
        return await Promise.resolve(undefined);
      }),
      poll: async (handle, ctx) => {
        try {
          return await sourcify.poll(handle, ctx);
        } finally {
          controller.abort(reason);
        }
      },
    };
    const r = await run(t, startVerify, forgotten(), {
      options: { signal: controller.signal },
      backend,
    });
    assert.equal(r.outcome, reason);
    assert.equal(lookups.count, 0);
  });
});

// --- time bound -----------------------------------------------------------------------------------

describe("verify(): the time bound with a forgotten job (R-FLOW-2)", () => {
  it("ends within timeoutMs + min(pollIntervalMs, 30000) when the answer comes at the deadline and the lookup hangs (R-FLOW-2, R-AX-7)", async (t) => {
    const cases: [timeoutMs: number, pollIntervalMs: number, pending: number][] = [
      [10_000, 3_000, 2],
      [100_000, 40_000, 1],
      [5_000, 1_000, 3],
    ];
    for (const [timeoutMs, pollIntervalMs, pending] of cases) {
      const r = await run(t, startVerify, [...forgotten(pending), "hang"], {
        options: { timeoutMs, pollIntervalMs },
        backend: lateNotFound(t, timeoutMs),
      });
      const error = jobNotFound(r.outcome);
      assertJobNotFoundEnvelope(error);
      assert.ok(error.cause instanceof Error);
      assert.ok(error.cause.message.includes("did not finish within"), error.cause.message);
      const bound = timeoutMs + Math.min(pollIntervalMs, REQUEST_TIMEOUT_MS);
      // The lookup got exactly the grace window past the deadline, and no more.
      assert.equal(r.elapsed, bound, `timeoutMs ${String(timeoutMs)}`);
    }
  });

  it("finds a match in the grace window when the answer comes after the deadline (R-FLOW-2, R-FLOW-3)", async (t) => {
    // The poll at 1000 ms answers at 2500 ms, past the 2000 ms deadline.
    const r = await run(t, startVerify, [...forgotten(), fixture("lookup-exact-match")], {
      options: { timeoutMs: 2_000, pollIntervalMs: 1_000 },
      backend: lateNotFound(t, 2_500),
    });
    assert.deepEqual(r.outcome, {
      status: "verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: GREETER_PAGE,
    });
    assert.equal(r.elapsed, 2_500);
  });
});

// --- events ---------------------------------------------------------------------------------------

describe("verify(): events for a forgotten job (R-DX-6, R-FLOW-5)", () => {
  it("emits no extra verify.lookup, and the same events after the poll as checkStatus() (R-DX-6, R-FLOW-5)", async (t) => {
    const found = await run(t, startVerify, [...forgotten(1), fixture("lookup-exact-match")]);
    assert.deepEqual(found.events, [
      { type: "verify.validated", chainId: SEPOLIA, address: GREETER },
      {
        type: "verify.routed",
        backend: "sourcify",
        apiHost: "sourcify.dev",
        routedBy: "table",
      },
      { type: "verify.lookup", backend: "sourcify", lookup: "none" },
      { type: "verify.submitted", backend: "sourcify", handle: LINE },
      { type: "verify.poll", backend: "sourcify", attempt: 1, state: "pending" },
      {
        type: "verify.result",
        backend: "sourcify",
        status: "verified",
        match: "exact",
        explorerUrl: GREETER_PAGE,
      },
    ]);

    const resumed = await run(t, startCheckStatus, [
      fixture("job-pending"),
      fixture("job-not-found"),
      fixture("lookup-exact-match"),
    ]);
    assert.deepEqual(resumed.outcome, found.outcome);
    const afterSubmit = found.events.slice(
      found.events.findIndex((event) => event.type === "verify.submitted") + 1,
    );
    const afterRoute = resumed.events.slice(
      resumed.events.findIndex((event) => event.type === "verify.routed") + 1,
    );
    assert.deepEqual(afterSubmit, afterRoute);

    const missing = await run(t, startVerify, [...forgotten(), fixture("lookup-not-verified")]);
    jobNotFound(missing.outcome);
    assert.deepEqual(
      missing.events.map((event) => event.type),
      ["verify.validated", "verify.routed", "verify.lookup", "verify.submitted"],
    );
    const gone = await run(t, startCheckStatus, [
      fixture("job-not-found"),
      fixture("lookup-not-verified"),
    ]);
    assert.deepEqual(
      gone.events.map((event) => event.type),
      ["verify.routed"],
    );
    assert.equal(jobNotFound(gone.outcome).message, jobNotFound(missing.outcome).message);
    assert.equal(jobNotFound(gone.outcome).hint, jobNotFound(missing.outcome).hint);
  });
});

// --- abortWins edges, from review -----------------------------------------------------------------

describe("verify() and checkStatus(): abortWins edges (R-FLOW-6, R-FLOW-5)", () => {
  it("lets the error through when the signal never aborts, in verify() and checkStatus() (R-FLOW-6, R-AX-7)", async (t) => {
    const fromVerify = await run(t, startVerify, [...forgotten(), fixture("lookup-not-verified")], {
      options: { signal: new AbortController().signal },
    });
    assertJobNotFoundEnvelope(jobNotFound(fromVerify.outcome));
    const fromStatus = await run(
      t,
      startCheckStatus,
      [fixture("job-not-found"), fixture("lookup-not-verified")],
      { options: { signal: new AbortController().signal } },
    );
    assertJobNotFoundEnvelope(jobNotFound(fromStatus.outcome));
  });

  it("returns the result reached before an abort that onEvent makes on verify.result (R-FLOW-6, R-FLOW-3)", async (t) => {
    const controller = new AbortController();
    const r = await run(t, startVerify, [...forgotten(), fixture("lookup-exact-match")], {
      options: {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "verify.result") {
            controller.abort(new Error("late"));
          }
        },
      },
    });
    assert.ok(controller.signal.aborted);
    assert.deepEqual(r.outcome, {
      status: "verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: GREETER_PAGE,
    });
  });

  for (const reason of ["stop", { why: "stop" }, 0, null]) {
    it(`keeps a reason that is not an Error, ${JSON.stringify(reason)}, by identity (R-FLOW-6)`, async (t) => {
      const controller = new AbortController();
      const backend = laterLookups(async () => {
        controller.abort(reason);
        throw new TypeError("not the reason");
      });
      const r = await run(t, startVerify, forgotten(), {
        options: { signal: controller.signal },
        backend,
      });
      assert.equal(r.outcome, reason);
    });
  }

  it("leaves no abort listener on the caller's signal after an abort during a hung lookup (R-FLOW-6)", async (t) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const r = await run(t, startVerify, [...forgotten(), "hang"], {
      options: { signal: controller.signal },
      onRound: (sent) => {
        if (sent.length === 4) {
          controller.abort(reason);
        }
      },
    });
    assert.equal(r.outcome, reason);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("keeps the call's deadline for the lookup when job-not-found arrives early (R-FLOW-2)", async (t) => {
    // The poll at 1000 ms answers job-not-found and the lookup hangs. The budget ends at 3000 ms,
    // later than one grace window after the answer, so the call ends at 3000 ms, not 4000 ms.
    const r = await run(t, startVerify, [...forgotten(), "hang"], {
      options: { timeoutMs: 3_000, pollIntervalMs: 1_000 },
    });
    assertJobNotFoundEnvelope(jobNotFound(r.outcome));
    assert.equal(r.elapsed, 3_000);
  });
});
