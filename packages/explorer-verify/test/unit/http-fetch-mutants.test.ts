// Tests added after a mutation review of the HTTP layer (#109; R-FLOW-6): each one fails on a
// code change that the other HTTP tests let pass. The tests after the second mutation pass of
// #158 (R-FLOW-4, R-FLOW-6, R-SEC-1, R-DX-3) follow at the end.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";

import { ExplorerVerifyError } from "../../src/errors.ts";
import { request } from "../../src/http/fetch.ts";
import type { HttpContext, HttpRequest } from "../../src/http/fetch.ts";
import { contextWith } from "./http-context.ts";

const TARGET_URL =
  "https://sourcify.dev/server/v2/contract/11155111/0x5fbdb2315678afecb367f032d93f642f64180aa3";
const GET: HttpRequest = { url: TARGET_URL, method: "GET", retry: "safe" };

function context(fetch: typeof globalThis.fetch, signal?: AbortSignal): HttpContext {
  const base: HttpContext = { backend: "sourcify", secrets: [], random: () => 0 };
  return contextWith(base, signal === undefined ? { fetch } : { fetch, signal });
}

/** Runs `promise` on mock timers until it settles, and returns what it threw. */
async function errorOf(t: TestContext, promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const state = { done: false };
  const tracked = promise
    .then(
      (value: unknown): unknown => ({ resolved: value }),
      (error: unknown): unknown => error,
    )
    .finally(() => {
      state.done = true;
    });
  for (let round = 0; round < 1_000 && !state.done; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (!state.done) {
      t.mock.timers.runAll();
    }
  }
  assert.ok(state.done, "the request did not settle");
  const outcome = await tracked;
  assert.ok(outcome instanceof ExplorerVerifyError, `expected an error, got ${String(outcome)}`);
  return outcome;
}

describe("request: a 429 body that is JSON but not an object (R-FLOW-6)", () => {
  for (const body of ["null", "5", '"slow down"']) {
    it(`retries a 429 with the body ${body} as rate-limited, never as a network failure`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      let calls = 0;
      const fetch: typeof globalThis.fetch = async () => {
        calls += 1;
        return new Response(body, { status: 429 });
      };
      const error = await errorOf(t, request(context(fetch), GET));
      assert.deepEqual(error.details, {
        code: "rate-limited",
        backend: "sourcify",
        attempts: calls,
      });
      assert.ok(calls > 1);
    });
  }
});

describe("request: a status above 599 (R-FLOW-6)", () => {
  it("throws unexpected-response at once and never retries it as a network failure", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      const response = new Response("odd", { status: 200 });
      Object.defineProperty(response, "status", { value: 600 });
      return response;
    };
    const error = await errorOf(t, request(context(fetch), GET));
    assert.deepEqual(error.details, {
      code: "unexpected-response",
      backend: "sourcify",
      status: 600,
      excerpt: "odd",
    });
    assert.match(error.message, /returned a response that cannot be read \(status 600\)/);
    assert.equal(calls, 1);
  });
});

describe("request: an abort after the request ended (R-FLOW-6)", () => {
  it("does not reach the ended request, even when the signal cannot remove its listener", async () => {
    const controller = new AbortController();
    const { signal } = controller;
    // A signal that keeps every listener, so only the settled flag stops a late abort.
    signal.removeEventListener = () => undefined;
    const seen: AbortSignal[] = [];
    const fetch: typeof globalThis.fetch = async (_request, init) => {
      if (init?.signal !== undefined && init.signal !== null) {
        seen.push(init.signal);
      }
      return new Response("{}", { status: 200 });
    };
    const response = await request(context(fetch, signal), GET);
    assert.equal(response.status, 200);
    controller.abort(new Error("stopped by the caller"));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.aborted, false);
  });
});

// --- Added after the second mutation pass (#158) -------------------------------------------------

/** Runs `promise` on mock timers until it settles, and returns what it resolved to. */
async function valueOf<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  const state = { done: false };
  const tracked = promise.finally(() => {
    state.done = true;
  });
  // The rejection is read by the await below; this keeps it from counting as unhandled meanwhile.
  tracked.catch(() => undefined);
  for (let round = 0; round < 1_000 && !state.done; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (!state.done) {
      t.mock.timers.runAll();
    }
  }
  return await tracked;
}

/** A fetch whose request never answers, and rejects when its signal aborts. */
const hanging: typeof globalThis.fetch = async (_request, init) =>
  await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new Error("aborted"));
    });
  });

/** A fetch that answers with a redirect to another host. */
const redirecting: typeof globalThis.fetch = async () =>
  new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } });

/** A fetch whose answer declares a body of 5000 bytes. */
const declaringLarge: typeof globalThis.fetch = async () =>
  new Response("small", { status: 200, headers: { "content-length": "5000" } });

describe("request: errors without a cause or an excerpt (R-FLOW-4, R-DX-3)", () => {
  it("throws a redirect with an empty excerpt and no cause", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const error = await errorOf(t, request(context(redirecting), GET));
    assert.deepEqual(error.details, {
      code: "unexpected-response",
      backend: "sourcify",
      status: 302,
      excerpt: "",
    });
    assert.equal(Object.hasOwn(error, "cause"), false);
  });

  it("throws a body declared larger than the limit with an empty excerpt", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const error = await errorOf(
      t,
      request(contextWith(context(declaringLarge), { maxResponseBytes: 100 }), GET),
    );
    assert.deepEqual(error.details, {
      code: "unexpected-response",
      backend: "sourcify",
      status: 200,
      excerpt: "",
    });
    assert.match(error.message, /sent a body larger than 100 bytes/);
  });
});

describe("request: the limits of the context (R-FLOW-6, R-SEC-1)", () => {
  it("accepts maxAttempts of 5 and sends 5 requests", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response("busy", { status: 503 });
    };
    const error = await errorOf(t, request(contextWith(context(fetch), { maxAttempts: 5 }), GET));
    assert.equal(error.code, "unexpected-response");
    assert.equal(calls, 5);
  });

  it("names every bad limit in one error, and says what maxAttempts must be", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const ctx = contextWith(context(hanging), {
      requestTimeoutMs: 0,
      maxResponseBytes: -1,
      maxAttempts: 6,
    });
    const error = await errorOf(t, request(ctx, GET));
    assert.equal(
      error.message,
      "The HTTP limits are invalid: requestTimeoutMs, maxResponseBytes, maxAttempts.",
    );
    assert.deepEqual(error.details.code === "invalid-input" && error.details.issues.at(-1), {
      field: "maxAttempts",
      message: "must be an integer from 1 to 5",
    });
  });

  it("removes the call's secrets from the error", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    // The secret is the name of the bad limit, so it reaches the message: it is removed from the
    // message only if the error gets the call's secrets.
    const ctx = contextWith(context(hanging), { maxAttempts: 0, secrets: ["maxAttempts"] });
    const error = await errorOf(t, request(ctx, GET));
    assert.equal(error.message, "The HTTP limits are invalid: [redacted].");
  });
});

/** A fetch whose request never answers and ignores its signal. */
const deaf: typeof globalThis.fetch = async () =>
  await new Promise<Response>(() => {
    // Never settles.
  });

describe("request: a per-request timeout (R-FLOW-6)", () => {
  it("removes its listener from the caller's signal when a request times out and never ends", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls += 1;
      return calls === 1 ? await deaf(input, init) : new Response("{}", { status: 200 });
    };
    const { signal } = new AbortController();
    const ctx = contextWith(context(fetch, signal), { requestTimeoutMs: 1_000 });
    const response = await valueOf(t, request(ctx, GET));
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.equal(getEventListeners(signal, "abort").length, 0);
  });

  it("retries a request that times out long before the budget ends", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls += 1;
      return calls === 1 ? await hanging(input, init) : new Response("{}", { status: 200 });
    };
    const ctx = contextWith(context(fetch), {
      requestTimeoutMs: 1_000,
      budget: { deadline: 600_000, timeoutMs: 600_000 },
    });
    const response = await valueOf(t, request(ctx, GET));
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  });

  it("gives up as network when every attempt times out before its headers", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const ctx = contextWith(context(hanging), { requestTimeoutMs: 1_000, maxAttempts: 2 });
    const error = await errorOf(t, request(ctx, GET));
    assert.deepEqual(error.details, { code: "network", backend: "sourcify", attempts: 2 });
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.name, "TimeoutError");
  });
});

describe("request: the body and its headers (R-FLOW-6)", () => {
  it("decodes a UTF-8 character split across two chunks", async () => {
    const bytes = new TextEncoder().encode('{"name":"Grüße"}');
    const split = bytes.indexOf(0xc3) + 1;
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, split));
            controller.enqueue(bytes.slice(split));
            controller.close();
          },
        }),
        { status: 200 },
      );
    const response = await request(context(fetch), GET);
    assert.equal(await response.text(), '{"name":"Grüße"}');
  });

  it("reads a Retry-After value with spaces around it from a fetch that keeps them", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const lines: string[] = [];
    const at = (message: string): void => {
      lines.push(message);
    };
    const logger = { debug: at, info: at, warn: at, error: at };
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      if (calls > 1) {
        return new Response("{}", { status: 200 });
      }
      const response = new Response("slow down", { status: 429 });
      // A fetch whose headers keep the spaces of the raw header line.
      const raw = new Map([["retry-after", " 7 "]]);
      Object.defineProperty(response, "headers", {
        value: { get: (name: string) => raw.get(name) ?? null },
      });
      return response;
    };
    const response = await valueOf(t, request(contextWith(context(fetch), { logger }), GET));
    assert.equal(response.status, 200);
    assert.ok(
      lines.some((line) => line.includes("answered 429; retrying in 7000 ms")),
      lines.join("\n"),
    );
  });
});
