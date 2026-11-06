// Tests for the logger fields and the onEvent events of decision 0010 (R-DX-5, R-DX-6, R-SEC-1):
// the observer that guards both, the shipped event schema, and the HTTP layer's use of them. No
// network: every request goes through an injected fetch, and every wait runs on mock timers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";

import { request } from "../../src/http/fetch.ts";
import type { HttpContext } from "../../src/http/fetch.ts";
import type { LogFields, Logger, LogValue, VerifyEvent, VerifyOptions } from "../../src/index.ts";
import { createObserver, redactEvent } from "../../src/observe.ts";
import { compileStrict } from "./envelope-schema.ts";
import { contextWith } from "./http-context.ts";
import type { ContextOverrides } from "./http-context.ts";

// Fake keys. Never real ones (R-SEC-1).
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const OTHER_SECRET = "observe-dummy-secret-0042";
const SECRETS = [DUMMY_KEY, OTHER_SECRET];
const ADDRESS = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
// A job id with the shape of an Etherscan key: a handle keeps it, so it still resumes (R-SEC-1).
const KEY_SHAPED_JOB = "JOB0123456789ABCDEFGHIJKLMNOPQRSTU";
const KEYED_URL = `https://api.example.org/v2/api?chainid=1&apikey=${DUMMY_KEY}&x=${OTHER_SECRET}`;

const SCHEMA_URL = new URL("../../schema/event.schema.json", import.meta.url);
const eventSchema: unknown = JSON.parse(readFileSync(SCHEMA_URL, "utf8"));
const validateEvent = compileStrict(eventSchema);

/** Fails when `value` breaks the shipped event schema. */
function assertValidEvent(value: unknown): void {
  assert.deepEqual(validateEvent(value), [], `breaks event.schema.json: ${JSON.stringify(value)}`);
}

/** Fails when any form of a dummy key appears in `text`. */
function assertNoKey(text: string): void {
  for (const secret of SECRETS) {
    assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `key in ${text}`);
  }
}

interface Line {
  readonly level: keyof Logger;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/** A logger that records every call, with the number of arguments it got. */
function recorder(): { logger: Logger; lines: Line[]; arities: number[] } {
  const lines: Line[] = [];
  const arities: number[] = [];
  const at =
    (level: keyof Logger) =>
    (...args: [message: string, fields?: LogFields]): void => {
      arities.push(args.length);
      lines.push({ level, message: args[0], fields: args[1] });
    };
  return {
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    lines,
    arities,
  };
}

/** One event of each type, with a dummy key in every free-text field that can hold one. */
function everyEvent(): VerifyEvent[] {
  return [
    { type: "verify.validated", chainId: 11155111, address: ADDRESS },
    { type: "verify.routed", backend: "sourcify", apiHost: `${DUMMY_KEY}.example.org` },
    { type: "verify.lookup", backend: "sourcify", match: "none" },
    { type: "verify.lookup", backend: "sourcify", match: "skipped" },
    {
      type: "verify.submitted",
      backend: "etherscan-v2",
      handle: `ev1:etherscan-v2:1:${ADDRESS}:${DUMMY_KEY}`,
    },
    {
      type: "verify.submitted",
      backend: "etherscan-v2",
      handle: `ev1:etherscan-v2:1:${ADDRESS}:${KEY_SHAPED_JOB}`,
    },
    { type: "verify.poll", backend: "sourcify", attempt: 1, state: "pending" },
    { type: "verify.poll", backend: "etherscan-v2", attempt: 2, state: "queued" },
    { type: "verify.poll", backend: "etherscan-v2", attempt: 3, state: "completed" },
    { type: "verify.retry", backend: "sourcify", attempt: 2, reason: "rate-limited", delayMs: 500 },
    { type: "verify.retry", backend: "sourcify", attempt: 3, reason: "network", delayMs: 1_000 },
    { type: "verify.retry", backend: "sourcify", attempt: 4, reason: "server-error", delayMs: 0 },
    {
      type: "verify.retry",
      backend: "sourcify",
      attempt: 2,
      reason: "duplicate-submission",
      delayMs: 3_000,
    },
    { type: "verify.result", backend: "sourcify", status: "verified", match: "exact" },
    { type: "verify.result", backend: "blockscout", status: "already-verified", match: "partial" },
    { type: "verify.result", backend: "routescan", status: "failed" },
  ];
}

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** A logger method or `onEvent` that always throws an error holding a dummy key. */
function throwing(): never {
  throw new Error(`broken ${DUMMY_KEY} ${KEYED_URL}`);
}

/** An Error-typed value that is not an `Error` instance, as some libraries throw. */
function errorLike(message: string): Error {
  const value = { name: "Custom", message, toString: () => message };
  return value;
}

/**
 * An `onEvent` that returns `value`. Its declared return is `void`, as `VerifyOptions.onEvent`
 * declares, while the body returns what a JavaScript or `async` callback would.
 */
function returning(value: unknown): (event: VerifyEvent) => void {
  function callback(event: VerifyEvent): void;
  function callback(): unknown {
    return value;
  }
  return callback;
}

/** Runs pending promise callbacks once. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

// --- types --------------------------------------------------------------------------------------

describe("Logger and VerifyEvent types (R-DX-5, R-DX-6)", () => {
  it("console satisfies Logger, and a logger that reads only the message still fits (R-DX-5)", () => {
    const fromConsole: Logger = console;
    const messageOnly: Logger = {
      debug: (message: string) => message.length,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    const options: VerifyOptions = { logger: console, onEvent: () => undefined };
    assert.equal(typeof fromConsole.info, "function");
    assert.equal(typeof messageOnly.debug, "function");
    assert.equal(typeof options.onEvent, "function");
  });

  it("LogValue is flat: string, number, boolean or null (R-DX-5)", () => {
    const flat: Equals<LogValue, string | number | boolean | null> = true;
    const consoleFits: typeof console extends Logger ? true : false = true;
    const fields: LogFields = { a: "x", b: 2, c: false, d: null };
    assert.equal(flat, true);
    assert.equal(consoleFits, true);
    assert.equal(Object.keys(fields).length, 4);
  });

  it("VerifyEvent has exactly the seven types of R-DX-6", () => {
    const types: Record<VerifyEvent["type"], true> = {
      "verify.validated": true,
      "verify.routed": true,
      "verify.lookup": true,
      "verify.submitted": true,
      "verify.poll": true,
      "verify.retry": true,
      "verify.result": true,
    };
    assert.deepEqual(Object.keys(types), [...new Set(everyEvent().map((event) => event.type))]);
  });

  it("pins the poll states, the retry reasons and a failed result without a match", () => {
    type Poll = Extract<VerifyEvent, { type: "verify.poll" }>;
    type Retry = Extract<VerifyEvent, { type: "verify.retry" }>;
    type Failed = Extract<VerifyEvent, { type: "verify.result"; status: "failed" }>;
    const states: Equals<Poll["state"], "pending" | "queued" | "completed"> = true;
    const reasons: Equals<
      Retry["reason"],
      | "rate-limited"
      | "network"
      | "server-error"
      | "duplicate-submission"
      | "not-indexed"
      | "empty-submit"
    > = true;
    const failedHasNoMatch: "match" extends keyof Failed ? false : true = true;
    const onEventMayBeAsync: Equals<
      ReturnType<NonNullable<VerifyOptions["onEvent"]>>,
      void | Promise<void>
    > = true;
    assert.deepEqual(
      [states, reasons, failedHasNoMatch, onEventMayBeAsync],
      [true, true, true, true],
    );
  });
});

// --- the event schema ---------------------------------------------------------------------------

describe("event.schema.json (R-DX-6, R-AX-16)", () => {
  it("compiles in strict mode and accepts one event of every type", () => {
    for (const event of everyEvent()) {
      assertValidEvent(redactEvent(event, SECRETS));
    }
  });

  it("lists state and reason as enums, so a new value is a schema change", () => {
    assert.notDeepEqual(
      validateEvent({ type: "verify.poll", backend: "sourcify", attempt: 1, state: "running" }),
      [],
    );
    assert.notDeepEqual(
      validateEvent({
        type: "verify.retry",
        backend: "sourcify",
        attempt: 2,
        reason: "timeout",
        delayMs: 1,
      }),
      [],
    );
  });

  it("rejects an unknown type, a missing field, a failed result with a match and a URL as host", () => {
    for (const bad of [
      { type: "verify.started", backend: "sourcify" },
      { type: "verify.lookup", backend: "sourcify" },
      { type: "verify.result", backend: "sourcify", status: "failed", match: "exact" },
      { type: "verify.result", backend: "sourcify", status: "verified" },
      { type: "verify.routed", backend: "sourcify", apiHost: "https://sourcify.dev/server" },
      { type: "verify.validated", chainId: 0, address: ADDRESS },
    ]) {
      assert.notDeepEqual(validateEvent(bad), [], JSON.stringify(bad));
    }
  });

  it("rejects every event with any one of its fields removed: every field is required", () => {
    for (const event of everyEvent()) {
      for (const name of Object.keys(event)) {
        const without = Object.fromEntries(Object.entries(event).filter(([key]) => key !== name));
        assert.notDeepEqual(validateEvent(without), [], `${event.type} without ${name}`);
      }
    }
  });

  it("rejects a value outside each pattern, minimum and integer rule", () => {
    const poll = { type: "verify.poll", backend: "sourcify", attempt: 1, state: "pending" };
    const retry = {
      type: "verify.retry",
      backend: "sourcify",
      attempt: 2,
      reason: "network",
      delayMs: 0,
    };
    const validated = { type: "verify.validated", chainId: 1, address: ADDRESS };
    const routed = { type: "verify.routed", backend: "sourcify", apiHost: "sourcify.dev" };
    const submitted = {
      type: "verify.submitted",
      backend: "sourcify",
      handle: `ev1:sourcify:1:${ADDRESS}:job`,
    };
    // Each base is valid, so every rejection below comes from the one changed value.
    for (const base of [poll, retry, validated, routed, submitted]) {
      assertValidEvent(base);
    }
    const bad: Record<string, unknown>[] = [
      { ...poll, state: "failed" },
      { ...poll, attempt: 0 },
      { ...poll, attempt: 1.5 },
      { ...poll, backend: "source fy" },
      { ...poll, backend: "Sourcify" },
      { ...retry, attempt: 1 },
      { ...retry, delayMs: 1.5 },
      { ...retry, delayMs: -1 },
      { ...validated, address: "0x5fbdb2315678afecb367f032d93f642f64180a" },
      { ...validated, address: ADDRESS.slice(2) },
      { ...validated, chainId: 0 },
      { ...validated, chainId: 1.5 },
      { ...routed, apiHost: "" },
      { ...routed, apiHost: "sourcify.dev/server" },
      { ...routed, apiHost: "sourcify.dev?x=1" },
      { ...routed, apiHost: "sourcify .dev" },
      { ...submitted, handle: `sourcify:1:${ADDRESS}:job` },
      { ...submitted, handle: `ev2:sourcify:1:${ADDRESS}:job` },
    ];
    for (const event of bad) {
      assert.notDeepEqual(validateEvent(event), [], JSON.stringify(event));
    }
  });

  it("accepts a field it does not know, as a later release may add one", () => {
    assertValidEvent({ type: "verify.lookup", backend: "sourcify", match: "exact", extra: 1 });
  });

  it("ships in the package as explorer-verify/event.schema.json", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const exportsMap: unknown =
      typeof manifest === "object" && manifest !== null && "exports" in manifest
        ? manifest.exports
        : undefined;
    const entry: unknown =
      typeof exportsMap === "object" && exportsMap !== null && "./event.schema.json" in exportsMap
        ? exportsMap["./event.schema.json"]
        : undefined;
    assert.equal(entry, "./schema/event.schema.json");
  });
});

// --- redactEvent --------------------------------------------------------------------------------

describe("redactEvent (R-SEC-1, R-DX-6)", () => {
  it("removes a dummy key from every event and keeps the event's type and shape", () => {
    const events = everyEvent();
    const redacted = events.map((event) => redactEvent(event, SECRETS));
    assertNoKey(JSON.stringify(redacted));
    assert.deepEqual(
      redacted.map((event) => event.type),
      events.map((event) => event.type),
    );
    assert.deepEqual(redacted[1], {
      type: "verify.routed",
      backend: "sourcify",
      apiHost: "[redacted].example.org",
    });
  });

  it("keeps a handle whose job id only has the shape of a key, so it still resumes", () => {
    const handle = `ev1:etherscan-v2:1:${ADDRESS}:${KEY_SHAPED_JOB}`;
    assert.deepEqual(
      redactEvent({ type: "verify.submitted", backend: "etherscan-v2", handle }, []),
      {
        type: "verify.submitted",
        backend: "etherscan-v2",
        handle,
      },
    );
  });

  it("redacts a handle whose job id equals a configured key", () => {
    const handle = `ev1:etherscan-v2:1:${ADDRESS}:${DUMMY_KEY}`;
    const out = redactEvent({ type: "verify.submitted", backend: "etherscan-v2", handle }, SECRETS);
    assert.deepEqual(out, {
      type: "verify.submitted",
      backend: "etherscan-v2",
      handle: `ev1:etherscan-v2:1:${ADDRESS}:[redacted]`,
    });
  });

  it("copies only the documented fields, so an extra field never leaks", () => {
    const withExtra = {
      type: "verify.lookup",
      backend: "sourcify",
      match: "exact",
      url: KEYED_URL,
    } as const;
    assert.deepEqual(redactEvent(withExtra, SECRETS), {
      type: "verify.lookup",
      backend: "sourcify",
      match: "exact",
    });
    const result = {
      type: "verify.result",
      backend: "sourcify",
      status: "failed",
      reason: KEYED_URL,
    } as const;
    assert.deepEqual(redactEvent(result, SECRETS), {
      type: "verify.result",
      backend: "sourcify",
      status: "failed",
    });
  });

  it("keeps every value of every event that holds no configured key", () => {
    assert.deepEqual(
      everyEvent().map((event) => redactEvent(event, [])),
      everyEvent(),
    );
  });

  it("drops an extra field from every event type", () => {
    for (const event of everyEvent()) {
      const withExtra = { ...event, extra: KEYED_URL };
      assert.deepEqual(redactEvent(withExtra, []), event, event.type);
    }
  });

  it("removes a configured key from the address", () => {
    const secret = ADDRESS.slice(2, 18);
    assert.deepEqual(
      redactEvent({ type: "verify.validated", chainId: 1, address: ADDRESS }, [secret]),
      { type: "verify.validated", chainId: 1, address: `0x[redacted]${ADDRESS.slice(18)}` },
    );
  });

  it("redacts only the job id of a handle, as the envelope and errors do (R-SEC-1)", () => {
    // A configured key equal to a word of the prefix leaves the prefix as it is.
    const handle = `ev1:etherscan-v2:1:${ADDRESS}:job-etherscan-v2`;
    assert.deepEqual(
      redactEvent({ type: "verify.submitted", backend: "etherscan-v2", handle }, ["etherscan-v2"]),
      {
        type: "verify.submitted",
        backend: "etherscan-v2",
        handle: `ev1:etherscan-v2:1:${ADDRESS}:job-[redacted]`,
      },
    );
    // Text that is not a one-line handle, which only untyped code passes, is redacted whole and
    // kept in the shape of HandleString.
    for (const text of [`x ${DUMMY_KEY}`, `ev1:sourcify:1:${ADDRESS}`]) {
      assert.deepEqual(
        Reflect.apply(redactEvent, undefined, [
          { type: "verify.submitted", backend: "sourcify", handle: text },
          [DUMMY_KEY],
        ]),
        {
          type: "verify.submitted",
          backend: "sourcify",
          handle: `ev1:sourcify:0:0x:${text.replace(DUMMY_KEY, "[redacted]")}`,
        },
      );
    }
  });

  it("returns a new object each time", () => {
    const event: VerifyEvent = { type: "verify.lookup", backend: "sourcify", match: "exact" };
    assert.notEqual(redactEvent(event, []), event);
  });

  it("throws on an event type it does not know, which only a JavaScript caller can pass", () => {
    assert.throws(
      () => Reflect.apply(redactEvent, undefined, [{ type: "verify.unknown" }, []]),
      TypeError,
    );
  });
});

// --- createObserver -----------------------------------------------------------------------------

describe("createObserver: silent default (R-DX-5, decision 0010)", () => {
  it("writes nothing to the console without a logger and an onEvent", (t: TestContext) => {
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((name) =>
      t.mock.method(console, name, () => {}),
    );
    const { log, emit } = createObserver({ secrets: SECRETS });
    log.debug("x", { a: 1 });
    log.info("x");
    log.warn("x");
    log.error("x");
    for (const event of everyEvent()) {
      emit(event);
    }
    for (const spy of spies) {
      assert.equal(spy.mock.callCount(), 0);
    }
  });

  it("emits nothing to a logger when there is no onEvent", () => {
    const { logger, lines } = recorder();
    const { emit } = createObserver({ logger, secrets: [] });
    emit({ type: "verify.lookup", backend: "sourcify", match: "skipped" });
    assert.deepEqual(lines, []);
  });
});

describe("createObserver: events (R-DX-6, R-SEC-1)", () => {
  it("passes every event in order, redacted, and each one validates against the schema", () => {
    const seen: VerifyEvent[] = [];
    const { emit } = createObserver({
      onEvent: (event) => void seen.push(event),
      secrets: SECRETS,
    });
    for (const event of everyEvent()) {
      emit(event);
    }
    // Written out: only the API host and the job id equal to a key change.
    const expected = everyEvent();
    expected[1] = {
      type: "verify.routed",
      backend: "sourcify",
      apiHost: "[redacted].example.org",
    };
    expected[4] = {
      type: "verify.submitted",
      backend: "etherscan-v2",
      handle: `ev1:etherscan-v2:1:${ADDRESS}:[redacted]`,
    };
    assert.deepEqual(seen, expected);
    assert.equal(seen.length, 16);
    for (const event of seen) {
      assertValidEvent(event);
    }
    assertNoKey(JSON.stringify(seen));
  });

  it("logs a throwing onEvent once at warn, redacted, and goes on (decision 0010)", () => {
    const { logger, lines } = recorder();
    let calls = 0;
    const { emit } = createObserver({
      logger,
      onEvent: () => {
        calls += 1;
        throw new Error(`callback failed for ${KEYED_URL}`);
      },
      secrets: SECRETS,
    });
    assert.doesNotThrow(() => {
      emit({ type: "verify.lookup", backend: "sourcify", match: "none" });
      emit({ type: "verify.poll", backend: "sourcify", attempt: 1, state: "pending" });
    });
    assert.equal(calls, 2);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.level, "warn");
    assert.equal(lines[0]?.fields?.["event"], "verify.lookup");
    assert.match(String(lines[0]?.fields?.["error"]), /^Error: callback failed for /);
    assertNoKey(JSON.stringify(lines));
  });

  it("describes a thrown value that is not an Error instance, and one that cannot be read", () => {
    const { logger, lines } = recorder();
    createObserver({
      logger,
      onEvent: () => {
        throw errorLike(`plain ${DUMMY_KEY}`);
      },
      secrets: SECRETS,
    }).emit({ type: "verify.lookup", backend: "sourcify", match: "none" });
    const fields = {
      name: "Unreadable",
      message: "",
      toString(): string {
        throw new Error("no");
      },
    };
    const unreadable: Error = fields;
    createObserver({
      logger,
      onEvent: () => {
        throw unreadable;
      },
      secrets: SECRETS,
    }).emit({ type: "verify.lookup", backend: "sourcify", match: "none" });
    assert.deepEqual(
      lines.map((line) => line.fields?.["error"]),
      ["plain [redacted]", "[unloggable]"],
    );
  });

  it("attaches a catch to a rejected promise and logs it once at warn", async () => {
    const { logger, lines } = recorder();
    const { emit } = createObserver({
      logger,
      onEvent: returning(Promise.reject(new Error(`async failure ${DUMMY_KEY}`))),
      secrets: SECRETS,
    });
    emit({ type: "verify.lookup", backend: "sourcify", match: "none" });
    emit({ type: "verify.lookup", backend: "sourcify", match: "exact" });
    await flush();
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.level, "warn");
    assert.equal(lines[0]?.fields?.["error"], "Error: async failure [redacted]");
  });

  it("returns before a pending promise settles, and catches its later rejection", async () => {
    const { logger, lines } = recorder();
    let rejectLater: ((error: Error) => void) | undefined;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectLater = reject;
    });
    const { emit } = createObserver({ logger, onEvent: returning(pending), secrets: [] });
    emit({ type: "verify.lookup", backend: "sourcify", match: "none" });
    await flush();
    // emit returned and the promise is still pending: nothing was waited for or logged.
    assert.equal(lines.length, 0);
    rejectLater?.(new Error("late"));
    await flush();
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.fields?.["error"], "Error: late");
  });

  it("accepts a returned value that is not a promise and logs nothing", async () => {
    const { logger, lines } = recorder();
    createObserver({ logger, onEvent: returning(42), secrets: [] }).emit({
      type: "verify.lookup",
      backend: "sourcify",
      match: "none",
    });
    await flush();
    assert.deepEqual(lines, []);
  });

  it("logs a rejecting thenable that is not a Promise (R-DX-6)", async () => {
    const { logger, lines } = recorder();
    const thenable = {};
    Reflect.set(thenable, "then", (_resolve: unknown, reject: (error: Error) => void) => {
      reject(new Error(`thenable ${DUMMY_KEY}`));
    });
    createObserver({ logger, onEvent: returning(thenable), secrets: SECRETS }).emit({
      type: "verify.lookup",
      backend: "sourcify",
      match: "none",
    });
    await flush();
    assert.equal(lines[0]?.fields?.["error"], "Error: thenable [redacted]");
  });

  it("hands out a frozen event, so a callback cannot redefine its type (decision 0010)", () => {
    const { logger, lines } = recorder();
    const { emit } = createObserver({
      logger,
      onEvent: (event) => {
        assert.ok(Object.isFrozen(event));
        Object.defineProperty(event, "type", {
          get(): never {
            throw new Error("type getter");
          },
        });
      },
      secrets: [],
    });
    assert.doesNotThrow(() => {
      emit({ type: "verify.lookup", backend: "sourcify", match: "none" });
    });
    assert.equal(lines[0]?.fields?.["event"], "verify.lookup");
  });

  it("catches a promise whose then throws, without throwing from emit", async () => {
    const { logger, lines } = recorder();
    const broken = Promise.resolve();
    Reflect.set(broken, "then", () => {
      throw new Error("then failed");
    });
    const { emit } = createObserver({ logger, onEvent: returning(broken), secrets: [] });
    assert.doesNotThrow(() => {
      emit({ type: "verify.lookup", backend: "sourcify", match: "none" });
    });
    await flush();
    assert.equal(lines[0]?.fields?.["error"], "Error: then failed");
  });

  it("never throws when both the logger and onEvent throw", () => {
    const { log, emit } = createObserver({
      logger: { debug: throwing, info: throwing, warn: throwing, error: throwing },
      onEvent: throwing,
      secrets: SECRETS,
    });
    assert.doesNotThrow(() => {
      emit({ type: "verify.lookup", backend: "sourcify", match: "none" });
      log.debug("x", { a: 1 });
      log.error("x");
    });
  });

  it("gives onEvent a copy, so a callback that changes it cannot change the caller's event", () => {
    const seen: VerifyEvent[] = [];
    const event: VerifyEvent = { type: "verify.lookup", backend: "sourcify", match: "none" };
    const { emit } = createObserver({
      onEvent: (received) => {
        seen.push(received);
        Reflect.set(received, "match", "exact");
      },
      secrets: [],
    });
    emit(event);
    assert.equal(event.match, "none");
    assert.notEqual(seen[0], event);
  });
});

// --- the HTTP layer -----------------------------------------------------------------------------

/** A fake fetch that answers `statuses` in order and repeats the last one. */
function answering(...statuses: number[]): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fake = (input: RequestInfo | URL): Promise<Response> => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const status = statuses[Math.min(urls.length, statuses.length) - 1] ?? 200;
    return Promise.resolve(
      new Response(`{"echo":"${KEYED_URL}"}`, {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch: fake, urls };
}

/** Runs the mock timers until `promise` settles. */
async function drive<T>(t: TestContext, promise: Promise<T>): Promise<T> {
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
    await flush();
    if (!state.done) {
      t.mock.timers.runAll();
    }
  }
  const outcome = await settled;
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

function context(overrides: ContextOverrides): HttpContext {
  return contextWith({ backend: "sourcify", secrets: SECRETS, random: () => 0 }, overrides);
}

describe("request: logger fields and verify.retry (R-DX-5, R-DX-6, R-SEC-1)", () => {
  it("logs fields with the backend, method, URL and attempt, and no key anywhere", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { logger, lines, arities } = recorder();
    const events: VerifyEvent[] = [];
    const { fetch } = answering(503, 502, 200);
    const response = await drive(
      t,
      request(context({ fetch, logger, onEvent: (e) => void events.push(e) }), {
        url: KEYED_URL,
        method: "GET",
        retry: "safe",
      }),
    );
    assert.equal(response.status, 200);
    const url = "https://api.example.org/v2/api?REDACTED";
    const where = { backend: "sourcify", method: "GET", url };
    assert.deepEqual(
      lines.map((line) => [line.level, line.fields]),
      [
        ["debug", { ...where, attempt: 1 }],
        ["warn", { ...where, attempt: 2, reason: "server-error", status: 503, delayMs: 500 }],
        ["debug", { ...where, attempt: 2 }],
        ["warn", { ...where, attempt: 3, reason: "server-error", status: 502, delayMs: 1_000 }],
        ["debug", { ...where, attempt: 3 }],
      ],
    );
    assert.deepEqual(arities, [2, 2, 2, 2, 2]);
    const retry = { type: "verify.retry", backend: "sourcify", reason: "server-error" };
    assert.deepEqual(events, [
      { ...retry, attempt: 2, delayMs: 500 },
      { ...retry, attempt: 3, delayMs: 1_000 },
    ]);
    for (const event of events) {
      assertValidEvent(event);
    }
    assertNoKey(JSON.stringify(lines));
    assertNoKey(JSON.stringify(events));
  });

  it("logs a network retry with a null status", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { logger, lines } = recorder();
    let calls = 0;
    const fetch = (): Promise<Response> => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new TypeError(`connect failed ${KEYED_URL}`))
        : Promise.resolve(new Response("ok"));
    };
    await drive(
      t,
      request(context({ fetch, logger }), { url: KEYED_URL, method: "GET", retry: "safe" }),
    );
    const warn = lines.find((line) => line.level === "warn");
    assert.equal(warn?.fields?.["reason"], "network");
    assert.equal(warn?.fields?.["status"], null);
    assertNoKey(JSON.stringify(lines));
  });

  it("returns the same response when the logger and onEvent throw on every call (decision 0010)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const logger: Logger = { debug: throwing, info: throwing, warn: throwing, error: throwing };
    const { fetch, urls } = answering(429, 503, 200);
    const response = await drive(
      t,
      request(context({ fetch, logger, onEvent: throwing }), {
        url: KEYED_URL,
        method: "GET",
        retry: "safe",
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(urls.length, 3);
  });

  it("logs a throwing onEvent once per request at warn, with no key", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { logger, lines } = recorder();
    const { fetch } = answering(503, 503, 200);
    const onEvent = (): never => {
      throw new Error(`failed on ${KEYED_URL}`);
    };
    await drive(
      t,
      request(context({ fetch, logger, onEvent }), {
        url: KEYED_URL,
        method: "GET",
        retry: "safe",
      }),
    );
    const warnings = lines.filter((line) => line.fields?.["event"] === "verify.retry");
    assert.equal(warnings.length, 1);
    assertNoKey(JSON.stringify(lines));
  });

  it("never logs at error a failure it throws (R-DX-5)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { logger, lines } = recorder();
    const events: VerifyEvent[] = [];
    const { fetch } = answering(503);
    await assert.rejects(
      drive(
        t,
        request(context({ fetch, logger, onEvent: (e) => void events.push(e) }), {
          url: KEYED_URL,
          method: "GET",
          retry: "safe",
        }),
      ),
    );
    assert.equal(lines.filter((line) => line.level === "error").length, 0);
    assert.equal(events.length, 4);
    assert.ok(events.every((event) => event.type === "verify.retry"));
    assertNoKey(JSON.stringify(lines));
    assertNoKey(JSON.stringify(events));
  });

  it("returns the response with an async logger that rejects, and leaves no unhandled rejection", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const unhandled = watchUnhandled(t);
    const rejecting = rejectingMethod(`async log ${DUMMY_KEY}`);
    const logger: Logger = { debug: rejecting, info: rejecting, warn: rejecting, error: rejecting };
    const { fetch } = answering(503, 200);
    const response = await drive(
      t,
      request(context({ fetch, logger }), { url: KEYED_URL, method: "GET", retry: "safe" }),
    );
    await flush();
    await flush();
    assert.equal(response.status, 200);
    assert.deepEqual(unhandled, []);
  });

  for (const variant of ["sync", "async"] as const) {
    it(`survives an onEvent that redefines the event's type and then throws (${variant})`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const unhandled = watchUnhandled(t);
      const { logger, lines } = recorder();
      const onEvent =
        variant === "sync"
          ? redefineAndThrow
          : async (event: VerifyEvent): Promise<void> => {
              await Promise.resolve();
              redefineAndThrow(event);
            };
      const { fetch } = answering(503, 200);
      const response = await drive(
        t,
        request(context({ fetch, logger, onEvent }), {
          url: KEYED_URL,
          method: "GET",
          retry: "safe",
        }),
      );
      await flush();
      await flush();
      assert.equal(response.status, 200);
      assert.deepEqual(unhandled, []);
      const warning = lines.find((line) => line.fields?.["event"] === "verify.retry");
      assert.equal(warning?.fields?.["error"], "Error: callback failed");
    });
  }
});

/**
 * A logger method declared as `void`, as `Logger` declares it, whose body returns a rejected
 * promise, as an async method does.
 */
function rejectingMethod(text: string): (message: string) => void {
  function method(message: string): void;
  function method(): unknown {
    return Promise.reject(new Error(text));
  }
  return method;
}

/** An onEvent that tries to redefine the event's `type` as a throwing getter, then throws. */
function redefineAndThrow(event: VerifyEvent): void {
  try {
    Object.defineProperty(event, "type", {
      get(): never {
        throw new Error("type getter");
      },
    });
  } catch {
    // The event is frozen; the redefinition fails as it should.
  }
  throw new Error("callback failed");
}

/** Collects unhandled rejections for the rest of the test; the listener is removed after it. */
function watchUnhandled(t: TestContext): unknown[] {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", listener);
  t.after(() => {
    process.off("unhandledRejection", listener);
  });
  return seen;
}
