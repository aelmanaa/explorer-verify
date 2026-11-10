// Black-box tests for issue #18: `checkStatus(handle)`, `formatHandle` and `parseHandle`. They use
// only the package entry point, the issue and its comments, docs/user/reference/check-status.md,
// verify.md, errors/index.md, json-output.md, logging-and-events.md, llms.txt and the TSDoc of the three
// functions. Every request goes to a fake `fetch` that answers by step (lookup, submit, status),
// with bodies shaped like Sourcify's answers. Time is mocked: `setTimeout` and `Date` run on
// node:test mock timers, so no test waits in real time.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { ERROR_EXIT_CODES, exitCodeOf, toEnvelope } from "../../src/envelope.ts";
import type { VerifyOutcome } from "../../src/envelope.ts";
import {
  ExplorerVerifyError,
  checkStatus as publicCheckStatus,
  formatHandle,
  parseHandle,
  verify as publicVerify,
} from "../../src/index.ts";
import type {
  Handle,
  Hex,
  Logger,
  LogFields,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/index.ts";
import { docsUrlOf } from "../helpers/docs-url.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const CHAIN_ID = 84532;
const ADDRESS: Hex = "0x616dc0f820416e46841d2e1122ff7ca615a740fe";
const MIXED: Hex = "0x616Dc0F820416E46841d2e1122FF7CA615a740Fe";
const JOB_ID = "c2ecf68c-2f91-436f-8670-3210387bb3ea";
const DOC_LINE = `ev1:sourcify:${CHAIN_ID}:${ADDRESS}:${JOB_ID}`;
const JSON_DOC_LINE =
  "ev1:sourcify:11155111:0x5fbdb2315678afecb367f032d93f642f64180aa3:550e8400-e29b-41d4-a716-446655440000";
const SECRET = "DUMMYSECRETq7w3e9r1t5y8u2i4o6p0zz";
const KEY_SHAPED_JOB = "ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678";

function makeHandle(overrides: Partial<Handle> = {}): Handle {
  return {
    version: 1,
    backend: "sourcify",
    chainId: CHAIN_ID,
    address: ADDRESS,
    jobId: JOB_ID,
    ...overrides,
  };
}

function makeInput(): VerifyInput {
  return {
    chainId: CHAIN_ID,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "contracts/Tiny.sol": { content: "contract Tiny {}" } },
        settings: { optimizer: { enabled: false, runs: 200 } },
      },
    },
    contractName: "contracts/Tiny.sol:Tiny",
  };
}

// ---------------------------------------------------------------------------------------------
// Mock time.

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
});

afterEach(() => {
  mock.timers.reset();
});

/** Runs every pending mock timer after each real turn until `pending` settles. */
function drive<T>(pending: Promise<T>): Promise<T> {
  void driveMockClock(pending, () => {
    mock.timers.runAll();
  });
  return pending;
}

function check(value: Handle | string, options?: VerifyOptions): Promise<VerifyResult> {
  return drive(publicCheckStatus(value, options));
}

function runVerify(input: VerifyInput, options?: VerifyOptions): Promise<VerifyResult> {
  return drive(publicVerify(input, options));
}

// ---------------------------------------------------------------------------------------------
// Fake fetch.

type Step = "lookup" | "submit" | "status";

interface Call {
  readonly step: Step;
  readonly method: string;
  readonly url: string;
  readonly at: number;
}

interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly hang?: boolean;
  readonly networkError?: boolean;
}

type Responder = (step: Step, index: number) => Reply;

interface Script {
  readonly lookup?: readonly Reply[];
  readonly submit?: readonly Reply[];
  readonly status?: readonly Reply[];
}

function stepOf(method: string, path: string): Step {
  if (method === "GET" && /\/v2\/contract\/\d+\/0x[0-9a-fA-F]{40}$/u.test(path)) {
    return "lookup";
  }
  if (method === "POST" && /\/v2\/verify\/\d+\/0x[0-9a-fA-F]{40}$/u.test(path)) {
    return "submit";
  }
  if (method === "GET" && /\/v2\/verify\/[^/]+$/u.test(path)) {
    return "status";
  }
  throw new Error(`unexpected request ${method} ${path}`);
}

function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal === null || signal === undefined) {
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => {
      reject(signal.reason);
    });
  });
}

function fromScript(script: Script): Responder {
  return (step, index) => {
    const replies = script[step] ?? [];
    const reply = replies[Math.min(index, replies.length - 1)];
    if (reply === undefined) {
      throw new Error(`no reply scripted for ${step}`);
    }
    return reply;
  };
}

function fakeFetch(script: Script | Responder): { fetch: typeof fetch; calls: Call[] } {
  const respond = typeof script === "function" ? script : fromScript(script);
  const calls: Call[] = [];
  const used = { lookup: 0, submit: 0, status: 0 };
  const fn: typeof fetch = async (target, init) => {
    const url = target instanceof Request ? target.url : String(target);
    const method = (
      target instanceof Request ? target.method : (init?.method ?? "GET")
    ).toUpperCase();
    const signal = target instanceof Request ? target.signal : init?.signal;
    const step = stepOf(method, new URL(url).pathname);
    calls.push({ step, method, url, at: Date.now() });
    const reply = respond(step, used[step]);
    used[step] += 1;
    if (reply.hang === true) {
      return await hang(signal);
    }
    if (reply.networkError === true) {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json; charset=utf-8", ...reply.headers },
    });
  };
  return { fetch: fn, calls };
}

type WireMatch = "exact_match" | "match" | null;

function lookup(match: WireMatch, address: Hex = ADDRESS): Reply {
  return {
    status: match === null ? 404 : 200,
    body: {
      match,
      creationMatch: match,
      runtimeMatch: match,
      chainId: String(CHAIN_ID),
      address,
      ...(match === null ? {} : { verifiedAt: "2026-11-03T10:00:00Z", matchId: "1" }),
    },
  };
}

function errorBody(customCode: string, message: string): object {
  return { customCode, message, errorId: "187d91ed-2ea2-4419-851b-028720c0ecab" };
}

function job(options: {
  completed: boolean;
  match?: WireMatch;
  error?: object;
  jobId?: string;
  address?: Hex;
}): Reply {
  const match = options.match ?? null;
  return {
    status: 200,
    body: {
      isJobCompleted: options.completed,
      verificationId: options.jobId ?? JOB_ID,
      jobStartTime: "2026-11-03T10:00:00Z",
      contract: {
        match,
        creationMatch: match,
        runtimeMatch: match,
        chainId: String(CHAIN_ID),
        address: options.address ?? ADDRESS,
      },
      ...(options.error === undefined ? {} : { error: options.error }),
    },
  };
}

const PENDING = job({ completed: false });
const EXACT = job({ completed: true, match: "exact_match" });
const JOB_NOT_FOUND: Reply = {
  status: 404,
  body: errorBody("job_not_found", "No verification job found for this id."),
};
const SERVER_500: Reply = { status: 500, body: { message: "boom" } };

// ---------------------------------------------------------------------------------------------
// Observers and schemas.

interface Line {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields: LogFields | undefined;
}

function recorder(): {
  logger: Logger;
  lines: Line[];
  events: VerifyEvent[];
  onEvent: (event: VerifyEvent) => void;
} {
  const lines: Line[] = [];
  const events: VerifyEvent[] = [];
  const at =
    (level: Line["level"]) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields });
    };
  return {
    lines,
    events,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    onEvent: (event) => {
      events.push(event);
    },
  };
}

function readSchema(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../schema/${name}`, import.meta.url), "utf8"));
}

function strictValidator(schema: unknown): (value: unknown) => string[] {
  if (typeof schema !== "object" || schema === null) {
    throw new TypeError("schema must be an object");
  }
  const compiled = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  return (value) =>
    compiled(value)
      ? []
      : (compiled.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`);
}

const validateEvent = strictValidator(readSchema("event.schema.json"));
const validateEnvelope = strictValidator(readSchema("envelope.schema.json"));

function assertEventsValid(events: readonly VerifyEvent[]): void {
  for (const event of events) {
    assert.deepEqual(validateEvent(JSON.parse(JSON.stringify(event))), [], JSON.stringify(event));
    assert.ok(Object.isFrozen(event), `${event.type} is frozen`);
  }
}

function types(events: readonly VerifyEvent[]): string[] {
  return events.map((event) => event.type);
}

async function outcomeOf(promise: Promise<VerifyResult>): Promise<VerifyOutcome> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ExplorerVerifyError) {
      return error;
    }
    throw error;
  }
}

async function errorOf(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExplorerVerifyError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an ExplorerVerifyError");
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function issueFields(error: ExplorerVerifyError): string[] {
  return error.details.code === "invalid-input" ? error.details.issues.map((i) => i.field) : [];
}

function parseError(value: unknown): ExplorerVerifyError {
  try {
    parseHandle(value);
  } catch (error) {
    if (error instanceof ExplorerVerifyError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected parseHandle to throw");
}

function handleOf(error: ExplorerVerifyError): Handle | undefined {
  const details = error.details;
  if (details.code === "not-confirmed" || details.code === "job-not-found") {
    return details.handle;
  }
  if (details.code === "unknown-state") {
    return details.handle;
  }
  return undefined;
}

function causeCode(error: ExplorerVerifyError): unknown {
  const cause = error.cause;
  if (cause instanceof Error && "code" in cause) {
    return cause.code;
  }
  return undefined;
}

const FAST = { pollIntervalMs: 1_000 };

function matchOf(result: VerifyResult): string | undefined {
  return result.status === "failed" ? undefined : result.match;
}

function explorerUrlOf(result: VerifyResult): string | undefined {
  return result.status === "failed" ? "failed" : result.explorerUrl;
}

function noSubmit(calls: readonly Call[]): void {
  assert.deepEqual(
    calls.filter((c) => c.method !== "GET"),
    [],
    "checkStatus never submits",
  );
}

// ---------------------------------------------------------------------------------------------

describe("checkStatus(): outcomes", () => {
  it("a pending job becomes verified exact; polls at once, then each interval", async () => {
    const fake = fakeFetch({ status: [PENDING, PENDING, EXACT] });
    const result = await check(DOC_LINE, { fetch: fake.fetch, pollIntervalMs: 3_000 });
    assert.deepEqual(result, {
      status: "verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: `https://repo.sourcify.dev/${CHAIN_ID}/${ADDRESS}`,
    });
    assert.deepEqual(
      fake.calls.map((c) => [c.step, c.at]),
      [
        ["status", 0],
        ["status", 3_000],
        ["status", 6_000],
      ],
    );
    assert.equal(fake.calls[0]?.url, `https://sourcify.dev/server/v2/verify/${JOB_ID}`);
    assert.equal(exitCodeOf(result), 0);
  });

  it("a partial match is verified partial", async () => {
    const fake = fakeFetch({ status: [job({ completed: true, match: "match" })] });
    const result = await check(makeHandle(), { fetch: fake.fetch });
    assert.equal(result.status, "verified");
    assert.equal(matchOf(result), "partial");
  });

  it("a job that reports already_verified looks up the grade: already-verified", async () => {
    const fake = fakeFetch({
      status: [job({ completed: true, error: errorBody("already_verified", "Already verified.") })],
      lookup: [lookup("exact_match")],
    });
    const result = await check(makeHandle(), { fetch: fake.fetch });
    assert.equal(result.status, "already-verified");
    assert.equal(matchOf(result), "exact");
    assert.equal(exitCodeOf(result), 0);
    noSubmit(fake.calls);
  });

  it("already_verified whose grade lookup fails throws unknown-state with the handle", async () => {
    const fake = fakeFetch({
      status: [job({ completed: true, error: errorBody("already_verified", "Already verified.") })],
      lookup: [SERVER_500],
    });
    const error = await errorOf(check(makeHandle(), { fetch: fake.fetch }));
    assert.equal(error.code, "unknown-state");
    assert.deepEqual(handleOf(error), makeHandle());
    assert.equal(exitCodeOf(error), 6);
  });

  it("a rejected source returns failed with the reason, exit code 1", async () => {
    const fake = fakeFetch({
      status: [
        job({
          completed: true,
          error: errorBody("no_match", "The deployed and recompiled bytecode don't match."),
        }),
      ],
    });
    const result = await check(makeHandle(), { fetch: fake.fetch });
    assert.deepEqual(result, {
      status: "failed",
      backend: "sourcify",
      reason: "no_match: The deployed and recompiled bytecode don't match.",
    });
    assert.equal(exitCodeOf(result), 1);
  });

  it("an error that may clear up throws verification-inconclusive with no handle", async () => {
    const fake = fakeFetch({
      status: [job({ completed: true, error: errorBody("internal_error", "Oops.") })],
    });
    const error = await errorOf(check(makeHandle(), { fetch: fake.fetch }));
    assert.equal(error.code, "verification-inconclusive");
    assert.equal(handleOf(error), undefined);
    assert.equal("handle" in error.toJSON(), false);
    assert.equal(exitCodeOf(error), 4);
  });

  it("a completed job with neither match nor error throws unknown-state", async () => {
    const fake = fakeFetch({ status: [job({ completed: true })] });
    const error = await errorOf(check(makeHandle(), { fetch: fake.fetch }));
    assert.equal(error.code, "unknown-state");
    assert.deepEqual(handleOf(error), makeHandle());
  });

  it("the budget runs out: not-confirmed with the same handle, never timeout", async () => {
    const fake = fakeFetch({ status: [PENDING], lookup: [lookup(null)] });
    const error = await errorOf(
      check(DOC_LINE, { fetch: fake.fetch, timeoutMs: 10_000, pollIntervalMs: 3_000 }),
    );
    assert.equal(error.code, "not-confirmed");
    assert.equal(error.retryable, true);
    assert.deepEqual(handleOf(error), parseHandle(DOC_LINE));
    assert.equal(error.toJSON().handle, DOC_LINE);
    assert.equal(exitCodeOf(error), 4);
    assert.ok(Date.now() <= 13_000, `ended at ${Date.now()}`);
    assert.equal(fake.calls.at(-1)?.step, "lookup", "one lookup after the budget");
    assert.equal(fake.calls.filter((c) => c.step === "lookup").length, 1);
    noSubmit(fake.calls);
  });

  it("the budget runs out but the final lookup finds a match: verified", async () => {
    const fake = fakeFetch({ status: [PENDING], lookup: [lookup("exact_match")] });
    const result = await check(makeHandle(), {
      fetch: fake.fetch,
      timeoutMs: 5_000,
      ...FAST,
    });
    assert.equal(result.status, "verified");
  });

  it("3 failed polls in a row end in not-confirmed after one lookup", async () => {
    const rec = recorder();
    const fake = fakeFetch({ status: [SERVER_500], lookup: [lookup(null)] });
    const error = await errorOf(
      check(makeHandle(), {
        fetch: fake.fetch,
        timeoutMs: 600_000,
        ...FAST,
        logger: rec.logger,
        onEvent: rec.onEvent,
      }),
    );
    assert.equal(error.code, "not-confirmed");
    assert.equal(fake.calls.filter((c) => c.step === "status").length, 3);
    assert.equal(fake.calls.filter((c) => c.step === "lookup").length, 1);
    assert.ok(Date.now() < 600_000, "stopped before the budget");
    assert.ok(rec.lines.filter((l) => l.level === "warn").length >= 3, "each failed poll warns");
  });

  it("a failed poll between pending polls does not end the call", async () => {
    const fake = fakeFetch({ status: [PENDING, SERVER_500, PENDING, SERVER_500, EXACT] });
    const result = await check(makeHandle(), { fetch: fake.fetch, ...FAST });
    assert.equal(result.status, "verified");
  });

  it("status requests that hang still end in not-confirmed within the bound", async () => {
    const fake = fakeFetch({ status: [{ hang: true }], lookup: [{ hang: true }] });
    const error = await errorOf(
      check(makeHandle(), { fetch: fake.fetch, timeoutMs: 10_000, pollIntervalMs: 3_000 }),
    );
    assert.equal(error.code, "not-confirmed");
    assert.ok(Date.now() <= 13_000, `ended at ${Date.now()}`);
  });

  it("a pollIntervalMs below 1000 is raised to 1000", async () => {
    const fake = fakeFetch({ status: [PENDING], lookup: [lookup(null)] });
    await errorOf(check(makeHandle(), { fetch: fake.fetch, timeoutMs: 5_000, pollIntervalMs: 1 }));
    const polls = fake.calls.filter((c) => c.step === "status").length;
    assert.ok(polls >= 4 && polls <= 7, `${polls} polls`);
  });

  it("a 429 poll is retried and emits verify.retry", async () => {
    const rec = recorder();
    const fake = fakeFetch({
      status: [{ status: 429, body: { message: "slow down" } }, EXACT],
    });
    const result = await check(makeHandle(), {
      fetch: fake.fetch,
      ...FAST,
      logger: rec.logger,
      onEvent: rec.onEvent,
    });
    assert.equal(result.status, "verified");
    const retry = rec.events.find((e) => e.type === "verify.retry");
    assert.ok(retry !== undefined && retry.type === "verify.retry");
    assert.equal(retry.reason, "rate-limited");
    assert.equal(retry.attempt, 2);
    assertEventsValid(rec.events);
  });

  it("an abort rejects with signal.reason unchanged", async () => {
    const controller = new AbortController();
    const reason = new Error("stop now");
    const fake = fakeFetch({ status: [PENDING] });
    const caught = await rejection(
      check(makeHandle(), {
        fetch: fake.fetch,
        signal: controller.signal,
        ...FAST,
        onEvent: (event) => {
          if (event.type === "verify.poll") {
            controller.abort(reason);
          }
        },
      }),
    );
    assert.equal(caught, reason);
  });
});

describe("checkStatus(): the forgotten job", () => {
  it("job_not_found and a lookup with no match: job-not-found, hint says verify()", async () => {
    const fake = fakeFetch({ status: [JOB_NOT_FOUND], lookup: [lookup(null)] });
    const error = await errorOf(check(makeHandle(), { fetch: fake.fetch }));
    assert.equal(error.code, "job-not-found");
    assert.equal(error.retryable, false);
    assert.match(error.hint, /verify\(\)/u);
    assert.deepEqual(handleOf(error), makeHandle());
    assert.equal(error.toJSON().handle, DOC_LINE);
    assert.equal(exitCodeOf(error), 6);
    assert.deepEqual(
      fake.calls.map((c) => c.step),
      ["status", "lookup"],
    );
    assert.equal(
      fake.calls[1]?.url,
      `https://sourcify.dev/server/v2/contract/${CHAIN_ID}/${ADDRESS}?fields=compilation`,
    );
  });

  it("job_not_found and a lookup with a match: verified", async () => {
    const fake = fakeFetch({ status: [JOB_NOT_FOUND], lookup: [lookup("exact_match")] });
    const result = await check(makeHandle(), { fetch: fake.fetch });
    assert.equal(result.status, "verified");
    assert.equal(matchOf(result), "exact");
  });

  it("job_not_found and a partial lookup: verified partial", async () => {
    const fake = fakeFetch({ status: [JOB_NOT_FOUND], lookup: [lookup("match")] });
    const result = await check(makeHandle(), { fetch: fake.fetch });
    assert.equal(result.status, "verified");
    assert.equal(matchOf(result), "partial");
  });

  it("job_not_found and a failed lookup: job-not-found, hint says check the explorer", async () => {
    const fake = fakeFetch({ status: [JOB_NOT_FOUND], lookup: [SERVER_500] });
    const error = await errorOf(check(makeHandle(), { fetch: fake.fetch }));
    assert.equal(error.code, "job-not-found");
    assert.match(error.hint, /Check the contract on the explorer/u);
    const fresh = fakeFetch({ status: [JOB_NOT_FOUND], lookup: [lookup(null)] });
    const notVerified = await errorOf(check(makeHandle(), { fetch: fresh.fetch }));
    assert.notEqual(error.hint, notVerified.hint, "the hint says which");
    assert.doesNotMatch(notVerified.hint, /Check the contract on the explorer/u);
    assert.equal(causeCode(error), "unexpected-response");
  });

  it("checking the same handle again fails the same way", async () => {
    const fake = fakeFetch({ status: [JOB_NOT_FOUND], lookup: [lookup(null)] });
    const first = await errorOf(check(makeHandle(), { fetch: fake.fetch }));
    const second = await errorOf(check(makeHandle(), { fetch: fake.fetch }));
    assert.deepEqual(second.toJSON(), first.toJSON());
    noSubmit(fake.calls);
  });

  it("a mixed-case handle address: the lookup answer in lower case still matches", async () => {
    const fake = fakeFetch({
      status: [JOB_NOT_FOUND],
      lookup: [lookup("exact_match", ADDRESS)],
    });
    const result = await check(makeHandle({ address: MIXED }), { fetch: fake.fetch });
    assert.equal(result.status, "verified");
  });
});

describe("handles: both forms and the round trip", () => {
  it("the object and the one-line form send the same request and give the same result", async () => {
    const a = fakeFetch({ status: [EXACT] });
    const b = fakeFetch({ status: [EXACT] });
    const ra = await check(makeHandle(), { fetch: a.fetch });
    const rb = await check(DOC_LINE, { fetch: b.fetch });
    assert.deepEqual(ra, rb);
    assert.deepEqual(
      a.calls.map((c) => c.url),
      b.calls.map((c) => c.url),
    );
  });

  it("formatHandle writes the one-line form", () => {
    assert.equal(formatHandle(makeHandle()), DOC_LINE);
  });

  it("parseHandle(formatHandle(h)) and the JSON round trip equal h", () => {
    for (const h of [
      makeHandle(),
      makeHandle({ address: MIXED }),
      makeHandle({ jobId: "a" }),
      makeHandle({ jobId: "x".repeat(128) }),
      makeHandle({ jobId: KEY_SHAPED_JOB }),
      makeHandle({ backend: "etherscan-v2", chainId: 1, jobId: "abc_DEF-123" }),
    ]) {
      assert.deepEqual(parseHandle(formatHandle(h)), h);
      assert.deepEqual(parseHandle(JSON.parse(JSON.stringify(h))), h);
    }
  });

  it("parseHandle returns a new object and keeps the address case", () => {
    const h = makeHandle({ address: MIXED });
    const parsed = parseHandle(h);
    assert.notEqual(parsed, h);
    assert.equal(parsed.address, MIXED);
    assert.deepEqual(Object.keys(parsed).toSorted(), [
      "address",
      "backend",
      "chainId",
      "jobId",
      "version",
    ]);
  });

  it("the doc handles parse", () => {
    assert.deepEqual(parseHandle(DOC_LINE), makeHandle());
    assert.deepEqual(parseHandle(JSON_DOC_LINE), {
      version: 1,
      backend: "sourcify",
      chainId: 11155111,
      address: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      jobId: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it("the one-line form holds no spaces or shell characters", () => {
    assert.match(formatHandle(makeHandle()), /^[A-Za-z0-9:_-]+$/u);
  });

  it("a key-shaped job id still resumes and is kept in the not-confirmed error", async () => {
    const line = formatHandle(makeHandle({ jobId: KEY_SHAPED_JOB }));
    const fake = fakeFetch({
      status: [job({ completed: false, jobId: KEY_SHAPED_JOB })],
      lookup: [lookup(null)],
    });
    const error = await errorOf(check(line, { fetch: fake.fetch, timeoutMs: 3_000, ...FAST }));
    assert.equal(error.code, "not-confirmed");
    assert.equal(error.toJSON().handle, line);
    assert.ok(fake.calls[0]?.url.endsWith(`/v2/verify/${KEY_SHAPED_JOB}`));
  });
});

describe("rejections: invalid-input, nothing sent", () => {
  const cases: readonly [string, unknown, string][] = [
    ["unknown version (2)", { ...makeHandle(), version: 2 }, "version"],
    ["version as a string", { ...makeHandle(), version: "1" }, "version"],
    ["unknown backend", { ...makeHandle(), backend: "nowhere" }, "backend"],
    ["bad address", { ...makeHandle(), address: "0x1234" }, "address"],
    ["address without 0x", { ...makeHandle(), address: ADDRESS.slice(2) }, "address"],
    ["empty job id", { ...makeHandle(), jobId: "" }, "jobId"],
    ["job id of 129 characters", { ...makeHandle(), jobId: "x".repeat(129) }, "jobId"],
    ["job id with a slash", { ...makeHandle(), jobId: "../admin" }, "jobId"],
    ["job id starting with -", { ...makeHandle(), jobId: "-abc" }, "jobId"],
    ["chain id 0", { ...makeHandle(), chainId: 0 }, "chainId"],
    ["chain id as a string", { ...makeHandle(), chainId: "84532" }, "chainId"],
    ["chain id fraction", { ...makeHandle(), chainId: 1.5 }, "chainId"],
    ["an extra apiUrl field", { ...makeHandle(), apiUrl: "https://attacker.example" }, "handle"],
    ["null", null, "handle"],
    ["a number", 42, "handle"],
    ["an array", [1, "sourcify"], "handle"],
    ["text of neither form", "hello", "handle"],
    ["one-line, four parts", `ev1:sourcify:${CHAIN_ID}:${ADDRESS}`, "handle"],
    ["one-line, six parts (job id with :)", `${DOC_LINE}:more`, "handle"],
    ["one-line, ev2 prefix", DOC_LINE.replace("ev1:", "ev2:"), "version"],
    ["one-line, unknown backend", DOC_LINE.replace("sourcify", "nowhere"), "backend"],
    ["one-line, bad chain id", DOC_LINE.replace(`:${CHAIN_ID}:`, ":abc:"), "chainId"],
    ["one-line, empty job id", `ev1:sourcify:${CHAIN_ID}:${ADDRESS}:`, "jobId"],
    ["one-line with surrounding spaces", ` ${DOC_LINE} `, "version"],
    ["one-line with a trailing newline", `${DOC_LINE}\n`, "jobId"],
  ];

  for (const [name, value, field] of cases) {
    it(`parseHandle: ${name} names ${field}`, () => {
      const error = parseError(value);
      assert.equal(error.code, "invalid-input");
      assert.equal(exitCodeOf(error), 2);
      const fields = issueFields(error);
      assert.ok(
        fields.includes(field) || (field === "version" && fields.includes("handle")),
        `${name}: got ${JSON.stringify(fields)}`,
      );
    });
  }

  it("messages never repeat a value or an unknown field name", () => {
    const marker = "zzSECRETVALUEzz";
    const values: unknown[] = [
      { ...makeHandle(), jobId: `${marker}/x` },
      { ...makeHandle(), address: `0x${marker}` },
      { ...makeHandle(), backend: marker },
      { ...makeHandle(), [marker]: "x" },
      { ...makeHandle(), apiUrl: `https://${marker}.example` },
      `ev1:${marker}:1:${ADDRESS}:abc`,
      marker,
    ];
    for (const value of values) {
      const error = parseError(value);
      const text = JSON.stringify([error.message, error.hint, error.details, error.toJSON()]);
      assert.ok(!text.includes(marker), text);
    }
  });

  it("unknown fields are reported as one issue on handle with their count", () => {
    const error = parseError({ ...makeHandle(), apiUrl: "https://a.example", host: "b" });
    const issues = error.details.code === "invalid-input" ? error.details.issues : [];
    const onHandle = issues.filter((i) => i.field === "handle");
    assert.equal(onHandle.length, 1);
    assert.match(onHandle[0]?.message ?? "", /2/u);
  });

  it("checkStatus with a bad handle throws invalid-input and sends nothing", async () => {
    const withUrl = { ...makeHandle(), apiUrl: "https://attacker.example" };
    const untrusted: readonly (Handle | string)[] = [
      withUrl,
      { ...makeHandle(), jobId: "" },
      `${DOC_LINE}:x`,
    ];
    for (const value of untrusted) {
      const fake = fakeFetch({ status: [EXACT] });
      const rec = recorder();
      const error = await errorOf(
        drive(
          publicCheckStatus(value, { fetch: fake.fetch, logger: rec.logger, onEvent: rec.onEvent }),
        ),
      );
      assert.equal(error.code, "invalid-input");
      assert.deepEqual(fake.calls, []);
      assert.deepEqual(rec.events, []);
    }
  });

  it("a handle whose backend is not the route's throws invalid-input naming backend", async () => {
    const fake = fakeFetch({ status: [EXACT] });
    const error = await errorOf(
      check(makeHandle({ backend: "etherscan-v2" }), { fetch: fake.fetch }),
    );
    assert.equal(error.code, "invalid-input");
    assert.ok(issueFields(error).includes("backend"), JSON.stringify(issueFields(error)));
    assert.deepEqual(fake.calls, []);
  });

  it("route.backend sourcify does not let an etherscan-v2 handle through", async () => {
    const fake = fakeFetch({ status: [EXACT] });
    const error = await errorOf(
      check(formatHandle(makeHandle({ backend: "etherscan-v2" })), {
        fetch: fake.fetch,
        route: { backend: "sourcify" },
      }),
    );
    assert.ok(issueFields(error).includes("backend"));
    assert.deepEqual(fake.calls, []);
  });

  it("invalid options throw invalid-input before any request", async () => {
    for (const options of [{ timeoutMs: -1 }, { pollIntervalMs: 0 }, { timeoutMs: Number.NaN }]) {
      const fake = fakeFetch({ status: [EXACT] });
      const error = await errorOf(check(makeHandle(), { fetch: fake.fetch, ...options }));
      assert.equal(error.code, "invalid-input");
      assert.deepEqual(fake.calls, []);
    }
  });

  it("bad options and a bad handle: options are read first", async () => {
    const fake = fakeFetch({ status: [EXACT] });
    const error = await errorOf(check(`${DOC_LINE}:x`, { fetch: fake.fetch, timeoutMs: -1 }));
    assert.ok(issueFields(error).includes("timeoutMs"), JSON.stringify(issueFields(error)));
  });
});

describe("routing: the handle never chooses a host", () => {
  it("route.apiUrl to a local fake is used for the poll and the lookup", async () => {
    const fake = fakeFetch({ status: [PENDING, JOB_NOT_FOUND], lookup: [lookup("exact_match")] });
    const rec = recorder();
    const result = await check(makeHandle(), {
      fetch: fake.fetch,
      route: { apiUrl: "http://127.0.0.1:8555/server" },
      ...FAST,
      logger: rec.logger,
      onEvent: rec.onEvent,
    });
    assert.equal(result.status, "verified");
    assert.equal(explorerUrlOf(result), undefined);
    assert.ok(fake.calls.length >= 3);
    for (const call of fake.calls) {
      assert.equal(new URL(call.url).host, "127.0.0.1:8555", call.url);
    }
    const routed = rec.events.find((e) => e.type === "verify.routed");
    assert.ok(routed !== undefined && routed.type === "verify.routed");
    assert.equal(routed.apiHost, "127.0.0.1:8555");
  });

  it("without route, a handle goes to the public Sourcify server", async () => {
    const fake = fakeFetch({ status: [EXACT] });
    await check(makeHandle(), { fetch: fake.fetch });
    assert.equal(new URL(fake.calls[0]?.url ?? "").origin, "https://sourcify.dev");
  });

  it("a key in route.apiUrl's query never reaches events, logs or errors", async () => {
    const rec = recorder();
    const fake = fakeFetch({ status: [PENDING], lookup: [lookup(null)] });
    const error = await errorOf(
      check(makeHandle(), {
        fetch: fake.fetch,
        route: { apiUrl: `https://sourcify.example.org/server?apikey=${SECRET}` },
        timeoutMs: 3_000,
        ...FAST,
        logger: rec.logger,
        onEvent: rec.onEvent,
      }),
    );
    const text = JSON.stringify([
      rec.lines,
      rec.events,
      error.message,
      error.hint,
      error.toJSON(),
      String(error.cause),
      toEnvelope(error),
    ]);
    assert.ok(!text.includes(SECRET), "key leaked");
  });
});

describe("events", () => {
  it("routed, one poll per pending poll, result last; validated against the schema", async () => {
    const rec = recorder();
    const fake = fakeFetch({ status: [PENDING, PENDING, EXACT] });
    await check(makeHandle(), {
      fetch: fake.fetch,
      ...FAST,
      logger: rec.logger,
      onEvent: rec.onEvent,
    });
    assert.deepEqual(types(rec.events), [
      "verify.routed",
      "verify.poll",
      "verify.poll",
      "verify.result",
    ]);
    assertEventsValid(rec.events);
    const polls = rec.events.flatMap((e) => (e.type === "verify.poll" ? [e.attempt] : []));
    assert.deepEqual(polls, [1, 2]);
    const last = rec.events.at(-1);
    assert.deepEqual(last, {
      type: "verify.result",
      backend: "sourcify",
      status: "verified",
      match: "exact",
      explorerUrl: `https://repo.sourcify.dev/${String(CHAIN_ID)}/${ADDRESS.toLowerCase()}`,
    });
  });

  it("a failed result has no match in verify.result", async () => {
    const rec = recorder();
    const fake = fakeFetch({
      status: [job({ completed: true, error: errorBody("no_match", "No.") })],
    });
    await check(makeHandle(), { fetch: fake.fetch, logger: rec.logger, onEvent: rec.onEvent });
    assert.deepEqual(rec.events.at(-1), {
      type: "verify.result",
      backend: "sourcify",
      status: "failed",
    });
    assertEventsValid(rec.events);
  });

  it("never emits validated, lookup or submitted, even when it looks up", async () => {
    const rec = recorder();
    const fake = fakeFetch({ status: [JOB_NOT_FOUND], lookup: [lookup("exact_match")] });
    await check(makeHandle(), { fetch: fake.fetch, logger: rec.logger, onEvent: rec.onEvent });
    assert.deepEqual(types(rec.events), ["verify.routed", "verify.result"]);
    assertEventsValid(rec.events);
  });

  it("a call that throws emits no verify.result", async () => {
    for (const script of [
      { status: [PENDING], lookup: [lookup(null)] },
      { status: [JOB_NOT_FOUND], lookup: [lookup(null)] },
      { status: [job({ completed: true, error: errorBody("internal_error", "x") })] },
    ]) {
      const rec = recorder();
      const fake = fakeFetch(script);
      await errorOf(
        check(makeHandle(), {
          fetch: fake.fetch,
          timeoutMs: 3_000,
          ...FAST,
          logger: rec.logger,
          onEvent: rec.onEvent,
        }),
      );
      assert.ok(!types(rec.events).includes("verify.result"), JSON.stringify(types(rec.events)));
      assert.equal(rec.events[0]?.type, "verify.routed");
      assertEventsValid(rec.events);
    }
  });

  it("writes nothing to console without a logger", async (t) => {
    const seen: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      t.mock.method(console, method, (...args: unknown[]) => {
        const text = args.map(String).join(" ");
        if (!text.includes("ExperimentalWarning")) {
          seen.push(`${method}: ${text}`);
        }
      });
    }
    const fake = fakeFetch({ status: [PENDING, SERVER_500, EXACT] });
    await check(makeHandle(), { fetch: fake.fetch, ...FAST });
    assert.deepEqual(seen, []);
  });
});

async function envelopeOf(script: Script, options: VerifyOptions = {}): Promise<unknown> {
  const fake = fakeFetch(script);
  const outcome = await outcomeOf(
    check(DOC_LINE, { fetch: fake.fetch, timeoutMs: 3_000, ...FAST, ...options }),
  );
  const envelope = toEnvelope(outcome);
  assert.deepEqual(validateEnvelope(JSON.parse(JSON.stringify(envelope))), []);
  assert.equal(envelope.ok, exitCodeOf(outcome) === 0);
  return JSON.parse(JSON.stringify(envelope));
}

describe("envelope and exit codes", () => {
  it("verified: ok, exit 0", async () => {
    assert.deepEqual(await envelopeOf({ status: [EXACT] }), {
      schemaVersion: 1,
      ok: true,
      result: {
        status: "verified",
        backend: "sourcify",
        match: "exact",
        explorerUrl: `https://repo.sourcify.dev/${CHAIN_ID}/${ADDRESS}`,
      },
    });
  });

  it("not-confirmed: the one-line handle, the documented hint, exit 4", async () => {
    const envelope = await envelopeOf({ status: [PENDING], lookup: [lookup(null)] });
    assert.deepEqual(envelope, {
      schemaVersion: 1,
      ok: false,
      error: {
        code: "not-confirmed",
        message: readMessage(envelope),
        hint: "Call checkStatus with details.handle later to continue polling.",
        docsUrl: docsUrlOf("not-confirmed"),
        retryable: true,
        handle: DOC_LINE,
        details: { code: "not-confirmed", handle: DOC_LINE },
      },
    });
  });

  it("job-not-found carries the handle, retryable false", async () => {
    const envelope = await envelopeOf({ status: [JOB_NOT_FOUND], lookup: [lookup(null)] });
    assert.ok(typeof envelope === "object" && envelope !== null && "error" in envelope);
    const error = envelope.error;
    assert.ok(typeof error === "object" && error !== null);
    assert.ok("handle" in error && error.handle === DOC_LINE);
    assert.ok("retryable" in error && error.retryable === false);
  });

  it("failed, inconclusive and invalid handle envelopes validate", async () => {
    await envelopeOf({ status: [job({ completed: true, error: errorBody("no_match", "x") })] });
    await envelopeOf({
      status: [job({ completed: true, error: errorBody("internal_error", "x") })],
    });
    const error = parseError(`${DOC_LINE}:x`);
    assert.deepEqual(validateEnvelope(JSON.parse(JSON.stringify(toEnvelope(error)))), []);
  });

  it("exit codes match the check-status table", () => {
    assert.equal(ERROR_EXIT_CODES["invalid-input"], 2);
    assert.equal(ERROR_EXIT_CODES["not-confirmed"], 4);
    assert.equal(ERROR_EXIT_CODES["verification-inconclusive"], 4);
    assert.equal(ERROR_EXIT_CODES["job-not-found"], 6);
  });
});

function readMessage(envelope: unknown): unknown {
  if (typeof envelope === "object" && envelope !== null && "error" in envelope) {
    const error = envelope.error;
    if (typeof error === "object" && error !== null && "message" in error) {
      return error.message;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Doc examples, copied in. Globals they use are local stubs; `verify` and `checkStatus` get the
// fake fetch through a wrapper, since the examples pass no fetch.

interface Store {
  items: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function stubStorage(): Store {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

interface ConsoleStub {
  out: string[];
  log: (text: string) => void;
  warn: (text: string) => void;
}

function stubConsole(): ConsoleStub {
  const out: string[] = [];
  return {
    out,
    log: (text) => {
      out.push(`log ${text}`);
    },
    warn: (text) => {
      out.push(`warn ${text}`);
    },
  };
}

describe("doc examples", () => {
  it("check-status.md Example (and the checkStatus TSDoc @example)", async () => {
    const localStorage = stubStorage();
    const console = stubConsole();
    const input = makeInput();
    let phase: "first" | "later" = "first";
    const fake = fakeFetch((step) => {
      if (step === "lookup") {
        return lookup(null);
      }
      if (step === "submit") {
        return { status: 202, body: { verificationId: JOB_ID } };
      }
      return phase === "first" ? PENDING : EXACT;
    });
    const verify = (value: VerifyInput): Promise<VerifyResult> =>
      drive(publicVerify(value, { fetch: fake.fetch }));
    const checkStatus = (value: string, options: VerifyOptions): Promise<VerifyResult> =>
      drive(publicCheckStatus(value, { ...options, fetch: fake.fetch }));

    // --- copied from check-status.md
    try {
      await verify(input);
    } catch (error) {
      if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
        localStorage.setItem("pending-verification", formatHandle(error.details.handle));
      } else {
        throw error;
      }
    }
    // ---
    assert.equal(localStorage.items.get("pending-verification"), DOC_LINE);
    phase = "later";

    // --- copied from check-status.md
    // Later, after a page reload:
    const stored = localStorage.getItem("pending-verification");
    if (stored !== null) {
      const result = await checkStatus(stored, { timeoutMs: 60_000 });
      localStorage.removeItem("pending-verification");
      console.log(result.status);
    }
    // ---
    assert.deepEqual(console.out, ["log verified"]);
    assert.equal(localStorage.items.size, 0);
    assert.equal(fake.calls.filter((c) => c.step === "submit").length, 1, "one submit in all");
  });

  it("verify.md and errors/index.md store formatHandle(handle); check(stored) resumes (#218)", async () => {
    const localStorage = stubStorage();
    let phase: "first" | "later" = "first";
    const fake = fakeFetch((step) => {
      if (step === "lookup") {
        return lookup(null);
      }
      if (step === "submit") {
        return { status: 202, body: { verificationId: JOB_ID } };
      }
      return phase === "first" ? PENDING : EXACT;
    });
    try {
      await runVerify(makeInput(), { fetch: fake.fetch, timeoutMs: 60_000 });
    } catch (error) {
      if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
        localStorage.setItem("pending-verification", formatHandle(error.details.handle));
      } else {
        throw error;
      }
    }
    phase = "later";
    const stored = localStorage.getItem("pending-verification") ?? "";
    const result = await check(parseHandle(stored), { fetch: fake.fetch });
    assert.equal(result.status, "verified");
  });

  it("parseHandle TSDoc @example reads the one-line form (#218)", () => {
    for (const value of [DOC_LINE]) {
      const localStorage = stubStorage();
      localStorage.setItem("pending-verification", value);
      // --- copied from the parseHandle TSDoc.
      const stored = localStorage.getItem("pending-verification");
      if (stored !== null) {
        const handle = parseHandle(stored);
        // ---
        assert.deepEqual(handle, makeHandle());
      }
    }
  });

  it("verify.md abort-and-resume: the verify.submitted handle resumes with checkStatus", async () => {
    let phase: "first" | "later" = "first";
    const fake = fakeFetch((step) => {
      if (step === "lookup") {
        return lookup(null);
      }
      if (step === "submit") {
        return { status: 202, body: { verificationId: JOB_ID } };
      }
      return phase === "first" ? PENDING : EXACT;
    });
    // --- copied from verify.md "Abort and resume"
    const controller = new AbortController();
    let handle: string | undefined;
    const pending = runVerify(makeInput(), {
      fetch: fake.fetch,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "verify.submitted") {
          handle = event.handle; // ev1:sourcify:<chainId>:<address>:<jobId>
          controller.abort(new Error("stop"));
        }
      },
    });
    // ---
    await rejection(pending);
    assert.equal(handle, DOC_LINE);
    phase = "later";
    const result = await check(handle ?? "", { fetch: fake.fetch });
    assert.equal(result.status, "verified");
  });

  it("json-output.md example, with checkStatus in place of verify", async () => {
    const fake = fakeFetch({ status: [PENDING], lookup: [lookup(null)] });
    const apiKey = SECRET;
    const out: string[] = [];
    const process = { exitCode: 0 };
    let outcome: VerifyOutcome;
    try {
      outcome = await check(DOC_LINE, { fetch: fake.fetch, timeoutMs: 3_000, ...FAST });
    } catch (error) {
      if (!(error instanceof ExplorerVerifyError)) throw error;
      outcome = error;
    }
    out.push(JSON.stringify(toEnvelope(outcome, { secrets: [apiKey] })));
    process.exitCode = exitCodeOf(outcome);
    assert.equal(process.exitCode, 4);
    assert.match(out[0] ?? "", new RegExp(`"handle":"${DOC_LINE}"`, "u"));
  });

  it("logging-and-events.md onEvent example runs on checkStatus events", async () => {
    const localStorage = stubStorage();
    const console = stubConsole();
    // --- copied from logging-and-events.md
    function onEvent(event: VerifyEvent): void {
      switch (event.type) {
        case "verify.submitted":
          localStorage.setItem("pending-verification", event.handle);
          break;
        case "verify.retry":
          console.warn(`retry ${event.attempt} in ${event.delayMs} ms: ${event.reason}`);
          break;
        case "verify.validated":
        case "verify.routed":
        case "verify.lookup":
        case "verify.poll":
        case "proxy.routed":
        case "proxy.poll":
        case "proxy.retry":
        case "proxy.result":
        case "verify.result":
          break;
        default: {
          const unknown: never = event;
          throw new Error(`Unknown event ${JSON.stringify(unknown)}`);
        }
      }
    }
    // ---
    const fake = fakeFetch({ status: [{ status: 429, body: {} }, EXACT] });
    await check(makeHandle(), { fetch: fake.fetch, onEvent, ...FAST });
    assert.equal(console.out.length, 1);
    assert.match(console.out[0] ?? "", /^warn retry 2 in \d+ ms: rate-limited$/u);
    assert.equal(localStorage.items.size, 0, "checkStatus emits no verify.submitted");
  });

  it("check-status.md 'Tested live' handle is valid", () => {
    assert.equal(formatHandle(parseHandle(DOC_LINE)), DOC_LINE);
  });
});
