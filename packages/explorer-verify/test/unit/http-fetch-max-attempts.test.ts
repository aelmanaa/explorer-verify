// `HttpContext.maxAttempts` of the HTTP layer: a caller such as the server handler sends fewer
// attempts than the default, so its retries and its client's do not multiply (R-FLOW-6).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "../../src/errors.ts";
import { MAX_ATTEMPTS, request } from "../../src/http/fetch.ts";
import type { HttpContext } from "../../src/http/fetch.ts";

function counting(status: number): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  return {
    fetch: async () => {
      calls += 1;
      return await Promise.resolve(new Response("{}", { status }));
    },
    calls: () => calls,
  };
}

async function rejection(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  try {
    await promise;
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError, String(error));
    return error;
  }
  throw new Error("the promise resolved");
}

describe("request: maxAttempts (R-FLOW-6)", () => {
  it("sends at most maxAttempts requests", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    for (const maxAttempts of [1, 2]) {
      const fake = counting(503);
      const pending = rejection(
        request(
          { backend: "etherscan-v2", secrets: [], fetch: fake.fetch, maxAttempts, random: () => 0 },
          { url: "https://api.example.org/", method: "GET", retry: "safe" },
        ),
      );
      for (let step = 0; step < 10; step += 1) {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        t.mock.timers.tick(1_000);
      }
      const error = await pending;
      assert.equal(error.code, "unexpected-response");
      assert.equal(fake.calls(), maxAttempts);
    }
  });

  it("refuses a maxAttempts that is not an integer from 1 to MAX_ATTEMPTS", async () => {
    for (const maxAttempts of [0, 1.5, MAX_ATTEMPTS + 1, Number.NaN]) {
      const fake = counting(200);
      const ctx: HttpContext = { backend: "sourcify", secrets: [], fetch: fake.fetch, maxAttempts };
      const error = await rejection(
        request(ctx, { url: "https://api.example.org/", method: "GET", retry: "safe" }),
      );
      assert.equal(error.code, "invalid-input");
      assert.match(error.message, /maxAttempts/);
      assert.equal(fake.calls(), 0);
    }
  });
});
