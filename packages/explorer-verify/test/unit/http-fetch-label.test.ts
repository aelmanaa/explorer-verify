// The HTTP layer's `label` for requests that do not go to a backend, such as the caller's JSON-RPC
// endpoint or IPFS gateway (#134, R-DX-5, R-DX-6, R-SEC-1). Log lines carry the label in place of
// a backend name, retries are logged at warn without a `verify.retry` event, and errors still
// name the context's backend. No network: an injected fetch answers, on mock timers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";

import { ExplorerVerifyError } from "../../src/errors.ts";
import { request } from "../../src/http/fetch.ts";
import type { HttpContext, RequestLabel } from "../../src/http/fetch.ts";
import { createObserver } from "../../src/observe.ts";
import type { LogFields, Logger, VerifyEvent } from "../../src/types.ts";

// Fake keys. Never real ones (R-SEC-1).
const PATH_KEY = "labelpathsecret0123456789";
const QUERY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const SECRETS = [PATH_KEY, QUERY_KEY];
const KEYED_URL = `https://rpc.example.org/v2/${PATH_KEY}?apikey=${QUERY_KEY}`;
const LOGGED_URL = "https://rpc.example.org/v2/[redacted]?REDACTED";

interface Line {
  readonly level: keyof Logger;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/** A logger that records each line. */
function recorder(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: keyof Logger) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields });
    };
  return {
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    lines,
  };
}

/** A fetch that answers with each status in turn, repeating the last, and echoes the URL. */
function answering(...statuses: number[]): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fake = (): Promise<Response> => {
    calls += 1;
    const status = statuses[Math.min(calls, statuses.length) - 1] ?? 200;
    return Promise.resolve(new Response(`{"echo":"${KEYED_URL}"}`, { status }));
  };
  return { fetch: fake, calls: () => calls };
}

/** Runs the mock timers until `promise` settles. */
async function drive<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  const state = { done: false };
  const tracked = promise.finally(() => {
    state.done = true;
  });
  tracked.catch(() => {});
  for (let round = 0; round < 1_000 && !state.done; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    t.mock.timers.runAll();
  }
  return await tracked;
}

/** A context for `label`, with a logger and an event list behind one observer. */
function labelled(
  label: RequestLabel | undefined,
  send: typeof fetch,
): { ctx: HttpContext; lines: Line[]; events: VerifyEvent[] } {
  const { logger, lines } = recorder();
  const events: VerifyEvent[] = [];
  const observer = createObserver({
    logger,
    onEvent: (event) => {
      events.push(event);
    },
    secrets: SECRETS,
  });
  const ctx: HttpContext = {
    backend: "etherscan-v2",
    ...(label === undefined ? {} : { label }),
    secrets: SECRETS,
    fetch: send,
    observer,
    random: () => 0,
  };
  return { ctx, lines, events };
}

/** Fails when a dummy key appears in `text`. */
function assertNoKey(text: string): void {
  for (const secret of SECRETS) {
    assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `key in ${text}`);
  }
}

describe("request: a label in place of a backend name (#134, R-DX-5, R-DX-6)", () => {
  for (const label of ["rpc", "ipfs"] as const) {
    it(`logs ${label} retries at warn with the label, no backend and no key`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const { fetch } = answering(503, 429, 200);
      const { ctx, lines, events } = labelled(label, fetch);
      const response = await drive(
        t,
        request(ctx, { url: KEYED_URL, method: "POST", body: "{}", retry: "safe" }),
      );
      assert.equal(response.status, 200);
      const where = { label, method: "POST", url: LOGGED_URL };
      assert.deepEqual(
        lines.map((line) => [line.level, line.fields]),
        [
          ["debug", { ...where, attempt: 1 }],
          ["warn", { ...where, attempt: 2, reason: "server-error", status: 503, delayMs: 500 }],
          ["debug", { ...where, attempt: 2 }],
          ["warn", { ...where, attempt: 3, reason: "rate-limited", status: 429, delayMs: 1_000 }],
          ["debug", { ...where, attempt: 3 }],
        ],
      );
      assert.ok(lines.every((line) => line.fields !== undefined && !("backend" in line.fields)));
      assert.doesNotMatch(JSON.stringify(lines), /etherscan|sourcify/);
      // verify.retry names the backend a request goes to; these requests go to none.
      assert.deepEqual(events, []);
      assertNoKey(JSON.stringify(lines));
    });
  }

  it("still names the context's backend in an error, with no key in it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { fetch, calls } = answering(503);
    const { ctx, lines, events } = labelled("rpc", fetch);
    const error = await drive(
      t,
      request(ctx, { url: KEYED_URL, method: "GET", retry: "safe" }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(error.code, "unexpected-response");
    assert.equal(
      error.details.code === "unexpected-response" && error.details.backend,
      "etherscan-v2",
    );
    assert.equal(calls(), 5);
    assert.equal(lines.filter((line) => line.level === "warn").length, 4);
    assert.equal(lines.filter((line) => line.level === "error").length, 0);
    assert.deepEqual(events, []);
    assertNoKey(JSON.stringify(lines));
    assertNoKey(`${error.message} ${JSON.stringify(error.details)}`);
  });

  it("logs the backend and emits verify.retry when no label is set", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { fetch } = answering(503, 200);
    const { ctx, lines, events } = labelled(undefined, fetch);
    await drive(t, request(ctx, { url: KEYED_URL, method: "GET", retry: "safe" }));
    assert.ok(lines.every((line) => line.fields?.["backend"] === "etherscan-v2"));
    assert.ok(lines.every((line) => line.fields !== undefined && !("label" in line.fields)));
    assert.deepEqual(events, [
      {
        type: "verify.retry",
        backend: "etherscan-v2",
        attempt: 2,
        reason: "server-error",
        delayMs: 500,
      },
    ]);
  });
});
