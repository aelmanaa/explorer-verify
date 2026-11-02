import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setImmediate } from "node:timers";
import { fileURLToPath } from "node:url";
import { inspect, promisify } from "node:util";

import { ExplorerVerifyError } from "../../src/errors.ts";
import {
  BASE_DELAY_MS,
  MAX_ATTEMPTS,
  MAX_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  request,
  sleep,
} from "../../src/http/fetch.ts";
import type { HttpContext, HttpRequest, RetryNotice } from "../../src/http/fetch.ts";
import type { Logger } from "../../src/index.ts";

// A fake key. Never a real one (R-SEC-1).
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const KEYED_URL = `https://api.example.org/v2/api?chainid=1&module=contract&apikey=${DUMMY_KEY}`;
const SOURCIFY_URL =
  "https://sourcify.dev/server/v2/verify/11155111/0x5fbdb2315678afecb367f032d93f642f64180aa3";
const execFileAsync = promisify(execFile);
const FETCH_MODULE = fileURLToPath(new URL("../../src/http/fetch.ts", import.meta.url));

/** One call the fake fetch received. */
interface Call {
  url: string;
  init: RequestInit;
  self: unknown;
}

/** What the fake fetch does on one call: answer, throw, or never settle. */
type Step = Response | Error | "hang";

/**
 * A fake `fetch` that plays `steps` in order and repeats the last one. A `hang` step settles only
 * when its signal aborts, like a real fetch, and `ignore-signal` hangs for good.
 */
function fakeFetch(...steps: (Step | "ignore-signal")[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  function fake(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {}, self: this });
    const step = steps[Math.min(calls.length, steps.length) - 1];
    if (step === undefined) {
      throw new Error("no step");
    }
    if (step === "ignore-signal") {
      return new Promise<Response>(() => {});
    }
    if (step === "hang") {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(reasonOf(signal));
        });
      });
    }
    if (step instanceof Error) {
      return Promise.reject(step);
    }
    return Promise.resolve(step.clone());
  }
  return { fetch: fake, calls };
}

function reasonOf(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return reason;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const TOO_MANY = { customCode: "too_many_requests", message: "You are sending too many requests" };
const DUPLICATE = {
  customCode: "duplicate_verification_request",
  message:
    "Contract 0x5FbDB2315678afecb367f032d93F642f64180aa3 on chain 31337 is already being verified.",
};

function context(overrides: Partial<HttpContext> = {}): HttpContext {
  return { backend: "sourcify", secrets: [DUMMY_KEY], random: () => 0, ...overrides };
}

function get(url: string = SOURCIFY_URL): HttpRequest {
  return { url, method: "GET", retry: "safe" };
}

function submit(url: string = SOURCIFY_URL): HttpRequest {
  return {
    url,
    method: "POST",
    body: JSON.stringify({ compilerVersion: "0.8.24+commit.e11b9ed9" }),
    headers: { "content-type": "application/json" },
    retry: "submit",
  };
}

/** Runs pending promise callbacks and I/O callbacks once, without moving the mocked clock. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** The state of a promise, read without waiting for it. */
function track<T>(promise: Promise<T>): {
  settled: () => boolean;
  result: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;
} {
  let done = false;
  const result = promise.then(
    (value) => {
      done = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      done = true;
      return { ok: false as const, error };
    },
  );
  return { settled: () => done, result };
}

/** Runs every timer, in order, until `promise` settles. Returns the mocked time it took. */
async function drive<T>(
  promise: Promise<T>,
): Promise<{ outcome: { ok: true; value: T } | { ok: false; error: unknown }; elapsed: number }> {
  const start = Date.now();
  const tracked = track(promise);
  for (let round = 0; round < 1_000 && !tracked.settled(); round += 1) {
    await flush();
    if (!tracked.settled()) {
      mock.timers.runAll();
    }
  }
  return { outcome: await tracked.result, elapsed: Date.now() - start };
}

async function driveToError(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const { outcome } = await drive(promise);
  assert.equal(outcome.ok, false);
  if (outcome.ok) {
    throw new Error("unreachable");
  }
  assert.ok(outcome.error instanceof ExplorerVerifyError, String(outcome.error));
  return outcome.error;
}

/** Fails when the key appears on any surface of the error (R-SEC-1). */
function assertNoKey(error: ExplorerVerifyError): void {
  const surfaces = [
    error.message,
    error.hint,
    JSON.stringify(error),
    JSON.stringify(error.toJSON()),
    JSON.stringify(error.details),
    String(error),
    error.stack ?? "",
    inspect(error, { depth: Infinity, showHidden: true }),
  ];
  for (const surface of surfaces) {
    assert.ok(!surface.includes(DUMMY_KEY), `key in ${surface}`);
    assert.ok(!surface.toLowerCase().includes(DUMMY_KEY.toLowerCase()), `key in ${surface}`);
  }
}

function recorder(): { logger: Logger; lines: [string, string][] } {
  const lines: [string, string][] = [];
  const logger: Logger = {
    debug: (message) => lines.push(["debug", message]),
    info: (message) => lines.push(["info", message]),
    warn: (message) => lines.push(["warn", message]),
    error: (message) => lines.push(["error", message]),
  };
  return { logger, lines };
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

describe("request: retries (R-FLOW-6)", () => {
  it("retries a 503 and then succeeds (R-FLOW-6)", async () => {
    const { fetch, calls } = fakeFetch(json(503, { error: "busy" }), json(200, { ok: 1 }));
    const { outcome, elapsed } = await drive(request(context({ fetch }), get()));
    assert.ok(outcome.ok);
    assert.equal(outcome.value.status, 200);
    assert.deepEqual(await outcome.value.json(), { ok: 1 });
    assert.equal(calls.length, 2);
    assert.equal(elapsed, BASE_DELAY_MS / 2);
  });

  it("gives up after 5 attempts with network and the attempt count (R-FLOW-6)", async () => {
    const { fetch, calls } = fakeFetch(new TypeError(`fetch failed: ${KEYED_URL}`));
    const error = await driveToError(request(context({ fetch }), get(KEYED_URL)));
    assert.equal(error.code, "network");
    assert.deepEqual(error.details, { code: "network", backend: "sourcify", attempts: 5 });
    assert.equal(calls.length, MAX_ATTEMPTS);
    assert.match(error.message, /after 5 attempts/);
    assertNoKey(error);
  });

  it("gives up after 5 attempts with rate-limited and the attempt count (R-FLOW-6)", async () => {
    const { fetch, calls } = fakeFetch(json(429, TOO_MANY));
    const error = await driveToError(request(context({ fetch }), get(KEYED_URL)));
    assert.deepEqual(error.details, { code: "rate-limited", backend: "sourcify", attempts: 5 });
    assert.equal(calls.length, MAX_ATTEMPTS);
    assertNoKey(error);
  });

  it("backs off exponentially with jitter between half and all of each step (R-FLOW-6)", async () => {
    const low = fakeFetch(new TypeError("down"));
    const lowRun = await drive(request(context({ fetch: low.fetch, random: () => 0 }), get()));
    assert.equal(lowRun.elapsed, 500 + 1_000 + 2_000 + 4_000);
    const high = fakeFetch(new TypeError("down"));
    const highRun = await drive(
      request(context({ fetch: high.fetch, random: () => 0.999_999 }), get()),
    );
    assert.equal(highRun.elapsed, 1_000 + 2_000 + 4_000 + 8_000);
  });

  it("uses Math.random for the jitter when no random source is given (R-FLOW-6)", async () => {
    const random = mock.method(Math, "random", () => 0.5);
    const { fetch } = fakeFetch(json(503, {}), json(200, {}));
    const { elapsed } = await drive(request({ backend: "sourcify", secrets: [], fetch }, get()));
    assert.equal(random.mock.callCount(), 1);
    assert.equal(elapsed, 750);
  });

  it("gives up after 5 attempts of 503 with unexpected-response, status and excerpt (R-FLOW-6)", async () => {
    const { fetch, calls } = fakeFetch(
      new Response(`<html>down ${KEYED_URL}</html>`, { status: 503 }),
    );
    const error = await driveToError(request(context({ fetch }), get(KEYED_URL)));
    assert.equal(error.details.code, "unexpected-response");
    assert.ok(error.details.code === "unexpected-response");
    assert.equal(error.details.status, 503);
    assert.match(error.details.excerpt, /^<html>down https:\/\/api\.example\.org/);
    assert.equal(calls.length, MAX_ATTEMPTS);
    assertNoKey(error);
  });

  for (const status of [429, 502, 503, 504]) {
    it(`retries ${String(status)} on retry safe (R-FLOW-6)`, async () => {
      const { fetch, calls } = fakeFetch(json(status, {}), json(200, {}));
      const { outcome } = await drive(request(context({ fetch }), get()));
      assert.ok(outcome.ok);
      assert.equal(calls.length, 2);
    });
  }

  for (const status of [400, 404, 409, 422, 500, 501]) {
    it(`returns ${String(status)} without a retry on retry safe (R-FLOW-6)`, async () => {
      const { fetch, calls } = fakeFetch(json(status, { status }));
      const { outcome } = await drive(request(context({ fetch }), get()));
      assert.ok(outcome.ok);
      assert.equal(outcome.value.status, status);
      assert.deepEqual(await outcome.value.json(), { status });
      assert.equal(calls.length, 1);
    });
  }

  it("does not retry a 500 on retry submit (R-FLOW-6)", async () => {
    const { fetch, calls } = fakeFetch(json(500, { error: "boom" }), json(200, {}));
    const { outcome } = await drive(request(context({ fetch }), submit()));
    assert.ok(outcome.ok);
    assert.equal(outcome.value.status, 500);
    assert.equal(calls.length, 1);
  });

  for (const status of [502, 504]) {
    it(`does not retry ${String(status)} on retry submit, so a submit is not repeated blindly (R-FLOW-6)`, async () => {
      const { fetch, calls } = fakeFetch(json(status, {}), json(200, {}));
      const { outcome } = await drive(request(context({ fetch }), submit()));
      assert.ok(outcome.ok);
      assert.equal(outcome.value.status, status);
      assert.equal(calls.length, 1);
    });
  }

  for (const step of [json(429, TOO_MANY), json(503, {}), new TypeError("socket hang up")]) {
    const name = step instanceof Response ? String(step.status) : "a network error";
    it(`retries ${name} on retry submit (R-FLOW-6)`, async () => {
      const { fetch, calls } = fakeFetch(step, json(200, { verificationId: "x" }));
      const { outcome } = await drive(request(context({ fetch }), submit()));
      assert.ok(outcome.ok);
      assert.equal(outcome.value.status, 200);
      assert.equal(calls.length, 2);
    });
  }

  it("does not retry duplicate_verification_request and returns the 429 to the backend (R-FLOW-6)", async () => {
    const { fetch, calls } = fakeFetch(json(429, DUPLICATE), json(200, {}));
    const { outcome } = await drive(request(context({ fetch }), submit()));
    assert.ok(outcome.ok);
    assert.equal(outcome.value.status, 429);
    assert.deepEqual(await outcome.value.json(), DUPLICATE);
    assert.equal(calls.length, 1);
  });

  for (const body of ["not json", "null", '"duplicate_verification_request"', '{"customCode":1}']) {
    it(`retries a 429 whose body is not the duplicate answer: ${body} (R-FLOW-6)`, async () => {
      const { fetch, calls } = fakeFetch(new Response(body, { status: 429 }), json(200, {}));
      const { outcome } = await drive(request(context({ fetch }), get()));
      assert.ok(outcome.ok);
      assert.equal(calls.length, 2);
    });
  }

  it("sends every attempt to the same URL with the same method, headers and body (R-SEC-2)", async () => {
    const { fetch, calls } = fakeFetch(json(503, {}), new TypeError("reset"), json(200, {}));
    const req = submit(KEYED_URL);
    await drive(request(context({ fetch }), req));
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.url, KEYED_URL);
      assert.equal(call.init.method, "POST");
      assert.equal(call.init.body, req.body);
      assert.deepEqual(call.init.headers, { "content-type": "application/json" });
    }
  });

  it("passes a URLSearchParams body as data, so a key-like source path adds no parameter", async () => {
    const body = new URLSearchParams({ "src/a&apikey=x.sol": "contract A {}" });
    const { fetch, calls } = fakeFetch(json(200, {}));
    await drive(
      request(context({ fetch }), { url: SOURCIFY_URL, method: "POST", body, retry: "submit" }),
    );
    const sent = calls[0]?.init.body;
    assert.ok(sent instanceof URLSearchParams);
    assert.deepEqual([...sent.keys()], ["src/a&apikey=x.sol"]);
    assert.equal(sent.get("apikey"), null);
    assert.equal(calls[0]?.url, SOURCIFY_URL);
  });

  it("reports each retry to onRetry before the wait, with the next attempt, reason and delay", async () => {
    const notices: RetryNotice[] = [];
    const { fetch } = fakeFetch(
      json(429, TOO_MANY),
      new TypeError("reset"),
      json(504, {}),
      json(200, {}),
    );
    await drive(request(context({ fetch, onRetry: (notice) => notices.push(notice) }), get()));
    assert.deepEqual(notices, [
      { attempt: 2, reason: "rate-limited", delayMs: 500 },
      { attempt: 3, reason: "network", delayMs: 1_000 },
      { attempt: 4, reason: "server-error", delayMs: 2_000 },
    ]);
  });
});

describe("request: Retry-After (R-FLOW-6)", () => {
  it("waits for Retry-After: 2 (R-FLOW-6)", async () => {
    const { fetch, calls } = fakeFetch(
      json(429, TOO_MANY, { "retry-after": "2" }),
      json(200, { ok: 1 }),
    );
    const pending = track(request(context({ fetch }), get()));
    await flush();
    assert.equal(calls.length, 1);
    mock.timers.tick(1_999);
    await flush();
    assert.equal(calls.length, 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(calls.length, 2);
    const outcome = await pending.result;
    assert.ok(outcome.ok);
  });

  for (const value of [
    "Thu, 01 Jan 1970 00:00:03 GMT",
    "Thursday, 01-Jan-70 00:00:03 GMT",
    "Thu Jan  1 00:00:03 1970",
  ]) {
    it(`waits for a Retry-After given as an HTTP date: ${value} (R-FLOW-6)`, async () => {
      const { fetch } = fakeFetch(json(503, {}, { "retry-after": value }), json(200, {}));
      const { elapsed } = await drive(request(context({ fetch }), get()));
      assert.equal(elapsed, 3_000);
    });
  }

  it("treats a Retry-After date in the past as no wait beyond the backoff (R-FLOW-6)", async () => {
    mock.timers.setTime(10_000);
    const { fetch } = fakeFetch(
      json(503, {}, { "retry-after": new Date(0).toUTCString() }),
      json(200, {}),
    );
    const { elapsed } = await drive(request(context({ fetch }), get()));
    assert.equal(elapsed, 500);
  });

  it("keeps the backoff when Retry-After is shorter (R-FLOW-6)", async () => {
    const { fetch } = fakeFetch(json(429, TOO_MANY, { "retry-after": "0" }), json(200, {}));
    const { elapsed } = await drive(request(context({ fetch }), get()));
    assert.equal(elapsed, 500);
  });

  for (const value of ["soon", "-1", "1.5", " ", "Mon, not a date"]) {
    it(`ignores a Retry-After it cannot read: "${value}" (R-FLOW-6)`, async () => {
      const { fetch } = fakeFetch(json(429, TOO_MANY, { "retry-after": value }), json(200, {}));
      const { elapsed } = await drive(request(context({ fetch }), get()));
      assert.equal(elapsed, 500);
    });
  }

  it("stops at once when Retry-After asks for more than 30 s, and reports the wait (R-FLOW-6)", async () => {
    const { fetch, calls } = fakeFetch(json(429, TOO_MANY, { "retry-after": "60" }));
    const { outcome, elapsed } = await drive(request(context({ fetch }), get()));
    assert.ok(!outcome.ok);
    assert.ok(outcome.error instanceof ExplorerVerifyError);
    assert.deepEqual(outcome.error.details, {
      code: "rate-limited",
      backend: "sourcify",
      retryAfterMs: 60_000,
      attempts: 1,
    });
    assert.match(outcome.error.message, /after 1 attempt\./);
    assert.equal(calls.length, 1);
    assert.equal(elapsed, 0);
  });

  it(`waits a Retry-After of exactly ${String(MAX_DELAY_MS / 1_000)} s (R-FLOW-6)`, async () => {
    const { fetch } = fakeFetch(json(503, {}, { "retry-after": "30" }), json(200, {}));
    const { elapsed } = await drive(request(context({ fetch }), get()));
    assert.equal(elapsed, MAX_DELAY_MS);
  });

  it("stops a 503 with a long Retry-After with unexpected-response (R-FLOW-6)", async () => {
    const { fetch } = fakeFetch(json(503, {}, { "retry-after": "31" }));
    const error = await driveToError(request(context({ fetch }), get()));
    assert.equal(error.code, "unexpected-response");
  });
});

describe("request: abort (R-FLOW-6)", () => {
  it("aborting during a backoff wait rejects with signal.reason within one tick (R-FLOW-6)", async () => {
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    let waiting: (() => void) | undefined;
    const retried = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const { fetch, calls } = fakeFetch(json(503, {}), json(200, {}));
    const pending = track(
      request(context({ fetch, signal: controller.signal, onRetry: () => waiting?.() }), get()),
    );
    await retried;
    controller.abort(reason);
    await flush();
    assert.ok(pending.settled());
    const outcome = await pending.result;
    assert.ok(!outcome.ok);
    assert.equal(outcome.error, reason);
    assert.equal(calls.length, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("aborting during a request rejects with signal.reason and aborts the fetch's signal (R-FLOW-6)", async () => {
    const controller = new AbortController();
    const reason = new DOMException("stop", "AbortError");
    const { fetch, calls } = fakeFetch("hang");
    const pending = track(request(context({ fetch, signal: controller.signal }), get()));
    await flush();
    controller.abort(reason);
    await flush();
    const outcome = await pending.result;
    assert.ok(!outcome.ok);
    assert.equal(outcome.error, reason);
    assert.equal(calls[0]?.init.signal?.aborted, true);
    assert.equal(calls[0]?.init.signal?.reason, reason);
  });

  it("rejects on abort even when the caller's fetch ignores the signal (R-FLOW-6)", async () => {
    const controller = new AbortController();
    const reason = "a string reason";
    const { fetch } = fakeFetch("ignore-signal");
    const pending = track(request(context({ fetch, signal: controller.signal }), get()));
    await flush();
    controller.abort(reason);
    await flush();
    const outcome = await pending.result;
    assert.ok(!outcome.ok);
    assert.equal(outcome.error, reason);
  });

  it("rejects with the reason of a signal that aborted before the call, and sends nothing (R-FLOW-6)", async () => {
    const reason = new Error("already");
    const { fetch, calls } = fakeFetch(json(200, {}));
    const outcome = await track(
      request(context({ fetch, signal: AbortSignal.abort(reason) }), get()),
    ).result;
    assert.ok(!outcome.ok);
    assert.equal(outcome.error, reason);
    assert.equal(calls.length, 0);
  });

  it("leaves no listener on the caller's signal after a request (R-FLOW-6)", async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch(json(503, {}), new TypeError("x"), json(200, {}));
    await drive(request(context({ fetch, signal: controller.signal }), get()));
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
});

describe("request: timeouts and the time budget (R-FLOW-6)", () => {
  it("the per-request timeout fires (R-FLOW-6)", async () => {
    const { fetch, calls } = fakeFetch("hang", json(200, {}));
    const pending = track(request(context({ fetch }), get()));
    await flush();
    mock.timers.tick(REQUEST_TIMEOUT_MS - 1);
    await flush();
    assert.equal(calls[0]?.init.signal?.aborted, false);
    mock.timers.tick(1);
    await flush();
    const signal = calls[0]?.init.signal;
    assert.equal(signal?.aborted, true);
    const reason: unknown = signal?.reason;
    assert.ok(reason instanceof DOMException);
    assert.equal(reason.name, "TimeoutError");
    const { outcome } = await drive(pending.result);
    assert.ok(outcome.ok);
    assert.ok(outcome.value.ok);
    assert.equal(calls.length, 2);
  });

  it("treats a timeout as no response: network after 5 attempts, with the timeout as cause (R-FLOW-6)", async () => {
    const { fetch, calls } = fakeFetch("ignore-signal");
    const error = await driveToError(
      request(context({ fetch, requestTimeoutMs: 1_000 }), submit(KEYED_URL)),
    );
    assert.equal(error.code, "network");
    assert.equal(calls.length, MAX_ATTEMPTS);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.name, "TimeoutError");
    assert.match(error.cause.message, /longer than 1000 ms/);
    assertNoKey(error);
  });

  it("covers the body read: a body that never ends times out (R-FLOW-6)", async () => {
    const stalled = new Response(new ReadableStream({ start: () => {} }), { status: 200 });
    const { fetch, calls } = fakeFetch(stalled, json(200, { ok: 1 }));
    const { outcome, elapsed } = await drive(request(context({ fetch }), get()));
    assert.ok(outcome.ok);
    assert.deepEqual(await outcome.value.json(), { ok: 1 });
    assert.equal(calls.length, 2);
    assert.equal(elapsed, REQUEST_TIMEOUT_MS + 500);
  });

  it("throws timeout with the budget when the deadline passes during a request (R-FLOW-6)", async () => {
    const { fetch, calls } = fakeFetch("hang");
    const budget = { deadline: 5_000, timeoutMs: 120_000 };
    const { outcome, elapsed } = await drive(request(context({ fetch, budget }), get(KEYED_URL)));
    assert.ok(!outcome.ok);
    assert.ok(outcome.error instanceof ExplorerVerifyError);
    assert.deepEqual(outcome.error.details, {
      code: "timeout",
      backend: "sourcify",
      timeoutMs: 120_000,
    });
    assert.equal(elapsed, 5_000);
    assert.equal(calls.length, 1);
    assertNoKey(outcome.error);
  });

  it("throws timeout without a request when the budget is already spent (R-FLOW-6)", async () => {
    mock.timers.setTime(9_000);
    const { fetch, calls } = fakeFetch(json(200, {}));
    const error = await driveToError(
      request(context({ fetch, budget: { deadline: 9_000, timeoutMs: 9_000 } }), get()),
    );
    assert.equal(error.code, "timeout");
    assert.equal(calls.length, 0);
  });

  it("stops retrying when the wait would reach the deadline, with the last failure (R-FLOW-6)", async () => {
    const { fetch, calls } = fakeFetch(new TypeError("down"));
    const error = await driveToError(
      request(context({ fetch, budget: { deadline: 1_500, timeoutMs: 1_500 } }), get()),
    );
    assert.deepEqual(error.details, { code: "network", backend: "sourcify", attempts: 2 });
    assert.equal(calls.length, 2);
  });

  it("keeps the per-request timeout when the budget is longer (R-FLOW-6)", async () => {
    const { fetch, calls } = fakeFetch("hang", json(200, {}));
    const { outcome, elapsed } = await drive(
      request(context({ fetch, budget: { deadline: 60_000, timeoutMs: 60_000 } }), get()),
    );
    assert.ok(outcome.ok);
    assert.equal(calls.length, 2);
    assert.equal(elapsed, REQUEST_TIMEOUT_MS + 500);
  });
});

describe("request: the caller's fetch (R-FLOW-6, R-SRV-5)", () => {
  it("the caller's fetch receives the signal (R-FLOW-6)", async () => {
    const controller = new AbortController();
    const { fetch, calls } = fakeFetch(json(200, {}));
    await drive(request(context({ fetch, signal: controller.signal }), get()));
    const signal = calls[0]?.init.signal;
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
  });

  it("calls the caller's fetch as a plain function, never as a method of the context (R-SRV-5)", async () => {
    const { fetch, calls } = fakeFetch(json(200, {}));
    await drive(request(context({ fetch }), get()));
    assert.equal(calls[0]?.self, undefined);
  });

  it("uses globalThis.fetch when the context has none (R-SRV-5)", async () => {
    const global = mock.method(globalThis, "fetch", () => Promise.resolve(json(200, { g: 1 })));
    const { outcome } = await drive(request({ backend: "sourcify", secrets: [] }, get()));
    assert.ok(outcome.ok);
    assert.deepEqual(await outcome.value.json(), { g: 1 });
    assert.equal(global.mock.callCount(), 1);
  });

  it("returns a response whose body is already read, with status, status text and headers", async () => {
    const { fetch } = fakeFetch(
      new Response("{}", { status: 202, statusText: "Accepted", headers: { "x-id": "7" } }),
    );
    const { outcome } = await drive(request(context({ fetch }), get()));
    assert.ok(outcome.ok);
    assert.equal(outcome.value.status, 202);
    assert.equal(outcome.value.statusText, "Accepted");
    assert.equal(outcome.value.headers.get("x-id"), "7");
    assert.equal(await outcome.value.text(), "{}");
  });

  for (const status of [204, 205, 304]) {
    it(`returns a ${String(status)} with an empty body`, async () => {
      const { fetch } = fakeFetch(new Response(null, { status }));
      const { outcome } = await drive(request(context({ fetch }), get()));
      assert.ok(outcome.ok);
      assert.equal(outcome.value.status, status);
      assert.equal(await outcome.value.text(), "");
    });
  }

  it("throws unexpected-response for an error response that holds no answer (status 0)", async () => {
    const { fetch, calls } = fakeFetch(Response.error());
    const error = await driveToError(request(context({ fetch }), get(KEYED_URL)));
    assert.deepEqual(error.details, {
      code: "unexpected-response",
      backend: "sourcify",
      status: 0,
      excerpt: "",
    });
    assert.equal(calls.length, 1);
    assertNoKey(error);
  });
});

describe("request: logging (R-SEC-1, R-DX-5)", () => {
  it("logs a URL containing apikey= and the logger receives no key and no query (R-SEC-1)", async () => {
    const { logger, lines } = recorder();
    const { fetch } = fakeFetch(json(503, {}), json(200, {}));
    await drive(request(context({ fetch, logger }), get(KEYED_URL)));
    assert.deepEqual(lines, [
      ["debug", "GET https://api.example.org/v2/api?REDACTED: attempt 1 of 5"],
      [
        "warn",
        "GET https://api.example.org/v2/api?REDACTED: answered 503; retrying in 500 ms (attempt 2 of 5)",
      ],
      ["debug", "GET https://api.example.org/v2/api?REDACTED: attempt 2 of 5"],
    ]);
  });

  it("logs a known key in the URL path as [redacted] (R-SEC-1)", async () => {
    const { logger, lines } = recorder();
    const { fetch } = fakeFetch(new TypeError("reset"), json(200, {}));
    await drive(
      request(context({ fetch, logger }), get(`https://rpc.example.org/v2/${DUMMY_KEY}/x`)),
    );
    assert.equal(lines.length, 3);
    for (const [, message] of lines) {
      assert.ok(message.startsWith("GET https://rpc.example.org/v2/[redacted]/x: "), message);
      assert.ok(!message.includes(DUMMY_KEY));
    }
    assert.match(lines[1]?.[1] ?? "", /no response; retrying in 500 ms/);
  });

  it("drops the user name, password and fragment, and never echoes a URL that does not parse (R-SEC-1)", async () => {
    const { logger, lines } = recorder();
    const { fetch } = fakeFetch(json(200, {}));
    await drive(request(context({ fetch, logger }), get(`https://u:${DUMMY_KEY}@x.example/p#k`)));
    await drive(request(context({ fetch, logger }), get(`not a url ${DUMMY_KEY}`)));
    assert.deepEqual(lines, [
      ["debug", "GET https://x.example/p: attempt 1 of 5"],
      ["debug", "GET [invalid URL]: attempt 1 of 5"],
    ]);
  });

  it("never logs at error a failure it throws (R-DX-5)", async () => {
    const { logger, lines } = recorder();
    const { fetch } = fakeFetch(new TypeError("down"));
    await driveToError(request(context({ fetch, logger }), get()));
    assert.equal(lines.filter(([level]) => level === "error").length, 0);
    assert.equal(lines.filter(([level]) => level === "warn").length, MAX_ATTEMPTS - 1);
  });

  it("writes nothing to console without a logger (R-DX-5)", async () => {
    const spies = (["log", "debug", "info", "warn", "error"] as const).map((name) =>
      mock.method(console, name, () => {}),
    );
    const { fetch } = fakeFetch(json(503, {}), new TypeError("x"), json(200, {}));
    await drive(request(context({ fetch }), get()));
    for (const spy of spies) {
      assert.equal(spy.mock.callCount(), 0);
    }
  });
});

describe("sleep (R-FLOW-6)", () => {
  it("resolves after the wait and leaves no listener on the signal", async () => {
    const controller = new AbortController();
    const pending = track(sleep(1_000, controller.signal));
    mock.timers.tick(999);
    await flush();
    assert.ok(!pending.settled());
    mock.timers.tick(1);
    await flush();
    assert.ok(pending.settled());
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("resolves without a signal", async () => {
    const pending = track(sleep(10));
    mock.timers.tick(10);
    assert.deepEqual(await pending.result, { ok: true, value: undefined });
  });

  it("rejects with signal.reason on abort, at once, and leaves no listener (R-FLOW-6)", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = track(sleep(60_000, controller.signal));
    controller.abort(reason);
    await flush();
    assert.deepEqual(await pending.result, { ok: false, error: reason });
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("rejects with the reason of a signal that already aborted (R-FLOW-6)", async () => {
    const reason = new Error("before");
    assert.deepEqual(await track(sleep(5, AbortSignal.abort(reason))).result, {
      ok: false,
      error: reason,
    });
  });
});

/** Runs `script` in a child Node process; returns its stdout and exit code. */
async function run(script: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
    return { stdout, code: 0 };
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : -1;
    return { stdout: "", code: typeof code === "number" ? code : -1 };
  }
}

describe("sleep keeps the Node event loop alive (R-FLOW-6, R-RUN-1)", () => {
  // These run a child process with real timers: the mock timers cannot show whether a timer holds
  // the event loop open. The waits are 20 ms. A process whose only pending work is an unref'd timer
  // exits with code 13 and prints nothing, which is how the prior art lost a poll.
  it("a process that waits only on sleep() finishes the wait and prints its result", async () => {
    mock.timers.reset();
    const result = await run(
      `const { sleep } = await import(${JSON.stringify(FETCH_MODULE)}); await sleep(20); console.log("done");`,
    );
    assert.deepEqual(result, { stdout: "done\n", code: 0 });
  });

  it("control: a process that waits only on an unref'd timer exits without its result", async () => {
    mock.timers.reset();
    const result = await run(
      `await new Promise((resolve) => setTimeout(resolve, 20).unref()); console.log("done");`,
    );
    assert.deepEqual(result, { stdout: "", code: 13 });
  });
});
