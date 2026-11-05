// Black-box tests for issue #17: `verify()`. They use only the package entry point, the issue and
// its comments, docs/user/reference/verify.md, logging-and-events.md, json-output.md, errors/index.md,
// sourcify.md, llms.txt and the TSDoc of `verify`. Every request goes to a fake `fetch` that
// answers by method and path, with bodies shaped like the recorded Sourcify answers. Time is
// mocked: `setTimeout` and `Date` run on node:test mock timers, so no test waits in real time.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { inspect } from "node:util";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  ExplorerVerifyError,
  exitCodeOf,
  toEnvelope,
  verify as publicVerify,
} from "../../src/index.ts";
import type {
  Hex,
  Logger,
  LogFields,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyOutcome,
  VerifyResult,
} from "../../src/index.ts";
import { docsUrlOf } from "../helpers/docs-url.ts";
import { driveMockClock, turnUntil } from "../helpers/mock-clock.ts";

const CHAIN_ID = 11155111;
const ADDRESS: Hex = "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC";
const DOC_ADDRESS: Hex = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const JOB_ID = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const DOC_JOB_ID = "550e8400-e29b-41d4-a716-446655440000";
const DEFAULT_API = "https://sourcify.dev/server";
const SECRET = "DUMMYSECRETq7w3e9r1t5y8u2i4o6p0zz";
const PRIVATE_API = `https://sourcify.example.org/server?apikey=${SECRET}`;

function makeInput(address: Hex = ADDRESS, chainId = CHAIN_ID): VerifyInput {
  return {
    chainId,
    address,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: {
          "contracts/Greeter.sol": { content: "contract Greeter {}" },
        },
        settings: { optimizer: { enabled: false, runs: 200 } },
      },
    },
    contractName: "contracts/Greeter.sol:Greeter",
  };
}

// ---------------------------------------------------------------------------------------------
// Mock time. Every test runs on mock `setTimeout` and `Date`; `setImmediate` stays real, so a
// driver can let promises settle between timer rounds.

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
});

afterEach(() => {
  mock.timers.reset();
});

/**
 * The public `verify()`, with the mock clock driven until the call settles: after each real turn,
 * every pending timer runs. The test sees the same promise the public function returns.
 */
function verify(input: VerifyInput, options?: VerifyOptions): Promise<VerifyResult> {
  const pending = publicVerify(input, options);
  void driveMockClock(pending, () => {
    mock.timers.runAll();
  });
  return pending;
}

// ---------------------------------------------------------------------------------------------
// Fake fetch, answering by step: lookup, submit or status.

interface Call {
  readonly step: "lookup" | "submit" | "status";
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
}

interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Never answers; rejects with the request's abort reason. */
  readonly hang?: boolean;
}

interface Script {
  readonly lookup?: readonly Reply[];
  readonly submit?: readonly Reply[];
  readonly status?: readonly Reply[];
}

function stepOf(method: string, path: string): Call["step"] {
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

async function bodyText(init: RequestInit | undefined): Promise<string | undefined> {
  const raw = init?.body;
  if (typeof raw === "string") {
    return raw;
  }
  if (raw === undefined || raw === null) {
    return undefined;
  }
  return await new Response(raw).text();
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

function fakeFetch(script: Script): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const used = { lookup: 0, submit: 0, status: 0 };
  const fn: typeof fetch = async (target, init) => {
    const url = target instanceof Request ? target.url : String(target);
    const method = (
      target instanceof Request ? target.method : (init?.method ?? "GET")
    ).toUpperCase();
    const signal = target instanceof Request ? target.signal : init?.signal;
    const step = stepOf(method, new URL(url).pathname);
    calls.push({ step, method, url, body: await bodyText(init) });
    const replies = script[step] ?? [];
    const reply = replies[Math.min(used[step], replies.length - 1)];
    used[step] += 1;
    if (reply === undefined) {
      throw new Error(`no reply scripted for ${step}`);
    }
    if (reply.hang === true) {
      return await hang(signal);
    }
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...reply.headers,
      },
    });
  };
  return { fetch: fn, calls };
}

type WireMatch = "exact_match" | "match" | null;

function lookup(match: WireMatch, address: Hex = ADDRESS, chainId = CHAIN_ID): Reply {
  return {
    status: match === null ? 404 : 200,
    body: {
      match,
      creationMatch: match,
      runtimeMatch: match,
      chainId: String(chainId),
      address,
      ...(match === null ? {} : { verifiedAt: "2026-11-02T23:39:56Z", matchId: "58142236" }),
    },
  };
}

function errorBody(customCode: string, message: string): object {
  return {
    customCode,
    message,
    errorId: "187d91ed-2ea2-4419-851b-028720c0ecab",
  };
}

function accepted(jobId = JOB_ID): Reply {
  return { status: 202, body: { verificationId: jobId } };
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
      jobStartTime: "2026-11-02T23:39:56Z",
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

// ---------------------------------------------------------------------------------------------
// Observers: every log line and event a call produces.

interface Line {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields: LogFields | undefined;
  readonly argCount: number;
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
    (...args: [string, LogFields?]): void => {
      lines.push({
        level,
        message: args[0],
        fields: args[1],
        argCount: args.length,
      });
    };
  return {
    lines,
    events,
    logger: {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
    },
    onEvent: (event) => {
      events.push(event);
    },
  };
}

const eventSchema: unknown = JSON.parse(
  readFileSync(new URL("../../schema/event.schema.json", import.meta.url), "utf8"),
);
const envelopeSchema: unknown = JSON.parse(
  readFileSync(new URL("../../schema/envelope.schema.json", import.meta.url), "utf8"),
);

function strictValidator(schema: unknown): (value: unknown) => string[] {
  if (typeof schema !== "object" || schema === null) {
    throw new TypeError("schema must be an object");
  }
  const check = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  return (value) =>
    check(value) ? [] : (check.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`);
}

const validateEvent = strictValidator(eventSchema);
const validateEnvelope = strictValidator(envelopeSchema);

function assertEventsValid(events: readonly VerifyEvent[]): void {
  for (const event of events) {
    assert.deepEqual(validateEvent(JSON.parse(JSON.stringify(event))), [], JSON.stringify(event));
    assert.ok(Object.isFrozen(event), `${event.type} is frozen`);
  }
}

function types(events: readonly VerifyEvent[]): string[] {
  return events.map((event) => event.type);
}

/** Runs `verify` and returns the outcome, never throwing an ExplorerVerifyError. */
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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  let threw = false;
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    threw = true;
    caught = error;
  }
  assert.ok(threw, "expected a rejection");
  return caught;
}

function throwing(): void {
  throw new Error("logger broke");
}

interface Store {
  items: Map<string, string>;
  setItem: (key: string, value: string) => void;
}

function stubStorage(): Store {
  const items = new Map<string, string>();
  return {
    items,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

interface ConsoleStub {
  out: string[];
  log: (s: string) => void;
  error: (s: string) => void;
  warn: (s: string) => void;
}

function stubConsole(): ConsoleStub {
  const out: string[] = [];
  return {
    out,
    log: (s) => out.push(`log ${s}`),
    error: (s) => out.push(`error ${s}`),
    warn: (s) => out.push(`warn ${s}`),
  };
}

async function verifyError(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const error = await rejection(promise);
  assert.ok(error instanceof ExplorerVerifyError, `not an ExplorerVerifyError: ${inspect(error)}`);
  return error;
}

function checkEnvelope(outcome: VerifyOutcome | ExplorerVerifyError): Record<string, unknown> {
  const envelope: unknown = JSON.parse(JSON.stringify(toEnvelope(outcome)));
  assert.deepEqual(validateEnvelope(envelope), []);
  assert.ok(typeof envelope === "object" && envelope !== null);
  const entries: Record<string, unknown> = { ...envelope };
  assert.equal(entries.ok, exitCodeOf(outcome) === 0);
  return entries;
}

const FAST = { pollIntervalMs: 1 } as const;

// ---------------------------------------------------------------------------------------------

describe("verify(): already verified", () => {
  for (const [wire, match] of [
    ["exact_match", "exact"],
    ["match", "partial"],
  ] as const) {
    it(`returns already-verified ${match} from the lookup and submits nothing`, async () => {
      const fake = fakeFetch({ lookup: [lookup(wire)] });
      const rec = recorder();
      const result = await verify(makeInput(), {
        fetch: fake.fetch,
        ...rec,
        ...FAST,
      });
      assert.deepEqual(result, {
        status: "already-verified",
        backend: "sourcify",
        match,
        explorerUrl: `https://repo.sourcify.dev/${CHAIN_ID}/${ADDRESS.toLowerCase()}`,
      });
      assert.deepEqual(
        fake.calls.map((c) => c.step),
        ["lookup"],
      );
      assert.equal(
        fake.calls[0]?.url,
        `${DEFAULT_API}/v2/contract/${CHAIN_ID}/${ADDRESS.toLowerCase()}`,
      );
      assert.deepEqual(types(rec.events), [
        "verify.validated",
        "verify.routed",
        "verify.lookup",
        "verify.result",
      ]);
      assert.deepEqual(rec.events[0], {
        type: "verify.validated",
        chainId: CHAIN_ID,
        address: ADDRESS.toLowerCase(),
      });
      assert.deepEqual(rec.events[1], {
        type: "verify.routed",
        backend: "sourcify",
        apiHost: "sourcify.dev",
      });
      assert.deepEqual(rec.events[2], {
        type: "verify.lookup",
        backend: "sourcify",
        match,
      });
      assert.deepEqual(rec.events[3], {
        type: "verify.result",
        backend: "sourcify",
        status: "already-verified",
        match,
      });
      assertEventsValid(rec.events);
      assert.equal(exitCodeOf(result), 0);
      const envelope = checkEnvelope(result);
      assert.deepEqual(envelope, { schemaVersion: 1, ok: true, result });
    });
  }

  it("returns already-verified exact when the submit answers 409 already_verified", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [
        {
          status: 409,
          body: errorBody("already_verified", "Contract is already verified"),
        },
      ],
    });
    const rec = recorder();
    const result = await verify(makeInput(), {
      fetch: fake.fetch,
      ...rec,
      ...FAST,
    });
    assert.equal(result.status, "already-verified");
    assert.equal(result.status === "already-verified" ? result.match : undefined, "exact");
    assert.deepEqual(types(rec.events), [
      "verify.validated",
      "verify.routed",
      "verify.lookup",
      "verify.result",
    ]);
    assert.deepEqual(rec.events[2], {
      type: "verify.lookup",
      backend: "sourcify",
      match: "none",
    });
    assertEventsValid(rec.events);
  });

  it("looks up the grade when a job ends with already_verified", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null), lookup("match")],
      submit: [accepted()],
      status: [
        job({
          completed: true,
          error: errorBody("already_verified", "already verified"),
        }),
      ],
    });
    const result = await verify(makeInput(), { fetch: fake.fetch, ...FAST });
    assert.equal(result.status, "already-verified");
    assert.equal(result.status === "already-verified" ? result.match : undefined, "partial");
  });

  it("throws unknown-state when the grade lookup after a job's already_verified says not verified", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null), lookup(null)],
      submit: [accepted()],
      status: [
        job({
          completed: true,
          error: errorBody("already_verified", "already verified"),
        }),
      ],
    });
    const error = await verifyError(verify(makeInput(), { fetch: fake.fetch, ...FAST }));
    assert.equal(error.code, "unknown-state");
    assert.equal(exitCodeOf(error), 6);
  });
});

describe("verify(): a submitted job", () => {
  for (const [wire, match] of [
    ["exact_match", "exact"],
    ["match", "partial"],
  ] as const) {
    it(`returns verified ${match} after pending polls, with the documented events`, async () => {
      const fake = fakeFetch({
        lookup: [lookup(null)],
        submit: [accepted()],
        status: [PENDING, PENDING, job({ completed: true, match: wire })],
      });
      const rec = recorder();
      const result = await verify(makeInput(), {
        fetch: fake.fetch,
        ...rec,
        ...FAST,
      });
      assert.deepEqual(result, {
        status: "verified",
        backend: "sourcify",
        match,
        explorerUrl: `https://repo.sourcify.dev/${CHAIN_ID}/${ADDRESS.toLowerCase()}`,
      });
      assert.deepEqual(
        fake.calls.map((c) => c.step),
        ["lookup", "submit", "status", "status", "status"],
      );
      assert.equal(fake.calls[2]?.url, `${DEFAULT_API}/v2/verify/${JOB_ID}`);
      assert.deepEqual(types(rec.events), [
        "verify.validated",
        "verify.routed",
        "verify.lookup",
        "verify.submitted",
        "verify.poll",
        "verify.poll",
        "verify.result",
      ]);
      const handle = `ev1:sourcify:${CHAIN_ID}:${ADDRESS.toLowerCase()}:${JOB_ID}`;
      assert.deepEqual(rec.events[3], {
        type: "verify.submitted",
        backend: "sourcify",
        handle,
      });
      assert.deepEqual(rec.events[4], {
        type: "verify.poll",
        backend: "sourcify",
        attempt: 1,
        state: "pending",
      });
      assert.deepEqual(rec.events[5], {
        type: "verify.poll",
        backend: "sourcify",
        attempt: 2,
        state: "pending",
      });
      assert.deepEqual(rec.events[6], {
        type: "verify.result",
        backend: "sourcify",
        status: "verified",
        match,
      });
      assertEventsValid(rec.events);
      // The handle is logged at info as soon as the submission is accepted.
      const handleLine = rec.lines.findIndex(
        (l) =>
          l.level === "info" &&
          (l.message.includes(handle) || Object.values(l.fields ?? {}).includes(handle)),
      );
      assert.ok(handleLine >= 0, "handle logged at info");
      const firstPollLine = rec.lines.findIndex(
        (l) => l.level === "debug" && String(l.fields?.url ?? "").includes(`/v2/verify/${JOB_ID}`),
      );
      assert.ok(handleLine < firstPollLine, "handle logged before the first poll");
      // A request line carries backend, method, url and attempt.
      const lookupLine = rec.lines.find(
        (l) => l.level === "debug" && l.fields?.method !== undefined,
      );
      assert.equal(lookupLine?.fields?.backend, "sourcify");
      assert.equal(lookupLine?.fields?.method, "GET");
      assert.equal(lookupLine?.fields?.attempt, 1);
      assert.equal(
        lookupLine?.fields?.url,
        `${DEFAULT_API}/v2/contract/${CHAIN_ID}/${ADDRESS.toLowerCase()}`,
      );
      assert.ok(rec.lines.every((l) => l.level !== "error"));
      assert.deepEqual(checkEnvelope(result), {
        schemaVersion: 1,
        ok: true,
        result,
      });
    });
  }

  it("sends the documented submit body", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [job({ completed: true, match: "exact_match" })],
    });
    const withTx: VerifyInput = {
      ...makeInput(),
      creationTxHash: "0x7b20ce96631cdedb27c013f5a70724932e8a813f40410399cfca4d1ecceb65b9",
    };
    const extra = { extra: true };
    withTx.compiler.input = { ...withTx.compiler.input, ...extra };
    await verify(withTx, { fetch: fake.fetch, ...FAST });
    const submit = fake.calls.find((c) => c.step === "submit");
    assert.equal(submit?.url, `${DEFAULT_API}/v2/verify/${CHAIN_ID}/${ADDRESS.toLowerCase()}`);
    const body: unknown = JSON.parse(submit?.body ?? "null");
    assert.deepEqual(body, {
      stdJsonInput: {
        language: "Solidity",
        sources: {
          "contracts/Greeter.sol": { content: "contract Greeter {}" },
        },
        settings: { optimizer: { enabled: false, runs: 200 } },
      },
      compilerVersion: "0.8.24+commit.e11b9ed9",
      contractIdentifier: "contracts/Greeter.sol:Greeter",
      creationTransactionHash: "0x7b20ce96631cdedb27c013f5a70724932e8a813f40410399cfca4d1ecceb65b9",
    });
  });

  it("returns failed with the explorer's reason, exit code 1, ok false", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [
        job({
          completed: true,
          error: errorBody("no_match", "The deployed and recompiled bytecode don't match."),
        }),
      ],
    });
    const rec = recorder();
    const result = await verify(makeInput(), {
      fetch: fake.fetch,
      ...rec,
      ...FAST,
    });
    assert.deepEqual(result, {
      status: "failed",
      backend: "sourcify",
      reason: "no_match: The deployed and recompiled bytecode don't match.",
    });
    assert.deepEqual(rec.events.at(-1), {
      type: "verify.result",
      backend: "sourcify",
      status: "failed",
    });
    assertEventsValid(rec.events);
    assert.equal(exitCodeOf(result), 1);
    assert.deepEqual(checkEnvelope(result), {
      schemaVersion: 1,
      ok: false,
      result,
    });
  });

  it("cuts a long reason to 300 characters", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [
        job({
          completed: true,
          error: errorBody("compiler_error", "x".repeat(2000)),
        }),
      ],
    });
    const result = await verify(makeInput(), { fetch: fake.fetch, ...FAST });
    assert.equal(result.status, "failed");
    const reason = result.status === "failed" ? result.reason : "";
    assert.ok(reason.startsWith("compiler_error: "));
    assert.ok(reason.length <= 300, `reason length ${reason.length}`);
  });

  it("throws verification-inconclusive, without a handle, for a job error that may clear up", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [
        job({
          completed: true,
          error: errorBody("internal_error", "The server encountered an unexpected error."),
        }),
      ],
    });
    const rec = recorder();
    const error = await verifyError(verify(makeInput(), { fetch: fake.fetch, ...rec, ...FAST }));
    assert.equal(error.code, "verification-inconclusive");
    assert.equal(
      error.details.code === "verification-inconclusive" ? error.details.reason : undefined,
      "internal_error: The server encountered an unexpected error.",
    );
    assert.equal(exitCodeOf(error), 4);
    assert.equal(error.retryable, true);
    assert.ok(!types(rec.events).includes("verify.result"));
    assert.ok(
      rec.lines.every((l) => l.level !== "error"),
      "a thrown failure is not logged at error",
    );
    const envelope = checkEnvelope(error);
    assert.equal(envelope.ok, false);
    const errorJson: unknown = envelope.error;
    assert.ok(typeof errorJson === "object" && errorJson !== null && !("handle" in errorJson));
  });

  it("throws job-not-found for a 404 job_not_found poll", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [{ status: 404, body: errorBody("job_not_found", "No job") }],
    });
    const error = await verifyError(verify(makeInput(), { fetch: fake.fetch, ...FAST }));
    assert.equal(error.code, "job-not-found");
    assert.equal(exitCodeOf(error), 6);
  });

  it("throws in-progress for a 429 duplicate_verification_request, without retrying", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [
        {
          status: 429,
          body: errorBody("duplicate_verification_request", "dup"),
        },
      ],
    });
    const rec = recorder();
    const error = await verifyError(verify(makeInput(), { fetch: fake.fetch, ...rec, ...FAST }));
    assert.equal(error.code, "in-progress");
    assert.equal(fake.calls.filter((c) => c.step === "submit").length, 1);
    assert.ok(!types(rec.events).includes("verify.retry"));
    assert.equal(exitCodeOf(error), 5);
  });

  it("throws unknown-state with the handle for an unclassified job error", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [job({ completed: true, error: errorBody("metadata_not_set", "?") })],
    });
    const error = await verifyError(verify(makeInput(), { fetch: fake.fetch, ...FAST }));
    assert.equal(error.code, "unknown-state");
    assert.equal(
      error.details.code === "unknown-state" ? error.details.handle.jobId : undefined,
      JOB_ID,
    );
  });

  it("never returns verified for a job about another contract: not-confirmed with the handle", async () => {
    // Each such poll fails with unexpected-response; after three in a row, and a last lookup that
    // finds no match, the call ends with not-confirmed and the handle.
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [job({ completed: true, match: "exact_match", address: DOC_ADDRESS })],
    });
    const error = await verifyError(verify(makeInput(), { fetch: fake.fetch, ...FAST }));
    assert.equal(error.code, "not-confirmed");
    assert.ok(error.toJSON().handle?.endsWith(`:${JOB_ID}`));
    assert.equal(
      error.cause instanceof Error && Reflect.get(error.cause, "code"),
      "unexpected-response",
    );
  });
});

describe("verify(): time budget", () => {
  it("throws timeout, no handle, when the budget runs out before a job id", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [{ status: 0, hang: true }],
    });
    const rec = recorder();
    const started = Date.now();
    const error = await verifyError(
      verify(makeInput(), {
        fetch: fake.fetch,
        ...rec,
        timeoutMs: 100,
        pollIntervalMs: 20,
      }),
    );
    const elapsed = Date.now() - started;
    assert.equal(error.code, "timeout");
    assert.equal(error.details.code === "timeout" ? error.details.timeoutMs : undefined, 100);
    assert.equal(exitCodeOf(error), 5);
    assert.ok(elapsed < 100 + 20 + 250, `ended after ${elapsed} ms`);
    assert.ok(!types(rec.events).includes("verify.submitted"));
    assert.ok(!types(rec.events).includes("verify.result"));
    const envelope = checkEnvelope(error);
    const errorJson: unknown = envelope.error;
    assert.ok(typeof errorJson === "object" && errorJson !== null && !("handle" in errorJson));
  });

  it("throws not-confirmed with the handle when the job stays pending past the budget", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null), lookup(null)],
      submit: [accepted()],
      status: [PENDING],
    });
    const rec = recorder();
    const started = Date.now();
    const error = await verifyError(
      verify(makeInput(), {
        fetch: fake.fetch,
        ...rec,
        timeoutMs: 1_500,
        pollIntervalMs: 1_000,
      }),
    );
    const elapsed = Date.now() - started;
    assert.equal(error.code, "not-confirmed");
    assert.ok(error.details.code === "not-confirmed");
    assert.deepEqual(error.details.code === "not-confirmed" ? error.details.handle : undefined, {
      version: 1,
      backend: "sourcify",
      chainId: CHAIN_ID,
      address: ADDRESS.toLowerCase(),
      jobId: JOB_ID,
    });
    assert.equal(exitCodeOf(error), 4);
    assert.equal(error.retryable, true);
    assert.ok(elapsed < 1_500 + 1_000 + 250, `ended after ${elapsed} ms`);
    // The lookup after the budget emits no event, and the call emits no verify.result.
    assert.equal(fake.calls.at(-1)?.step, "lookup");
    assert.equal(rec.events.filter((e) => e.type === "verify.lookup").length, 1);
    assert.ok(!types(rec.events).includes("verify.result"));
    assert.deepEqual(types(rec.events).slice(0, 4), [
      "verify.validated",
      "verify.routed",
      "verify.lookup",
      "verify.submitted",
    ]);
    assert.ok(
      types(rec.events)
        .slice(4)
        .every((t) => t === "verify.poll"),
    );
    assertEventsValid(rec.events);
    const envelope = checkEnvelope(error);
    const errorJson: unknown = envelope.error;
    assert.ok(typeof errorJson === "object" && errorJson !== null);
    assert.equal(
      Object.entries(errorJson).find(([k]) => k === "handle")?.[1],
      `ev1:sourcify:${CHAIN_ID}:${ADDRESS.toLowerCase()}:${JOB_ID}`,
    );
  });

  it("returns verified when the lookup after the budget finds a match", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null), lookup("exact_match")],
      submit: [accepted()],
      status: [PENDING],
    });
    const rec = recorder();
    const result = await verify(makeInput(), {
      fetch: fake.fetch,
      ...rec,
      timeoutMs: 1_500,
      pollIntervalMs: 1_000,
    });
    assert.equal(result.status, "verified");
    assert.equal(result.status === "verified" ? result.match : undefined, "exact");
    assert.deepEqual(rec.events.at(-1), {
      type: "verify.result",
      backend: "sourcify",
      status: "verified",
      match: "exact",
    });
  });

  it("gives the doc's not-confirmed envelope for the doc's handle", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null, DOC_ADDRESS), lookup(null, DOC_ADDRESS)],
      submit: [accepted(DOC_JOB_ID)],
      status: [job({ completed: false, jobId: DOC_JOB_ID, address: DOC_ADDRESS })],
    });
    const error = await verifyError(
      verify(makeInput(DOC_ADDRESS), {
        fetch: fake.fetch,
        timeoutMs: 1_500,
        pollIntervalMs: 1_000,
      }),
    );
    const envelope = checkEnvelope(error);
    const errorJson: unknown = envelope.error;
    assert.ok(typeof errorJson === "object" && errorJson !== null);
    const { message, ...rest }: Record<string, unknown> = { ...errorJson };
    assert.equal(typeof message, "string");
    // From json-output.md, with the message left out.
    assert.deepEqual(
      { ...envelope, error: rest },
      {
        schemaVersion: 1,
        ok: false,
        error: {
          code: "not-confirmed",
          hint: "Call checkStatus with details.handle later to continue polling.",
          docsUrl: docsUrlOf("not-confirmed"),
          retryable: true,
          handle:
            "ev1:sourcify:11155111:0x5fbdb2315678afecb367f032d93f642f64180aa3:550e8400-e29b-41d4-a716-446655440000",
        },
      },
    );
  });

  it("lowers a poll interval above 2147483647 instead of firing at once", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [PENDING],
    });
    const controller = new AbortController();
    const rec = recorder();
    // The public function, not the driven one: the test moves the clock itself.
    const pending = publicVerify(makeInput(), {
      fetch: fake.fetch,
      signal: controller.signal,
      timeoutMs: 2 ** 40,
      pollIntervalMs: 2 ** 40,
      onEvent: rec.onEvent,
    });
    pending.catch(() => {});
    const warnings: string[] = [];
    const onWarning = (w: Error): void => {
      warnings.push(w.name);
    };
    process.on("warning", onWarning);
    // The first call in a process loads its client first, which takes real turns.
    await turnUntil(() => types(rec.events).includes("verify.submitted"));
    for (let round = 0; round < 20; round += 1) {
      await nextTurn();
    }
    // An overflowing timer would fire at once; a clamped one waits about 24.8 days.
    mock.timers.tick(60_000);
    for (let round = 0; round < 5; round += 1) {
      await nextTurn();
    }
    process.off("warning", onWarning);
    assert.ok(types(rec.events).includes("verify.submitted"));
    assert.equal(fake.calls.filter((c) => c.step === "status").length, 0, "no poll fired early");
    assert.ok(!warnings.includes("TimeoutOverflowWarning"));
    const reason = new Error("stop");
    controller.abort(reason);
    assert.equal(await rejection(pending), reason);
  });
});

describe("verify(): invalid input, options and route", () => {
  const cases: readonly [string, VerifyInput, VerifyOptions][] = [
    ["a bad address", { ...makeInput(), address: "0x1234" }, {}],
    ["timeoutMs 0", makeInput(), { timeoutMs: 0 }],
    ["timeoutMs -1", makeInput(), { timeoutMs: -1 }],
    ["timeoutMs NaN", makeInput(), { timeoutMs: Number.NaN }],
    ["timeoutMs Infinity", makeInput(), { timeoutMs: Number.POSITIVE_INFINITY }],
    ["pollIntervalMs 0", makeInput(), { pollIntervalMs: 0 }],
    ["pollIntervalMs -5", makeInput(), { pollIntervalMs: -5 }],
    [
      "an http apiUrl that is not localhost",
      makeInput(),
      { route: { apiUrl: "http://example.com/server" } },
    ],
    [
      "an apiUrl with a fragment",
      makeInput(),
      { route: { apiUrl: "https://example.com/server#x" } },
    ],
    [
      // Without apiUrl, an etherscan-compatible key binds to the row's standalone host instead
      // (decision 0039); an Etherscan v2 key belongs in apiKeys.
      "route.apiKey for etherscan-v2 without route.apiUrl",
      makeInput(),
      { route: { backend: "etherscan-v2", apiKey: "dummy-standalone-key-17x" } },
    ],
  ];
  for (const [name, value, options] of cases) {
    it(`throws invalid-input for ${name}, sends nothing and emits no event`, async () => {
      const fake = fakeFetch({ lookup: [lookup(null)] });
      const rec = recorder();
      const error = await verifyError(verify(value, { ...options, fetch: fake.fetch, ...rec }));
      assert.equal(error.code, "invalid-input");
      assert.equal(exitCodeOf(error), 2);
      assert.equal(fake.calls.length, 0);
      assert.deepEqual(rec.events, []);
      assert.equal(checkEnvelope(error).ok, false);
    });
  }

  it("throws invalid-input for a timeoutMs that is not a number", async () => {
    const fake = fakeFetch({ lookup: [lookup(null)] });
    const options: VerifyOptions = {};
    Reflect.set(options, "timeoutMs", "100");
    const error = await verifyError(verify(makeInput(), { ...options, fetch: fake.fetch }));
    assert.equal(error.code, "invalid-input");
    assert.equal(fake.calls.length, 0);
  });

  it("accepts a timeoutMs above 2147483647", async () => {
    const fake = fakeFetch({ lookup: [lookup("exact_match")] });
    const result = await verify(makeInput(), {
      fetch: fake.fetch,
      timeoutMs: 1e15,
    });
    assert.equal(result.status, "already-verified");
  });

  it("does not repeat the apiUrl value in an invalid-input error", async () => {
    const error = await verifyError(
      verify(makeInput(), {
        route: { apiUrl: `http://evil.example/${SECRET}` },
        fetch: fakeFetch({}).fetch,
      }),
    );
    assert.equal(error.code, "invalid-input");
    assert.ok(!inspect(error, { depth: 10 }).includes(SECRET));
    assert.ok(!JSON.stringify(error).includes(SECRET));
  });
});

describe("verify(): unsupported chain, rate limits, abort", () => {
  it("throws unsupported-chain for a 400 unsupported_chain lookup", async () => {
    const fake = fakeFetch({
      lookup: [
        {
          status: 400,
          body: errorBody("unsupported_chain", "Chain 9429413 not found"),
        },
      ],
    });
    const rec = recorder();
    const error = await verifyError(
      verify(makeInput(ADDRESS, 9429413), {
        fetch: fake.fetch,
        allowSourcifyFallback: true,
        ...rec,
        ...FAST,
      }),
    );
    assert.equal(error.code, "unsupported-chain");
    assert.equal(exitCodeOf(error), 2);
    assert.ok(error.details.code === "unsupported-chain");
    assert.equal(
      error.details.code === "unsupported-chain" ? error.details.chainId : undefined,
      9429413,
    );
    assert.equal(
      error.details.code === "unsupported-chain" ? error.details.backend : undefined,
      "sourcify",
    );
    assert.deepEqual(types(rec.events).slice(0, 2), ["verify.validated", "verify.routed"]);
    assert.ok(!types(rec.events).includes("verify.result"));
    assert.equal(fake.calls.filter((c) => c.step === "submit").length, 0);
    checkEnvelope(error);
  });

  it("throws rate-limited at once when Retry-After asks for more than 30 seconds", async () => {
    const fake = fakeFetch({
      lookup: [{ status: 429, body: {}, headers: { "retry-after": "60" } }],
    });
    const error = await verifyError(verify(makeInput(), { fetch: fake.fetch, ...FAST }));
    assert.equal(error.code, "rate-limited");
    assert.equal(
      error.details.code === "rate-limited" ? error.details.retryAfterMs : undefined,
      60_000,
    );
    assert.equal(fake.calls.length, 1);
    assert.equal(exitCodeOf(error), 5);
    checkEnvelope(error);
  });

  it("retries a 429 lookup 5 times in all with doubling waits, then throws rate-limited", async () => {
    mock.timers.setTime(1_800_000_000_000);
    const fake = fakeFetch({ lookup: [{ status: 429, body: {} }] });
    const rec = recorder();
    const pending = outcomeOf(publicVerify(makeInput(), { fetch: fake.fetch, ...rec }));
    await driveMockClock(pending, () => {
      mock.timers.runAll();
    });
    const outcome = await pending;
    assert.ok(outcome instanceof ExplorerVerifyError);
    assert.equal(outcome.code, "rate-limited");
    assert.equal(outcome.details.code === "rate-limited" ? outcome.details.attempts : undefined, 5);
    assert.equal(fake.calls.length, 5);
    const retries = rec.events.flatMap((e) => (e.type === "verify.retry" ? [e] : []));
    assert.deepEqual(
      retries.map((e) => [e.attempt, e.reason]),
      [
        [2, "rate-limited"],
        [3, "rate-limited"],
        [4, "rate-limited"],
        [5, "rate-limited"],
      ],
    );
    retries.forEach((e, i) => {
      const base = 1000 * 2 ** i;
      assert.ok(e.delayMs >= base / 2 && e.delayMs <= base, `delay ${e.delayMs} for base ${base}`);
    });
    assertEventsValid(rec.events);
    assert.deepEqual(types(rec.events), [
      "verify.validated",
      "verify.routed",
      "verify.retry",
      "verify.retry",
      "verify.retry",
      "verify.retry",
    ]);
    // Each retry is logged at warn with reason, status and delayMs.
    const warns = rec.lines.filter((l) => l.level === "warn");
    assert.equal(warns.length, 4);
    assert.equal(warns[0]?.fields?.status, 429);
    assert.equal(typeof warns[0]?.fields?.delayMs, "number");
  });

  it("rejects with signal.reason, unchanged, when aborted during polling; the handle came first", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [PENDING],
    });
    const controller = new AbortController();
    const reason = { mine: true };
    let handle: string | undefined;
    const rec = recorder();
    const pending = verify(makeInput(), {
      fetch: fake.fetch,
      signal: controller.signal,
      pollIntervalMs: 5,
      timeoutMs: 60_000,
      logger: rec.logger,
      onEvent: (event) => {
        rec.events.push(event);
        if (event.type === "verify.poll" && event.attempt === 2) {
          controller.abort(reason);
        }
        if (event.type === "verify.submitted") {
          handle = event.handle;
        }
      },
    });
    const error = await rejection(pending);
    assert.equal(error, reason);
    assert.equal(handle, `ev1:sourcify:${CHAIN_ID}:${ADDRESS.toLowerCase()}:${JOB_ID}`);
    assert.ok(!types(rec.events).includes("verify.result"));
  });

  it("rejects with signal.reason when aborted while a request hangs", async () => {
    const fake = fakeFetch({ lookup: [{ status: 0, hang: true }] });
    const controller = new AbortController();
    const reason = new Error("user stop");
    const pending = verify(makeInput(), {
      fetch: fake.fetch,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 20);
    assert.equal(await rejection(pending), reason);
  });

  it("rejects with signal.reason for a signal aborted before the call, and submits nothing", async () => {
    const fake = fakeFetch({ lookup: [lookup(null)], submit: [accepted()] });
    const reason = new Error("already gone");
    const error = await rejection(
      verify(makeInput(), { fetch: fake.fetch, signal: AbortSignal.abort(reason) }),
    );
    assert.equal(error, reason);
    assert.equal(fake.calls.filter((c) => c.step === "submit").length, 0);
  });
});

describe("verify(): callbacks that fail", () => {
  it("logs the first onEvent exception once at warn and keeps the outcome", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [PENDING, job({ completed: true, match: "exact_match" })],
    });
    const rec = recorder();
    const result = await verify(makeInput(), {
      fetch: fake.fetch,
      logger: rec.logger,
      ...FAST,
      onEvent: () => {
        throw new Error("callback broke");
      },
    });
    assert.equal(result.status, "verified");
    const warns = rec.lines.filter((l) => l.level === "warn");
    assert.equal(warns.length, 1);
    assert.ok(
      warns[0] !== undefined &&
        `${warns[0].message} ${JSON.stringify(warns[0].fields ?? {})}`.includes("callback broke"),
    );
  });

  it("ignores an async onEvent that rejects, and a logger that throws", async () => {
    const fake = fakeFetch({ lookup: [lookup("exact_match")] });
    const result = await verify(makeInput(), {
      fetch: fake.fetch,
      logger: {
        debug: throwing,
        info: throwing,
        warn: throwing,
        error: throwing,
      },
      onEvent: async () => {
        await Promise.resolve();
        throw new Error("async broke");
      },
    });
    assert.equal(result.status, "already-verified");
    await nextTurn();
  });
});

describe("verify(): keys in the route URL", () => {
  function assertClean(label: string, value: unknown): void {
    const text =
      typeof value === "string"
        ? value
        : `${JSON.stringify(value)} ${inspect(value, { depth: 20 })}`;
    assert.ok(!text.includes(SECRET), `${label} leaks the secret`);
    assert.ok(!text.includes(encodeURIComponent(SECRET)), `${label} leaks the encoded secret`);
  }

  const echo = `echo ${SECRET} and ?apikey=${SECRET}`;
  const scenarios: readonly [string, Script, VerifyOptions][] = [
    [
      "verified",
      {
        lookup: [lookup(null)],
        submit: [accepted()],
        status: [PENDING, job({ completed: true, match: "exact_match" })],
      },
      FAST,
    ],
    [
      "failed echoing the key",
      {
        lookup: [lookup(null)],
        submit: [accepted()],
        status: [job({ completed: true, error: errorBody("no_match", echo) })],
      },
      FAST,
    ],
    [
      "inconclusive echoing the key",
      {
        lookup: [lookup(null)],
        submit: [accepted()],
        status: [job({ completed: true, error: errorBody("internal_error", echo) })],
      },
      FAST,
    ],
    [
      "unknown-state echoing the key",
      {
        lookup: [lookup(null)],
        submit: [accepted()],
        status: [job({ completed: true, error: errorBody("brand_new_code", echo) })],
      },
      FAST,
    ],
    [
      "unexpected-response echoing the key",
      { lookup: [{ status: 400, body: errorBody("invalid_parameter", echo) }] },
      FAST,
    ],
    [
      "not-confirmed",
      { lookup: [lookup(null)], submit: [accepted()], status: [PENDING] },
      { timeoutMs: 1_500, pollIntervalMs: 1_000 },
    ],
    [
      "retries then rate-limited",
      {
        lookup: [
          {
            status: 429,
            body: errorBody("too_many_requests", echo),
            headers: { "retry-after": "31" },
          },
        ],
      },
      FAST,
    ],
  ];
  for (const [name, script, options] of scenarios) {
    it(`keeps the key out of every output: ${name}`, async () => {
      const fake = fakeFetch(script);
      const rec = recorder();
      const outcome = await outcomeOf(
        verify(makeInput(), {
          ...options,
          fetch: fake.fetch,
          ...rec,
          route: { apiUrl: PRIVATE_API },
        }),
      );
      // The query string is sent with every request.
      assert.ok(fake.calls.length > 0);
      for (const call of fake.calls) {
        assert.equal(new URL(call.url).searchParams.get("apikey"), SECRET, call.url);
        assert.ok(call.url.startsWith("https://sourcify.example.org/server/v2/"));
      }
      assertClean("events", rec.events);
      assertClean("log lines", rec.lines);
      assertClean("outcome", outcome);
      if (outcome instanceof ExplorerVerifyError) {
        assertClean("message", outcome.message);
        assertClean("details", outcome.details);
        assertClean("cause", outcome.cause);
        assertClean("stack", outcome.stack ?? "");
      } else {
        assert.equal("explorerUrl" in outcome, false, "a private route gives no explorerUrl");
      }
      assertClean("envelope", toEnvelope(outcome));
      const routed = rec.events.find((e) => e.type === "verify.routed");
      assert.deepEqual(routed, {
        type: "verify.routed",
        backend: "sourcify",
        apiHost: "sourcify.example.org",
      });
      for (const line of rec.lines.filter(
        (l) => l.level === "debug" && l.fields?.method !== undefined,
      )) {
        const url = String(line.fields?.url ?? "");
        assert.ok(url.endsWith("?REDACTED"), url);
      }
    });
  }
});

describe("verify(): log line shape", () => {
  it("passes one argument for a line with no fields", async () => {
    const fake = fakeFetch({ lookup: [lookup("exact_match")] });
    const rec = recorder();
    await verify(makeInput(), { fetch: fake.fetch, ...rec });
    for (const line of rec.lines) {
      assert.equal(line.argCount, line.fields === undefined ? 1 : 2);
    }
    assert.ok(
      rec.lines.some((l) => l.level === "info"),
      "the result is logged at info",
    );
  });

  it("writes nothing to console without a logger", async (t) => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const seen: string[] = [];
    for (const method of methods) {
      t.mock.method(console, method, (...args: unknown[]) => {
        const text = args.map(String).join(" ");
        if (!text.includes("ExperimentalWarning")) {
          seen.push(`${method}: ${text}`);
        }
      });
    }
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [PENDING, job({ completed: true, match: "exact_match" })],
    });
    await verify(makeInput(), { fetch: fake.fetch, ...FAST });
    assert.deepEqual(seen, []);
  });
});

// verify.md "Example" and the TSDoc @example of verify, with `verify` given the fake fetch.
async function verifyMdExample(
  input: VerifyInput,
  fake: typeof fetch,
  console: ConsoleStub,
  localStorage: Store,
): Promise<void> {
  try {
    const result = await verify(input, {
      timeoutMs: 60_000,
      fetch: fake,
      ...FAST,
    });
    if (result.status === "failed") {
      console.error(`Rejected: ${result.reason}`);
    } else {
      console.log(`${result.status} (${result.match}) ${result.explorerUrl ?? ""}`);
    }
  } catch (error) {
    if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
      localStorage.setItem("pending-verification", JSON.stringify(error.details.handle));
    } else {
      throw error;
    }
  }
}
// ---------------------------------------------------------------------------------------------
// The doc examples, copied in. Globals they use (console, localStorage, process) are local stubs.

describe("verify(): doc examples", () => {
  it("verify.md example: verified prints status, match and page", async () => {
    const out = stubConsole();
    const store = stubStorage();
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [job({ completed: true, match: "exact_match" })],
    });
    await verifyMdExample(makeInput(), fake.fetch, out, store);
    assert.deepEqual(out.out, [
      `log verified (exact) https://repo.sourcify.dev/${CHAIN_ID}/${ADDRESS.toLowerCase()}`,
    ]);
  });

  it("verify.md example: failed prints the reason", async () => {
    const out = stubConsole();
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [
        job({
          completed: true,
          error: errorBody("no_match", "The deployed and recompiled bytecode don't match."),
        }),
      ],
    });
    await verifyMdExample(makeInput(), fake.fetch, out, stubStorage());
    assert.deepEqual(out.out, [
      "error Rejected: no_match: The deployed and recompiled bytecode don't match.",
    ]);
  });

  it("verify.md example: not-confirmed stores a handle that round-trips", async () => {
    const out = stubConsole();
    const store = stubStorage();
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [PENDING],
    });
    // The example uses timeoutMs 60000; mock time passes it at once.
    mock.timers.setTime(1_800_000_000_000);
    await driveMockClock(verifyMdExample(makeInput(), fake.fetch, out, store), () => {
      mock.timers.runAll();
    });
    assert.deepEqual(out.out, []);
    const stored: unknown = JSON.parse(store.items.get("pending-verification") ?? "null");
    assert.deepEqual(stored, {
      version: 1,
      backend: "sourcify",
      chainId: CHAIN_ID,
      address: ADDRESS.toLowerCase(),
      jobId: JOB_ID,
    });
  });

  it("verify.md abort-and-resume example keeps the one-line handle", async () => {
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [PENDING],
    });
    // Copied from verify.md "Abort and resume".
    const controller = new AbortController();
    let handle: string | undefined;
    const pending = verify(makeInput(), {
      fetch: fake.fetch,
      ...FAST,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "verify.submitted") {
          handle = event.handle; // ev1:sourcify:<chainId>:<address>:<jobId>
        }
      },
    });
    await turnUntil(() => handle !== undefined);
    assert.ok(handle !== undefined);
    controller.abort();
    const error = await rejection(pending);
    assert.ok(error instanceof DOMException && error.name === "AbortError", inspect(error));
    assert.match(handle, /^ev1:sourcify:11155111:0x[0-9a-f]{40}:[0-9a-f-]+$/u);
  });

  it("logging-and-events.md onEvent example compiles and stores the handle", async () => {
    const localStorage = stubStorage();
    const console = stubConsole();
    // Copied from logging-and-events.md.
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
        case "verify.result":
          break;
        default: {
          const unknown: never = event;
          throw new Error(`Unknown event ${JSON.stringify(unknown)}`);
        }
      }
    }
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [{ status: 503, body: {} }, job({ completed: true, match: "exact_match" })],
    });
    const result = await verify(makeInput(), {
      fetch: fake.fetch,
      onEvent,
      ...FAST,
    });
    assert.equal(result.status, "verified");
    assert.equal(
      localStorage.items.get("pending-verification"),
      `ev1:sourcify:${CHAIN_ID}:${ADDRESS.toLowerCase()}:${JOB_ID}`,
    );
    assert.equal(console.out.length, 1);
    assert.match(console.out[0] ?? "", /^warn retry 2 in \d+ ms: server-error$/u);
  });

  it("logging-and-events.md pino wrapper passes fields first", async () => {
    const seen: [string, Record<string, unknown>, string][] = [];
    // A stand-in for pino: fields first, then the message.
    const log = {
      debug: (fields: object, message: string) => seen.push(["debug", { ...fields }, message]),
      info: (fields: object, message: string) => seen.push(["info", { ...fields }, message]),
      warn: (fields: object, message: string) => seen.push(["warn", { ...fields }, message]),
      error: (fields: object, message: string) => seen.push(["error", { ...fields }, message]),
    };
    const logger: Logger = {
      debug: (message, fields) => log.debug(fields ?? {}, message),
      info: (message, fields) => log.info(fields ?? {}, message),
      warn: (message, fields) => log.warn(fields ?? {}, message),
      error: (message, fields) => log.error(fields ?? {}, message),
    };
    await verify(makeInput(), {
      fetch: fakeFetch({ lookup: [lookup("exact_match")] }).fetch,
      logger,
    });
    assert.ok(seen.length >= 2);
    assert.ok(
      seen.every(
        ([, fields, message]) => typeof message === "string" && typeof fields === "object",
      ),
    );
  });

  it("json-output.md example prints the envelope and sets the exit code", async () => {
    const apiKey = SECRET;
    const console = stubConsole();
    const process = { exitCode: 0 };
    const fake = fakeFetch({
      lookup: [lookup(null)],
      submit: [accepted()],
      status: [
        job({
          completed: true,
          error: errorBody("no_match", `nope ${SECRET}`),
        }),
      ],
    });
    // Copied from json-output.md, with `verify` given the fake fetch.
    let outcome: VerifyOutcome;
    try {
      outcome = await verify(makeInput(), { fetch: fake.fetch, ...FAST });
    } catch (error) {
      if (!(error instanceof ExplorerVerifyError)) throw error;
      outcome = error;
    }
    console.log(JSON.stringify(toEnvelope(outcome, { secrets: [apiKey] })));
    process.exitCode = exitCodeOf(outcome);

    assert.equal(process.exitCode, 1);
    const printed = (console.out[0] ?? "").replace(/^log /u, "");
    assert.ok(!printed.includes(SECRET));
    const envelope: unknown = JSON.parse(printed);
    assert.deepEqual(validateEnvelope(envelope), []);
    assert.ok(typeof envelope === "object" && envelope !== null);
    assert.deepEqual(Object.keys(envelope), ["schemaVersion", "ok", "result"]);
  });

  it("errors/index.md example rethrows and stores the handle for not-confirmed", async () => {
    const localStorage = stubStorage();
    const fake = fakeFetch({
      lookup: [lookup(null), lookup(null)],
      submit: [accepted()],
      status: [PENDING],
    });
    const run = async (): Promise<void> => {
      // Copied from errors/index.md, with `verify` given the fake fetch and a 1.5 s budget, long
      // enough for the lookup and the submit on a loaded machine.
      try {
        await verify(makeInput(), {
          fetch: fake.fetch,
          timeoutMs: 1_500,
          pollIntervalMs: 1_000,
        });
      } catch (error) {
        if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
          localStorage.setItem("pending-verification", JSON.stringify(error.details.handle));
        }
        throw error;
      }
    };
    const error = await verifyError(run());
    assert.equal(error.code, "not-confirmed");
    assert.ok(localStorage.items.has("pending-verification"));
  });
});
