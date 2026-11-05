// Tests added when the proxy-link code joined mutation testing (#194; R-FLOW-8, R-FLOW-4): each one
// fails on a code change in src/backends/proxy-blockscout.ts that the linkProxy() tests let pass.
// Each test calls the linker directly, with a fake fetch that answers in order.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { LinkTarget, LinkVerdict } from "../../src/backends/backend.ts";
import { blockscoutProxyLinker } from "../../src/backends/proxy-blockscout.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import type { RouteOverride } from "../../src/types.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import {
  BOX,
  PROXY,
  SEPOLIA,
  assertUnexpected,
  json,
  recorder,
  rejection,
  setup,
} from "../helpers/proxy-link.ts";
import type { SetupOptions } from "../helpers/proxy-link.ts";

const BLOCKSCOUT: RouteOverride = {
  backend: "blockscout",
  apiUrl: "https://eth-sepolia.blockscout.com/api",
};
const UID = "ed5b8413e605598ef86cd7617f12701f74ca255c6aeb80cb";
const NOT_VERIFIED = "Smart-contract not found or is not verified";
const target: LinkTarget = { chainId: SEPOLIA, address: PROXY };
const answer = (status: "0" | "1", message: unknown, result: unknown, http = 200): Response =>
  json({ status, message, result }, http);
const accepted = (): Response => answer("1", "OK", UID);
const oneAttempt = (message: unknown = "Only one attempt in 10ms", http = 200): Response =>
  answer("0", message, null, http);
const lookup = (implementations: unknown, http = 200): Response =>
  json({ proxy_type: "eip1967", implementations }, http);
const linked = `The proxy's (${PROXY}) implementation contract is found at ${BOX} and is successfully updated.`;

/** Runs `request` on mock timers, so a repeat-interval wait passes at once. */
const request = async (
  t: TestContext,
  steps: Step[],
  options: SetupOptions & { readonly deadline?: number } = {},
): Promise<{ outcome: unknown; calls: Call[]; times: number[] }> => {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const times: number[] = [];
  const { ctx, calls } = setup(BLOCKSCOUT, steps, {
    ...options,
    before: () => {
      times.push(Date.now());
    },
  });
  const { deadline } = options;
  const call = blockscoutProxyLinker.request(target, {
    ...ctx,
    http: {
      ...ctx.http,
      ...(deadline === undefined ? {} : { budget: { deadline, timeoutMs: deadline } }),
    },
  });
  await driveMockClock(call, () => {
    t.mock.timers.runAll();
  });
  const outcome = await call.then(
    (value: unknown) => value,
    (error: unknown) => error,
  );
  return { outcome, calls, times };
};
const check = async (steps: Step[]): Promise<LinkVerdict> => {
  const { ctx } = setup(BLOCKSCOUT, steps);
  return await blockscoutProxyLinker.check(UID, target, ctx);
};
const expectUnexpected = (outcome: unknown, message: string): void => {
  assert.ok(
    outcome instanceof ExplorerVerifyError,
    `expected an error, got ${JSON.stringify(outcome)}`,
  );
  assertUnexpected(outcome, "blockscout", message);
};
const REQUEST_ANSWER = (status: number): string =>
  `Blockscout gave an answer to the proxy link request that this client does not recognise (status ${String(status)}).`;

describe("the Blockscout proxy link (R-FLOW-8, R-FLOW-4)", () => {
  it("sends a form POST with module=contract, as a safe request that is sent again after a 502", async (t) => {
    const r = await request(t, [new Response("Bad Gateway", { status: 502 }), accepted()]);
    assert.deepEqual(r.outcome, { state: "submitted", jobId: UID });
    assert.equal(r.calls.length, 2);
    assert.equal(r.calls[0]?.method, "POST");
    assert.equal(r.calls[0]?.headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(r.calls[0]?.body)), {
      module: "contract",
      action: "verifyproxycontract",
      address: PROXY,
    });
  });

  it("gives submitted only for status 1 and HTTP 200 with a uid of the documented form", async (t) => {
    for (const each of [answer("0", "NOTOK", UID), answer("1", "OK", UID, 201)]) {
      const r = await request(t, [each]);
      expectUnexpected(r.outcome, REQUEST_ANSWER(each.status));
    }
  });

  it("throws unexpected-response for a request answer that is not JSON", async (t) => {
    const r = await request(t, [new Response("<html>busy</html>", { status: 200 })]);
    expectUnexpected(r.outcome, REQUEST_ANSWER(200));
  });

  it("gives not-linked for a proxy it has not verified only with status 0 and HTTP 200", async (t) => {
    assert.deepEqual((await request(t, [answer("0", NOT_VERIFIED, null)])).outcome, {
      state: "not-linked",
      reason: NOT_VERIFIED,
    });
    for (const each of [answer("1", NOT_VERIFIED, null), answer("0", NOT_VERIFIED, null, 201)]) {
      const r = await request(t, [each]);
      expectUnexpected(r.outcome, REQUEST_ANSWER(each.status));
    }
  });

  it("waits only for the whole repeat-interval text, with status 0 and HTTP 200", async (t) => {
    for (const each of [
      oneAttempt("Note: Only one attempt in 10ms"),
      oneAttempt("Only one attempt in 10ms, then more"),
      oneAttempt("Only one attempt in 10ms", 201),
      answer("1", "Only one attempt in 10ms", null),
    ]) {
      const r = await request(t, [each, accepted()]);
      expectUnexpected(r.outcome, REQUEST_ANSWER(each.status));
      assert.equal(r.calls.length, 1);
    }
    // A message that is not text is not the repeat-interval refusal, even when its text would be.
    const list = await request(t, [oneAttempt(["Only one attempt in 10ms"]), accepted()]);
    expectUnexpected(list.outcome, REQUEST_ANSWER(200));
  });

  it("waits the interval and logs it at warn, then sends the request again", async (t) => {
    const lines: [string, string, unknown][] = [];
    const logger = recorder(lines);
    const r = await request(t, [oneAttempt(), accepted()], { logger });
    assert.deepEqual(r.outcome, { state: "submitted", jobId: UID });
    assert.deepEqual(r.times, [0, 10]);
    assert.deepEqual(
      lines.filter(([level]) => level !== "debug"),
      [
        [
          "warn",
          "Blockscout allows one proxy link request per 10 ms; sending it again then",
          { backend: "blockscout", delayMs: 10 },
        ],
      ],
    );
  });

  it("reads the record without waiting when the wait would end exactly at the deadline", async (t) => {
    const lines: [string, string, unknown][] = [];
    const r = await request(t, [oneAttempt(), lookup([{ address_hash: BOX }])], {
      deadline: 10,
      logger: recorder(lines),
    });
    assert.deepEqual(r.outcome, { state: "linked", implementation: BOX });
    assert.equal(r.calls[1]?.method, "GET");
    assert.equal(
      r.calls[1]?.url,
      `https://eth-sepolia.blockscout.com/api/v2/smart-contracts/${PROXY}`,
    );
    assert.deepEqual(
      lines.filter(([level]) => level === "info"),
      [
        [
          "info",
          "Blockscout refused another proxy link request; reading its record instead",
          { backend: "blockscout" },
        ],
      ],
    );
  });

  it("reads the record without a logger, as a safe request sent again after a 502", async (t) => {
    const r = await request(
      t,
      [
        oneAttempt("Only one attempt in 10000ms"),
        new Response("Bad Gateway", { status: 502 }),
        lookup([{ address_hash: BOX }]),
      ],
      { deadline: 5_000 },
    );
    assert.deepEqual(r.outcome, { state: "linked", implementation: BOX });
  });

  it("reads the record only from HTTP 200 with JSON", async (t) => {
    for (const each of [
      lookup([{ address_hash: BOX }], 201),
      new Response("<html>busy</html>", { status: 200 }),
    ]) {
      const r = await request(t, [oneAttempt(), each], { deadline: 5 });
      expectUnexpected(
        r.outcome,
        `Blockscout gave an answer to the lookup of the proxy that this client does not recognise (status ${String(each.status)}).`,
      );
    }
  });

  it("reads a check only from HTTP 200, and names the status request", async () => {
    const error = await rejection(check([answer("1", "OK", linked, 201)]));
    assertUnexpected(
      error,
      "blockscout",
      "Blockscout gave an answer to the proxy link status request that this client does not recognise (status 201).",
    );
  });

  it("gives linked from a check", async () => {
    assert.deepEqual(await check([answer("1", "OK", linked)]), {
      state: "linked",
      implementation: BOX,
    });
  });
});
