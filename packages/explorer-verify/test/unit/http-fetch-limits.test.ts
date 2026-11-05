// Redirects, body limits, timer bounds and abort checks of the HTTP layer (R-SEC-2, R-FLOW-6).
// Every test injects a fake fetch; the tests against real local servers are in
// http-fetch-servers.test.ts. Timers and methods are mocked through the test's own `t.mock`, so
// nothing outlives a test, and each test has a 20 s limit so a stuck mock timer fails before the
// runner's 30 s default.
import assert from "node:assert/strict";
import { describe, it as baseIt } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";
import { inspect } from "node:util";

import { ExplorerVerifyError } from "../../src/errors.ts";
import {
  MAX_RESPONSE_BYTES,
  MAX_RETRY_AFTER_MS,
  MAX_TIMER_MS,
  platformFetch,
  REQUEST_TIMEOUT_MS,
  request,
  sleep,
} from "../../src/http/fetch.ts";
import type { HttpContext, HttpRequest } from "../../src/http/fetch.ts";
import { redact } from "../../src/redact.ts";
import type { VerifyEvent } from "../../src/types.ts";
import { contextWith } from "./http-context.ts";
import type { ContextOverrides } from "./http-context.ts";

// Fake keys. Never real ones (R-SEC-1).
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const MiB = 1024 * 1024;

/** `it` with a 20 s limit per test. */
function it(name: string, fn: (t: TestContext) => Promise<void> | void): void {
  void baseIt(name, { timeout: 20_000 }, fn);
}

/** An `onEvent` callback and a promise that resolves on the first `verify.retry` event. */
function retried(): { onEvent: (event: VerifyEvent) => void; first: Promise<void> } {
  let resolve: (() => void) | undefined;
  const first = new Promise<void>((done) => {
    resolve = done;
  });
  return { onEvent: (event) => (event.type === "verify.retry" ? resolve?.() : undefined), first };
}

function context(overrides: ContextOverrides = {}): HttpContext {
  return contextWith({ backend: "sourcify", secrets: [DUMMY_KEY], random: () => 0 }, overrides);
}

function get(url = "https://api.example.org/v2/contract/1/0x01"): HttpRequest {
  return { url, method: "GET", retry: "safe" };
}

/** A fetch that answers every call with `make()`, and counts the calls. */
function answering(make: () => Response): { fetch: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const fake = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(init ?? {});
    return Promise.resolve(make());
  };
  return { fetch: fake, calls };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("the promise resolved");
}

async function explorerError(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const error = await rejection(promise);
  assert.ok(error instanceof ExplorerVerifyError, String(error));
  return error;
}

/** Every surface of an error as text, to check that a value never appears in it. */
function surfaces(error: ExplorerVerifyError): string {
  return [
    error.message,
    error.hint,
    JSON.stringify(error),
    JSON.stringify(error.details),
    String(error),
    error.stack ?? "",
    inspect(error, { depth: Infinity, showHidden: true }),
  ].join("\n");
}

/** A response whose body is `total` bytes in 1 MiB chunks, made only when read. */
function streamed(
  total: number,
  status = 200,
  headers: Record<string, string> = {},
): { response: Response; pulled: () => number; cancelled: () => boolean } {
  let sent = 0;
  let cancelled = false;
  const chunk = new Uint8Array(MiB).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(MiB, total - sent);
      sent += size;
      controller.enqueue(size === MiB ? chunk : chunk.subarray(0, size));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream, { status, headers }),
    pulled: () => sent,
    cancelled: () => cancelled,
  };
}

/** A Response whose read-only fields report what a redirecting fetch would. */
class FakeResponse extends Response {
  readonly #fields: { url?: string; redirected?: boolean; type?: ResponseType };

  constructor(
    body: string,
    init: ResponseInit,
    fields: { url?: string; redirected?: boolean; type?: ResponseType },
  ) {
    super(body, init);
    this.#fields = fields;
  }

  override get url(): string {
    return this.#fields.url ?? "";
  }

  override get redirected(): boolean {
    return this.#fields.redirected ?? false;
  }

  override get type(): ResponseType {
    return this.#fields.type ?? "default";
  }
}

describe("request: redirects are never followed (R-SEC-2)", () => {
  it("asks fetch not to follow redirects", async () => {
    const { fetch, calls } = answering(() => new Response("{}"));
    await request(context({ fetch }), get());
    assert.equal(calls[0]?.redirect, "manual");
  });

  const cases: [string, () => Response][] = [
    ["an opaque redirect", () => new FakeResponse("", { status: 200 }, { type: "opaqueredirect" })],
    [
      "a response that says it was redirected",
      () => new FakeResponse("{}", { status: 200 }, { redirected: true }),
    ],
    [
      "a response that says it was redirected, from another origin",
      () =>
        new FakeResponse(
          "{}",
          { status: 200 },
          { redirected: true, url: "https://handler.example/api/verify" },
        ),
    ],
    ["a 304", () => new Response(null, { status: 304 })],
  ];
  for (const [name, make] of cases) {
    it(`rejects ${name} from a fetch that ignores redirect: "manual", without a retry (R-SEC-2)`, async () => {
      const { fetch, calls } = answering(make);
      const error = await explorerError(request(context({ fetch }), get()));
      assert.equal(error.code, "unexpected-response");
      assert.match(error.message, /redirect/);
      assert.equal(calls.length, 1);
    });
  }

  it("accepts a response whose URL has the request's origin", async () => {
    const { fetch } = answering(
      () => new FakeResponse('{"ok":1}', { status: 200 }, { url: "https://api.example.org/other" }),
    );
    const response = await request(context({ fetch }), get());
    assert.deepEqual(await response.json(), { ok: 1 });
  });

  // Decision 0035: an injected fetch may send the request to another URL on purpose, such as a
  // server handler on the page's origin, so the URL of its answer is not checked.
  for (const url of ["https://dapp.example/api/verify", "not a url"]) {
    it(`accepts an answer from ${url} through an injected fetch (decision 0035)`, async () => {
      const { fetch, calls } = answering(
        () => new FakeResponse('{"ok":1}', { status: 200 }, { url }),
      );
      const response = await request(context({ fetch }), get());
      assert.deepEqual(await response.json(), { ok: 1 });
      assert.equal(calls.length, 1);
    });
  }

  // Without an injected fetch, the platform's fetch sends to the request URL and nowhere else, so
  // an answer from another origin, or from a URL that does not parse, is a followed redirect.
  const platformCases: [string, string][] = [
    ["another origin", "https://evil.example/x"],
    ["a URL that does not parse", "not a url"],
  ];
  for (const [name, url] of platformCases) {
    it(`rejects an answer from ${name} through the default fetch, without a retry (R-SEC-2)`, async (t) => {
      const { fetch, calls } = answering(() => new FakeResponse("{}", { status: 200 }, { url }));
      t.mock.method(globalThis, "fetch", fetch);
      const error = await explorerError(request(context(), get()));
      assert.equal(error.code, "unexpected-response");
      assert.match(error.message, /redirect/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.redirect, "manual");
    });
  }

  it("checks the origin when the caller passes platformFetch as its default (decision 0035)", async (t) => {
    const { fetch, calls } = answering(
      () => new FakeResponse("{}", { status: 200 }, { url: "https://evil.example/x" }),
    );
    t.mock.method(globalThis, "fetch", fetch);
    const error = await explorerError(request(context({ fetch: platformFetch }), get()));
    assert.equal(error.code, "unexpected-response");
    assert.equal(calls.length, 1);
  });

  it("accepts an answer with the request's origin, or with no URL, through the default fetch", async (t) => {
    const urls = ["https://api.example.org/other", ""];
    const { fetch } = answering(
      () => new FakeResponse('{"ok":1}', { status: 200 }, { url: urls.shift() ?? "" }),
    );
    t.mock.method(globalThis, "fetch", fetch);
    for (let i = 0; i < 2; i += 1) {
      const response = await request(context(), get());
      assert.deepEqual(await response.json(), { ok: 1 });
    }
  });
});

describe("request: response body limit (R-FLOW-6)", () => {
  it(`stops reading a 200 MB body at the ${String(MAX_RESPONSE_BYTES / MiB)} MiB limit and cancels it`, async () => {
    const body = streamed(200 * MiB);
    const { fetch, calls } = answering(() => body.response);
    const error = await explorerError(request(context({ fetch }), get()));
    assert.deepEqual(error.details, {
      code: "unexpected-response",
      backend: "sourcify",
      status: 200,
      excerpt: "",
    });
    assert.match(error.message, /larger than 16777216 bytes/);
    assert.ok(body.pulled() <= MAX_RESPONSE_BYTES + 2 * MiB, `read ${String(body.pulled())} bytes`);
    assert.ok(body.cancelled());
    assert.equal(calls.length, 1);
  });

  it("reads a body of exactly the limit", async () => {
    const body = streamed(2 * MiB);
    const { fetch } = answering(() => body.response);
    const response = await request(context({ fetch, maxResponseBytes: 2 * MiB }), get());
    assert.equal((await response.text()).length, 2 * MiB);
  });

  it("does not retry an oversized 502, even on retry safe", async () => {
    const { fetch, calls } = answering(() => streamed(64 * MiB, 502).response);
    const error = await explorerError(request(context({ fetch, maxResponseBytes: MiB }), get()));
    assert.ok(error.details.code === "unexpected-response");
    assert.equal(error.details.status, 502);
    assert.equal(calls.length, 1);
  });

  it("fails before reading when content-length is above the limit", async () => {
    let read = false;
    // highWaterMark 0: the stream pulls only when read.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          read = true;
          throw new Error("must not be read");
        },
      },
      { highWaterMark: 0 },
    );
    const { fetch } = answering(
      () => new Response(stream, { status: 200, headers: { "content-length": String(MiB + 1) } }),
    );
    const error = await explorerError(request(context({ fetch, maxResponseBytes: MiB }), get()));
    assert.match(error.message, /larger than 1048576 bytes/);
    assert.equal(read, false);
  });

  it("is unexpected-response, not network, and is not retried when the body fails after the headers", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError(`terminated ${DUMMY_KEY}`));
      },
    });
    const { fetch, calls } = answering(() => new Response(stream, { status: 200 }));
    const error = await explorerError(request(context({ fetch }), get()));
    assert.equal(error.code, "unexpected-response");
    assert.match(error.message, /could not be read/);
    assert.ok(error.cause instanceof Error);
    assert.equal(calls.length, 1);
    assert.ok(!surfaces(error).includes(DUMMY_KEY));
  });

  it("removes content-encoding, content-length and transfer-encoding from the returned response", async () => {
    const { fetch } = answering(
      () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-encoding": "gzip",
            "content-length": "2",
            "transfer-encoding": "chunked",
            "x-id": "7",
          },
        }),
    );
    const response = await request(context({ fetch }), get());
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("transfer-encoding"), null);
    assert.equal(response.headers.get("x-id"), "7");
    assert.equal(await response.text(), "{}");
  });
});

describe("request: Retry-After bounds (R-FLOW-6)", () => {
  it(`reports a very large Retry-After as ${String(MAX_RETRY_AFTER_MS)} ms`, async () => {
    const { fetch } = answering(
      () => new Response("{}", { status: 429, headers: { "retry-after": "9".repeat(30) } }),
    );
    const error = await explorerError(request(context({ fetch }), get()));
    assert.ok(error.details.code === "rate-limited");
    assert.equal(error.details.retryAfterMs, MAX_RETRY_AFTER_MS);
  });

  it("ignores a Retry-After too large to be a finite number", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const replies = [
      new Response("{}", { status: 429, headers: { "retry-after": "9".repeat(400) } }),
      new Response("{}", { status: 200 }),
    ];
    const { fetch, calls } = answering(
      () => replies[Math.min(calls.length - 1, 1)] ?? new Response(),
    );
    const retry = retried();
    const pending = request(context({ fetch, onEvent: retry.onEvent }), get());
    await retry.first;
    // The backoff with random 0: Retry-After was ignored.
    t.mock.timers.tick(500);
    assert.equal((await pending).status, 200);
    assert.equal(calls.length, 2);
  });

  it("keeps retryAfterMs on the unexpected-response after a 503 with Retry-After", async () => {
    const { fetch, calls } = answering(
      () => new Response("down", { status: 503, headers: { "retry-after": "60" } }),
    );
    const error = await explorerError(request(context({ fetch }), get()));
    assert.deepEqual(error.details, {
      code: "unexpected-response",
      backend: "sourcify",
      status: 503,
      excerpt: "down",
      retryAfterMs: 60_000,
    });
    assert.equal(calls.length, 1);
  });
});

/** Records the delay of every `setTimeout` call and never runs the callback. */
function recordTimers(t: TestContext): number[] {
  const delays: number[] = [];
  t.mock.method(globalThis, "setTimeout", (_callback: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return 0;
  });
  t.mock.method(globalThis, "clearTimeout", () => {});
  return delays;
}

describe("timers stay within setTimeout's range (R-FLOW-6)", () => {
  for (const ms of [2 ** 31, 3e9, Infinity]) {
    it(`clamps sleep(${String(ms)}) to ${String(MAX_TIMER_MS)} ms`, (t) => {
      const delays = recordTimers(t);
      void sleep(ms);
      assert.deepEqual(delays, [MAX_TIMER_MS]);
    });
  }

  for (const requestTimeoutMs of [2 ** 31, 3e9]) {
    it(`clamps a per-request timeout of ${String(requestTimeoutMs)} ms`, async (t) => {
      const delays = recordTimers(t);
      const { fetch } = answering(() => new Response("{}"));
      await request(context({ fetch, requestTimeoutMs }), get());
      assert.deepEqual(delays, [MAX_TIMER_MS]);
    });
  }

  it("clamps the time left in a far-away budget", async (t) => {
    const delays = recordTimers(t);
    const { fetch } = answering(() => new Response("{}"));
    await request(
      context({
        fetch,
        requestTimeoutMs: 1e13,
        budget: { deadline: Date.now() + 1e12, timeoutMs: 1e12 },
      }),
      get(),
    );
    assert.deepEqual(delays, [MAX_TIMER_MS]);
  });

  for (const value of [Infinity, Number.NaN, 0, -1]) {
    it(`rejects requestTimeoutMs ${String(value)} as invalid-input, before any request`, async () => {
      const { fetch, calls } = answering(() => new Response("{}"));
      const error = await explorerError(
        request(context({ fetch, requestTimeoutMs: value }), get()),
      );
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [{ field: "requestTimeoutMs", message: "must be a positive finite number" }],
      });
      assert.equal(calls.length, 0);
    });
  }

  it("rejects maxResponseBytes 0 as invalid-input", async () => {
    const error = await explorerError(request(context({ maxResponseBytes: 0 }), get()));
    assert.ok(error.details.code === "invalid-input");
    assert.equal(error.details.issues[0]?.field, "maxResponseBytes");
  });

  it(`keeps the default per-request timeout of ${String(REQUEST_TIMEOUT_MS)} ms`, async (t) => {
    const delays = recordTimers(t);
    const { fetch } = answering(() => new Response("{}"));
    await request(context({ fetch }), get());
    assert.deepEqual(delays, [REQUEST_TIMEOUT_MS]);
  });
});

describe("request: abort between attempts (R-FLOW-6)", () => {
  it("does not start an attempt after the logger aborted the signal (R-FLOW-6)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const controller = new AbortController();
    const reason = new Error("stop");
    let calls = 0;
    const fetch = (): Promise<Response> => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(new Response("x", { status: 503 }))
        : new Promise(() => {});
    };
    const logger = {
      debug: (message: string): void => {
        if (message.includes("attempt 2")) {
          controller.abort(reason);
        }
      },
      info: (): void => {},
      warn: (): void => {},
      error: (): void => {},
    };
    const retry = retried();
    const pending = rejection(
      request(context({ fetch, logger, signal: controller.signal, onEvent: retry.onEvent }), get()),
    );
    await retry.first;
    t.mock.timers.tick(500);
    assert.equal(await pending, reason);
    assert.equal(calls, 1);
  });
});

describe("redact: URL-parser encodings of a known key (R-SEC-1)", () => {
  const key = "s3cr3t-Key_val.ue~x y'z";

  it("redacts the key as the WHATWG URL parser encodes it in a query and in a path", () => {
    const query = new URL(`http://h/?q=${key}`).search.slice(3);
    const path = new URL(`http://h/${key}`).pathname.slice(1);
    assert.equal(redact(`echo q=${query} p=/${path}/`, [key]), "echo q=[redacted] p=/[redacted]/");
  });

  it("redacts the parsed forms in an explorer's echoed answer, inside an error excerpt", async () => {
    const query = new URL(`http://h/?q=${key}`).search.slice(3);
    // Retry-After above 30 s ends the retries at once, with no wait and no real-time budget.
    const { fetch } = answering(
      () =>
        new Response(`bad request q=${query}`, { status: 503, headers: { "retry-after": "60" } }),
    );
    const error = await explorerError(
      request({ backend: "sourcify", secrets: [key], random: () => 0, fetch }, get()),
    );
    assert.ok(error.details.code === "unexpected-response");
    assert.equal(error.details.excerpt, "bad request q=[redacted]");
  });

  it("drops a parsed form that a # or ? cut short, so it never matches unrelated text", () => {
    assert.equal(redact("a cat sat", ["a#bcdefghijk"]), "a cat sat");
    assert.equal(redact("a cat sat", ["a?bcdefghijk"]), "a cat sat");
  });
});

describe("request: limit boundaries (R-SEC-2, R-FLOW-6)", () => {
  for (const status of [300, 399]) {
    it(`treats ${String(status)} as a redirect (R-SEC-2)`, async () => {
      const { fetch, calls } = answering(() => new Response("x", { status }));
      const error = await explorerError(request(context({ fetch }), get()));
      assert.ok(error.details.code === "unexpected-response");
      assert.equal(error.details.status, status);
      assert.match(error.message, /redirect/);
      assert.equal(calls.length, 1);
    });
  }

  it("rejects a streamed body one byte over the limit", async () => {
    const body = streamed(MiB + 1);
    const { fetch } = answering(() => body.response);
    const error = await explorerError(request(context({ fetch, maxResponseBytes: MiB }), get()));
    assert.match(error.message, /larger than 1048576 bytes/);
  });

  it("reads a body whose content-length equals the limit", async () => {
    const body = streamed(MiB, 200, { "content-length": String(MiB) });
    const { fetch } = answering(() => body.response);
    const response = await request(context({ fetch, maxResponseBytes: MiB }), get());
    assert.equal((await response.text()).length, MiB);
  });

  it("cancels the body of a redirect", async () => {
    const body = streamed(10, 302);
    const { fetch } = answering(() => body.response);
    await explorerError(request(context({ fetch }), get()));
    assert.ok(body.cancelled());
  });

  it("cancels a body whose content-length is above the limit", async () => {
    const body = streamed(10, 200, { "content-length": String(MiB + 1) });
    const { fetch } = answering(() => body.response);
    await explorerError(request(context({ fetch, maxResponseBytes: MiB }), get()));
    assert.ok(body.cancelled());
  });

  it("redacts the form of a key that only the URL path encoding produces (R-SEC-1)", () => {
    const key = "s3cr3t{Key[val";
    const path = new URL(`http://h/${key}`).pathname.slice(1);
    assert.equal(path, "s3cr3t%7BKey[val");
    assert.equal(redact(`p=/${path}/`, [key]), "p=/[redacted]/");
  });

  it("pins the limits: one hour of Retry-After, 2147483647 ms timers, 16 MiB bodies", () => {
    assert.equal(MAX_RETRY_AFTER_MS, 3_600_000);
    assert.equal(MAX_TIMER_MS, 2_147_483_647);
    assert.equal(MAX_RESPONSE_BYTES, 16 * MiB);
  });

  it("reports the clamped per-request timeout in the timeout cause", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    let signal: AbortSignal | undefined;
    const fetch = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    };
    // A submit is not retried after a timeout, so the call ends with this one attempt.
    const req: HttpRequest = { ...get(), method: "POST", retry: "submit" };
    const pending = rejection(request(context({ fetch, requestTimeoutMs: 2 ** 31 }), req));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    t.mock.timers.tick(MAX_TIMER_MS);
    const reason: unknown = signal?.reason;
    assert.ok(reason instanceof Error);
    assert.match(reason.message, /longer than 2147483647 ms/);
    const error = await pending;
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(error.code, "network");
  });

  it("rejects with the reason of an aborted signal before it checks the limits (R-FLOW-6)", async () => {
    const reason = new Error("stopped");
    const error = await rejection(
      request(context({ signal: AbortSignal.abort(reason), requestTimeoutMs: 0 }), get()),
    );
    assert.equal(error, reason);
  });

  it("decodes a UTF-8 sequence cut at the end of the body as U+FFFD", async () => {
    const { fetch } = answering(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([0x61, 0xe2, 0x82]));
              controller.close();
            },
          }),
        ),
    );
    const response = await request(context({ fetch }), get());
    assert.equal(await response.text(), "a�");
  });
});
