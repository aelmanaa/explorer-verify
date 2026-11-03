// Black-box tests for issue #14: the HTTP layer. They use only the names in the built
// declaration of http/fetch.ts, the issue, R-FLOW-6, R-SEC-1, R-SEC-2, decisions 0009 and 0010,
// the "Retries" section of docs/user/reference/errors.md and the "HTTP layer" section of
// docs/contributor/architecture.md. No real network: every test injects a fake fetch. Every wait
// runs on the node:test mock timers. The process-liveness test of sleep() lives in
// http-fetch.test.ts.
import assert from "node:assert/strict";
import { describe, it as baseIt } from "node:test";
import type { TestContext } from "node:test";
import { inspect } from "node:util";

import {
  BASE_DELAY_MS,
  MAX_ATTEMPTS,
  MAX_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  request,
  sleep,
} from "../../src/http/fetch.ts";
import type { HttpContext, HttpRequest, RetryNotice } from "../../src/http/fetch.ts";
import { ExplorerVerifyError } from "../../src/index.ts";
import type { ErrorDetails, Logger } from "../../src/index.ts";

/**
 * `it` with a 20 s limit per test. A stuck mock timer then fails the test within the limit
 * instead of at the runner's 30 s default, with room for a loaded machine.
 */
function it(name: string, fn: (t: TestContext) => Promise<void> | void): void {
  void baseIt(name, { timeout: 20_000 }, fn);
}

// --- fixtures -----------------------------------------------------------------------------------

// Fake keys, never real ones. KEY looks like an Etherscan key; SECRET is caught only through
// ctx.secrets, because it sits in a parameter that is not on the deny-list.
const KEY = "FAKEKEY0BLACKBOX14TEST0Z9Y8X7W6V5U";
const SECRET = "bb14-dummy-secret-value-qq";
const BASE = "https://api.example-explorer.test/v2/api";
const KEYED_URL = `${BASE}?chainid=1&apikey=${KEY}&extra=${SECRET}`;
const PLAIN_URL = "https://sourcify.example.test/server/v2/verify/abc";
const NOW = 1_800_000_000_000; // a multiple of 1000, so HTTP dates round-trip exactly

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
  readonly headers: unknown;
  readonly signal: AbortSignal | undefined;
  readonly at: number;
}

type Step =
  | {
      kind: "status";
      status: number;
      body?: string;
      headers?: Record<string, string>;
    }
  | { kind: "network"; message?: string }
  | { kind: "hang" } // never answers, but rejects with the signal's reason on abort
  | { kind: "hang-deaf" }; // never answers and ignores the signal

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A fake fetch that plays `steps` in order, repeating the last one. */
function fakeFetch(steps: readonly Step[]): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl: typeof fetch = (input, init) => {
    calls.push({
      url: urlOf(input),
      method: init?.method,
      body: init?.body,
      headers: init?.headers,
      signal: init?.signal ?? undefined,
      at: Date.now(),
    });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === undefined) return Promise.reject(new Error("no step"));
    if (step.kind === "status") {
      return Promise.resolve(
        new Response(step.body ?? "", {
          status: step.status,
          headers: step.headers ?? {},
        }),
      );
    }
    if (step.kind === "network") {
      return Promise.reject(
        new TypeError("fetch failed", {
          cause: new Error(step.message ?? "connect ECONNREFUSED"),
        }),
      );
    }
    if (step.kind === "hang-deaf") return new Promise<Response>(() => {});
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal === null || signal === undefined) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => {
        reject(signal.reason);
      });
    });
  };
  return { fetch: impl, calls };
}

interface LogLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly text: string;
}

function captureLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at =
    (level: LogLine["level"]) =>
    (message: string, fields?: unknown): void => {
      lines.push({
        level,
        text: `${message} ${JSON.stringify(fields ?? null)}`,
      });
    };
  return {
    logger: {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
    },
    lines,
  };
}

function ctxWith(
  fetchImpl: typeof fetch,
  extra: Partial<Omit<HttpContext, "fetch" | "backend">> = {},
): HttpContext {
  return {
    backend: "sourcify",
    fetch: fetchImpl,
    secrets: [],
    random: () => 0,
    ...extra,
  };
}

const GET: HttpRequest = { url: PLAIN_URL, method: "GET", retry: "safe" };
const SUBMIT: HttpRequest = {
  url: PLAIN_URL,
  method: "POST",
  body: '{"contract":"x"}',
  headers: { "content-type": "application/json" },
  retry: "submit",
};

function useClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
}

/** Lets pending promise jobs and body reads run, without advancing the mock clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

interface Settled<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: unknown;
  readonly elapsedMs: number;
}

/** Records how a promise settles, without advancing the clock. */
function track<T>(promise: Promise<T>): { current: () => Settled<T> | undefined } {
  const state: { result?: Settled<T> } = {};
  void promise
    .then<Settled<T>, Settled<T>>(
      (value) => ({ ok: true, value, elapsedMs: 0 }),
      (error: unknown) => ({ ok: false, error, elapsedMs: 0 }),
    )
    .then((settled) => (state.result = settled));
  return { current: () => state.result };
}

/** Advances the mock clock in `stepMs` steps until `promise` settles or `limitMs` passes. */
async function drive<T>(
  t: TestContext,
  promise: Promise<T>,
  { stepMs = 50, limitMs = 400_000 } = {},
): Promise<Settled<T>> {
  const start = Date.now();
  const state: { result?: Settled<T> } = {};
  const tracked = promise.then<Settled<T>, Settled<T>>(
    (value) => ({ ok: true, value, elapsedMs: Date.now() - start }),
    (error: unknown) => ({ ok: false, error, elapsedMs: Date.now() - start }),
  );
  void tracked.then((settled) => (state.result = settled));
  await flush();
  while (state.result === undefined && Date.now() - start < limitMs) {
    t.mock.timers.tick(stepMs);
    await flush();
  }
  const { result } = state;
  if (result === undefined) throw new Error(`did not settle within ${String(limitMs)} ms`);
  return result;
}

function evError(settled: Settled<unknown>): ExplorerVerifyError {
  assert.equal(settled.ok, false, "expected a rejection");
  assert.ok(settled.error instanceof ExplorerVerifyError, `got ${inspect(settled.error)}`);
  return settled.error;
}

type Detail<C extends ErrorDetails["code"]> = Extract<ErrorDetails, { code: C }>;

function networkOf(error: ExplorerVerifyError): Detail<"network"> {
  const d = error.details;
  assert.equal(error.code, d.code);
  if (d.code !== "network") assert.fail(`expected network, got ${d.code}`);
  return d;
}

function rateLimitedOf(error: ExplorerVerifyError): Detail<"rate-limited"> {
  const d = error.details;
  assert.equal(error.code, d.code);
  if (d.code !== "rate-limited") assert.fail(`expected rate-limited, got ${d.code}`);
  return d;
}

function unexpectedOf(error: ExplorerVerifyError): Detail<"unexpected-response"> {
  const d = error.details;
  assert.equal(error.code, d.code);
  if (d.code !== "unexpected-response") assert.fail(`expected unexpected-response, got ${d.code}`);
  return d;
}

function timeoutOf(error: ExplorerVerifyError): Detail<"timeout"> {
  const d = error.details;
  assert.equal(error.code, d.code);
  if (d.code !== "timeout") assert.fail(`expected timeout, got ${d.code}`);
  return d;
}

function okResponse(settled: Settled<Response>): Response {
  assert.equal(settled.ok, true, `expected a response, got ${inspect(settled.error)}`);
  assert.ok(settled.value instanceof Response);
  return settled.value;
}

function endlessBody(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
    },
  });
  return new Response(stream, { status: 200 });
}

/** A fetch whose response body never ends. */
const endlessFetch: typeof fetch = () => Promise.resolve(endlessBody());

function assertClean(text: string, where: string): void {
  assert.ok(!text.includes(KEY), `${where} holds the key: ${text}`);
  assert.ok(!text.includes(SECRET), `${where} holds the secret: ${text}`);
  assert.ok(!text.includes(encodeURIComponent(SECRET)), `${where} holds the encoded secret`);
}

function surfaces(error: unknown): string[] {
  assert.ok(error instanceof ExplorerVerifyError);
  return [
    error.message,
    error.hint,
    String(error.stack),
    JSON.stringify(error),
    JSON.stringify(error.details),
    inspect(error, { depth: 10, showHidden: true }),
    inspect(error.cause, { depth: 10, showHidden: true }),
  ];
}

// --- success ------------------------------------------------------------------------------------

describe("blackbox #14: success (R-FLOW-6)", () => {
  it("returns the first response with its body, after one call", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([{ kind: "status", status: 200, body: '{"ok":true}' }]);
    const res = okResponse(await drive(t, request(ctxWith(fetch), GET)));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"ok":true}');
    assert.equal(calls.length, 1);
  });

  it("passes an AbortSignal, the method, body and headers to the caller's fetch", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([{ kind: "status", status: 201 }]);
    okResponse(await drive(t, request(ctxWith(fetch), SUBMIT)));
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, PLAIN_URL);
    assert.equal(call.method, "POST");
    assert.equal(call.body, SUBMIT.body);
    assert.ok(call.signal instanceof AbortSignal, "the caller's fetch receives a signal");
    assert.match(inspect(call.headers), /content-type/i);
  });

  it("uses globalThis.fetch when ctx.fetch is absent, read at request time", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([{ kind: "status", status: 200, body: "g" }]);
    t.mock.method(globalThis, "fetch", fetch);
    const ctx: HttpContext = { backend: "sourcify", secrets: [] };
    const res = okResponse(await drive(t, request(ctx, GET)));
    assert.equal(await res.text(), "g");
    assert.equal(calls.length, 1);
  });

  it("returns non-retryable statuses at once, for both kinds", async (t) => {
    useClock(t);
    const cases: { status: number; req: HttpRequest }[] = [
      { status: 400, req: GET },
      { status: 404, req: GET },
      { status: 500, req: GET },
      { status: 400, req: SUBMIT },
      { status: 404, req: SUBMIT },
      { status: 500, req: SUBMIT },
      { status: 502, req: SUBMIT },
      { status: 504, req: SUBMIT },
    ];
    for (const { status, req } of cases) {
      const { fetch, calls } = fakeFetch([
        { kind: "status", status, body: `b${String(status)}` },
        { kind: "status", status: 200 },
      ]);
      const res = okResponse(await drive(t, request(ctxWith(fetch), req)));
      assert.equal(res.status, status, `${req.retry} ${String(status)}`);
      assert.equal(await res.text(), `b${String(status)}`);
      assert.equal(calls.length, 1, `${req.retry} ${String(status)} is not retried`);
    }
  });
});

// --- retries ------------------------------------------------------------------------------------

describe("blackbox #14: retried cases (R-FLOW-6)", () => {
  const retried: {
    name: string;
    req: HttpRequest;
    first: Step;
    reason: RetryNotice["reason"];
  }[] = [
    {
      name: "safe 429",
      req: GET,
      first: { kind: "status", status: 429 },
      reason: "rate-limited",
    },
    {
      name: "safe 502",
      req: GET,
      first: { kind: "status", status: 502 },
      reason: "server-error",
    },
    {
      name: "safe 503",
      req: GET,
      first: { kind: "status", status: 503 },
      reason: "server-error",
    },
    {
      name: "safe 504",
      req: GET,
      first: { kind: "status", status: 504 },
      reason: "server-error",
    },
    {
      name: "safe network",
      req: GET,
      first: { kind: "network" },
      reason: "network",
    },
    {
      name: "submit 429",
      req: SUBMIT,
      first: { kind: "status", status: 429 },
      reason: "rate-limited",
    },
    {
      name: "submit 503",
      req: SUBMIT,
      first: { kind: "status", status: 503 },
      reason: "server-error",
    },
  ];
  for (const { name, req, first, reason } of retried) {
    it(`retries ${name} once and then succeeds`, async (t) => {
      useClock(t);
      const notices: RetryNotice[] = [];
      const { fetch, calls } = fakeFetch([first, { kind: "status", status: 200, body: "done" }]);
      const ctx = ctxWith(fetch, { onRetry: (n) => notices.push(n) });
      const res = okResponse(await drive(t, request(ctx, req)));
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "done");
      assert.equal(calls.length, 2);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.attempt, 2);
      assert.equal(notices[0]?.reason, reason);
    });
  }

  it("retries a safe request that timed out", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([{ kind: "hang" }, { kind: "status", status: 200 }]);
    const settled = await drive(t, request(ctxWith(fetch), GET), { stepMs: 250 });
    assert.equal(okResponse(settled).status, 200);
    assert.equal(calls.length, 2);
    assert.ok(calls[0]?.signal?.aborted, "the first attempt's signal was aborted");
  });

  it("does not retry a submit that got no response: network error or timeout", async (t) => {
    useClock(t);
    for (const first of [{ kind: "network" }, { kind: "hang" }] as const) {
      const { fetch, calls } = fakeFetch([first, { kind: "status", status: 200 }]);
      const settled = await drive(t, request(ctxWith(fetch), SUBMIT), { stepMs: 250 });
      assert.equal(settled.ok, false, first.kind);
      assert.ok(settled.error instanceof ExplorerVerifyError);
      assert.equal(settled.error.code, "network");
      assert.equal(calls.length, 1, `${first.kind}: not retried`);
    }
  });

  it("does not follow or retry a redirect, safe or submit (R-SEC-2)", async (t) => {
    useClock(t);
    for (const req of [GET, SUBMIT]) {
      const { fetch, calls } = fakeFetch([
        { kind: "status", status: 307, headers: { location: "https://elsewhere.test/x" } },
        { kind: "status", status: 200 },
      ]);
      const settled = await drive(t, request(ctxWith(fetch), req));
      assert.equal(settled.ok, false);
      assert.ok(settled.error instanceof ExplorerVerifyError);
      assert.equal(settled.error.code, "unexpected-response");
      assert.ok(!settled.error.message.includes("elsewhere"), "the Location header leaked");
      assert.equal(calls.length, 1);
    }
  });

  it("retries a 429 whose customCode is something else", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([
      {
        kind: "status",
        status: 429,
        body: '{"customCode":"too_many_requests"}',
        headers: { "content-type": "application/json" },
      },
      { kind: "status", status: 200 },
    ]);
    okResponse(await drive(t, request(ctxWith(fetch), GET)));
    assert.equal(calls.length, 2);
  });

  it("does not retry a 429 duplicate_verification_request, safe or submit", async (t) => {
    useClock(t);
    const body = '{"customCode":"duplicate_verification_request","message":"already running"}';
    for (const req of [GET, SUBMIT]) {
      const { fetch, calls } = fakeFetch([
        {
          kind: "status",
          status: 429,
          body,
          headers: { "content-type": "application/json" },
        },
        { kind: "status", status: 200 },
      ]);
      const res = okResponse(await drive(t, request(ctxWith(fetch), req)));
      assert.equal(res.status, 429);
      assert.equal(await res.text(), body, "the body is still readable");
      assert.equal(calls.length, 1);
    }
  });

  it("sends the same URL, method, body and headers on every attempt (R-SEC-2)", async (t) => {
    useClock(t);
    const form = new URLSearchParams({ module: "contract", action: "verify" });
    const req: HttpRequest = {
      url: PLAIN_URL,
      method: "POST",
      body: form,
      retry: "submit",
    };
    const { fetch, calls } = fakeFetch([
      { kind: "status", status: 503 },
      { kind: "status", status: 429 },
      { kind: "status", status: 200 },
    ]);
    okResponse(await drive(t, request(ctxWith(fetch), req)));
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.url, PLAIN_URL);
      assert.equal(call.method, "POST");
      assert.equal(String(call.body), form.toString());
    }
    for (const call of calls.slice(1)) assert.deepEqual(call.headers, calls[0]?.headers);
  });

  // One case per test: each drives about 15 s of mock time in 50 ms steps.
  for (const random of [0, 0.999_999]) {
    it(`waits a backoff with jitter: 1 s doubled per attempt, between half and all of each step (random ${String(random)})`, async (t) => {
      useClock(t);
      const notices: RetryNotice[] = [];
      const { fetch, calls } = fakeFetch([{ kind: "status", status: 503 }]);
      const ctx = ctxWith(fetch, {
        random: () => random,
        onRetry: (n) => notices.push(n),
      });
      await drive(t, request(ctx, GET), { stepMs: 50 });
      assert.equal(calls.length, MAX_ATTEMPTS);
      assert.deepEqual(
        notices.map((n) => n.attempt),
        [2, 3, 4, 5],
      );
      notices.forEach((n, i) => {
        const step = Math.min(BASE_DELAY_MS * 2 ** i, MAX_DELAY_MS);
        assert.ok(
          n.delayMs >= step / 2 && n.delayMs <= step,
          `random ${String(random)} retry ${String(i + 2)}: ${String(n.delayMs)} not in [${String(step / 2)}, ${String(step)}]`,
        );
        const gap = (calls[i + 1]?.at ?? 0) - (calls[i]?.at ?? 0);
        assert.ok(
          gap >= n.delayMs && gap < n.delayMs + 50,
          `gap ${String(gap)} vs wait ${String(n.delayMs)}`,
        );
      });
    });
  }

  it("does not send the next attempt before the wait ends", async (t) => {
    useClock(t);
    const notices: RetryNotice[] = [];
    const { fetch, calls } = fakeFetch([
      { kind: "status", status: 503 },
      { kind: "status", status: 200 },
    ]);
    const p = request(ctxWith(fetch, { onRetry: (n) => notices.push(n) }), GET);
    await flush();
    assert.equal(calls.length, 1);
    const wait = notices[0]?.delayMs ?? 0;
    assert.ok(wait > 0);
    t.mock.timers.tick(wait - 1);
    await flush();
    assert.equal(calls.length, 1, "no attempt before the wait ends");
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls.length, 2);
    assert.equal((await p).status, 200);
  });
});

// --- Retry-After --------------------------------------------------------------------------------

describe("blackbox #14: Retry-After (R-FLOW-6)", () => {
  it("waits at least Retry-After in seconds (2)", async (t) => {
    useClock(t);
    const notices: RetryNotice[] = [];
    const { fetch, calls } = fakeFetch([
      { kind: "status", status: 429, headers: { "retry-after": "2" } },
      { kind: "status", status: 200 },
    ]);
    const p = request(ctxWith(fetch, { onRetry: (n) => notices.push(n) }), GET);
    await flush();
    t.mock.timers.tick(1_999);
    await flush();
    assert.equal(calls.length, 1, "no retry before 2 s");
    const settled = await drive(t, p, { stepMs: 1 });
    okResponse(settled);
    assert.equal(calls.length, 2);
    assert.ok((notices[0]?.delayMs ?? 0) >= 2_000);
    assert.ok((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0) >= 2_000);
  });

  it("waits at least Retry-After given as an HTTP date", async (t) => {
    useClock(t);
    const notices: RetryNotice[] = [];
    const date = new Date(NOW + 5_000).toUTCString();
    const { fetch, calls } = fakeFetch([
      { kind: "status", status: 503, headers: { "retry-after": date } },
      { kind: "status", status: 200 },
    ]);
    const p = request(ctxWith(fetch, { onRetry: (n) => notices.push(n) }), GET);
    await flush();
    t.mock.timers.tick(4_999);
    await flush();
    assert.equal(calls.length, 1, "no retry before the date");
    okResponse(await drive(t, p, { stepMs: 1 }));
    assert.equal(calls.length, 2);
    assert.ok((notices[0]?.delayMs ?? 0) >= 5_000, `delay ${String(notices[0]?.delayMs)}`);
    assert.ok((notices[0]?.delayMs ?? 0) <= MAX_DELAY_MS);
  });

  it("ends the retries at once when Retry-After asks for more than 30 s", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([
      { kind: "status", status: 429, headers: { "retry-after": "31" } },
      { kind: "status", status: 200 },
    ]);
    const settled = await drive(t, request(ctxWith(fetch), GET));
    const d = rateLimitedOf(evError(settled));
    assert.equal(calls.length, 1);
    assert.equal(d.retryAfterMs, 31_000);
    assert.equal(d.attempts, 1);
    assert.ok(settled.elapsedMs < 1_000, "gave up without waiting");
  });

  it("ends the retries at once for a Retry-After date more than 30 s away", async (t) => {
    useClock(t);
    const date = new Date(NOW + 60_000).toUTCString();
    const { fetch, calls } = fakeFetch([
      { kind: "status", status: 429, headers: { "retry-after": date } },
    ]);
    const settled = await drive(t, request(ctxWith(fetch), GET));
    const d = rateLimitedOf(evError(settled));
    assert.equal(calls.length, 1);
    assert.equal(d.retryAfterMs, 60_000);
  });

  it("accepts Retry-After of exactly 30 s", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([
      { kind: "status", status: 429, headers: { "retry-after": "30" } },
      { kind: "status", status: 200 },
    ]);
    okResponse(await drive(t, request(ctxWith(fetch), GET), { stepMs: 500 }));
    assert.equal(calls.length, 2);
    assert.ok((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0) >= 30_000);
  });
});

describe("blackbox #14: edge cases (R-FLOW-6)", () => {
  for (const value of ["soon", "-1", "", "1.5e3", new Date(NOW - 60_000).toUTCString()]) {
    it(`falls back to the backoff for Retry-After ${JSON.stringify(value)}`, async (t) => {
      useClock(t);
      const notices: RetryNotice[] = [];
      const { fetch, calls } = fakeFetch([
        { kind: "status", status: 503, headers: { "retry-after": value } },
        { kind: "status", status: 200 },
      ]);
      const ctx = ctxWith(fetch, { onRetry: (n) => notices.push(n) });
      okResponse(await drive(t, request(ctx, GET), { stepMs: 10 }));
      assert.equal(calls.length, 2);
      const wait = notices[0]?.delayMs ?? -1;
      assert.ok(wait >= BASE_DELAY_MS / 2 && wait <= MAX_DELAY_MS, `wait ${String(wait)}`);
    });
  }

  it("times out an attempt whose body never ends, and does not retry it", async (t) => {
    useClock(t);
    let n = 0;
    const impl: typeof fetch = () => {
      n += 1;
      return Promise.resolve(n === 1 ? endlessBody() : new Response("full", { status: 200 }));
    };
    const settled = await drive(t, request(ctxWith(impl, { requestTimeoutMs: 2_000 }), GET), {
      stepMs: 10,
    });
    assert.equal(settled.ok, false);
    assert.ok(settled.error instanceof ExplorerVerifyError);
    assert.equal(settled.error.code, "unexpected-response");
    assert.equal(n, 1);
    assert.ok(settled.elapsedMs >= 2_000);
  });

  it("rejects with signal.reason when aborted while the body is read", async (t) => {
    useClock(t);
    const controller = new AbortController();
    const reason = new Error("stop-body");
    const tracker = track(request(ctxWith(endlessFetch, { signal: controller.signal }), GET));
    await flush();
    assert.equal(tracker.current(), undefined);
    controller.abort(reason);
    await flush();
    const settled = tracker.current();
    assert.ok(settled);
    assert.equal(settled.error, reason);
  });

  it("throws timeout without a request when the deadline has already passed", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([{ kind: "status", status: 200 }]);
    const budget = { deadline: NOW - 1, timeoutMs: 5_000 };
    const settled = await drive(t, request(ctxWith(fetch, { budget }), GET));
    assert.equal(timeoutOf(evError(settled)).timeoutMs, 5_000);
    assert.equal(calls.length, 0);
  });

  it("ends a safe 503 at once when its Retry-After is above 30 s", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([
      {
        kind: "status",
        status: 503,
        body: "maint",
        headers: { "retry-after": "3600" },
      },
    ]);
    const d = unexpectedOf(evError(await drive(t, request(ctxWith(fetch), GET))));
    assert.equal(d.status, 503);
    assert.equal(calls.length, 1);
  });
});

// --- giving up ----------------------------------------------------------------------------------

describe("blackbox #14: errors when giving up (R-FLOW-6)", () => {
  it("throws network with attempts 5 after five network errors", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([{ kind: "network" }]);
    const error = evError(await drive(t, request(ctxWith(fetch), GET)));
    const d = networkOf(error);
    assert.equal(d.attempts, MAX_ATTEMPTS);
    assert.equal(d.backend, "sourcify");
    assert.equal(error.retryable, true);
    assert.equal(calls.length, MAX_ATTEMPTS);
  });

  it("throws rate-limited with attempts 5 and retryAfterMs after five 429s", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([
      { kind: "status", status: 429, headers: { "retry-after": "1" } },
    ]);
    const error = evError(await drive(t, request(ctxWith(fetch), SUBMIT)));
    const d = rateLimitedOf(error);
    assert.equal(d.attempts, MAX_ATTEMPTS);
    assert.equal(d.retryAfterMs, 1_000);
    assert.equal(calls.length, MAX_ATTEMPTS);
  });

  it("throws rate-limited without retryAfterMs when no header was sent", async (t) => {
    useClock(t);
    const { fetch } = fakeFetch([{ kind: "status", status: 429 }]);
    const d = rateLimitedOf(evError(await drive(t, request(ctxWith(fetch), GET))));
    assert.equal(d.attempts, MAX_ATTEMPTS);
    assert.equal(d.retryAfterMs, undefined);
  });

  for (const status of [502, 503, 504]) {
    it(`throws unexpected-response with status and excerpt after five ${String(status)}s`, async (t) => {
      useClock(t);
      const body = `<html>${"x".repeat(1_000)}</html>`;
      const { fetch, calls } = fakeFetch([{ kind: "status", status, body }]);
      const error = evError(await drive(t, request(ctxWith(fetch), GET)));
      const d = unexpectedOf(error);
      assert.equal(d.status, status);
      assert.ok(d.excerpt.startsWith("<html>xxx"), d.excerpt.slice(0, 20));
      assert.ok(d.excerpt.length <= 300, `excerpt length ${String(d.excerpt.length)}`);
      assert.equal(calls.length, MAX_ATTEMPTS);
    });
  }

  it("throws unexpected-response 503 for submit after five 503s", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([{ kind: "status", status: 503, body: "down" }]);
    const d = unexpectedOf(evError(await drive(t, request(ctxWith(fetch), SUBMIT))));
    assert.equal(d.status, 503);
    assert.equal(d.excerpt, "down");
    assert.equal(calls.length, MAX_ATTEMPTS);
  });

  it("reports the last failure when the kinds change between attempts", async (t) => {
    useClock(t);
    const { fetch } = fakeFetch([
      { kind: "status", status: 503 },
      { kind: "status", status: 429 },
      { kind: "network" },
      { kind: "status", status: 503 },
      { kind: "status", status: 429, headers: { "retry-after": "1" } },
    ]);
    const d = rateLimitedOf(evError(await drive(t, request(ctxWith(fetch), GET))));
    assert.equal(d.attempts, MAX_ATTEMPTS);
  });

  it("times out one attempt after REQUEST_TIMEOUT_MS by default", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([{ kind: "hang" }, { kind: "status", status: 200 }]);
    const p = request(ctxWith(fetch), GET);
    await flush();
    t.mock.timers.tick(REQUEST_TIMEOUT_MS - 1);
    await flush();
    assert.equal(calls[0]?.signal?.aborted, false, "not aborted before 30 s");
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls[0]?.signal?.aborted, true, "aborted at 30 s");
    okResponse(await drive(t, p));
  });

  it("honours requestTimeoutMs, even when fetch ignores the signal", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([{ kind: "hang-deaf" }, { kind: "status", status: 200 }]);
    const p = request(ctxWith(fetch, { requestTimeoutMs: 5_000 }), GET);
    await flush();
    t.mock.timers.tick(4_999);
    await flush();
    assert.equal(calls.length, 1);
    const settled = await drive(t, p, { stepMs: 10 });
    okResponse(settled);
    assert.equal(calls.length, 2);
    assert.ok((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0) >= 5_000);
  });

  it("gives up with network and attempts 5 after five per-request timeouts", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([{ kind: "hang" }]);
    const settled = await drive(t, request(ctxWith(fetch, { requestTimeoutMs: 1_000 }), GET));
    const d = networkOf(evError(settled));
    assert.equal(d.attempts, MAX_ATTEMPTS);
    assert.equal(calls.length, MAX_ATTEMPTS);
  });

  it("throws timeout with the budget when the deadline passes during a request", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([{ kind: "hang" }]);
    const budget = { deadline: NOW + 10_000, timeoutMs: 10_000 };
    const settled = await drive(t, request(ctxWith(fetch, { budget }), GET), {
      stepMs: 10,
    });
    const d = timeoutOf(evError(settled));
    assert.equal(d.timeoutMs, 10_000);
    assert.equal(calls.length, 1);
    assert.ok(settled.elapsedMs >= 10_000 && settled.elapsedMs < 10_020, String(settled.elapsedMs));
  });

  it("ends with the last error when the wait would pass the deadline", async (t) => {
    useClock(t);
    const { fetch, calls } = fakeFetch([
      {
        kind: "status",
        status: 503,
        body: "busy",
        headers: { "retry-after": "2" },
      },
      { kind: "status", status: 200 },
    ]);
    const budget = { deadline: NOW + 1_500, timeoutMs: 1_500 };
    const settled = await drive(t, request(ctxWith(fetch, { budget }), GET));
    const d = unexpectedOf(evError(settled));
    assert.equal(d.status, 503);
    assert.equal(calls.length, 1);
    assert.ok(settled.elapsedMs < 1_500, "gave up without waiting");
  });
});

// --- abort --------------------------------------------------------------------------------------

describe("blackbox #14: abort rejects with signal.reason unchanged (R-FLOW-6, decision 0009)", () => {
  it("before the request: fetch is not called", async (t) => {
    useClock(t);
    const controller = new AbortController();
    const reason = new Error("stop-before");
    controller.abort(reason);
    const { fetch, calls } = fakeFetch([{ kind: "status", status: 200 }]);
    const settled = await drive(t, request(ctxWith(fetch, { signal: controller.signal }), GET));
    assert.equal(settled.ok, false);
    assert.equal(settled.error, reason);
    assert.equal(calls.length, 0);
  });

  it("during fetch, even when fetch ignores the signal", async (t) => {
    useClock(t);
    for (const kind of ["hang", "hang-deaf"] as const) {
      const controller = new AbortController();
      const reason = { custom: kind };
      const { fetch, calls } = fakeFetch([{ kind }]);
      const tracker = track(request(ctxWith(fetch, { signal: controller.signal }), GET));
      await flush();
      assert.equal(calls.length, 1);
      controller.abort(reason);
      await flush();
      const settled = tracker.current();
      assert.ok(settled, `${kind}: settled without advancing the clock`);
      assert.equal(settled.ok, false);
      assert.equal(settled.error, reason, `${kind}: the reason is unchanged`);
    }
  });

  it("during a backoff wait, within one tick", async (t) => {
    useClock(t);
    const controller = new AbortController();
    const reason = new DOMException("user cancelled", "AbortError");
    const { fetch, calls } = fakeFetch([{ kind: "status", status: 503 }]);
    const tracker = track(request(ctxWith(fetch, { signal: controller.signal }), GET));
    await flush();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(100);
    await flush();
    assert.equal(tracker.current(), undefined, "still waiting");
    controller.abort(reason);
    await flush();
    const settled = tracker.current();
    assert.ok(settled);
    assert.equal(settled.error, reason);
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(calls.length, 1, "no attempt after the abort");
  });

  it("with the default reason when abort() has no argument", async (t) => {
    useClock(t);
    const controller = new AbortController();
    const { fetch } = fakeFetch([{ kind: "network" }]);
    const p = request(ctxWith(fetch, { signal: controller.signal }), GET);
    await flush();
    controller.abort();
    const settled = await drive(t, p);
    assert.equal(settled.error, controller.signal.reason);
  });
});

describe("blackbox #14: sleep", () => {
  it("resolves after ms on the mock clock", async (t) => {
    useClock(t);
    let done = false;
    void sleep(1_000).then(() => (done = true));
    t.mock.timers.tick(999);
    await flush();
    assert.equal(done, false);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(done, true);
  });

  it("rejects with signal.reason before and during the wait", async (t) => {
    useClock(t);
    const before = new AbortController();
    const r1 = new Error("r1");
    before.abort(r1);
    await assert.rejects(sleep(1_000, before.signal), (e) => e === r1);

    const during = new AbortController();
    const r2 = { why: "r2" };
    const p = sleep(1_000, during.signal);
    t.mock.timers.tick(500);
    during.abort(r2);
    await assert.rejects(p, (e) => e === r2);
  });
});

// --- keys and logging ---------------------------------------------------------------------------

describe("blackbox #14: keys never leak (R-SEC-1, decision 0010)", () => {
  it("network failure whose message holds the URL", async (t) => {
    useClock(t);
    const { logger, lines } = captureLogger();
    const { fetch } = fakeFetch([
      { kind: "network", message: `connect ECONNREFUSED ${KEYED_URL}` },
    ]);
    const ctx = ctxWith(fetch, { logger, secrets: [KEY, SECRET] });
    const req: HttpRequest = { ...GET, url: KEYED_URL };
    const settled = await drive(t, request(ctx, req));
    networkOf(evError(settled));
    for (const s of surfaces(settled.error)) assertClean(s, "error");
    assert.ok(lines.length > 0, "retries are logged");
    for (const line of lines) assertClean(line.text, `log ${line.level}`);
    assert.ok(
      lines.some((l) => l.text.includes(BASE)),
      "log lines show the origin and path",
    );
    assert.ok(
      lines.some((l) => /\?REDACTED|\[redacted\]/.test(l.text)),
      "log lines mark the removed query",
    );
    assert.ok(
      lines.some((l) => l.level === "warn"),
      "a retry is logged at warn",
    );
    assert.equal(
      lines.filter((l) => l.level === "error").length,
      0,
      "a thrown failure is not logged at error",
    );
  });

  it("5xx excerpt that echoes the key and the URL", async (t) => {
    useClock(t);
    const { logger, lines } = captureLogger();
    const body = `{"error":"bad","apikey":"${KEY}","url":"${KEYED_URL}","echo":"${SECRET}"}`;
    const { fetch } = fakeFetch([{ kind: "status", status: 503, body }]);
    const ctx = ctxWith(fetch, { logger, secrets: [KEY, SECRET] });
    const settled = await drive(t, request(ctx, { ...SUBMIT, url: KEYED_URL }));
    const d = unexpectedOf(evError(settled));
    assertClean(d.excerpt, "excerpt");
    for (const s of surfaces(settled.error)) assertClean(s, "error");
    for (const line of lines) assertClean(line.text, `log ${line.level}`);
  });

  it("429, timeout and Retry-After paths", async (t) => {
    useClock(t);
    const { logger, lines } = captureLogger();
    const cases: { steps: Step[]; extra: Partial<HttpContext> }[] = [
      {
        steps: [{ kind: "status", status: 429, headers: { "retry-after": "99" } }],
        extra: {},
      },
      { steps: [{ kind: "status", status: 429 }], extra: {} },
      {
        steps: [{ kind: "hang" }],
        extra: { budget: { deadline: NOW + 2_000, timeoutMs: 2_000 } },
      },
    ];
    for (const { steps, extra } of cases) {
      const { fetch } = fakeFetch(steps);
      const ctx = ctxWith(fetch, { logger, secrets: [KEY, SECRET], ...extra });
      const settled = await drive(t, request(ctx, { ...GET, url: KEYED_URL }));
      for (const s of surfaces(settled.error)) assertClean(s, "error");
    }
    for (const line of lines) assertClean(line.text, `log ${line.level}`);
  });

  it("onRetry notices carry no URL or key", async (t) => {
    useClock(t);
    const notices: RetryNotice[] = [];
    const { fetch } = fakeFetch([{ kind: "network", message: KEYED_URL }]);
    const ctx = ctxWith(fetch, {
      secrets: [KEY, SECRET],
      onRetry: (n) => notices.push(n),
    });
    await drive(t, request(ctx, { ...GET, url: KEYED_URL }));
    assert.equal(notices.length, MAX_ATTEMPTS - 1);
    assertClean(JSON.stringify(notices), "onRetry");
  });

  it("writes nothing to the console when no logger is given (decision 0010)", async (t) => {
    useClock(t);
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((name) =>
      t.mock.method(console, name, () => {}),
    );
    const { fetch } = fakeFetch([{ kind: "network" }, { kind: "status", status: 503 }]);
    await drive(t, request(ctxWith(fetch), GET));
    const { fetch: f2 } = fakeFetch([
      { kind: "status", status: 429 },
      { kind: "status", status: 200 },
    ]);
    await drive(t, request(ctxWith(f2), SUBMIT));
    for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
  });
});
