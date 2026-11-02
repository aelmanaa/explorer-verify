// Redirects, body limits, timer bounds and abort checks of the HTTP layer (R-SEC-2, R-FLOW-6).
// The redirect and gzip tests run two HTTP servers on 127.0.0.1 and use the real fetch; every
// other test injects a fake fetch.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, mock } from "node:test";
import { setImmediate } from "node:timers";
import { inspect } from "node:util";
import { gzipSync } from "node:zlib";

import { ExplorerVerifyError } from "../../src/errors.ts";
import {
  MAX_RESPONSE_BYTES,
  MAX_RETRY_AFTER_MS,
  MAX_TIMER_MS,
  REQUEST_TIMEOUT_MS,
  request,
  sleep,
} from "../../src/http/fetch.ts";
import type { HttpContext, HttpRequest } from "../../src/http/fetch.ts";
import { redact } from "../../src/redact.ts";

// Fake keys. Never real ones (R-SEC-1).
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const MiB = 1024 * 1024;

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

function context(overrides: Partial<HttpContext> = {}): HttpContext {
  return { backend: "sourcify", secrets: [DUMMY_KEY], random: () => 0, ...overrides };
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

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const { port } = address satisfies AddressInfo;
  return { server, origin: `http://127.0.0.1:${String(port)}` };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

describe("request: redirects are never followed (R-SEC-2)", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    for (const retry of ["safe", "submit"] as const) {
      it(`does not follow a ${String(status)} to another server, on retry ${retry} (R-SEC-2)`, async () => {
        let elsewhere = 0;
        const other = await listen((req, res) => {
          elsewhere += 1;
          req.resume();
          res.end("{}");
        });
        let hits = 0;
        const api = await listen((req, res) => {
          hits += 1;
          req.resume();
          res.writeHead(status, { location: `${other.origin}/steal?apikey=${DUMMY_KEY}` });
          res.end();
        });
        try {
          const req: HttpRequest = {
            url: `${api.origin}/v2/api?apikey=${DUMMY_KEY}`,
            method: retry === "submit" ? "POST" : "GET",
            retry,
          };
          const error = await explorerError(
            request({ backend: "sourcify", secrets: [DUMMY_KEY] }, req),
          );
          assert.equal(error.code, "unexpected-response");
          assert.match(error.message, /redirect, which is not followed/);
          assert.equal(hits, 1);
          assert.equal(elsewhere, 0);
          const text = surfaces(error);
          assert.ok(!text.includes(DUMMY_KEY));
          assert.ok(!text.includes("/steal"), "the Location header leaked");
        } finally {
          await close(api.server);
          await close(other.server);
        }
      });
    }
  }

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
      "a response from another origin",
      () => new FakeResponse("{}", { status: 200 }, { url: "https://evil.example/x" }),
    ],
    [
      "a response with a URL that does not parse",
      () => new FakeResponse("{}", { status: 200 }, { url: "not a url" }),
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

  it("stops a gzip body whose decoded size is above the limit (R-FLOW-6)", async () => {
    const packed = gzipSync(new Uint8Array(8 * MiB));
    const api = await listen((req, res) => {
      req.resume();
      res.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": String(packed.length),
      });
      res.end(packed);
    });
    try {
      const error = await explorerError(
        request({ backend: "sourcify", secrets: [], maxResponseBytes: MiB }, get(`${api.origin}/`)),
      );
      assert.match(error.message, /larger than 1048576 bytes/);
    } finally {
      await close(api.server);
    }
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

  it("ignores a Retry-After too large to be a finite number", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const replies = [
      new Response("{}", { status: 429, headers: { "retry-after": "9".repeat(400) } }),
      new Response("{}", { status: 200 }),
    ];
    const { fetch, calls } = answering(
      () => replies[Math.min(calls.length - 1, 1)] ?? new Response(),
    );
    const pending = request(context({ fetch }), get());
    for (let round = 0; round < 20 && calls.length < 2; round += 1) {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      mock.timers.tick(500);
    }
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
function recordTimers(): number[] {
  const delays: number[] = [];
  mock.method(globalThis, "setTimeout", (_callback: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return 0;
  });
  mock.method(globalThis, "clearTimeout", () => {});
  return delays;
}

describe("timers stay within setTimeout's range (R-FLOW-6)", () => {
  for (const ms of [2 ** 31, 3e9, Infinity]) {
    it(`clamps sleep(${String(ms)}) to ${String(MAX_TIMER_MS)} ms`, () => {
      const delays = recordTimers();
      void sleep(ms);
      assert.deepEqual(delays, [MAX_TIMER_MS]);
    });
  }

  for (const requestTimeoutMs of [2 ** 31, 3e9]) {
    it(`clamps a per-request timeout of ${String(requestTimeoutMs)} ms`, async () => {
      const delays = recordTimers();
      const { fetch } = answering(() => new Response("{}"));
      await request(context({ fetch, requestTimeoutMs }), get());
      assert.deepEqual(delays, [MAX_TIMER_MS]);
    });
  }

  it("clamps the time left in a far-away budget", async () => {
    const delays = recordTimers();
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

  it(`keeps the default per-request timeout of ${String(REQUEST_TIMEOUT_MS)} ms`, async () => {
    const delays = recordTimers();
    const { fetch } = answering(() => new Response("{}"));
    await request(context({ fetch }), get());
    assert.deepEqual(delays, [REQUEST_TIMEOUT_MS]);
  });
});

describe("request: abort between attempts (R-FLOW-6)", () => {
  it("does not start an attempt after the logger aborted the signal (R-FLOW-6)", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
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
    const pending = rejection(
      request(context({ fetch, logger, signal: controller.signal }), get()),
    );
    for (let round = 0; round < 10; round += 1) {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      mock.timers.tick(500);
    }
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
    const { fetch } = answering(() => new Response(`bad request q=${query}`, { status: 503 }));
    const error = await explorerError(
      request(
        {
          backend: "sourcify",
          secrets: [key],
          random: () => 0,
          fetch,
          budget: { deadline: Date.now() + 100, timeoutMs: 100 },
        },
        get(),
      ),
    );
    assert.ok(error.details.code === "unexpected-response");
    assert.equal(error.details.excerpt, "bad request q=[redacted]");
  });

  it("drops a parsed form that a # or ? cut short, so it never matches unrelated text", () => {
    assert.equal(redact("a cat sat", ["a#bcdefghijk"]), "a cat sat");
    assert.equal(redact("a cat sat", ["a?bcdefghijk"]), "a cat sat");
  });
});
