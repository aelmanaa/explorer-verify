// Black-box tests for issue #53: logger fields and onEvent events. They use only the issue,
// decision 0010, docs/user/reference/logging-and-events.md, llms.txt, the shipped
// schema/event.schema.json, the package exports and the HTTP layer's documented context
// (HttpContext and request() in http/fetch.ts, as architecture.md describes them).
import assert from "node:assert/strict";
import { Console } from "node:console";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setImmediate } from "node:timers";

import { Ajv2020 } from "ajv/dist/2020.js";

import { request } from "../../src/http/fetch.ts";
import type { HttpContext, HttpRequest } from "../../src/http/fetch.ts";
import type { LogFields, Logger, LogValue, VerifyEvent, VerifyOptions } from "../../src/index.ts";
import { contextWith } from "./http-context.ts";
import type { ContextOverrides } from "./http-context.ts";

// The pages import from "explorer-verify"; that name resolves to dist/ only after a build, so the
// typed examples import the same exports from src/index.ts.
type PublicLogger = Logger;

const SECRET = "DUMMYKEYzq9x7w5v3u1tQ8r6p4o2n0mLkJ"; // known to the call through `secrets`
// Upper-case letters and digits, 34 characters: the bare Etherscan-style shape of errors/index.md.
const UNKNOWN_KEY = "ABCDEFGHIJ1234567890KLMNOPQRST1234";
const ORIGIN = "https://api.example.test";

const schema: unknown = JSON.parse(
  readFileSync(new URL("../../schema/event.schema.json", import.meta.url), "utf8"),
);

function compile(value: unknown): (event: unknown) => string[] {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("schema must be an object");
  }
  const check = new Ajv2020({ strict: true, allErrors: true }).compile(value);
  return (event) =>
    check(event)
      ? []
      : (check.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

// The page's `import schema from "explorer-verify/event.schema.json" with { type: "json" }`, run
// through the package's self-reference. A static import fails `tsc -b` here (TS6307: the JSON file
// is outside this project's file list), so the specifier is a variable.
const SCHEMA_SPECIFIER = "explorer-verify/event.schema.json";
const schemaModule: unknown = await import(SCHEMA_SPECIFIER, { with: { type: "json" } });
const schemaFromPackage: unknown =
  typeof schemaModule === "object" && schemaModule !== null
    ? Reflect.get(schemaModule, "default")
    : undefined;

const validateEvent = compile(schema);

function boom(): void {
  throw new Error("broke");
}

function neverSettles(): Promise<void> {
  return new Promise<void>(() => {});
}

/** Returns a promise as `unknown`, the way a caller's async callback reaches the library. */
function rejectWith(message: string, pending: Promise<unknown>[]): unknown {
  const promise = Promise.reject(new Error(message));
  pending.push(promise.catch(() => {}));
  return promise;
}

const con = console;

function neverSettlesUnknown(): unknown {
  return neverSettles();
}

interface Line {
  level: "debug" | "info" | "warn" | "error";
  args: unknown[];
}

/** A logger that records every call with its exact arguments. */
function spyLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const logger: Logger = {
    debug: (...args: unknown[]) => void lines.push({ level: "debug", args }),
    info: (...args: unknown[]) => void lines.push({ level: "info", args }),
    warn: (...args: unknown[]) => void lines.push({ level: "warn", args }),
    error: (...args: unknown[]) => void lines.push({ level: "error", args }),
  };
  return { logger, lines };
}

/** A fake fetch that answers from a script, one entry per call, and records each URL. */
function scriptedFetch(
  script: readonly (number | "network")[],
  headers: Record<string, string> = {},
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fake = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input instanceof Request ? input.url : input));
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step === "network" || step === undefined) {
      throw new TypeError(`fetch failed for key ${SECRET}`);
    }
    return new Response(step === 200 ? '{"ok":true}' : "busy", { status: step, headers });
  };
  return { fetch: fake, calls };
}

function ctxOf(overrides: ContextOverrides & Pick<HttpContext, "fetch">): HttpContext {
  return contextWith({ backend: "etherscan-v2", secrets: [SECRET], random: () => 0 }, overrides);
}

// The backoff waits run on mock timers, so the suite takes milliseconds, not the real 23 s.
beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
});
afterEach(() => {
  mock.timers.reset();
});

/** Runs every timer, in order, until `promise` settles. */
async function drive<T>(promise: Promise<T>): Promise<T> {
  const state = { done: false };
  const settled = promise.then(
    (value) => {
      state.done = true;
      return { ok: true, value } as const;
    },
    (error: unknown) => {
      state.done = true;
      return { ok: false, error } as const;
    },
  );
  for (let round = 0; round < 1_000 && !state.done; round += 1) {
    await nextTurn();
    if (!state.done) {
      mock.timers.runAll();
    }
  }
  const outcome = await settled;
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Lets pending promise callbacks and I/O run, without moving the mocked clock. */
async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

const GET: HttpRequest = {
  url: `${ORIGIN}/v2/api/${SECRET}?chainid=1&apikey=${SECRET}&module=contract`,
  method: "GET",
  retry: "safe",
};

/** Every string found anywhere in a value. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...strings(inner)]);
  }
  return [];
}

function assertNoSecret(value: unknown, where: string, secret: string = SECRET): void {
  for (const text of strings(value)) {
    for (const form of [secret, secret.toLowerCase(), secret.toUpperCase()]) {
      assert.ok(!text.includes(form), `${where} leaks the key: ${text}`);
    }
  }
}

function isLogValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function fieldsOf(line: Line): Map<string, unknown> {
  const fields = line.args[1];
  assert.ok(typeof fields === "object" && fields !== null, "the line has a fields object");
  return new Map<string, unknown>(Object.entries(fields));
}

// ---------------------------------------------------------------------------------------------
describe("#53 types", () => {
  it("console satisfies Logger, also through the package name", () => {
    const local: Logger = console;
    const fromPackage: PublicLogger = console;
    assert.equal(typeof local.debug, "function");
    assert.equal(typeof fromPackage.warn, "function");
  });

  it("a logger that reads only the message fits", () => {
    const messages: string[] = [];
    const logger: Logger = {
      debug: (message: string) => void messages.push(message),
      info: (message: string) => void messages.push(message),
      warn: (message: string) => void messages.push(message),
      error: (message: string) => void messages.push(message),
    };
    const options: VerifyOptions = { logger, onEvent: () => {} };
    assert.ok(options.logger);
  });

  it("LogValue and LogFields take flat JSON-safe values", () => {
    const values: LogValue[] = ["a", 1, true, null];
    const fields: LogFields = { backend: "sourcify", attempt: 2, delayMs: 1_000 };
    assert.equal(values.length, 4);
    assert.equal(fields["attempt"], 2);
  });
});

// ---------------------------------------------------------------------------------------------
describe("#53 schema", () => {
  it("the package export resolves to the same schema file", () => {
    assert.deepEqual(schemaFromPackage, schema);
  });

  it("every documented event shape validates, typed as VerifyEvent", () => {
    const events: VerifyEvent[] = [
      {
        type: "verify.validated",
        chainId: 11155111,
        address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      },
      { type: "verify.routed", backend: "sourcify", apiHost: "sourcify.dev" },
      { type: "verify.lookup", backend: "blockscout", lookup: "skipped" },
      {
        type: "verify.submitted",
        backend: "etherscan-v2",
        handle: "ev1:etherscan-v2:1:0x5FbDB2315678afecb367f032d93F642f64180aa3:abc",
      },
      { type: "verify.poll", backend: "routescan", attempt: 1, state: "queued" },
      {
        type: "verify.retry",
        backend: "etherscan-v2",
        attempt: 2,
        reason: "duplicate-submission",
        delayMs: 0,
      },
      { type: "verify.result", backend: "sourcify", status: "already-verified", match: "partial" },
      { type: "verify.result", backend: "sourcify", status: "failed" },
    ];
    for (const event of events) {
      assert.deepEqual(validateEvent(event), [], event.type);
    }
  });

  it("rejects values outside the documented table", () => {
    const bad: unknown[] = [
      { type: "verify.routed", backend: "sourcify", apiHost: "sourcify.dev/server" },
      { type: "verify.routed", backend: "sourcify", apiHost: "sourcify.dev?apikey=x" },
      { type: "verify.retry", backend: "sourcify", attempt: 1, reason: "network", delayMs: 0 },
      { type: "verify.retry", backend: "sourcify", attempt: 2, reason: "timeout", delayMs: 0 },
      { type: "verify.poll", backend: "sourcify", attempt: 1, state: "failed" },
      { type: "verify.result", backend: "sourcify", status: "failed", match: "exact" },
      { type: "verify.result", backend: "sourcify", status: "verified" },
      { type: "verify.lookup", backend: "sourcify", lookup: "maybe" },
      { type: "verify.unknown", backend: "sourcify" },
    ];
    for (const event of bad) {
      assert.notDeepEqual(validateEvent(event), [], JSON.stringify(event));
    }
  });

  it("allows a field it does not know, as the docs promise readers", () => {
    assert.deepEqual(
      validateEvent({ type: "verify.lookup", backend: "sourcify", lookup: "none", extra: 1 }),
      [],
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("#53 HTTP layer: silent by default", () => {
  it("writes nothing to console without logger and onEvent, retries included", async (t) => {
    const spies = [
      t.mock.method(console, "log", () => {}),
      t.mock.method(console, "debug", () => {}),
      t.mock.method(console, "info", () => {}),
      t.mock.method(console, "warn", () => {}),
      t.mock.method(console, "error", () => {}),
      t.mock.method(console, "trace", () => {}),
    ];
    const { fetch } = scriptedFetch([503, "network", 200]);
    const response = await drive(request(ctxOf({ fetch }), GET));
    assert.equal(response.status, 200);
    // Node 22 prints its own ExperimentalWarning for MockTimers through console.error. That line
    // comes from Node, not from the library, so it is not counted.
    const fromLibrary = spies.flatMap((spy) =>
      spy.mock.calls.filter((call) => !String(call.arguments[0]).includes("ExperimentalWarning")),
    );
    assert.equal(fromLibrary.length, 0);
  });
});

describe("#53 HTTP layer: log lines", () => {
  it("logs a debug line per attempt with backend, method, url and attempt", async () => {
    const { logger, lines } = spyLogger();
    const { fetch } = scriptedFetch([429, 200], { "retry-after": "0" });
    await drive(request(ctxOf({ fetch, logger }), GET));
    const debug = lines.filter((line) => line.level === "debug");
    assert.ok(debug.length >= 2, "one debug line per attempt");
    const attempts = debug.map((line) => fieldsOf(line).get("attempt"));
    assert.ok(attempts.includes(1) && attempts.includes(2), `attempts: ${attempts.join(",")}`);
    for (const line of debug) {
      const fields = fieldsOf(line);
      assert.equal(fields.get("backend"), "etherscan-v2");
      assert.equal(fields.get("method"), "GET");
      assert.equal(typeof fields.get("attempt"), "number");
      const url = fields.get("url");
      assert.equal(typeof url, "string");
      assert.ok(String(url).startsWith(ORIGIN), `url keeps the origin: ${String(url)}`);
      assert.ok(String(url).endsWith("?REDACTED"), `query becomes ?REDACTED: ${String(url)}`);
    }
  });

  it("logs a retry at warn with reason, status and delayMs; status null without a response", async () => {
    const { logger, lines } = spyLogger();
    const { fetch } = scriptedFetch(["network", 429, 200], { "retry-after": "0" });
    await drive(request(ctxOf({ fetch, logger }), GET));
    const warns = lines.filter((line) => line.level === "warn");
    assert.equal(warns.length, 2);
    const [first, second] = warns.map(fieldsOf);
    assert.ok(first && second);
    for (const fields of [first, second]) {
      for (const key of ["backend", "method", "url", "attempt", "reason", "status", "delayMs"]) {
        assert.ok(fields.has(key), `retry line has ${key}`);
      }
      assert.equal(typeof fields.get("delayMs"), "number");
    }
    assert.equal(first.get("status"), null);
    assert.equal(second.get("status"), 429);
  });

  it("passes flat JSON-safe fields and no error line for a recovered request", async () => {
    const { logger, lines } = spyLogger();
    const { fetch } = scriptedFetch([502, 200]);
    await drive(request(ctxOf({ fetch, logger }), GET));
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.equal(typeof line.args[0], "string");
      assert.ok(line.args.length === 1 || line.args.length === 2, "one or two arguments");
      if (line.args.length === 2) {
        for (const [key, value] of fieldsOf(line)) {
          assert.ok(isLogValue(value), `field ${key} is not flat: ${String(value)}`);
        }
      }
    }
  });

  it("never passes undefined as fields, so console prints no undefined", async () => {
    const { logger, lines } = spyLogger();
    const { fetch } = scriptedFetch([503, 200]);
    await drive(request(ctxOf({ fetch, logger }), GET));
    for (const line of lines) {
      assert.ok(!line.args.includes(undefined), `${line.level} got an undefined argument`);
    }

    let out = "";
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        out += chunk.toString();
        done();
      },
    });
    const real = new Console({ stdout: sink, stderr: sink });
    await drive(request(ctxOf({ fetch: scriptedFetch([503, 200]).fetch, logger: real }), GET));
    assert.ok(out.length > 0, "the console printed the lines");
    assert.ok(!out.includes("undefined"), out);
  });

  it("does not log at error a failure it throws", async () => {
    const { logger, lines } = spyLogger();
    const { fetch } = scriptedFetch(["network"]);
    await assert.rejects(drive(request(ctxOf({ fetch, logger }), { ...GET, retry: "submit" })));
    assert.equal(lines.filter((line) => line.level === "error").length, 0);
  });

  it("ignores a logger whose every method throws", async () => {
    const logger: Logger = { debug: boom, info: boom, warn: boom, error: boom };
    const { fetch } = scriptedFetch([503, 200]);
    const response = await drive(request(ctxOf({ fetch, logger }), GET));
    assert.equal(response.status, 200);
  });
});

describe("#53 HTTP layer: verify.retry events", () => {
  it("emits one verify.retry per retry, attempt from 2, each valid against the schema", async () => {
    const events: VerifyEvent[] = [];
    const { fetch } = scriptedFetch([429, "network", 503, 200], { "retry-after": "0" });
    await drive(request(ctxOf({ fetch, onEvent: (event) => void events.push(event) }), GET));
    assert.deepEqual(
      events.map((event) => (event.type === "verify.retry" ? [event.attempt, event.reason] : [])),
      [
        [2, "rate-limited"],
        [3, "network"],
        [4, "server-error"],
      ],
    );
    for (const event of events) {
      assert.deepEqual(validateEvent(event), [], JSON.stringify(event));
      assert.deepEqual(Object.keys(event).toSorted(), [
        "attempt",
        "backend",
        "delayMs",
        "reason",
        "type",
      ]);
      assert.deepEqual(JSON.parse(JSON.stringify(event)), { ...event }, "JSON-safe");
    }
    assert.notEqual(events[0], events[1], "each event is a new object");
  });

  it("emits no event when nothing is retried", async () => {
    const events: VerifyEvent[] = [];
    const { fetch } = scriptedFetch([200]);
    await drive(request(ctxOf({ fetch, onEvent: (event) => void events.push(event) }), GET));
    assert.equal(events.length, 0);
  });

  it("a throwing onEvent is logged once at warn with the type and message; result comes back", async () => {
    const { logger, lines } = spyLogger();
    let calls = 0;
    const onEvent = (): void => {
      calls += 1;
      throw new Error(`callback broke ${SECRET}`);
    };
    const { fetch } = scriptedFetch([503, 503, 200]);
    const response = await drive(request(ctxOf({ fetch, logger, onEvent }), GET));
    assert.equal(response.status, 200);
    assert.equal(calls, 2, "onEvent still receives later events");
    const warnings = lines.filter(
      (line) =>
        line.level === "warn" && strings(line.args).some((s) => s.includes("callback broke")),
    );
    assert.equal(warnings.length, 1, "logged once");
    const text = strings(warnings[0]?.args).join(" ");
    assert.ok(text.includes("verify.retry"), `names the event type: ${text}`);
    assertNoSecret(warnings[0]?.args, "callback warning");
  });

  it("a rejecting onEvent is handled like a throw and is not awaited", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const { logger, lines } = spyLogger();
      const pending: Promise<unknown>[] = [];
      // The type says `=> void`; the docs say a returned promise is handled.
      const onEvent: (event: VerifyEvent) => void = () =>
        rejectWith("async callback broke", pending);
      const { fetch } = scriptedFetch([503, 503, 200]);
      const response = await drive(request(ctxOf({ fetch, logger, onEvent }), GET));
      assert.equal(response.status, 200);
      await Promise.all(pending);
      await nextTurn();
      await nextTurn();
      const warnings = lines.filter(
        (line) =>
          line.level === "warn" &&
          strings(line.args).some((s) => s.includes("async callback broke")),
      );
      assert.equal(warnings.length, 1, "logged once");
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("a never-settling onEvent promise does not slow the request", async () => {
    const onEvent: (event: VerifyEvent) => void = neverSettlesUnknown;
    const { fetch } = scriptedFetch([503, 200]);
    const response = await drive(request(ctxOf({ fetch, onEvent }), GET));
    assert.equal(response.status, 200);
  });

  it("throwing logger and throwing onEvent together still return the response", async () => {
    const { fetch } = scriptedFetch([503, 200]);
    const response = await drive(
      request(
        ctxOf({
          fetch,
          logger: { debug: boom, info: boom, warn: boom, error: boom },
          onEvent: boom,
        }),
        GET,
      ),
    );
    assert.equal(response.status, 200);
  });

  it("a callback that changes the event changes nothing else", async () => {
    const seen: string[] = [];
    const { fetch } = scriptedFetch([503, 503, 200]);
    const first = (event: VerifyEvent): void => {
      seen.push(JSON.stringify(event));
      Object.defineProperty(event, "backend", { value: "changed" });
    };
    // A mutation must not leak into the next event or throw out of the request.
    await drive(request(ctxOf({ fetch, onEvent: first }), GET));
    for (const text of seen) assert.ok(!text.includes("changed"), text);
  });
});

describe("#53 HTTP layer: no key in any output", () => {
  it("removes the key from every log line, field and event", async () => {
    const { logger, lines } = spyLogger();
    const events: VerifyEvent[] = [];
    const { fetch } = scriptedFetch(["network", 429, 503, 200], { "retry-after": "0" });
    const req: HttpRequest = {
      url: `${ORIGIN}/v2/${SECRET.toLowerCase()}/${encodeURIComponent(SECRET)}?apikey=${SECRET}`,
      method: "POST",
      body: new URLSearchParams({ apikey: SECRET }),
      retry: "safe",
    };
    await drive(
      request(ctxOf({ fetch, logger, onEvent: (event) => void events.push(event) }), req),
    );
    assert.ok(lines.length > 0 && events.length > 0);
    assertNoSecret(
      lines.map((line) => line.args),
      "log line",
    );
    assertNoSecret(events, "event");
  });

  it("removes a 34-character key it was not told about from the URL path", async () => {
    const { logger, lines } = spyLogger();
    const { fetch } = scriptedFetch([503, 200]);
    await drive(
      request(ctxOf({ fetch, logger, secrets: [] }), {
        url: `${ORIGIN}/v2/${UNKNOWN_KEY}/x?apikey=${UNKNOWN_KEY}`,
        method: "GET",
        retry: "safe",
      }),
    );
    assert.ok(lines.length > 0);
    assertNoSecret(
      lines.map((line) => line.args),
      "log line",
      UNKNOWN_KEY,
    );
  });
});

// ---------------------------------------------------------------------------------------------
/** The TSDoc example's helper: passes `fields` only when the line has them. */
const print =
  (write: (...data: unknown[]) => void) =>
  (message: string, fields?: LogFields): void => {
    if (fields === undefined) {
      write(message);
    } else {
      write(message, fields);
    }
  };

describe("#53 doc examples", () => {
  it("the pino adapter compiles and passes fields first", () => {
    // The page's adapter, with a pino-shaped stand-in: pino is not a dependency.
    const calls: [string, unknown, string][] = [];
    const log = {
      debug: (obj: object, msg: string) => void calls.push(["debug", obj, msg]),
      info: (obj: object, msg: string) => void calls.push(["info", obj, msg]),
      warn: (obj: object, msg: string) => void calls.push(["warn", obj, msg]),
      error: (obj: object, msg: string) => void calls.push(["error", obj, msg]),
    };
    const logger: PublicLogger = {
      debug: (message, fields) => log.debug(fields ?? {}, message),
      info: (message, fields) => log.info(fields ?? {}, message),
      warn: (message, fields) => log.warn(fields ?? {}, message),
      error: (message, fields) => log.error(fields ?? {}, message),
    };
    logger.warn("retry", { attempt: 2 });
    logger.info("plain");
    assert.deepEqual(calls, [
      ["warn", { attempt: 2 }, "retry"],
      ["info", {}, "plain"],
    ]);
  });

  it("the Logger TSDoc example passes fields only when a line has them", (t) => {
    const info = t.mock.method(console, "info", () => {});
    // Copied from the TSDoc example, with `con` for `console` (no-console) and `print` at
    // module level (consistent-function-scoping).
    const logger: Logger = {
      debug: () => {},
      info: print(con.info),
      warn: print(con.warn),
      error: print(con.error),
    };
    logger.info("plain");
    logger.info("with", { attempt: 2 });
    assert.deepEqual(
      info.mock.calls.map((call) => call.arguments),
      [["plain"], ["with", { attempt: 2 }]],
    );
  });

  it("the onEvent example stores the handle and prints a retry", (t) => {
    const store = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { setItem: (key: string, value: string) => void store.set(key, value) },
    });
    const warn = t.mock.method(console, "warn", () => {});
    try {
      // Copied from the page. Changes for this repo's lint rules only: `con` for `console`
      // (no-console).
      function onEvent(event: VerifyEvent): void {
        switch (event.type) {
          case "verify.submitted":
            localStorage.setItem("pending-verification", event.handle);
            break;
          case "verify.retry":
            con.warn(`retry ${event.attempt} in ${event.delayMs} ms: ${event.reason}`);
            break;
          case "verify.validated":
          case "verify.routed":
          case "verify.lookup":
          case "verify.stored":
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
      const handle = "ev1:sourcify:1:0x5FbDB2315678afecb367f032d93F642f64180aa3:job";
      onEvent({ type: "verify.submitted", backend: "sourcify", handle });
      onEvent({
        type: "verify.retry",
        backend: "sourcify",
        attempt: 2,
        reason: "rate-limited",
        delayMs: 1000,
      });
      assert.equal(store.get("pending-verification"), handle);
      assert.deepEqual(warn.mock.calls[0]?.arguments, ["retry 2 in 1000 ms: rate-limited"]);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("the schema import example works", () => {
    assert.equal(
      typeof schemaFromPackage === "object" && schemaFromPackage !== null
        ? Reflect.get(schemaFromPackage, "$schema")
        : undefined,
      "https://json-schema.org/draft/2020-12/schema",
    );
  });
});
