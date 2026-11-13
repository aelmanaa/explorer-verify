// Tests for checkStatus() (R-FLOW-5, R-SEC-2, R-DX-6): resuming a submitted job from its handle.
// Every request goes to a fake fetch that replays recorded Sourcify answers, every wait runs on
// mock timers, and the backoff jitter is fixed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { Backend } from "../../src/backends/backend.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "../../src/envelope.ts";
import type { ErrorCode } from "../../src/errors.ts";
import { MAX_POLL_FAILURES } from "../../src/flow/verify.ts";
import type { FlowDependencies } from "../../src/flow/verify.ts";
import { ExplorerVerifyError, checkStatus, formatHandle, parseHandle } from "../../src/index.ts";
import type {
  Handle,
  LogFields,
  Logger,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/index.ts";
import { runCheckStatus, runVerify } from "../helpers/defaults.ts";
import { loadFixture, responseOf } from "../helpers/fake-fetch.ts";
import type { Fixture } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { compileStrict, validateEnvelope } from "./envelope-schema.ts";

const SEPOLIA = 11155111;
// The Greeter deployed on Sepolia on 2026-11-02, whose responses the fixtures recorded.
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const GREETER_CHECKSUM = "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC";
const GREETER_JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const GREETER_PAGE = `https://repo.sourcify.dev/${String(SEPOLIA)}/${GREETER}`;
const POLL_URL = `https://sourcify.dev/server/v2/verify/${GREETER_JOB}`;
const LOOKUP_URL = `https://sourcify.dev/server/v2/contract/${String(SEPOLIA)}/${GREETER}?fields=compilation`;
// The contract of the no_match, already_verified and internal_error jobs.
const OTHER = "0xa6b01960ea6e942ada412c76456bc9465682f3ab";
const OTHER_JOB = "dea83eb0-3918-449b-a914-3038dd554b42";
// A fake key. Never a real one (R-SEC-1).
const SECRET = "status-dummy-secret-9x4k";

const eventSchema: unknown = JSON.parse(
  readFileSync(new URL("../../schema/event.schema.json", import.meta.url), "utf8"),
);
const validateEvent = compileStrict(eventSchema);

function fixture(name: string): Fixture {
  return loadFixture("sourcify", `2026-11-02-${name}`);
}

function handleOf(address: string = GREETER, jobId: string = GREETER_JOB): Handle {
  return {
    version: 1,
    backend: "sourcify",
    chainId: SEPOLIA,
    address: `0x${address.slice(2)}`,
    jobId,
  };
}

const LINE = `ev1:sourcify:${String(SEPOLIA)}:${GREETER}:${GREETER_JOB}`;

/** One answer of the fake fetch: a fixture, a response or an error. */
type Step = Fixture | Response | Error;

interface Sent {
  readonly url: string;
  readonly method: string;
}

/** A fake fetch that plays `steps` in order. A request after the last step rejects. */
function script(steps: readonly Step[]): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fake = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    sent.push({ url, method: init?.method ?? "GET" });
    const step = steps[sent.length - 1];
    if (step === undefined) {
      throw new Error(`unexpected request ${String(sent.length)}`);
    }
    if (step instanceof Error) {
      throw step;
    }
    return step instanceof Response ? step.clone() : responseOf(step);
  };
  return { fetch: fake, sent };
}

interface Line {
  readonly level: keyof Logger;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

function recorder(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: keyof Logger) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields });
    };
  return {
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    lines,
  };
}

interface Run {
  readonly outcome: unknown;
  readonly events: VerifyEvent[];
  readonly lines: Line[];
  readonly sent: Sent[];
  /** Milliseconds on the mock clock from the call to its end. */
  readonly elapsed: number;
}

/** Runs `start` on mock timers until it settles; every event must fit the event schema. */
async function settleOnTimers(
  t: TestContext,
  start: () => Promise<VerifyResult>,
): Promise<unknown> {
  const state = { done: false };
  const tracked = start()
    .then(
      (result: VerifyResult): unknown => result,
      (error: unknown): unknown => error,
    )
    .finally(() => {
      state.done = true;
    });
  await driveMockClock(tracked, () => {
    t.mock.timers.runAll();
  });
  assert.ok(state.done, "the call did not settle");
  return await tracked;
}

interface RunOptions {
  readonly options?: VerifyOptions;
  readonly dependencies?: Partial<FlowDependencies>;
}

/**
 * Runs checkStatus() on mock timers until it settles, with a logger and onEvent that record every
 * line and event. Every event must fit the shipped event schema, checked by strict ajv (R-DX-6).
 */
async function run(
  t: TestContext,
  handle: unknown,
  steps: readonly Step[],
  use: RunOptions = {},
): Promise<Run> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { fetch, sent } = script(steps);
  const { logger, lines } = recorder();
  const events: VerifyEvent[] = [];
  const options: VerifyOptions = {
    fetch,
    logger,
    ...use.options,
    onEvent: (event) => {
      events.push(event);
    },
  };
  const outcome = await settleOnTimers(
    t,
    async () =>
      await runCheckStatus(handle, options, {
        random: () => 0,
        backends: use.dependencies?.backends ?? { sourcify },
      }),
  );
  for (const event of events) {
    assert.deepEqual(
      validateEvent(event),
      [],
      `breaks event.schema.json: ${JSON.stringify(event)}`,
    );
  }
  return { outcome, events, lines, sent, elapsed: Date.now() };
}

function errorOf(outcome: unknown, code: ErrorCode): ExplorerVerifyError {
  assert.ok(outcome instanceof ExplorerVerifyError, `expected an error, got ${String(outcome)}`);
  assert.equal(outcome.code, code, outcome.message);
  return outcome;
}

/** Fails unless the result is exactly `expected`, fits the envelope schema and maps to `exitCode`. */
function assertResult(outcome: unknown, expected: VerifyResult, exitCode: number): void {
  assert.deepEqual(outcome, expected);
  const envelope = toEnvelope(expected);
  assert.deepEqual(validateEnvelope(envelope), []);
  assert.equal(exitCodeOf(expected), exitCode);
  assert.equal(envelope.ok, exitCode === 0);
}

/** Fails unless the error's envelope fits the schema and maps to the catalogue's exit code. */
function assertErrorEnvelope(error: ExplorerVerifyError, exitCode: number): void {
  const envelope = toEnvelope(error);
  assert.deepEqual(validateEnvelope(envelope), []);
  assert.equal(exitCodeOf(error), ERROR_EXIT_CODES[error.code]);
  assert.equal(exitCodeOf(error), exitCode);
}

function types(events: readonly VerifyEvent[]): string[] {
  return events.map((event) => event.type);
}

function pending(count: number): Step[] {
  return Array.from({ length: count }, () => fixture("job-pending"));
}

/** A network error from a backend, as the HTTP layer throws it after its retries. */
function networkError(): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "network", backend: "sourcify", attempts: 5 },
    "Sourcify could not be reached.",
    { secrets: [] },
  );
}

/** Sourcify's client with `lookup` replaced. */
function withLookup(lookup: Backend["lookup"]): Backend {
  return { ...sourcify, lookup };
}

const ROUTED: VerifyEvent = {
  type: "verify.routed",
  backend: "sourcify",
  apiHost: "sourcify.dev",
  routedBy: "table",
};

// --- resume ---------------------------------------------------------------------------------------

describe("checkStatus(): resume a job (R-FLOW-5)", () => {
  it("polls a pending job until it is verified, from the handle object (R-FLOW-5, R-FLOW-2)", async (t) => {
    const r = await run(t, handleOf(), [...pending(2), fixture("job-exact-match")]);
    assertResult(
      r.outcome,
      { status: "verified", backend: "sourcify", match: "exact", explorerUrl: GREETER_PAGE },
      0,
    );
    assert.deepEqual(
      r.sent.map((s) => `${s.method} ${s.url}`),
      [`GET ${POLL_URL}`, `GET ${POLL_URL}`, `GET ${POLL_URL}`],
    );
    // The first poll goes out at once; one interval before each later poll.
    assert.equal(r.elapsed, 2 * 3_000);
    // Only the events that apply to a resume: no validated, lookup or submitted (R-DX-6).
    assert.deepEqual(r.events, [
      ROUTED,
      { type: "verify.poll", backend: "sourcify", attempt: 1, state: "pending" },
      { type: "verify.poll", backend: "sourcify", attempt: 2, state: "pending" },
      {
        type: "verify.result",
        backend: "sourcify",
        status: "verified",
        match: "exact",
        explorerUrl: GREETER_PAGE,
      },
    ]);
  });

  it("takes the one-line form and returns at once for a job that already ended (R-FLOW-5)", async (t) => {
    const r = await run(t, LINE, [fixture("job-exact-match")]);
    assertResult(
      r.outcome,
      { status: "verified", backend: "sourcify", match: "exact", explorerUrl: GREETER_PAGE },
      0,
    );
    assert.equal(r.sent.length, 1);
    assert.equal(r.elapsed, 0);
  });

  it("resumes the same job from the handle object and from formatHandle's line (R-FLOW-5, #218)", async (t) => {
    const forms: unknown[] = [handleOf(), formatHandle(handleOf())];
    for (const form of forms) {
      const r = await run(t, form, [...pending(1), fixture("job-exact-match")]);
      assertResult(
        r.outcome,
        { status: "verified", backend: "sourcify", match: "exact", explorerUrl: GREETER_PAGE },
        0,
      );
      assert.deepEqual(
        r.sent.map((s) => `${s.method} ${s.url}`),
        [`GET ${POLL_URL}`, `GET ${POLL_URL}`],
      );
      t.mock.timers.reset();
    }
  });

  it("uses the address in lower case for the lookup and the page (R-FLOW-3)", async (t) => {
    const r = await run(
      t,
      handleOf(GREETER_CHECKSUM),
      [...pending(1), fixture("lookup-exact-match")],
      { options: { timeoutMs: 1_000 } },
    );
    assertResult(
      r.outcome,
      { status: "verified", backend: "sourcify", match: "exact", explorerUrl: GREETER_PAGE },
      0,
    );
    assert.equal(r.sent[1]?.url, LOOKUP_URL);
  });

  it("keeps the handle's case in a not-confirmed error (R-FLOW-5)", async (t) => {
    const r = await run(
      t,
      handleOf(GREETER_CHECKSUM),
      [...pending(1), fixture("lookup-not-verified")],
      { options: { timeoutMs: 1_000 } },
    );
    const error = errorOf(r.outcome, "not-confirmed");
    assert.deepEqual(error.details, { code: "not-confirmed", handle: handleOf(GREETER_CHECKSUM) });
    assert.equal(r.sent[1]?.url, LOOKUP_URL);
  });

  it("returns failed for a rejected job, as verify() does (R-FLOW-4)", async (t) => {
    const r = await run(t, handleOf(OTHER, OTHER_JOB), [fixture("job-no-match")]);
    const result = r.outcome;
    assert.ok(typeof result === "object" && result !== null && "status" in result);
    assert.equal(result.status, "failed");
    assert.ok("reason" in result && typeof result.reason === "string");
    assert.ok(result.reason.startsWith("no_match"));
    assertResult(
      result,
      {
        status: "failed",
        backend: "sourcify",
        reason: result.reason,
        reasonCode: "bytecode-mismatch",
      },
      1,
    );
    assert.deepEqual(r.events.at(-1), {
      type: "verify.result",
      backend: "sourcify",
      status: "failed",
    });
  });

  it("looks the grade up for a job that found the contract already verified (R-FLOW-3)", async (t) => {
    const r = await run(t, handleOf(OTHER, OTHER_JOB), [
      fixture("job-already-verified"),
      fixture("lookup-match"),
    ]);
    assertResult(
      r.outcome,
      {
        status: "already-verified",
        backend: "sourcify",
        match: "partial",
        explorerUrl: `https://repo.sourcify.dev/${String(SEPOLIA)}/${OTHER}`,
      },
      0,
    );
  });

  it("throws verification-inconclusive, with no handle, for a job that ended without a verdict (decision 0011)", async (t) => {
    const r = await run(t, handleOf(OTHER, OTHER_JOB), [fixture("job-internal-error")]);
    const error = errorOf(r.outcome, "verification-inconclusive");
    assert.equal(error.toJSON().handle, undefined);
    assert.ok(error.hint.includes("verify()"));
    assertErrorEnvelope(error, 4);
    // One poll: the job has ended, so polling it again would give the same answer.
    assert.equal(r.sent.length, 1);
    assert.ok(!types(r.events).includes("verify.result"));
  });

  it("resumes the handle of a not-confirmed error from verify() (R-FLOW-5)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
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
    const first = script([
      fixture("lookup-not-verified"),
      fixture("submit-accepted"),
      ...pending(1),
      fixture("lookup-not-verified"),
    ]);
    const deps: FlowDependencies = { backends: { sourcify }, random: () => 0 };
    const outcome = await settleOnTimers(
      t,
      async () => await runVerify(input, { fetch: first.fetch, timeoutMs: 4_000 }, deps),
    );
    const error = errorOf(outcome, "not-confirmed");
    const line = error.toJSON().handle;
    assert.equal(line, LINE);
    // A CLI prints the line and reads it back; a browser stores the object as JSON.
    for (const stored of [line, JSON.parse(JSON.stringify(error.details))]) {
      const handle: unknown =
        typeof stored === "object" && stored !== null && "handle" in stored
          ? stored.handle
          : stored;
      const second = script([fixture("job-exact-match")]);
      const result = await settleOnTimers(
        t,
        async () => await runCheckStatus(handle, { fetch: second.fetch }, deps),
      );
      assert.deepEqual(result, {
        status: "verified",
        backend: "sourcify",
        match: "exact",
        explorerUrl: GREETER_PAGE,
      });
      assert.deepEqual(second.sent, [{ url: POLL_URL, method: "GET" }]);
    }
  });
});

// --- budget ---------------------------------------------------------------------------------------

describe("checkStatus(): time budget (R-FLOW-2, R-FLOW-4, R-FLOW-5)", () => {
  it("throws not-confirmed with the same handle when the budget runs out (R-FLOW-5)", async (t) => {
    const handle = handleOf();
    const r = await run(t, handle, [...pending(4), fixture("lookup-not-verified")], {
      options: { timeoutMs: 10_000, pollIntervalMs: 3_000 },
    });
    const error = errorOf(r.outcome, "not-confirmed");
    assert.deepEqual(error.details, { code: "not-confirmed", handle });
    assert.equal(error.toJSON().handle, formatHandle(handle));
    assert.equal(error.retryable, true);
    assert.ok(error.message.includes("the 10 s budget ran out"));
    assertErrorEnvelope(error, 4);
    // Polls at 0, 3, 6 and 9 s; the budget ends at 10 s; one last lookup.
    assert.deepEqual(
      r.sent.map((s) => s.url),
      [POLL_URL, POLL_URL, POLL_URL, POLL_URL, LOOKUP_URL],
    );
    assert.equal(r.elapsed, 10_000);
    assert.ok(!types(r.events).includes("verify.result"));
    // The handle in the error resumes again.
    assert.deepEqual(parseHandle(error.toJSON().handle), handle);
  });

  it("turns a lagging job into verified with the last lookup (R-FLOW-2)", async (t) => {
    const r = await run(t, handleOf(), [...pending(2), fixture("lookup-exact-match")], {
      options: { timeoutMs: 4_000 },
    });
    assertResult(
      r.outcome,
      { status: "verified", backend: "sourcify", match: "exact", explorerUrl: GREETER_PAGE },
      0,
    );
  });

  it(`ends with not-confirmed after ${String(MAX_POLL_FAILURES)} failed polls in a row`, async (t) => {
    const polls = { count: 0 };
    const failing: Backend = {
      ...sourcify,
      poll: async () => {
        polls.count += 1;
        throw networkError();
      },
    };
    const r = await run(t, handleOf(), [fixture("lookup-not-verified")], {
      dependencies: { backends: { sourcify: failing } },
    });
    const error = errorOf(r.outcome, "not-confirmed");
    assert.equal(polls.count, MAX_POLL_FAILURES);
    assert.ok(error.message.includes(`${String(MAX_POLL_FAILURES)} status polls in a row failed`));
    assert.equal(error.cause instanceof Error && Reflect.get(error.cause, "code"), "network");
    assertErrorEnvelope(error, 4);
    assert.equal(
      r.lines.filter((line) => line.level === "warn" && line.message.includes("status poll"))
        .length,
      MAX_POLL_FAILURES,
    );
  });

  it("emits verify.retry before a retried poll (R-DX-6)", async (t) => {
    const r = await run(t, handleOf(), [
      new Response("busy", { status: 503 }),
      fixture("job-exact-match"),
    ]);
    assert.deepEqual(types(r.events), ["verify.routed", "verify.retry", "verify.result"]);
    assert.deepEqual(r.events[1], {
      type: "verify.retry",
      backend: "sourcify",
      attempt: 2,
      reason: "server-error",
      delayMs: 500,
    });
  });
});

// --- forgotten job --------------------------------------------------------------------------------

describe("checkStatus(): a job the explorer no longer knows (R-FLOW-5)", () => {
  it("throws job-not-found, with the handle and a hint to call verify() again, when the contract is not verified", async (t) => {
    const handle = handleOf();
    const r = await run(t, handle, [fixture("job-not-found"), fixture("lookup-not-verified")]);
    const error = errorOf(r.outcome, "job-not-found");
    assert.deepEqual(error.details, { code: "job-not-found", handle });
    assert.equal(error.toJSON().handle, LINE);
    assert.equal(error.retryable, false);
    assert.equal(
      error.hint,
      "Call verify() again: the job is gone and the contract is not verified, so a new submission is needed.",
    );
    assert.equal(
      error.message,
      `Sourcify does not know job ${GREETER_JOB}, and a lookup found the contract not verified.`,
    );
    assert.equal(error.cause instanceof Error && Reflect.get(error.cause, "code"), "job-not-found");
    assertErrorEnvelope(error, 6);
    assert.deepEqual(
      r.sent.map((s) => s.url),
      [POLL_URL, LOOKUP_URL],
    );
    assert.ok(!types(r.events).includes("verify.result"));
  });

  it("returns verified when the job is gone but the contract is verified, as after Routescan forgets a job id", async (t) => {
    const r = await run(t, handleOf(), [fixture("job-not-found"), fixture("lookup-exact-match")]);
    assertResult(
      r.outcome,
      { status: "verified", backend: "sourcify", match: "exact", explorerUrl: GREETER_PAGE },
      0,
    );
    assert.deepEqual(r.events.at(-1), {
      type: "verify.result",
      backend: "sourcify",
      status: "verified",
      match: "exact",
      explorerUrl: GREETER_PAGE,
    });
  });

  it("throws job-not-found with the default hint and the lookup's error as cause when the lookup fails", async (t) => {
    const r = await run(t, handleOf(), [fixture("job-not-found")], {
      dependencies: {
        backends: {
          sourcify: withLookup(async () => {
            throw networkError();
          }),
        },
      },
    });
    const error = errorOf(r.outcome, "job-not-found");
    assert.ok(error.hint.startsWith("Do not retry automatically."));
    assert.ok(error.message.endsWith("and the lookup of the contract failed."));
    assert.equal(error.cause instanceof Error && Reflect.get(error.cause, "code"), "network");
    assertErrorEnvelope(error, 6);
  });

  it("rethrows an error that is not an ExplorerVerifyError from that lookup unchanged", async (t) => {
    const bug = new RangeError("bug");
    const r = await run(t, handleOf(), [fixture("job-not-found")], {
      dependencies: {
        backends: {
          sourcify: withLookup(async () => {
            throw bug;
          }),
        },
      },
    });
    assert.equal(r.outcome, bug);
  });
});

// --- handle and route -----------------------------------------------------------------------------

describe("checkStatus(): the handle never chooses a host (R-SEC-2)", () => {
  it("sends every request to options.route.apiUrl, and the result has no explorerUrl (R-SEC-2, R-RT-2)", async (t) => {
    const r = await run(t, LINE, [...pending(1), fixture("job-exact-match")], {
      options: { route: { apiUrl: "http://127.0.0.1:5555/server" } },
    });
    assertResult(r.outcome, { status: "verified", backend: "sourcify", match: "exact" }, 0);
    assert.deepEqual(
      r.sent.map((s) => s.url),
      [
        `http://127.0.0.1:5555/server/v2/verify/${GREETER_JOB}`,
        `http://127.0.0.1:5555/server/v2/verify/${GREETER_JOB}`,
      ],
    );
    assert.deepEqual(r.events[0], {
      type: "verify.routed",
      backend: "sourcify",
      apiHost: "127.0.0.1:5555",
      routedBy: "api-url",
    });
  });

  it("rejects a handle with a URL field before any request, so it cannot change the route (R-SEC-2)", async (t) => {
    for (const name of ["apiUrl", "url", "host"]) {
      const r = await run(t, { ...handleOf(), [name]: "https://evil.example" }, [], {
        options: { route: { apiUrl: "http://127.0.0.1:5555/server" } },
      });
      const error = errorOf(r.outcome, "invalid-input");
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [{ field: "handle", message: "has 1 field that is not a handle field" }],
      });
      assert.equal(r.sent.length, 0);
      assert.deepEqual(r.events, []);
      t.mock.timers.reset();
    }
  });

  it("rejects a one-line handle whose job id holds a URL or a path (R-SEC-2)", async (t) => {
    const cases: [jobId: string, field: string][] = [
      // The `:` of the scheme makes six parts.
      ["https://evil.example/x", "handle"],
      ["..", "jobId"],
      ["a/b", "jobId"],
      ["a?b=c", "jobId"],
    ];
    for (const [jobId, field] of cases) {
      const r = await run(t, `ev1:sourcify:${String(SEPOLIA)}:${GREETER}:${jobId}`, []);
      const error = errorOf(r.outcome, "invalid-input");
      assert.deepEqual(
        error.details.code === "invalid-input" && error.details.issues.map((issue) => issue.field),
        [field],
        jobId,
      );
      assert.equal(r.sent.length, 0);
      t.mock.timers.reset();
    }
  });

  it("rejects a handle whose backend is not the one the route resolves for its chain (R-SEC-2)", async (t) => {
    {
      const r = await run(t, { ...handleOf(), backend: "etherscan-v2" }, []);
      const error = errorOf(r.outcome, "invalid-input");
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [{ field: "backend", message: "must be sourcify, the route's backend" }],
      });
      assert.equal(
        error.message,
        `The handle names etherscan-v2, but chain ${String(SEPOLIA)} routes to sourcify.`,
      );
      assert.ok(error.hint.includes("route option"));
      assertErrorEnvelope(error, 2);
      assert.equal(r.sent.length, 0);
      assert.deepEqual(r.events, []);
    }
  });

  it("throws invalid-input for a value of neither form, before any request", async (t) => {
    for (const value of [undefined, null, 7, "ev1:sourcify", `${LINE}:extra`]) {
      const r = await run(t, value, []);
      const error = errorOf(r.outcome, "invalid-input");
      assert.deepEqual(
        error.details.code === "invalid-input" && error.details.issues.map((issue) => issue.field),
        ["handle"],
      );
      assert.equal(r.sent.length, 0);
      t.mock.timers.reset();
    }
  });

  it("checks the options before the handle", async (t) => {
    const r = await run(t, "not a handle", [], { options: { timeoutMs: -1 } });
    const error = errorOf(r.outcome, "invalid-input");
    assert.deepEqual(
      error.details.code === "invalid-input" && error.details.issues.map((issue) => issue.field),
      ["timeoutMs"],
    );
  });

  it("throws unsupported-chain when the table picks a backend with no client in this version (R-RT-1)", async (t) => {
    const r = await run(t, handleOf(), [], { dependencies: { backends: {} } });
    const error = errorOf(r.outcome, "unsupported-chain");
    assert.deepEqual(error.details, {
      code: "unsupported-chain",
      chainId: SEPOLIA,
      backend: "sourcify",
    });
    assert.equal(r.sent.length, 0);
  });

  it("resolves a handle on a chain missing from the table only with allowSourcifyFallback (R-RT-3)", async (t) => {
    const handle = { ...handleOf(), chainId: 999_999 };
    const refused = await run(t, handle, []);
    const error = errorOf(refused.outcome, "unsupported-chain");
    assert.match(error.hint, /allowSourcifyFallback/);
    assert.equal(refused.sent.length, 0);
    t.mock.timers.reset();
    // With the fallback, the job is polled on the public Sourcify API. The recorded answer is
    // for another chain, so only where the poll went is checked here.
    const allowed = await run(t, handle, [fixture("job-exact-match")], {
      options: { allowSourcifyFallback: true },
    });
    assert.ok(allowed.sent.length > 0);
    assert.ok(allowed.sent[0]?.url.startsWith("https://sourcify.dev/server/v2/verify/"));
  });
});

// --- abort ----------------------------------------------------------------------------------------

describe("checkStatus(): abort (R-FLOW-6)", () => {
  it("rejects with the reason and sends nothing when the signal is already aborted", async (t) => {
    const reason = new Error("stop");
    const r = await run(t, handleOf(), [], { options: { signal: AbortSignal.abort(reason) } });
    assert.equal(r.outcome, reason);
    assert.equal(r.sent.length, 0);
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.lines, []);
  });

  it("rejects with the reason when the signal aborts as a job-not-found answer arrives", async (t) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const lookups = { count: 0 };
    const r = await run(t, handleOf(), [], {
      options: { signal: controller.signal },
      dependencies: {
        backends: {
          sourcify: {
            ...sourcify,
            poll: async () => {
              controller.abort(reason);
              throw new ExplorerVerifyError(
                { code: "job-not-found", handle: handleOf() },
                "Sourcify does not know the job.",
                { secrets: [] },
              );
            },
            lookup: async () => {
              lookups.count += 1;
              return await Promise.resolve(undefined);
            },
          },
        },
      },
    });
    assert.equal(r.outcome, reason);
    assert.equal(lookups.count, 0);
  });

  it("rejects with the reason, unchanged, when aborted during the wait between polls", async (t) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const steps = pending(1);
    const { fetch } = script(steps);
    const aborting: typeof fetch = async (request, init) => {
      const response = await fetch(request, init);
      controller.abort(reason);
      return response;
    };
    const r = await run(t, handleOf(), [], {
      options: { signal: controller.signal, fetch: aborting },
    });
    assert.equal(r.outcome, reason);
  });

  it("rejects with the reason, unchanged, when aborted during the lookup for a forgotten job", async (t) => {
    const controller = new AbortController();
    const reason = new ExplorerVerifyError(
      { code: "job-not-found", handle: handleOf() },
      "an abort reason that looks like the flow's own error",
      { secrets: [] },
    );
    const r = await run(t, handleOf(), [fixture("job-not-found")], {
      options: { signal: controller.signal },
      dependencies: {
        backends: {
          sourcify: withLookup(async () => {
            controller.abort(reason);
            throw reason;
          }),
        },
      },
    });
    assert.equal(r.outcome, reason);
  });

  it("rethrows a job-not-found abort reason from a poll unchanged, with no lookup", async (t) => {
    const controller = new AbortController();
    const reason = new ExplorerVerifyError(
      { code: "job-not-found", handle: handleOf() },
      "the abort reason",
      { secrets: [] },
    );
    const lookups = { count: 0 };
    const r = await run(t, handleOf(), [], {
      options: { signal: controller.signal },
      dependencies: {
        backends: {
          sourcify: {
            ...sourcify,
            poll: async () => {
              controller.abort(reason);
              throw reason;
            },
            lookup: async () => {
              lookups.count += 1;
              return await Promise.resolve(undefined);
            },
          },
        },
      },
    });
    assert.equal(r.outcome, reason);
    assert.equal(lookups.count, 0);
  });
});

// --- logging and keys -----------------------------------------------------------------------------

describe("checkStatus(): logging and keys (R-DX-5, R-SEC-1)", () => {
  it("logs the resume at debug with the redacted API URL, and never at error", async (t) => {
    const r = await run(t, handleOf(), [fixture("job-not-found"), fixture("lookup-not-verified")], {
      options: { route: { apiUrl: `https://sourcify.example.org/server?token=${SECRET}` } },
    });
    errorOf(r.outcome, "job-not-found");
    const resumed = r.lines.find((line) => line.message.startsWith("Resuming"));
    assert.equal(resumed?.level, "debug");
    assert.deepEqual(resumed.fields, {
      backend: "sourcify",
      chainId: SEPOLIA,
      api: "https://sourcify.example.org/server?REDACTED",
    });
    assert.ok(r.lines.every((line) => line.level !== "error"));
  });

  it("keeps a key in the route's query out of every log line, event and error (R-SEC-1)", async (t) => {
    const echo = (): Response =>
      new Response(JSON.stringify({ message: `echo ${SECRET}` }), { status: 500 });
    const r = await run(t, handleOf(), [echo(), echo(), echo(), echo()], {
      options: { route: { apiUrl: `https://sourcify.example.org/server?k=${SECRET}` } },
    });
    const error = errorOf(r.outcome, "not-confirmed");
    const text = JSON.stringify([
      r.lines,
      r.events,
      error.toJSON(),
      error.details,
      error.message,
      String(error.cause),
    ]);
    assert.ok(!text.includes(SECRET), text);
  });

  it("writes nothing to console without a logger or onEvent (R-DX-5)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const spies = (["debug", "info", "log", "warn", "error"] as const).map((name) =>
      t.mock.method(console, name),
    );
    const { fetch } = script([fixture("job-exact-match")]);
    const result = await settleOnTimers(t, async () => await checkStatus(handleOf(), { fetch }));
    assert.equal(
      typeof result === "object" && result !== null && "status" in result && result.status,
      "verified",
    );
    for (const spy of spies) {
      // Node 22 prints its own ExperimentalWarning for MockTimers through console.error.
      const calls = spy.mock.calls.filter(
        (call) => !String(call.arguments[0]).includes("ExperimentalWarning"),
      );
      assert.equal(calls.length, 0);
    }
  });
});

// --- live -----------------------------------------------------------------------------------------

describe("checkStatus(): live, keyless, read-only", () => {
  it(
    "reads a recorded Sourcify job from its one-line handle and sends only GET requests (R-FLOW-5)",
    { skip: process.env["BLACKBOX_LIVE"] === "1" ? false : "set BLACKBOX_LIVE=1" },
    async () => {
      const methods: string[] = [];
      const counting: typeof fetch = async (request, init) => {
        methods.push(init?.method ?? "GET");
        return await globalThis.fetch(request, init);
      };
      // Job c2ecf68c… verified this Base Sepolia contract on 2026-11-03 (verify.md, Tested live).
      const line =
        "ev1:sourcify:84532:0x616dc0f820416e46841d2e1122ff7ca615a740fe:c2ecf68c-2f91-436f-8670-3210387bb3ea";
      // Sourcify may drop an old job id; then the lookup finds the contract verified, and the
      // result is the same.
      const result = await checkStatus(line, { fetch: counting, timeoutMs: 30_000 });
      assert.equal(result.status, "verified");
      assert.equal(result.match, "exact");
      assert.ok(methods.every((method) => method === "GET"));
    },
  );
});

// --- mutation killers from review ---------------------------------------------------------------

describe("killers #18", () => {
  it("K-S13: looks a forgotten job up with a grace window when the poll ends after the budget", async (t) => {
    const notFound = new ExplorerVerifyError(
      { code: "job-not-found", handle: handleOf() },
      "gone",
      { secrets: [] },
    );
    const slow: Backend = {
      ...sourcify,
      poll: async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 2_000);
        });
        throw notFound;
      },
    };
    const r = await run(t, handleOf(), [fixture("lookup-exact-match")], {
      options: { timeoutMs: 1_000 },
      dependencies: { backends: { sourcify: slow } },
    });
    assertResult(
      r.outcome,
      { status: "verified", backend: "sourcify", match: "exact", explorerUrl: GREETER_PAGE },
      0,
    );
  });

  it("K-S15: rejects with the abort reason before reading the handle, and emits nothing", async (t) => {
    const reason = new Error("stop");
    const bad = await run(t, "not a handle", [], {
      options: { signal: AbortSignal.abort(reason) },
    });
    assert.equal(bad.outcome, reason);
    t.mock.timers.reset();
    const good = await run(t, handleOf(), [], { options: { signal: AbortSignal.abort(reason) } });
    assert.equal(good.outcome, reason);
    assert.deepEqual(good.events, []);
    assert.deepEqual(good.lines, []);
  });

  it("K-S25: looks a forgotten job's contract up by its lower-case address", async (t) => {
    const r = await run(t, handleOf(GREETER_CHECKSUM), [
      fixture("job-not-found"),
      fixture("lookup-not-verified"),
    ]);
    const error = errorOf(r.outcome, "job-not-found");
    assert.deepEqual(error.details, { code: "job-not-found", handle: handleOf(GREETER_CHECKSUM) });
    assert.equal(r.sent[1]?.url, LOOKUP_URL);
  });

  it("K-V08: redacts a route key from every log line and event, even inside the job id", async (t) => {
    const r = await run(t, handleOf(GREETER, SECRET), [fixture("job-exact-match")], {
      options: { route: { apiUrl: `https://sourcify.example.org/server?k=${SECRET}` } },
    });
    assert.ok(!JSON.stringify([r.lines, r.events]).includes(SECRET));
  });

  it("K-H02/H22: rejects a chain id with a sign and a line with other separators", () => {
    for (const chainId of ["+1", "+11155111"]) {
      assert.throws(
        () => parseHandle(`ev1:sourcify:${chainId}:${GREETER}:${GREETER_JOB}`),
        (error: unknown) =>
          error instanceof ExplorerVerifyError &&
          error.details.code === "invalid-input" &&
          error.details.issues.map((issue) => issue.field).join() === "chainId",
      );
    }
    assert.throws(
      () => parseHandle(`ev1;sourcify;${String(SEPOLIA)};${GREETER};${GREETER_JOB}`),
      (error: unknown) =>
        error instanceof ExplorerVerifyError &&
        error.details.code === "invalid-input" &&
        error.details.issues.map((issue) => issue.field).join() === "handle",
    );
  });

  it("K-S20c/S27b: a failed lookup for a forgotten job keeps the handle and logs the fallback", async (t) => {
    const handle = handleOf();
    const r = await run(t, handle, [fixture("job-not-found")], {
      dependencies: {
        backends: {
          sourcify: withLookup(async () => {
            throw networkError();
          }),
        },
      },
    });
    const error = errorOf(r.outcome, "job-not-found");
    assert.deepEqual(error.details, { code: "job-not-found", handle });
    assert.equal(error.toJSON().handle, LINE);
    assert.ok(
      r.lines.some(
        (line) =>
          line.level === "debug" &&
          line.message ===
            `Sourcify does not know job ${GREETER_JOB}; looking the contract up instead`,
      ),
    );
  });
});
