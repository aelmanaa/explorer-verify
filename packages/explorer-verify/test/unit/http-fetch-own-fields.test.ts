// The HTTP layer reads each field of its context, budget, observer and request once, as an own
// property (R-SEC-2). A value on `Object.prototype` or on another prototype is never used, and a
// getter or Proxy trap that throws gives `invalid-input` without its own text (R-SEC-1).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";
import { inspect } from "node:util";

import { ExplorerVerifyError } from "../../src/errors.ts";
import { request } from "../../src/http/fetch.ts";
import type { Budget, HttpContext, HttpRequest } from "../../src/http/fetch.ts";
import type { Observer } from "../../src/observe.ts";
import type { LogFields, Logger } from "../../src/types.ts";

type Fetch = typeof fetch;

// A fake key. Never a real one (R-SEC-1).
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
// What a hostile getter throws. It must never reach an error surface.
const GETTER_TEXT = `getter says ${DUMMY_KEY}`;
const URL_OK = "https://sourcify.dev/server/v2/contract/1/0x01";

/** A fake fetch that answers each call from `replies` in order, repeating the last one. */
function answering(...replies: (() => Response)[]): {
  fetch: typeof fetch;
  calls: RequestInit[];
} {
  const calls: RequestInit[] = [];
  const fake = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(init ?? {});
    const reply = replies[Math.min(calls.length, replies.length) - 1];
    return Promise.resolve(reply === undefined ? new Response("{}") : reply());
  };
  return { fetch: fake, calls };
}

const ok = (): Response => new Response("{}", { status: 200 });
const busy = (): Response => new Response("{}", { status: 503 });

function get(): HttpRequest {
  return { url: URL_OK, method: "GET", retry: "safe" };
}

function post(): HttpRequest {
  return {
    url: URL_OK,
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
    retry: "submit",
  };
}

/** A logger that records each line. */
function recorder(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record = (message: string): void => {
    lines.push(message);
  };
  return { logger: { debug: record, info: record, warn: record, error: record }, lines };
}

/** An observer whose logger keeps the fields of each line. */
function fieldsObserver(lines: LogFields[]): Observer {
  const record = (_message: string, fields?: LogFields): void => {
    lines.push(fields ?? {});
  };
  return observerOf({ debug: record, info: record, warn: record, error: record });
}

function observerOf(logger: Logger): Observer {
  return { log: logger, emit: () => {} };
}

function budgetOf(): Budget {
  return { deadline: Date.now() + 60_000, timeoutMs: 60_000 };
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

/** Every surface of an error as text. */
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

/**
 * Checks an `invalid-input` for one field: the issue names it, no surface holds the getter's text
 * or the key, and the getter's error is not kept as the cause (R-SEC-1).
 */
function assertInvalidField(error: ExplorerVerifyError, field: string, message: string): void {
  assert.equal(error.code, "invalid-input");
  assert.deepEqual(error.details, { code: "invalid-input", issues: [{ field, message }] });
  assert.equal(error.cause, undefined);
  const text = surfaces(error);
  assert.ok(!text.includes("getter says"), text);
  assert.ok(!text.includes(DUMMY_KEY), text);
}

/** A context with every field set. */
function fullContext(send: Fetch): HttpContext {
  return {
    backend: "sourcify",
    secrets: [DUMMY_KEY],
    fetch: send,
    signal: new AbortController().signal,
    observer: observerOf(recorder().logger),
    requestTimeoutMs: 10_000,
    maxResponseBytes: 1_000,
    budget: budgetOf(),
    random: () => 0,
  };
}

/** Sets `Object.prototype[name]` for the length of `run`, then removes it, even on failure. */
async function withPollution<T>(name: string, value: unknown, run: () => Promise<T>): Promise<T> {
  assert.equal(Object.hasOwn(Object.prototype, name), false);
  Reflect.defineProperty(Object.prototype, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: false,
  });
  try {
    return await run();
  } finally {
    Reflect.deleteProperty(Object.prototype, name);
    assert.equal(name in {}, false);
  }
}

/** A copy of `value` whose `name` is a getter that throws {@link GETTER_TEXT}. */
function throwing<T extends object>(value: T, name: string): T {
  const copy = { ...value };
  Object.defineProperty(copy, name, {
    get(): never {
      throw new Error(GETTER_TEXT);
    },
    configurable: true,
    enumerable: true,
  });
  return copy;
}

/** A copy of `value` whose `name` is inherited from its prototype, not an own field. */
function inherited<T extends object>(value: T, name: keyof T): T {
  const copy = { ...value };
  const prototype = { [name]: value[name] };
  Reflect.deleteProperty(copy, name);
  Reflect.setPrototypeOf(copy, prototype);
  assert.equal(Object.hasOwn(copy, name), false);
  assert.equal(copy[name], value[name]);
  return copy;
}

/** A Proxy over `value` whose `get` trap throws; `Object.hasOwn` still answers. */
function getTrap<T extends object>(value: T): T {
  return new Proxy(value, {
    get(): never {
      throw new Error(GETTER_TEXT);
    },
  });
}

function fail(): never {
  throw new Error(GETTER_TEXT);
}

/** A Proxy over `value` whose every trap throws. */
function allTraps<T extends object>(value: T): T {
  return new Proxy(value, {
    get: fail,
    has: fail,
    ownKeys: fail,
    getOwnPropertyDescriptor: fail,
    getPrototypeOf: fail,
  });
}

/** Runs pending promise and I/O callbacks once, without moving the mocked clock. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** Runs every mocked timer until `promise` settles. */
async function drive<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  const state = { done: false };
  const tracked = promise.finally(() => {
    state.done = true;
  });
  for (let round = 0; round < 100 && !state.done; round += 1) {
    await flush();
    t.mock.timers.runAll();
  }
  return await tracked;
}

describe("request: a field on Object.prototype has no effect (R-SEC-2)", () => {
  it("ignores a polluted signal; an own aborted signal stops the request", async () => {
    const reason = new Error("aborted");
    const own = answering(ok);
    const signal = AbortSignal.abort(reason);
    assert.equal(
      await rejection(
        request({ backend: "sourcify", secrets: [], fetch: own.fetch, signal }, get()),
      ),
      reason,
    );
    assert.equal(own.calls.length, 0);

    const { fetch, calls } = answering(ok);
    const response = await withPollution(
      "signal",
      signal,
      async () => await request({ backend: "sourcify", secrets: [], fetch }, get()),
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
  });

  it("ignores a polluted requestTimeoutMs; an own invalid one is invalid-input", async () => {
    const { fetch, calls } = answering(ok);
    const error = await explorerError(
      request({ backend: "sourcify", secrets: [], fetch, requestTimeoutMs: -1 }, get()),
    );
    assert.equal(error.code, "invalid-input");

    const response = await withPollution(
      "requestTimeoutMs",
      -1,
      async () => await request({ backend: "sourcify", secrets: [], fetch }, get()),
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
  });

  it("ignores a polluted maxResponseBytes; an own one of 1 byte rejects the body", async () => {
    const { fetch } = answering(ok);
    const error = await explorerError(
      request({ backend: "sourcify", secrets: [], fetch, maxResponseBytes: 1 }, get()),
    );
    assert.equal(error.code, "unexpected-response");

    const response = await withPollution(
      "maxResponseBytes",
      1,
      async () => await request({ backend: "sourcify", secrets: [], fetch }, get()),
    );
    assert.equal(await response.text(), "{}");
  });

  it("ignores a polluted budget; an own budget that ran out is timeout", async () => {
    const { fetch } = answering(ok);
    const spent: Budget = { deadline: Date.now() - 1, timeoutMs: 5 };
    const error = await explorerError(
      request({ backend: "sourcify", secrets: [], fetch, budget: spent }, get()),
    );
    assert.equal(error.code, "timeout");

    const response = await withPollution(
      "budget",
      spent,
      async () => await request({ backend: "sourcify", secrets: [], fetch }, get()),
    );
    assert.equal(response.status, 200);
  });

  it("ignores a polluted fetch and uses globalThis.fetch (R-SRV-5)", async (t) => {
    const global = t.mock.method(globalThis, "fetch", () => Promise.resolve(ok()));
    const polluted = answering(ok);
    const response = await withPollution(
      "fetch",
      polluted.fetch,
      async () => await request({ backend: "sourcify", secrets: [] }, get()),
    );
    assert.equal(response.status, 200);
    assert.equal(global.mock.callCount(), 1);
    assert.equal(polluted.calls.length, 0);
  });

  it("ignores a polluted observer; an own observer gets the debug line", async () => {
    const { fetch } = answering(ok);
    const own = recorder();
    await request(
      { backend: "sourcify", secrets: [], fetch, observer: observerOf(own.logger) },
      get(),
    );
    assert.equal(own.lines.length, 1);

    const polluted = recorder();
    await withPollution(
      "observer",
      observerOf(polluted.logger),
      async () => await request({ backend: "sourcify", secrets: [], fetch }, get()),
    );
    assert.deepEqual(polluted.lines, []);
  });

  it("ignores a polluted label; an own label replaces the backend in log lines (#134)", async () => {
    const { fetch } = answering(ok);
    const own: LogFields[] = [];
    await request(
      { backend: "sourcify", label: "ipfs", secrets: [], fetch, observer: fieldsObserver(own) },
      get(),
    );
    assert.equal(own[0]?.["label"], "ipfs");
    assert.equal(own[0]?.["backend"], undefined);

    const polluted: LogFields[] = [];
    await withPollution(
      "label",
      "rpc",
      async () =>
        await request(
          { backend: "sourcify", secrets: [], fetch, observer: fieldsObserver(polluted) },
          get(),
        ),
    );
    assert.equal(polluted[0]?.["backend"], "sourcify");
    assert.equal(polluted[0]?.["label"], undefined);
  });

  it("ignores a polluted random; an own random sets the backoff", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const own = answering(busy, ok);
    let ownCalls = 0;
    const random = (): number => {
      ownCalls += 1;
      return 0;
    };
    await drive(t, request({ backend: "sourcify", secrets: [], fetch: own.fetch, random }, get()));
    assert.equal(ownCalls, 1);

    let pollutedCalls = 0;
    const pollutedRandom = (): number => {
      pollutedCalls += 1;
      return 0;
    };
    const { fetch, calls } = answering(busy, ok);
    const response = await withPollution(
      "random",
      pollutedRandom,
      async () => await drive(t, request({ backend: "sourcify", secrets: [], fetch }, get())),
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(pollutedCalls, 0);
  });

  it("sends no polluted body; an own body is sent", async () => {
    const own = answering(ok);
    await request({ backend: "sourcify", secrets: [], fetch: own.fetch }, post());
    assert.equal(own.calls[0]?.body, "{}");

    const { fetch, calls } = answering(ok);
    await withPollution(
      "body",
      "polluted=1",
      async () => await request({ backend: "sourcify", secrets: [], fetch }, get()),
    );
    const init = calls[0];
    assert.ok(init !== undefined);
    assert.equal(Object.hasOwn(init, "body"), false);
  });

  it("sends no polluted headers; own headers are sent", async () => {
    const own = answering(ok);
    await request({ backend: "sourcify", secrets: [], fetch: own.fetch }, post());
    assert.deepEqual(own.calls[0]?.headers, { "content-type": "application/json" });

    const { fetch, calls } = answering(ok);
    await withPollution(
      "headers",
      { "x-polluted": "1" },
      async () => await request({ backend: "sourcify", secrets: [], fetch }, get()),
    );
    const init = calls[0];
    assert.ok(init !== undefined);
    assert.equal(Object.hasOwn(init, "headers"), false);
  });

  it("does not copy a header inherited by the headers object", async () => {
    const { fetch, calls } = answering(ok);
    const headers = inherited({ "content-type": "application/json", "x-a": "1" }, "x-a");
    await request({ backend: "sourcify", secrets: [], fetch }, { ...get(), headers });
    assert.deepEqual(calls[0]?.headers, { "content-type": "application/json" });
  });

  it("passes fetch a RequestInit without a prototype, so a plain read finds no polluted member", async () => {
    const seen: { body: unknown; headers: unknown; prototype: unknown }[] = [];
    const fake = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      // Plain reads, as a fetch implementation does them.
      seen.push({
        body: init?.body,
        headers: init?.headers,
        prototype: init === undefined ? undefined : Reflect.getPrototypeOf(init),
      });
      return Promise.resolve(ok());
    };
    await withPollution(
      "body",
      "polluted=1",
      async () =>
        await withPollution(
          "headers",
          { "x-injected": "yes" },
          async () => await request({ backend: "sourcify", secrets: [], fetch: fake }, get()),
        ),
    );
    assert.deepEqual(seen, [{ body: undefined, headers: undefined, prototype: null }]);
  });
});

describe("request: an aborted signal wins over an invalid field (R-FLOW-6)", () => {
  it("rejects with the reason when the request also has a throwing headers getter", async () => {
    const reason = new Error("aborted");
    const { fetch, calls } = answering(ok);
    const signal = AbortSignal.abort(reason);
    const error = await rejection(
      request({ backend: "sourcify", secrets: [], fetch, signal }, throwing(post(), "headers")),
    );
    assert.equal(error, reason);
    assert.equal(calls.length, 0);
  });

  it("rejects with the reason when the request has no own url", async () => {
    const reason = new Error("aborted");
    const { fetch, calls } = answering(ok);
    const signal = AbortSignal.abort(reason);
    const error = await rejection(
      request({ backend: "sourcify", secrets: [], fetch, signal }, inherited(get(), "url")),
    );
    assert.equal(error, reason);
    assert.equal(calls.length, 0);
  });

  it("still rejects a throwing signal getter as invalid-input", async () => {
    const { fetch } = answering(ok);
    const ctx = throwing<HttpContext>({ backend: "sourcify", secrets: [], fetch }, "signal");
    const error = await explorerError(request(ctx, inherited(get(), "url")));
    assertInvalidField(error, "context.signal", "could not be read");
  });
});

describe("request: a required field only on a prototype is missing (R-SEC-2)", () => {
  const cases: { field: string; run: (send: Fetch) => Promise<Response> }[] = [
    {
      field: "context.backend",
      run: (fetch) =>
        request(inherited({ backend: "sourcify", secrets: [], fetch }, "backend"), get()),
    },
    {
      field: "context.secrets",
      run: (fetch) =>
        request(inherited({ backend: "sourcify", secrets: [], fetch }, "secrets"), get()),
    },
    {
      field: "context.observer.log",
      run: (fetch) =>
        request(
          {
            backend: "sourcify",
            secrets: [],
            fetch,
            observer: inherited(observerOf(recorder().logger), "log"),
          },
          get(),
        ),
    },
    {
      field: "context.observer.emit",
      run: (fetch) =>
        request(
          {
            backend: "sourcify",
            secrets: [],
            fetch,
            observer: inherited(observerOf(recorder().logger), "emit"),
          },
          get(),
        ),
    },
    {
      field: "context.budget.deadline",
      run: (fetch) =>
        request(
          { backend: "sourcify", secrets: [], fetch, budget: inherited(budgetOf(), "deadline") },
          get(),
        ),
    },
    {
      field: "context.budget.timeoutMs",
      run: (fetch) =>
        request(
          { backend: "sourcify", secrets: [], fetch, budget: inherited(budgetOf(), "timeoutMs") },
          get(),
        ),
    },
    {
      field: "request.url",
      run: (fetch) => request({ backend: "sourcify", secrets: [], fetch }, inherited(get(), "url")),
    },
    {
      field: "request.method",
      run: (fetch) =>
        request({ backend: "sourcify", secrets: [], fetch }, inherited(get(), "method")),
    },
    {
      field: "request.retry",
      run: (fetch) =>
        request({ backend: "sourcify", secrets: [], fetch }, inherited(get(), "retry")),
    },
  ];
  for (const { field, run } of cases) {
    it(`rejects an inherited ${field} as invalid-input and sends nothing`, async () => {
      const { fetch, calls } = answering(ok);
      const error = await explorerError(run(fetch));
      assertInvalidField(error, field, "is missing");
      assert.equal(calls.length, 0);
    });
  }

  it("rejects a required field that is null as invalid-input", async () => {
    const { fetch, calls } = answering(ok);
    const req = get();
    Object.defineProperty(req, "url", { value: null });
    const error = await explorerError(request({ backend: "sourcify", secrets: [], fetch }, req));
    assertInvalidField(error, "request.url", "is missing");
    assert.equal(calls.length, 0);
  });

  it("ignores an optional field inherited from another prototype", async () => {
    const { fetch, calls } = answering(ok);
    const req = inherited(post(), "body");
    await request({ backend: "sourcify", secrets: [], fetch }, req);
    const init = calls[0];
    assert.ok(init !== undefined);
    assert.equal(Object.hasOwn(init, "body"), false);
  });
});

describe("request: a getter or Proxy trap that throws is invalid-input (R-SEC-1, R-SEC-2)", () => {
  const contextFields = [
    "backend",
    "label",
    "fetch",
    "signal",
    "observer",
    "secrets",
    "requestTimeoutMs",
    "maxResponseBytes",
    "budget",
    "random",
  ];
  for (const name of contextFields) {
    it(`rejects a throwing context.${name} getter without its text`, async () => {
      const { fetch, calls } = answering(ok);
      const error = await explorerError(request(throwing(fullContext(fetch), name), post()));
      assertInvalidField(error, `context.${name}`, "could not be read");
      assert.equal(calls.length, 0);
    });
  }

  for (const name of ["url", "method", "body", "headers", "retry"]) {
    it(`rejects a throwing request.${name} getter without its text`, async () => {
      const { fetch, calls } = answering(ok);
      const error = await explorerError(request(fullContext(fetch), throwing(post(), name)));
      assertInvalidField(error, `request.${name}`, "could not be read");
      assert.equal(calls.length, 0);
    });
  }

  for (const name of ["log", "emit"]) {
    it(`rejects a throwing context.observer.${name} getter without its text`, async () => {
      const { fetch, calls } = answering(ok);
      const observer = throwing(observerOf(recorder().logger), name);
      const error = await explorerError(request({ ...fullContext(fetch), observer }, post()));
      assertInvalidField(error, `context.observer.${name}`, "could not be read");
      assert.equal(calls.length, 0);
    });
  }

  for (const name of ["deadline", "timeoutMs"]) {
    it(`rejects a throwing context.budget.${name} getter without its text`, async () => {
      const { fetch, calls } = answering(ok);
      const budget = throwing(budgetOf(), name);
      const error = await explorerError(request({ ...fullContext(fetch), budget }, post()));
      assertInvalidField(error, `context.budget.${name}`, "could not be read");
      assert.equal(calls.length, 0);
    });
  }

  it("rejects a throwing header value getter without its text", async () => {
    const { fetch, calls } = answering(ok);
    const headers = throwing({ "content-type": "application/json" }, "x-a");
    const error = await explorerError(request(fullContext(fetch), { ...post(), headers }));
    assertInvalidField(error, "request.headers", "could not be read");
    assert.equal(calls.length, 0);
  });

  const proxies: {
    name: string;
    field: string;
    run: (send: Fetch) => Promise<Response>;
  }[] = [
    {
      name: "a context whose get trap throws",
      field: "context.signal",
      run: (fetch) => request(getTrap(fullContext(fetch)), post()),
    },
    {
      name: "a context whose every trap throws",
      field: "context.signal",
      run: (fetch) => request(allTraps(fullContext(fetch)), post()),
    },
    {
      name: "a request whose get trap throws",
      field: "request.headers",
      run: (fetch) => request(fullContext(fetch), getTrap(post())),
    },
    {
      name: "a request whose every trap throws",
      field: "request.headers",
      run: (fetch) => request(fullContext(fetch), allTraps(post())),
    },
    {
      name: "an observer whose every trap throws",
      field: "context.observer.log",
      run: (fetch) =>
        request(
          { ...fullContext(fetch), observer: allTraps(observerOf(recorder().logger)) },
          post(),
        ),
    },
    {
      name: "a budget whose every trap throws",
      field: "context.budget.deadline",
      run: (fetch) => request({ ...fullContext(fetch), budget: allTraps(budgetOf()) }, post()),
    },
    {
      name: "headers whose ownKeys trap throws",
      field: "request.headers",
      run: (fetch) =>
        request(fullContext(fetch), { ...post(), headers: allTraps({ "content-type": "x" }) }),
    },
  ];
  for (const { name, field, run } of proxies) {
    it(`rejects ${name} without its text`, async () => {
      const { fetch, calls } = answering(ok);
      const error = await explorerError(run(fetch));
      assertInvalidField(error, field, "could not be read");
      assert.equal(calls.length, 0);
    });
  }
});

describe("request: each field is read once per call (R-SEC-2)", () => {
  it("reads every context, budget, observer and request field once, across retries", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const reads = new Map<string, number>();
    /** A copy of `value` whose every own field counts its reads under `prefix`. */
    function counted<T extends object>(value: T, prefix: string): T {
      const copy = { ...value };
      for (const [name, field] of Object.entries(value)) {
        Object.defineProperty(copy, name, {
          get(): unknown {
            const key = `${prefix}.${name}`;
            reads.set(key, (reads.get(key) ?? 0) + 1);
            return field;
          },
          enumerable: true,
        });
      }
      return copy;
    }
    const { fetch, calls } = answering(busy, ok);
    const ctx = counted<HttpContext>(
      {
        backend: "sourcify",
        label: "rpc",
        secrets: [],
        fetch,
        signal: new AbortController().signal,
        observer: counted(observerOf(recorder().logger), "context.observer"),
        requestTimeoutMs: 10_000,
        maxResponseBytes: 1_000,
        budget: counted(budgetOf(), "context.budget"),
        random: () => 0,
      },
      "context",
    );
    const req = counted<HttpRequest>(
      {
        url: URL_OK,
        method: "POST",
        body: "{}",
        headers: counted({ "content-type": "application/json" }, "request.headers"),
        retry: "safe",
      },
      "request",
    );
    const response = await drive(t, request(ctx, req));
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(reads.size, 20);
    for (const [key, count] of reads) {
      assert.equal(count, 1, key);
    }
  });
});
