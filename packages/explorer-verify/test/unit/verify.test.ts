// Tests for verify() (R-FLOW-1 to R-FLOW-6, R-DX-5, R-DX-6, R-SEC-1): the flow from input to one
// of three results or a typed error. Every request goes to a fake fetch that replays recorded
// Sourcify answers, every wait runs on mock timers, and the backoff jitter is fixed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";

import type { Backend } from "../../src/backends/backend.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { exitCodeOf, toEnvelope } from "../../src/envelope.ts";
import { ERROR_EXIT_CODES, ExplorerVerifyError } from "../../src/errors.ts";
import type { ErrorCode } from "../../src/errors.ts";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_POLL_FAILURES,
  MIN_POLL_INTERVAL_MS,
  runVerify,
} from "../../src/flow/verify.ts";
import type { FlowDependencies } from "../../src/flow/verify.ts";
import { MAX_TIMER_MS, REQUEST_TIMEOUT_MS, request as send, sleep } from "../../src/http/fetch.ts";
import type { HttpContext } from "../../src/http/fetch.ts";
import { verify } from "../../src/index.ts";
import type {
  LogFields,
  Logger,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/index.ts";
import { loadFixture, responseOf } from "../helpers/fake-fetch.ts";
import type { Fixture } from "../helpers/fake-fetch.ts";
import { compileStrict, validateEnvelope } from "./envelope-schema.ts";

const SEPOLIA = 11155111;
// The Greeter deployed on Sepolia on 2026-11-02, whose responses the fixtures recorded.
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const GREETER_JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const GREETER_PAGE = `https://repo.sourcify.dev/${String(SEPOLIA)}/${GREETER}`;
// The contract of the no_match, already_verified, internal_error and unknown-code jobs.
const OTHER = "0xa6b01960ea6e942ada412c76456bc9465682f3ab";
const OTHER_JOB = "dea83eb0-3918-449b-a914-3038dd554b42";
// The Base Sepolia contract of the recorded `match` (partial) job.
const BASE_SEPOLIA = 84532;
const PARTIAL = "0x840c7297c3bf0a65c465e6dc2cb147bbf5040cb3";
const PARTIAL_JOB = "c8dc71e8-7335-4b1b-b12a-112c7d9acf57";
// Fake keys. Never real ones (R-SEC-1).
const SECRET = "verify-dummy-secret-7q3w";
const BARE_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNOP";
const CALLBACK_FAILED = "The onEvent callback threw. The error is ignored and the call goes on.";

const eventSchema: unknown = JSON.parse(
  readFileSync(new URL("../../schema/event.schema.json", import.meta.url), "utf8"),
);
const validateEvent = compileStrict(eventSchema);

function fixture(name: string): Fixture {
  return loadFixture("sourcify", `2026-11-02-${name}`);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Sourcify's "not verified" lookup answer for any contract. */
function notVerified(address: string, chainId: number = SEPOLIA): Response {
  return json(404, {
    match: null,
    creationMatch: null,
    runtimeMatch: null,
    chainId: String(chainId),
    address,
  });
}

/** Sourcify's 202 for a submit that started `jobId`. */
function accepted(jobId: string): Response {
  return json(202, { verificationId: jobId });
}

/** A recorded answer with its JSON body changed by `edit`. */
function edited(name: string, edit: (body: Record<string, unknown>) => void): Response {
  const recorded = fixture(name);
  const body: unknown = structuredClone(recorded.response.body);
  assert.ok(typeof body === "object" && body !== null && !Array.isArray(body));
  const copy: Record<string, unknown> = { ...body };
  edit(copy);
  return json(recorded.response.status, copy);
}

function input(address: string = GREETER, chainId: number = SEPOLIA): VerifyInput {
  return {
    chainId,
    address: `0x${address.slice(2)}`,
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
}

/** One answer of the fake fetch: a fixture, a response, an error, or a request that never ends. */
type Step = Fixture | Response | Error | "hang";

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
    if (step === "hang") {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
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

interface RunOptions {
  readonly input?: VerifyInput;
  readonly options?: VerifyOptions;
  readonly dependencies?: FlowDependencies;
  /** Called after each round of timers, with the events and requests so far. */
  readonly onRound?: (events: readonly VerifyEvent[], sent: readonly Sent[]) => void;
}

interface Run {
  readonly outcome: unknown;
  readonly events: VerifyEvent[];
  readonly lines: Line[];
  readonly sent: Sent[];
  /** Milliseconds on the mock clock from the call to its end. */
  readonly elapsed: number;
}

/**
 * Runs verify() on mock timers until it settles. The logger and onEvent of `options` are wrapped,
 * so each test sees every line and event.
 */
async function run(t: TestContext, steps: readonly Step[], use: RunOptions = {}): Promise<Run> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { fetch, sent } = script(steps);
  const { logger, lines } = recorder();
  const events: VerifyEvent[] = [];
  const own = use.options ?? {};
  const options: VerifyOptions = {
    fetch,
    logger,
    ...own,
    onEvent: (event) => {
      events.push(event);
      return own.onEvent?.(event);
    },
  };
  const state = { done: false };
  const promise = runVerify(use.input ?? input(), options, {
    random: () => 0,
    ...use.dependencies,
    backends: use.dependencies?.backends ?? { sourcify },
  }).then(
    (result: VerifyResult): unknown => result,
    (error: unknown): unknown => error,
  );
  const tracked = promise.finally(() => {
    state.done = true;
  });
  for (let round = 0; round < 500 && !state.done; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    use.onRound?.(events, sent);
    if (!state.done) {
      t.mock.timers.runAll();
    }
  }
  assert.ok(state.done, "verify() did not settle");
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

function resultOf(outcome: unknown): VerifyResult {
  assert.ok(
    typeof outcome === "object" && outcome !== null,
    `expected a result, got ${String(outcome)}`,
  );
  const fields = new Map<string, unknown>(Object.entries(outcome));
  const status = fields.get("status");
  const match = fields.get("match");
  const reason = fields.get("reason");
  const explorerUrl = fields.get("explorerUrl");
  assert.equal(fields.get("backend"), "sourcify");
  if (status === "failed") {
    assert.ok(typeof reason === "string");
    return { status, backend: "sourcify", reason };
  }
  assert.ok(status === "verified" || status === "already-verified", `status ${String(status)}`);
  assert.ok(match === "exact" || match === "partial");
  return typeof explorerUrl === "string"
    ? { status, backend: "sourcify", match, explorerUrl }
    : { status, backend: "sourcify", match };
}

function errorOf(outcome: unknown, code: ErrorCode): ExplorerVerifyError {
  assert.ok(outcome instanceof ExplorerVerifyError, `expected an error, got ${String(outcome)}`);
  assert.equal(outcome.code, code, outcome.message);
  return outcome;
}

/** Fails unless the result is exactly `expected`, fits the envelope schema and maps to `exitCode`. */
function assertResult(outcome: unknown, expected: VerifyResult, exitCode: number): void {
  assert.deepEqual(outcome, expected);
  const result = resultOf(outcome);
  const envelope = toEnvelope(result);
  assert.deepEqual(validateEnvelope(envelope), []);
  assert.equal(exitCodeOf(result), exitCode);
  assert.equal(envelope.ok, exitCode === 0);
}

/** Fails unless the error's envelope fits the schema and maps to the catalogue's exit code. */
function assertErrorEnvelope(error: ExplorerVerifyError): void {
  const envelope = toEnvelope(error);
  assert.deepEqual(validateEnvelope(envelope), []);
  assert.equal(exitCodeOf(error), ERROR_EXIT_CODES[error.code]);
}

function types(events: readonly VerifyEvent[]): string[] {
  return events.map((event) => event.type);
}

/** The steps for a submit of OTHER whose job answers with `job`. */
function otherSteps(job: Step): Step[] {
  return [notVerified(OTHER), accepted(OTHER_JOB), job];
}

/** `count` pending job answers. */
function pending(count: number): Step[] {
  return Array.from({ length: count }, () => fixture("job-pending"));
}

/** A 503 on the lookup, then a lookup, a submit, one pending poll and an exact match. */
function retryThenVerified(): Step[] {
  return [
    new Response("busy", { status: 503 }),
    fixture("lookup-not-verified"),
    fixture("submit-accepted"),
    fixture("job-pending"),
    fixture("job-exact-match"),
  ];
}

/** Sourcify's client, except that every lookup after the first runs `later`. */
function laterLookups(later: () => never): Backend {
  const seen = { lookups: 0 };
  return {
    ...sourcify,
    lookup: async (target, ctx) => {
      seen.lookups += 1;
      return seen.lookups === 1 ? await sourcify.lookup(target, ctx) : later();
    },
  };
}

const SUBMITTED_HANDLE = `ev1:sourcify:${String(SEPOLIA)}:${GREETER}:${GREETER_JOB}`;

// --- lookup first --------------------------------------------------------------------------------

describe("verify(): lookup first (R-FLOW-1)", () => {
  it("returns already-verified without submitting (R-FLOW-1)", async (t) => {
    const r = await run(t, [fixture("lookup-exact-match")]);
    assertResult(
      r.outcome,
      {
        status: "already-verified",
        backend: "sourcify",
        match: "exact",
        explorerUrl: GREETER_PAGE,
      },
      0,
    );
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0]?.method, "GET");
    assert.deepEqual(r.events, [
      { type: "verify.validated", chainId: SEPOLIA, address: GREETER },
      { type: "verify.routed", backend: "sourcify", apiHost: "sourcify.dev" },
      { type: "verify.lookup", backend: "sourcify", match: "exact" },
      { type: "verify.result", backend: "sourcify", status: "already-verified", match: "exact" },
    ]);
  });

  it("returns already-verified with partial for a match lookup, without submitting (R-FLOW-1, R-FLOW-3)", async (t) => {
    const r = await run(t, [fixture("lookup-match")], { input: input(OTHER) });
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
    assert.equal(r.sent.length, 1);
  });

  it("throws the lookup's error and never submits when the lookup fails (R-FLOW-4)", async (t) => {
    const r = await run(t, [fixture("lookup-internal-error")]);
    const error = errorOf(r.outcome, "unexpected-response");
    assertErrorEnvelope(error);
    assert.equal(r.sent.length, 1);
    assert.ok(!types(r.events).includes("verify.result"));
  });

  it("throws unsupported-chain with exit code 2 for a chain Sourcify does not serve", async (t) => {
    const r = await run(t, [fixture("lookup-unsupported-chain")], {
      input: input("0x000000000000000000000000000000000000dead", 9429413),
    });
    const error = errorOf(r.outcome, "unsupported-chain");
    assert.equal(exitCodeOf(error), 2);
  });
});

// --- submit and poll -----------------------------------------------------------------------------

describe("verify(): submit and poll (R-FLOW-2, R-FLOW-3)", () => {
  it("submits, polls twice while pending, then returns verified with exact (R-FLOW-2, R-FLOW-3)", async (t) => {
    const r = await run(t, [
      fixture("lookup-not-verified"),
      fixture("submit-accepted"),
      fixture("job-pending"),
      fixture("job-pending"),
      fixture("job-exact-match"),
    ]);
    assertResult(
      r.outcome,
      { status: "verified", backend: "sourcify", match: "exact", explorerUrl: GREETER_PAGE },
      0,
    );
    assert.deepEqual(
      r.sent.map((s) => `${s.method} ${s.url}`),
      [
        `GET https://sourcify.dev/server/v2/contract/${String(SEPOLIA)}/${GREETER}`,
        `POST https://sourcify.dev/server/v2/verify/${String(SEPOLIA)}/${GREETER}`,
        `GET https://sourcify.dev/server/v2/verify/${GREETER_JOB}`,
        `GET https://sourcify.dev/server/v2/verify/${GREETER_JOB}`,
        `GET https://sourcify.dev/server/v2/verify/${GREETER_JOB}`,
      ],
    );
    // One interval before each of the three polls.
    assert.equal(r.elapsed, 3 * DEFAULT_POLL_INTERVAL_MS);
    // The stage events of decision 0010, in order (R-DX-6).
    assert.deepEqual(r.events, [
      { type: "verify.validated", chainId: SEPOLIA, address: GREETER },
      { type: "verify.routed", backend: "sourcify", apiHost: "sourcify.dev" },
      { type: "verify.lookup", backend: "sourcify", match: "none" },
      { type: "verify.submitted", backend: "sourcify", handle: SUBMITTED_HANDLE },
      { type: "verify.poll", backend: "sourcify", attempt: 1, state: "pending" },
      { type: "verify.poll", backend: "sourcify", attempt: 2, state: "pending" },
      { type: "verify.result", backend: "sourcify", status: "verified", match: "exact" },
    ]);
  });

  it("returns verified with partial for a match job (R-FLOW-3)", async (t) => {
    const r = await run(
      t,
      [notVerified(PARTIAL, BASE_SEPOLIA), accepted(PARTIAL_JOB), fixture("job-match")],
      { input: input(PARTIAL, BASE_SEPOLIA) },
    );
    assertResult(
      r.outcome,
      {
        status: "verified",
        backend: "sourcify",
        match: "partial",
        explorerUrl: `https://repo.sourcify.dev/${String(BASE_SEPOLIA)}/${PARTIAL}`,
      },
      0,
    );
  });

  it("returns already-verified when the submit says so, with no poll (R-FLOW-1)", async (t) => {
    const r = await run(t, [fixture("lookup-not-verified"), fixture("submit-already-verified")]);
    assertResult(
      r.outcome,
      {
        status: "already-verified",
        backend: "sourcify",
        match: "exact",
        explorerUrl: GREETER_PAGE,
      },
      0,
    );
    assert.equal(r.sent.length, 2);
    assert.deepEqual(types(r.events), [
      "verify.validated",
      "verify.routed",
      "verify.lookup",
      "verify.result",
    ]);
  });

  it("returns already-verified when the submit's recovery lookup finds the contract verified", async (t) => {
    // The submit got a 502, which may hide an accepted submit; the lookup that follows finds the
    // contract verified, possibly by this same call.
    const r = await run(t, [
      fixture("lookup-not-verified"),
      new Response("bad gateway", { status: 502 }),
      fixture("lookup-exact-match"),
    ]);
    assertResult(
      r.outcome,
      {
        status: "already-verified",
        backend: "sourcify",
        match: "exact",
        explorerUrl: GREETER_PAGE,
      },
      0,
    );
  });

  it("throws in-progress when Sourcify is already verifying the contract", async (t) => {
    const r = await run(t, [fixture("lookup-not-verified"), fixture("submit-duplicate")]);
    assertErrorEnvelope(errorOf(r.outcome, "in-progress"));
  });

  it("sets explorerUrl on both success variants (R-FLOW-3)", async (t) => {
    const already = await run(t, [fixture("lookup-exact-match")]);
    t.mock.timers.reset();
    const verified = await run(t, [
      fixture("lookup-not-verified"),
      fixture("submit-accepted"),
      fixture("job-exact-match"),
    ]);
    for (const outcome of [already.outcome, verified.outcome]) {
      const result = resultOf(outcome);
      assert.ok(result.status !== "failed");
      assert.equal(result.explorerUrl, GREETER_PAGE);
    }
  });

  it("leaves explorerUrl out for a route to another Sourcify server (R-FLOW-3)", async (t) => {
    const r = await run(t, [fixture("lookup-exact-match")], {
      options: { route: { apiUrl: "http://127.0.0.1:5555/server" } },
    });
    assertResult(r.outcome, { status: "already-verified", backend: "sourcify", match: "exact" }, 0);
    assert.equal(
      r.sent[0]?.url,
      `http://127.0.0.1:5555/server/v2/contract/${String(SEPOLIA)}/${GREETER}`,
    );
    assert.deepEqual(r.events[1], {
      type: "verify.routed",
      backend: "sourcify",
      apiHost: "127.0.0.1:5555",
    });
  });
});

// --- job outcomes --------------------------------------------------------------------------------

describe("verify(): job outcomes (R-FLOW-3, R-FLOW-4)", () => {
  it("returns failed for no_match, with the explorer's reason (R-FLOW-4)", async (t) => {
    const r = await run(t, otherSteps(fixture("job-no-match")), { input: input(OTHER) });
    assertResult(
      r.outcome,
      {
        status: "failed",
        backend: "sourcify",
        reason: "no_match: The deployed and recompiled bytecode don't match.",
      },
      1,
    );
    assert.deepEqual(r.events.at(-1), {
      type: "verify.result",
      backend: "sourcify",
      status: "failed",
    });
  });

  it("keeps a failed reason redacted: no key from the route or the answer reaches it (R-SEC-1)", async (t) => {
    const job = edited("job-no-match", (body) => {
      body.error = {
        customCode: "no_match",
        message: `mismatch for ${SECRET} and ${BARE_KEY}`,
      };
    });
    const r = await run(t, otherSteps(job), {
      input: input(OTHER),
      options: { route: { apiUrl: `https://sourcify.example.org/server?token=${SECRET}&a=1` } },
    });
    const result = resultOf(r.outcome);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "no_match: mismatch for [redacted] and [redacted]");
    const text = JSON.stringify([r.outcome, toEnvelope(result), r.events, r.lines]);
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes(BARE_KEY));
  });

  it("throws unknown-state for an unrecognised code and never returns verified (R-FLOW-4)", async (t) => {
    const r = await run(t, otherSteps(fixture("job-unknown-code")), { input: input(OTHER) });
    const error = errorOf(r.outcome, "unknown-state");
    assert.equal(error.details.code, "unknown-state");
    assert.deepEqual(error.details.handle, {
      version: 1,
      backend: "sourcify",
      chainId: SEPOLIA,
      address: OTHER,
      jobId: OTHER_JOB,
    });
    assert.equal(exitCodeOf(error), 6);
    assertErrorEnvelope(error);
    assert.ok(!types(r.events).includes("verify.result"));
  });

  it("throws verification-inconclusive, with no handle, for a job that ended without a verdict (decision 0011)", async (t) => {
    const r = await run(t, otherSteps(fixture("job-internal-error")), { input: input(OTHER) });
    const error = errorOf(r.outcome, "verification-inconclusive");
    assert.ok(!("handle" in error.details));
    assert.equal(error.toJSON().handle, undefined);
    assert.equal(exitCodeOf(error), 4);
    assertErrorEnvelope(error);
  });

  it("throws job-not-found when Sourcify forgot the job and a lookup finds the contract not verified (R-FLOW-5)", async (t) => {
    const missing = edited("job-not-found", () => {});
    const r = await run(t, [notVerified(OTHER), accepted(OTHER_JOB), missing, notVerified(OTHER)], {
      input: input(OTHER),
    });
    const error = errorOf(r.outcome, "job-not-found");
    assertErrorEnvelope(error);
    assert.equal(r.sent.length, 4);
    assert.ok(error.hint.startsWith("Call verify() again"));
  });

  it("looks the grade up for a job that found the contract already verified (R-FLOW-3)", async (t) => {
    const r = await run(
      t,
      [...otherSteps(fixture("job-already-verified")), fixture("lookup-match")],
      {
        input: input(OTHER),
      },
    );
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
    assert.equal(r.sent.length, 4);
  });

  it("throws unknown-state, never a guess, when that lookup fails (R-FLOW-4)", async (t) => {
    const r = await run(
      t,
      [...otherSteps(fixture("job-already-verified")), json(500, { customCode: "internal_error" })],
      { input: input(OTHER) },
    );
    const error = errorOf(r.outcome, "unknown-state");
    assert.equal(error.details.code === "unknown-state" && error.details.handle.jobId, OTHER_JOB);
    assert.equal(
      error.details.code === "unknown-state" && error.details.excerpt,
      '{"customCode":"internal_error"}',
    );
    assert.ok(error.cause instanceof Error);
  });

  it("throws unknown-state when that lookup says the contract is not verified (R-FLOW-4)", async (t) => {
    const r = await run(t, [...otherSteps(fixture("job-already-verified")), notVerified(OTHER)], {
      input: input(OTHER),
    });
    const error = errorOf(r.outcome, "unknown-state");
    assert.equal(error.details.code === "unknown-state" && error.details.excerpt, "");
    assert.equal(error.cause, undefined);
  });

  it("throws unknown-state with an empty excerpt when that lookup fails without an answer", async (t) => {
    const seen = { lookups: 0 };
    const failing: Backend = {
      ...sourcify,
      lookup: async (target, ctx) => {
        seen.lookups += 1;
        if (seen.lookups === 1) {
          return await sourcify.lookup(target, ctx);
        }
        throw new ExplorerVerifyError(
          { code: "network", backend: "sourcify", attempts: 5 },
          "no answer",
          { secrets: [] },
        );
      },
    };
    const r = await run(
      t,
      [notVerified(OTHER), accepted(OTHER_JOB), fixture("job-already-verified")],
      {
        input: input(OTHER),
        dependencies: { backends: { sourcify: failing } },
      },
    );
    const error = errorOf(r.outcome, "unknown-state");
    assert.equal(error.details.code === "unknown-state" && error.details.excerpt, "");
    assert.ok(error.cause instanceof Error);
  });
});

// --- budget --------------------------------------------------------------------------------------

describe("verify(): time budget (R-FLOW-2, R-FLOW-4, R-FLOW-5)", () => {
  it("throws not-confirmed carrying the handle when the budget runs out (R-FLOW-4, R-FLOW-5)", async (t) => {
    const r = await run(
      t,
      [
        fixture("lookup-not-verified"),
        fixture("submit-accepted"),
        ...pending(3),
        fixture("lookup-not-verified"),
      ],
      { options: { timeoutMs: 10_000, pollIntervalMs: 3_000 } },
    );
    const error = errorOf(r.outcome, "not-confirmed");
    assert.deepEqual(error.details, {
      code: "not-confirmed",
      handle: {
        version: 1,
        backend: "sourcify",
        chainId: SEPOLIA,
        address: GREETER,
        jobId: GREETER_JOB,
      },
    });
    assert.equal(error.toJSON().handle, SUBMITTED_HANDLE);
    assert.equal(exitCodeOf(error), 4);
    assertErrorEnvelope(error);
    // Polls at 3, 6 and 9 s; the budget ends at 10 s; one last lookup.
    assert.equal(r.sent.length, 6);
    assert.equal(r.elapsed, 10_000);
    assert.ok(!types(r.events).includes("verify.result"));
  });

  it("turns a lagging job into verified with the last lookup (R-FLOW-2)", async (t) => {
    const r = await run(
      t,
      [
        fixture("lookup-not-verified"),
        fixture("submit-accepted"),
        ...pending(3),
        fixture("lookup-exact-match"),
      ],
      { options: { timeoutMs: 10_000, pollIntervalMs: 3_000 } },
    );
    assertResult(
      r.outcome,
      { status: "verified", backend: "sourcify", match: "exact", explorerUrl: GREETER_PAGE },
      0,
    );
    assert.equal(
      r.sent.at(-1)?.url,
      `https://sourcify.dev/server/v2/contract/${String(SEPOLIA)}/${GREETER}`,
    );
  });

  it("throws not-confirmed with the cause when the last lookup fails", async (t) => {
    const r = await run(
      t,
      [
        fixture("lookup-not-verified"),
        fixture("submit-accepted"),
        ...pending(1),
        fixture("lookup-internal-error"),
      ],
      { options: { timeoutMs: 4_000, pollIntervalMs: 3_000 } },
    );
    const error = errorOf(r.outcome, "not-confirmed");
    assert.ok(error.cause instanceof Error);
  });

  it("maps a budget spent during a poll request to not-confirmed, never timeout (R-FLOW-4)", async (t) => {
    const r = await run(
      t,
      [
        fixture("lookup-not-verified"),
        fixture("submit-accepted"),
        "hang",
        fixture("lookup-not-verified"),
      ],
      { options: { timeoutMs: 5_000, pollIntervalMs: 3_000 } },
    );
    errorOf(r.outcome, "not-confirmed");
    assert.equal(r.elapsed, 5_000);
  });

  it("throws timeout, with no handle, when the budget runs out before the submit is accepted", async (t) => {
    const r = await run(t, [fixture("lookup-not-verified"), "hang"], {
      options: { timeoutMs: 5_000 },
    });
    const error = errorOf(r.outcome, "timeout");
    assert.equal(error.toJSON().handle, undefined);
    assert.equal(exitCodeOf(error), 5);
    assert.ok(!types(r.events).includes("verify.submitted"));
  });

  it("clamps a timeoutMs above the setTimeout limit instead of firing at once", async (t) => {
    // The first wait lasts the whole clamped budget, so no poll runs; the last lookup never
    // answers and ends in its per-request timeout and retries.
    const r = await run(t, [fixture("lookup-not-verified"), fixture("submit-accepted"), "hang"], {
      options: { timeoutMs: 2 ** 40, pollIntervalMs: 2 ** 40 },
    });
    const error = errorOf(r.outcome, "not-confirmed");
    assert.ok(error.message.includes(`${String(MAX_TIMER_MS)} ms`), error.message);
    assert.ok(r.elapsed >= MAX_TIMER_MS);
  });
});

// --- abort ---------------------------------------------------------------------------------------

describe("verify(): abort (R-FLOW-6)", () => {
  it("rejects with the signal's reason when aborted mid-poll, after verify.submitted (R-FLOW-6, R-FLOW-5)", async (t) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const r = await run(
      t,
      [fixture("lookup-not-verified"), fixture("submit-accepted"), fixture("job-pending")],
      {
        options: {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "verify.poll") {
              controller.abort(reason);
            }
          },
        },
      },
    );
    assert.equal(r.outcome, reason);
    assert.deepEqual(types(r.events), [
      "verify.validated",
      "verify.routed",
      "verify.lookup",
      "verify.submitted",
      "verify.poll",
    ]);
    assert.equal(r.sent.length, 3);
    // The handle was logged at info as soon as Sourcify accepted the submission.
    assert.ok(
      r.lines.some((line) => line.level === "info" && line.fields?.["handle"] === SUBMITTED_HANDLE),
    );
  });

  it("rejects with the reason and sends nothing when the signal is already aborted", async (t) => {
    const controller = new AbortController();
    const reason = new Error("already");
    controller.abort(reason);
    const r = await run(t, [], { options: { signal: controller.signal } });
    assert.equal(r.outcome, reason);
    assert.equal(r.sent.length, 0);
    assert.equal(r.events.length, 0);
  });

  it("rejects with the reason, unchanged, when aborted during a request", async (t) => {
    const controller = new AbortController();
    const reason = "a string reason";
    const r = await run(t, ["hang"], {
      options: { signal: controller.signal },
      onRound: (_events, sent) => {
        if (sent.length === 1) {
          controller.abort(reason);
        }
      },
    });
    assert.equal(r.outcome, reason);
  });

  it("rethrows an abort reason that is an ExplorerVerifyError timeout, unchanged, during a poll", async (t) => {
    const controller = new AbortController();
    const reason = new ExplorerVerifyError(
      { code: "timeout", backend: "sourcify", timeoutMs: 1 },
      "caller's own timeout",
      { secrets: [] },
    );
    const r = await run(t, [fixture("lookup-not-verified"), fixture("submit-accepted"), "hang"], {
      options: { signal: controller.signal },
      // The third request is the poll, which never answers.
      onRound: (_events, sent) => {
        if (sent.length === 3) {
          controller.abort(reason);
        }
      },
    });
    assert.equal(r.outcome, reason);
  });

  it("rejects with the reason, unchanged, when aborted during the last lookup", async (t) => {
    const controller = new AbortController();
    const reason = new ExplorerVerifyError(
      { code: "network", backend: "sourcify", attempts: 1 },
      "caller's reason",
      { secrets: [] },
    );
    const aborting = laterLookups(() => {
      controller.abort(reason);
      throw reason;
    });
    const r = await run(t, [fixture("lookup-not-verified"), fixture("submit-accepted")], {
      options: { signal: controller.signal, timeoutMs: 1 },
      dependencies: { backends: { sourcify: aborting } },
    });
    assert.equal(r.outcome, reason);
  });

  it("rejects with the reason, unchanged, when aborted during the grade lookup", async (t) => {
    const controller = new AbortController();
    const reason = new ExplorerVerifyError(
      { code: "network", backend: "sourcify", attempts: 1 },
      "caller's reason",
      { secrets: [] },
    );
    const aborting = laterLookups(() => {
      controller.abort(reason);
      throw reason;
    });
    const r = await run(
      t,
      [notVerified(OTHER), accepted(OTHER_JOB), fixture("job-already-verified")],
      {
        input: input(OTHER),
        options: { signal: controller.signal },
        dependencies: { backends: { sourcify: aborting } },
      },
    );
    assert.equal(r.outcome, reason);
  });

  it("rethrows an error that is not an ExplorerVerifyError from a later lookup unchanged", async (t) => {
    const bug = new TypeError("bug");
    const broken = laterLookups(() => {
      throw bug;
    });
    const r = await run(t, [fixture("lookup-not-verified"), fixture("submit-accepted")], {
      options: { timeoutMs: 1 },
      dependencies: { backends: { sourcify: broken } },
    });
    assert.equal(r.outcome, bug);
  });
});

// --- abort wins over every lookup error (R-FLOW-6) ------------------------------------------------

/** Errors a lookup may throw after the signal aborted, none of them the abort reason. */
function otherErrors(): Error[] {
  return [
    new ExplorerVerifyError(
      { code: "network", backend: "sourcify", attempts: 1 },
      "not the reason",
      { secrets: [] },
    ),
    new TypeError("not the reason either"),
  ];
}

describe("verify(): an abort wins over the error a lookup throws (R-FLOW-6)", () => {
  it("rejects with the reason when the first lookup throws another error after an abort", async (t) => {
    for (const other of otherErrors()) {
      t.mock.timers.reset();
      const controller = new AbortController();
      const reason = new Error("stop");
      const backend: Backend = {
        ...sourcify,
        lookup: async () => {
          controller.abort(reason);
          return await Promise.reject(other);
        },
      };
      const r = await run(t, [], {
        options: { signal: controller.signal },
        dependencies: { backends: { sourcify: backend } },
      });
      assert.equal(r.outcome, reason, other.message);
    }
  });

  it("rejects with the reason when the last lookup throws another error after an abort (R-FLOW-2)", async (t) => {
    for (const other of otherErrors()) {
      t.mock.timers.reset();
      const controller = new AbortController();
      const reason = new Error("stop");
      const aborting = laterLookups(() => {
        controller.abort(reason);
        throw other;
      });
      const r = await run(t, [fixture("lookup-not-verified"), fixture("submit-accepted")], {
        options: { signal: controller.signal, timeoutMs: 1 },
        dependencies: { backends: { sourcify: aborting } },
      });
      assert.equal(r.outcome, reason, other.message);
      assert.equal(r.sent.length, 2);
    }
  });

  it("rejects with the reason when the grade lookup throws another error after an abort (R-FLOW-3)", async (t) => {
    for (const other of otherErrors()) {
      t.mock.timers.reset();
      const controller = new AbortController();
      const reason = new Error("stop");
      const aborting = laterLookups(() => {
        controller.abort(reason);
        throw other;
      });
      const r = await run(
        t,
        [notVerified(OTHER), accepted(OTHER_JOB), fixture("job-already-verified")],
        {
          input: input(OTHER),
          options: { signal: controller.signal },
          dependencies: { backends: { sourcify: aborting } },
        },
      );
      assert.equal(r.outcome, reason, other.message);
    }
  });

  it("rejects with the reason when the forgotten-job lookup throws another error after an abort (R-FLOW-5)", async (t) => {
    for (const other of otherErrors()) {
      t.mock.timers.reset();
      const controller = new AbortController();
      const reason = new Error("stop");
      const aborting = laterLookups(() => {
        controller.abort(reason);
        throw other;
      });
      const r = await run(t, [notVerified(OTHER), accepted(OTHER_JOB), fixture("job-not-found")], {
        input: input(OTHER),
        options: { signal: controller.signal },
        dependencies: { backends: { sourcify: aborting } },
      });
      assert.equal(r.outcome, reason, other.message);
    }
  });

  it("rejects with the reason when a poll throws another error after an abort (R-FLOW-6)", async (t) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const lookups = { count: 0 };
    const backend: Backend = {
      ...laterLookups(() => {
        lookups.count += 1;
        throw new Error("no lookup expected");
      }),
      poll: async () => {
        controller.abort(reason);
        return await Promise.reject(
          new ExplorerVerifyError({ code: "network", backend: "sourcify", attempts: 1 }, "x", {
            secrets: [],
          }),
        );
      },
    };
    const r = await run(t, [fixture("lookup-not-verified"), fixture("submit-accepted")], {
      options: { signal: controller.signal },
      dependencies: { backends: { sourcify: backend } },
    });
    assert.equal(r.outcome, reason);
    assert.equal(lookups.count, 0);
  });
});

// --- input and options ---------------------------------------------------------------------------

describe("verify(): input and options (R-IN-6)", () => {
  it("makes no request and emits no event for invalid input (R-IN-6)", async (t) => {
    const bad: VerifyInput = { ...input(), address: "0x1234" };
    const r = await run(t, [], { input: bad });
    const error = errorOf(r.outcome, "invalid-input");
    assert.equal(exitCodeOf(error), 2);
    assert.equal(r.sent.length, 0);
    assert.equal(r.events.length, 0);
  });

  it("makes no request for an invalid route (R-SEC-2)", async (t) => {
    const r = await run(t, [], { options: { route: { apiUrl: "http://example.org" } } });
    const error = errorOf(r.outcome, "invalid-input");
    assert.deepEqual(
      error.details.code === "invalid-input" && error.details.issues.map((issue) => issue.field),
      ["route.apiUrl"],
    );
    assert.equal(r.sent.length, 0);
  });

  it("rejects timeoutMs and pollIntervalMs that are not positive finite numbers", async (t) => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      t.mock.timers.reset();
      const r = await run(t, [], { options: { timeoutMs: value, pollIntervalMs: value } });
      const error = errorOf(r.outcome, "invalid-input");
      assert.deepEqual(
        error.details.code === "invalid-input" && error.details.issues.map((issue) => issue.field),
        ["timeoutMs", "pollIntervalMs"],
      );
      assert.equal(r.sent.length, 0);
    }
  });

  it("rejects options that are not an object, as a JavaScript caller may pass", async () => {
    // `Reflect.set` takes an untyped value, so the test needs no cast.
    const box: { options?: VerifyOptions } = {};
    Reflect.set(box, "options", null);
    const outcome = await verify(input(), box.options).then(
      () => "resolved",
      (error: unknown) => error,
    );
    const error = errorOf(outcome, "invalid-input");
    assert.deepEqual(error.details.code === "invalid-input" && error.details.issues, [
      { field: "options", message: "must be an object" },
    ]);
  });

  it("takes the defaults when options are left out", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const original = globalThis.fetch;
    const { fetch, sent } = script([fixture("lookup-exact-match")]);
    globalThis.fetch = fetch;
    try {
      const result = await verify(input());
      assert.equal(result.status, "already-verified");
      assert.equal(sent.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("throws invalid-input for a backend with no client in this version", async (t) => {
    const r = await run(t, [], { dependencies: { backends: {} } });
    const error = errorOf(r.outcome, "invalid-input");
    assert.deepEqual(
      error.details.code === "invalid-input" && error.details.issues.map((issue) => issue.field),
      ["route.backend"],
    );
  });
});

// --- events and logging --------------------------------------------------------------------------

describe("verify(): events and logging (R-DX-5, R-DX-6, R-SEC-1)", () => {
  it("emits verify.retry between the stages, in order (R-DX-6)", async (t) => {
    const r = await run(t, [
      new Response("busy", { status: 503 }),
      fixture("lookup-not-verified"),
      fixture("submit-accepted"),
      fixture("job-exact-match"),
    ]);
    assert.deepEqual(types(r.events), [
      "verify.validated",
      "verify.routed",
      "verify.retry",
      "verify.lookup",
      "verify.submitted",
      "verify.result",
    ]);
    assert.deepEqual(r.events[2], {
      type: "verify.retry",
      backend: "sourcify",
      attempt: 2,
      reason: "server-error",
      delayMs: 500,
    });
  });

  it("warns once per call when onEvent throws on every event across several requests (decision 0010)", async (t) => {
    const throwing: VerifyOptions = {
      onEvent: () => {
        throw new Error("callback broke");
      },
    };
    for (let call = 0; call < 2; call += 1) {
      t.mock.timers.reset();
      const r = await run(t, retryThenVerified(), { options: throwing });
      assert.equal(resultOf(r.outcome).status, "verified");
      assert.equal(r.sent.length, 5);
      assert.equal(r.events.length, 7);
      const warnings = r.lines.filter((line) => line.message === CALLBACK_FAILED);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.level, "warn");
    }
  });

  it("never logs at error a failure it throws (R-DX-5)", async (t) => {
    const r = await run(t, [notVerified(OTHER), accepted(OTHER_JOB), fixture("job-unknown-code")], {
      input: input(OTHER),
    });
    errorOf(r.outcome, "unknown-state");
    assert.deepEqual(
      r.lines.filter((line) => line.level === "error"),
      [],
    );
  });

  it("keeps a key in the route's URL out of every log line and event (R-SEC-1)", async (t) => {
    const r = await run(t, [new Response("busy", { status: 503 }), fixture("lookup-exact-match")], {
      options: {
        route: { apiUrl: `https://sourcify.example.org/server?apikey=${BARE_KEY}&x=${SECRET}` },
      },
    });
    resultOf(r.outcome);
    assert.ok(r.lines.length > 0);
    const text = JSON.stringify([r.lines, r.events, r.outcome]);
    assert.ok(!text.includes(BARE_KEY), text);
    assert.ok(!text.includes(SECRET), text);
    assert.ok(text.includes("?REDACTED"));
  });

  it("logs fields that are flat and JSON-safe (R-DX-5)", async (t) => {
    const r = await run(t, [
      fixture("lookup-not-verified"),
      fixture("submit-accepted"),
      fixture("job-pending"),
      fixture("job-exact-match"),
    ]);
    for (const line of r.lines) {
      for (const value of Object.values(line.fields ?? {})) {
        assert.ok(value === null || ["string", "number", "boolean"].includes(typeof value));
      }
    }
    assert.ok(
      r.lines.some((line) => line.level === "info" && line.message.includes(SUBMITTED_HANDLE)),
    );
  });

  it("reads options.logger in one place only, and hands it to createObserver (R-SEC-1)", () => {
    const source = readFileSync(new URL("../../src/flow/verify.ts", import.meta.url), "utf8");
    assert.equal(source.match(/own\(options, "logger"\)/g)?.length, 1);
    assert.equal(source.match(/options\??\.logger\b/g), null);
    assert.equal(source.match(/createObserver\(/g)?.length, 1);
    assert.equal(source.match(/\.\.\.options\b/g), null);
    assert.equal(source.match(/\}\s*=\s*options\b/g), null);
  });

  it("writes nothing to console without a logger or onEvent (R-DX-5)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const spies = (["debug", "info", "log", "warn", "error"] as const).map((name) =>
      t.mock.method(console, name),
    );
    const { fetch } = script([fixture("lookup-exact-match")]);
    const result = await verify(input(), { fetch });
    assert.equal(result.status, "already-verified");
    for (const spy of spies) {
      // Node 22 prints its own ExperimentalWarning for MockTimers through console.error.
      const calls = spy.mock.calls.filter(
        (call) => !String(call.arguments[0]).includes("ExperimentalWarning"),
      );
      assert.equal(calls.length, 0);
    }
  });
});

// --- poll failures -------------------------------------------------------------------------------

/** `count` copies of a 503 answer. */
function busy(count: number): Step[] {
  return Array.from({ length: count }, () => new Response("busy", { status: 503 }));
}

/** `count` network failures. */
function offline(count: number): Step[] {
  return Array.from({ length: count }, () => new TypeError("fetch failed"));
}

describe("verify(): status polls that fail (R-FLOW-4, R-FLOW-5)", () => {
  // The HTTP layer sends a poll up to 5 times before it gives up.
  const ATTEMPTS = 5;

  it("ends with not-confirmed and the handle when every poll answers 503", async (t) => {
    const r = await run(t, [
      fixture("lookup-not-verified"),
      fixture("submit-accepted"),
      ...busy(MAX_POLL_FAILURES * ATTEMPTS),
      fixture("lookup-not-verified"),
    ]);
    const error = errorOf(r.outcome, "not-confirmed");
    assert.equal(error.toJSON().handle, SUBMITTED_HANDLE);
    assert.equal(exitCodeOf(error), 4);
    assert.ok(error.message.includes(`${String(MAX_POLL_FAILURES)} status polls in a row failed`));
    assert.ok(error.cause instanceof Error);
    assert.equal(Reflect.get(error.cause, "code"), "unexpected-response");
    assert.equal(
      r.lines.filter((line) => line.level === "warn" && line.message.includes("status poll"))
        .length,
      MAX_POLL_FAILURES,
    );
    assertErrorEnvelope(error);
  });

  it("ends with not-confirmed and the handle when every poll gets no response", async (t) => {
    const r = await run(t, [
      fixture("lookup-not-verified"),
      fixture("submit-accepted"),
      ...offline(MAX_POLL_FAILURES * ATTEMPTS),
      fixture("lookup-not-verified"),
    ]);
    const error = errorOf(r.outcome, "not-confirmed");
    assert.ok(error.cause instanceof Error);
    assert.equal(Reflect.get(error.cause, "code"), "network");
  });

  it("keeps the handle when the deadline cuts a poll's retries short", async (t) => {
    // Poll at 1000 ms answers 503, the retry at 1500 ms too; the next wait would pass the
    // 2500 ms deadline, so the HTTP layer gives up and polling ends at the deadline.
    const r = await run(
      t,
      [
        fixture("lookup-not-verified"),
        fixture("submit-accepted"),
        ...busy(2),
        fixture("lookup-not-verified"),
      ],
      { options: { timeoutMs: 2_500, pollIntervalMs: 1_000 } },
    );
    const error = errorOf(r.outcome, "not-confirmed");
    assert.ok(error.message.includes("2500 ms budget"), error.message);
    assert.equal(
      error.cause instanceof Error && Reflect.get(error.cause, "code"),
      "unexpected-response",
    );
    assert.equal(r.sent.length, 5);
    assert.equal(r.elapsed, 2_500);
  });

  it(`stops after ${String(MAX_POLL_FAILURES)} failed polls in a row, not before`, async (t) => {
    const r = await run(t, [
      fixture("lookup-not-verified"),
      fixture("submit-accepted"),
      ...busy((MAX_POLL_FAILURES - 1) * ATTEMPTS),
      fixture("job-pending"),
      ...busy(MAX_POLL_FAILURES * ATTEMPTS),
      fixture("lookup-exact-match"),
    ]);
    // A pending answer resets the count; the last lookup then finds the contract verified.
    assertResult(
      r.outcome,
      { status: "verified", backend: "sourcify", match: "exact", explorerUrl: GREETER_PAGE },
      0,
    );
    assert.equal(r.sent.length, 2 + (2 * MAX_POLL_FAILURES - 1) * ATTEMPTS + 2);
  });

  it("returns verified when a failed poll is followed by an answer", async (t) => {
    const r = await run(t, [
      fixture("lookup-not-verified"),
      fixture("submit-accepted"),
      ...busy(ATTEMPTS),
      fixture("job-exact-match"),
    ]);
    assertResult(
      r.outcome,
      { status: "verified", backend: "sourcify", match: "exact", explorerUrl: GREETER_PAGE },
      0,
    );
  });

  it("throws other poll errors at once", async (t) => {
    const r = await run(t, [notVerified(OTHER), accepted(OTHER_JOB), fixture("job-unknown-code")], {
      input: input(OTHER),
    });
    errorOf(r.outcome, "unknown-state");
    assert.equal(r.sent.length, 3);
  });

  it("keeps a not-confirmed cause as a plain Error copy with its name, message and code", async (t) => {
    const r = await run(
      t,
      [
        fixture("lookup-not-verified"),
        fixture("submit-accepted"),
        "hang",
        fixture("lookup-not-verified"),
      ],
      { options: { timeoutMs: 5_000, pollIntervalMs: 3_000 } },
    );
    const error = errorOf(r.outcome, "not-confirmed");
    // The error class redacts its cause by copying it: a plain Error, not an ExplorerVerifyError.
    assert.ok(error.cause instanceof Error);
    assert.ok(!(error.cause instanceof ExplorerVerifyError));
    assert.equal(error.cause.name, "ExplorerVerifyError");
    assert.equal(Reflect.get(error.cause, "code"), "timeout");
    assert.ok(error.cause.message.includes("did not finish within the 5000 ms budget"));
  });
});

// --- durations -----------------------------------------------------------------------------------

describe("verify(): durations", () => {
  it(`raises a pollIntervalMs below ${String(MIN_POLL_INTERVAL_MS)} ms to it`, async (t) => {
    const r = await run(
      t,
      [
        fixture("lookup-not-verified"),
        fixture("submit-accepted"),
        fixture("job-pending"),
        fixture("job-exact-match"),
      ],
      { options: { pollIntervalMs: 10 } },
    );
    assert.equal(resultOf(r.outcome).status, "verified");
    assert.equal(r.elapsed, 2 * 1_000);
  });

  it("caps the last lookup's window at the request timeout for a long interval", async (t) => {
    const r = await run(t, [fixture("lookup-not-verified"), fixture("submit-accepted"), "hang"], {
      options: { timeoutMs: 500, pollIntervalMs: 600_000 },
    });
    errorOf(r.outcome, "not-confirmed");
    assert.equal(r.elapsed, 500 + REQUEST_TIMEOUT_MS);
  });
});

// --- options of the wrong kind -------------------------------------------------------------------

/** Options with `name` set to `value`, as a JavaScript caller may pass. No cast is needed. */
function optionsWith(name: string, value: unknown): VerifyOptions {
  const options: VerifyOptions = {};
  Reflect.set(options, name, value);
  return options;
}

describe("verify(): options of the wrong kind (R-SEC-2)", () => {
  const cases: [name: string, value: unknown][] = [
    ["signal", { aborted: false }],
    ["signal", null],
    ["fetch", "https://example.org"],
    ["logger", "console"],
    ["logger", null],
    ["onEvent", {}],
    ["timeoutMs", "100"],
  ];
  for (const [name, value] of cases) {
    it(`throws invalid-input for ${name} set to ${JSON.stringify(value)}`, async () => {
      const { fetch, sent } = script([]);
      const options = optionsWith(name, value);
      if (name !== "fetch") {
        options.fetch = fetch;
      }
      const outcome = await runVerify(input(), options, { backends: { sourcify } }).then(
        () => "resolved",
        (error: unknown) => error,
      );
      const error = errorOf(outcome, "invalid-input");
      assert.deepEqual(
        error.details.code === "invalid-input" && error.details.issues.map((issue) => issue.field),
        [name],
      );
      assert.equal(sent.length, 0);
    });
  }

  it("accepts a logger that is a function object with the four methods", async (t) => {
    const lines: string[] = [];
    const logger = Object.assign(() => {}, {
      debug: (message: string) => lines.push(message),
      info: (message: string) => lines.push(message),
      warn: (message: string) => lines.push(message),
      error: (message: string) => lines.push(message),
    });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { fetch } = script([fixture("lookup-exact-match")]);
    await verify(input(), { fetch, logger });
    assert.ok(lines.length > 0);
  });

  it("leaves no timer behind for a signal whose listeners cannot be added", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const broken = {
      aborted: false,
      reason: undefined,
      throwIfAborted: () => {},
      addEventListener: () => {
        throw new TypeError("no listeners here");
      },
      removeEventListener: () => {
        throw new TypeError("no listeners here");
      },
    };
    const box: { signal?: AbortSignal } = {};
    Reflect.set(box, "signal", broken);
    await assert.rejects(sleep(1_000, box.signal), TypeError);
    const { fetch } = script([fixture("lookup-exact-match")]);
    const ctx: HttpContext = { backend: "sourcify", secrets: [], fetch, ...box };
    await assert.rejects(
      send(ctx, { url: "https://sourcify.dev/server/x", method: "GET", retry: "safe" }),
      TypeError,
    );
    // A timer left behind would call removeEventListener and throw here.
    t.mock.timers.runAll();
    t.mock.timers.tick(60_000);
  });
});

describe("verify(): options read once, own properties only (R-SEC-2)", () => {
  it("ignores a polluted Object.prototype.route and .fetch", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const evil: string[] = [];
    const evilFetch = async (): Promise<Response> => {
      evil.push("called");
      return await Promise.reject(new Error("evil fetch"));
    };
    const original = globalThis.fetch;
    const { fetch, sent } = script([fixture("lookup-exact-match")]);
    globalThis.fetch = fetch;
    Reflect.defineProperty(Object.prototype, "route", {
      value: { apiUrl: "https://evil.example" },
      configurable: true,
      writable: true,
    });
    Reflect.defineProperty(Object.prototype, "fetch", {
      value: evilFetch,
      configurable: true,
      writable: true,
    });
    try {
      const result = await verify(input(), {});
      assert.equal(result.status, "already-verified");
    } finally {
      Reflect.deleteProperty(Object.prototype, "route");
      Reflect.deleteProperty(Object.prototype, "fetch");
      globalThis.fetch = original;
    }
    assert.deepEqual(evil, []);
    assert.equal(
      sent[0]?.url,
      `https://sourcify.dev/server/v2/contract/${String(SEPOLIA)}/${GREETER}`,
    );
  });

  it("maps a getter that throws to invalid-input without its text", async () => {
    const options: VerifyOptions = {};
    Reflect.defineProperty(options, "logger", {
      enumerable: true,
      get: () => {
        throw new Error(SECRET);
      },
    });
    const outcome = await verify(input(), options).then(
      () => "resolved",
      (error: unknown) => error,
    );
    const error = errorOf(outcome, "invalid-input");
    assert.deepEqual(error.details.code === "invalid-input" && error.details.issues, [
      { field: "options", message: "could not be read" },
    ]);
    assert.ok(
      !JSON.stringify([error.message, error.toJSON(), String(error.cause)]).includes(SECRET),
    );
  });

  it("maps a Proxy whose traps throw to invalid-input without its text", async () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error(SECRET);
        },
      },
    );
    const box: { options?: VerifyOptions } = {};
    Reflect.set(box, "options", hostile);
    const outcome = await verify(input(), box.options).then(
      () => "resolved",
      (error: unknown) => error,
    );
    const error = errorOf(outcome, "invalid-input");
    assert.ok(!error.message.includes(SECRET));
    assert.equal(error.cause, undefined);
  });
});

// --- secrets derived from the route --------------------------------------------------------------

describe("verify(): secrets from the route's query (R-SEC-1)", () => {
  it("keeps the handle, the address and the chain id readable; still redacts a real key", async (t) => {
    const route = {
      apiUrl: `https://sourcify.example.org/server?client=sourcify&a=8275d36f64&n=111551110&token=${SECRET}`,
    };
    const r = await run(
      t,
      [
        fixture("lookup-not-verified"),
        fixture("submit-accepted"),
        ...pending(1),
        edited("lookup-internal-error", (body) => {
          body.message = `echo ${SECRET}`;
        }),
      ],
      { options: { route, timeoutMs: 4_000 } },
    );
    const error = errorOf(r.outcome, "not-confirmed");
    assert.equal(error.toJSON().handle, SUBMITTED_HANDLE);
    assert.equal(error.details.code === "not-confirmed" && error.details.handle.address, GREETER);
    const logged = r.lines.find((line) => line.fields?.["handle"] !== undefined);
    assert.equal(logged?.fields?.["handle"], SUBMITTED_HANDLE);
    const submitted = r.events.find((event) => event.type === "verify.submitted");
    assert.equal(submitted?.type === "verify.submitted" && submitted.handle, SUBMITTED_HANDLE);
    const text = JSON.stringify([r.lines, r.events, error.toJSON(), String(error.cause)]);
    assert.ok(!text.includes(SECRET));
  });
});

describe("verify(): API keys stay secret (R-SEC-1, R-DX-5, R-DX-6)", () => {
  // Made-up keys, each in the shape of no rule but the call's own secrets, so only the apiKeys
  // path can redact them. Never real keys.
  const ETHERSCAN_KEY = "etherscan-dummy-key-r58x";
  const ROUTESCAN_KEY = "routescan-dummy-key-r58y";
  const apiKeys = { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY };

  function leaks(text: string): boolean {
    return text.includes(ETHERSCAN_KEY) || text.includes(ROUTESCAN_KEY);
  }

  it("keeps a dummy key in apiKeys out of the logger, onEvent and a result (R-SEC-1, R-DX-5, R-DX-6)", async (t) => {
    const job = edited("job-no-match", (body) => {
      body.error = {
        customCode: "no_match",
        message: `mismatch for ${ETHERSCAN_KEY} and ${ROUTESCAN_KEY}`,
      };
    });
    const r = await run(t, otherSteps(job), { input: input(OTHER), options: { apiKeys } });
    const result = resultOf(r.outcome);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "no_match: mismatch for [redacted] and [redacted]");
    assert.ok(r.lines.length > 0);
    assert.ok(r.events.length > 0);
    assert.ok(!leaks(JSON.stringify([r.outcome, toEnvelope(result), r.events, r.lines])));
  });

  it("keeps a dummy key in apiKeys out of a thrown error and its toJSON() (R-SEC-1)", async (t) => {
    const job = edited("job-internal-error", (body) => {
      body.error = {
        customCode: "internal_error",
        message: `echo ${ETHERSCAN_KEY} ${ROUTESCAN_KEY}`,
      };
    });
    const r = await run(t, otherSteps(job), { input: input(OTHER), options: { apiKeys } });
    const error = errorOf(r.outcome, "verification-inconclusive");
    const text = JSON.stringify([
      error.message,
      error.hint,
      error.details,
      error.toJSON(),
      toEnvelope(error),
      String(error.stack),
      r.events,
      r.lines,
    ]);
    assert.ok(text.includes("[redacted]"), text);
    assert.ok(!leaks(text), text);
  });

  it("keeps an invalid apiKeys value out of the invalid-input error and sends nothing (R-SEC-1, R-IN-6)", async (t) => {
    const bad = `${ETHERSCAN_KEY} with a space`;
    const r = await run(t, [], { options: { apiKeys: { "etherscan-v2": bad } } });
    const error = errorOf(r.outcome, "invalid-input");
    assert.deepEqual(error.details, {
      code: "invalid-input",
      issues: [
        {
          field: "apiKeys.etherscan-v2",
          message: "must hold only letters, digits, '.', '_', '~' and '-'",
        },
      ],
    });
    assert.ok(!JSON.stringify([error.message, error.toJSON(), r.lines]).includes(ETHERSCAN_KEY));
    assert.equal(r.sent.length, 0);
  });

  it("verifies on Sourcify with keys set for other backends: a key never goes to sourcify.dev (R-SEC-2)", async (t) => {
    const r = await run(t, [fixture("lookup-exact-match")], { options: { apiKeys } });
    assert.equal(resultOf(r.outcome).status, "already-verified");
    assert.ok(!leaks(JSON.stringify(r.sent)));
  });
});

describe("killers", () => {
  it("K1 rejects at once when aborted during the wait before a poll (R-FLOW-6)", async (t) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const r = await run(t, [fixture("lookup-not-verified"), fixture("submit-accepted")], {
      options: { signal: controller.signal },
      onRound: (events) => {
        if (events.some((event) => event.type === "verify.submitted")) {
          controller.abort(reason);
        }
      },
    });
    assert.equal(r.outcome, reason);
    assert.equal(r.sent.length, 2);
    assert.equal(r.elapsed, 0);
  });

  it("K2 gives a last lookup that never answers exactly one more interval (R-FLOW-2)", async (t) => {
    const cases: [timeoutMs: number, pollIntervalMs: number][] = [
      [10_000, 3_000],
      [9_000, 3_000],
      [1_000, 5_000],
      [7_500, 1_000],
      [DEFAULT_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS],
    ];
    for (const [timeoutMs, pollIntervalMs] of cases) {
      t.mock.timers.reset();
      const polls = Math.ceil(timeoutMs / pollIntervalMs) - 1;
      const r = await run(
        t,
        [fixture("lookup-not-verified"), fixture("submit-accepted"), ...pending(polls), "hang"],
        { options: { timeoutMs, pollIntervalMs } },
      );
      const error = errorOf(r.outcome, "not-confirmed");
      // The last lookup reached the hanging step and ended on the grace budget.
      assert.equal(r.sent.length, 2 + polls + 1);
      assert.ok(
        error.cause instanceof Error && error.cause.message.includes("did not finish within"),
      );
      assert.equal(r.elapsed, timeoutMs + pollIntervalMs);
    }
  });

  it("K3 gives the grade lookup one more interval when the job answers past the deadline", async (t) => {
    const slowPoll: Backend = {
      ...sourcify,
      poll: async (handle, ctx) => {
        const outcome = await sourcify.poll(handle, ctx);
        t.mock.timers.tick(2_000);
        return outcome;
      },
    };
    const r = await run(
      t,
      [...otherSteps(fixture("job-already-verified")), fixture("lookup-match")],
      {
        input: input(OTHER),
        options: { timeoutMs: 4_000, pollIntervalMs: 3_000 },
        dependencies: { backends: { sourcify: slowPoll } },
      },
    );
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

  it("K4a uses a 120000 ms budget and a 3000 ms interval by default", async (t) => {
    const r = await run(t, [
      fixture("lookup-not-verified"),
      fixture("submit-accepted"),
      ...pending(39),
      fixture("lookup-not-verified"),
    ]);
    const error = errorOf(r.outcome, "not-confirmed");
    assert.equal(r.events.filter((event) => event.type === "verify.poll").length, 39);
    assert.equal(r.elapsed, 120_000);
    assert.ok(error.message.includes("120000 ms"), error.message);
  });

  it("K4b uses the same defaults when options are left out entirely", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const original = globalThis.fetch;
    const { fetch, sent } = script([
      fixture("lookup-not-verified"),
      fixture("submit-accepted"),
      ...pending(39),
      fixture("lookup-not-verified"),
    ]);
    globalThis.fetch = fetch;
    try {
      const state = { done: false };
      const tracked = verify(input())
        .then(
          () => "resolved",
          (error: unknown) => error,
        )
        .finally(() => {
          state.done = true;
        });
      for (let round = 0; round < 500 && !state.done; round += 1) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (!state.done) {
          t.mock.timers.runAll();
        }
      }
      errorOf(await tracked, "not-confirmed");
      assert.equal(sent.length, 42);
      assert.equal(Date.now(), 120_000);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("K5 rejects a single bad duration option", async (t) => {
    const cases: [VerifyOptions, string][] = [
      [{ timeoutMs: 0 }, "timeoutMs"],
      [{ pollIntervalMs: Number.NaN }, "pollIntervalMs"],
    ];
    for (const [options, field] of cases) {
      t.mock.timers.reset();
      const r = await run(t, [], { options });
      const error = errorOf(r.outcome, "invalid-input");
      assert.deepEqual(
        error.details.code === "invalid-input" && error.details.issues.map((issue) => issue.field),
        [field],
      );
      assert.equal(r.sent.length, 0);
    }
  });

  it("K6 reports the caller's timeoutMs in a timeout error", async (t) => {
    const r = await run(t, [fixture("lookup-not-verified"), "hang"], {
      options: { timeoutMs: 5_000 },
    });
    const error = errorOf(r.outcome, "timeout");
    assert.equal(error.details.code === "timeout" && error.details.timeoutMs, 5_000);
  });

  it("K7 names the budget in the not-confirmed message", async (t) => {
    const r = await run(
      t,
      [
        fixture("lookup-not-verified"),
        fixture("submit-accepted"),
        ...pending(3),
        fixture("lookup-not-verified"),
      ],
      { options: { timeoutMs: 10_000, pollIntervalMs: 3_000 } },
    );
    const error = errorOf(r.outcome, "not-confirmed");
    assert.ok(error.message.includes("10000 ms budget"), error.message);
  });

  it("K8 uses the job's own match for already-verified, with no extra lookup", async (t) => {
    const graded: Backend = {
      ...sourcify,
      poll: async () => ({ state: "already-verified", match: "exact" }),
    };
    const r = await run(t, [notVerified(OTHER), accepted(OTHER_JOB)], {
      input: input(OTHER),
      dependencies: { backends: { sourcify: graded } },
    });
    assertResult(
      r.outcome,
      {
        status: "already-verified",
        backend: "sourcify",
        match: "exact",
        explorerUrl: `https://repo.sourcify.dev/${String(SEPOLIA)}/${OTHER}`,
      },
      0,
    );
    assert.equal(r.sent.length, 2);
  });

  it("K9 logs the result at info", async (t) => {
    const r = await run(t, [fixture("lookup-exact-match")]);
    assert.ok(
      r.lines.some(
        (line) => line.level === "info" && line.fields?.["status"] === "already-verified",
      ),
    );
  });

  it("K10 does not start the last lookup after an abort during a poll", async (t) => {
    const controller = new AbortController();
    const reason = new ExplorerVerifyError(
      { code: "timeout", backend: "sourcify", timeoutMs: 1 },
      "caller's own timeout",
      { secrets: [] },
    );
    const r = await run(t, [fixture("lookup-not-verified"), fixture("submit-accepted"), "hang"], {
      options: { signal: controller.signal },
      onRound: (_events, sent) => {
        if (sent.length === 3) {
          controller.abort(reason);
        }
      },
    });
    assert.equal(r.outcome, reason);
    assert.ok(!r.lines.some((line) => line.message.includes("looking the contract up once more")));
  });

  it("K11 logs the route's URL with its query replaced, even for a short value", async (t) => {
    const r = await run(t, [fixture("lookup-exact-match")], {
      options: { route: { apiUrl: "https://sourcify.example.org/server?k=q1w2e" } },
    });
    resultOf(r.outcome);
    assert.ok(!JSON.stringify(r.lines).includes("q1w2e"), JSON.stringify(r.lines));
  });
});

// --- live ----------------------------------------------------------------------------------------

describe("verify(): live, keyless, read-only", () => {
  it(
    "returns already-verified for a verified Sepolia contract without submitting (R-FLOW-1)",
    { skip: process.env["BLACKBOX_LIVE"] === "1" ? false : "set BLACKBOX_LIVE=1" },
    async () => {
      const methods: string[] = [];
      const counting: typeof fetch = async (request, init) => {
        methods.push(init?.method ?? "GET");
        return await globalThis.fetch(request, init);
      };
      const result = await verify(input(), { fetch: counting, timeoutMs: 30_000 });
      assert.equal(result.status, "already-verified");
      assert.equal(result.match, "exact");
      assert.deepEqual(methods, ["GET"]);
    },
  );
});
