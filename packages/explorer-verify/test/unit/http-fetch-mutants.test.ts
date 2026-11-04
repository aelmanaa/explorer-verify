// Tests added after a mutation review of the HTTP layer (#109; R-FLOW-6): each one fails on a
// code change that the other HTTP tests let pass.
import assert from "node:assert/strict";
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
