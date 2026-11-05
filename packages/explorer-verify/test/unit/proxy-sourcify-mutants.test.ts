// Tests added when the proxy-link code joined mutation testing (#194; R-FLOW-8, R-FLOW-4): each one
// fails on a code change in src/backends/proxy-sourcify.ts that the linkProxy() tests let pass.
// Each test calls the linker directly, with a fake fetch that answers in order.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LinkStep } from "../../src/backends/backend.ts";
import { sourcifyProxyLinker } from "../../src/backends/proxy-sourcify.ts";
import type { RouteOverride } from "../../src/types.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import {
  BOX,
  PROXY,
  SEPOLIA,
  assertUnexpected,
  json,
  rejection,
  setup,
} from "../helpers/proxy-link.ts";

const SOURCIFY: RouteOverride = { backend: "sourcify" };
const request = async (steps: Step[]): Promise<{ step: Promise<LinkStep>; calls: Call[] }> => {
  const { ctx, calls } = setup(SOURCIFY, steps);
  return await Promise.resolve({
    step: sourcifyProxyLinker.request({ chainId: SEPOLIA, address: PROXY }, ctx),
    calls,
  });
};
const resolution = (value: unknown, status = 200): Response =>
  json({ match: "exact_match", proxyResolution: value }, status);

describe("the Sourcify proxy lookup (R-FLOW-8, R-FLOW-4)", () => {
  it("sends one GET with fields=proxyResolution, and gives the one implementation as linked", async () => {
    const { step, calls } = await request([
      resolution({ isProxy: true, implementations: [{ address: BOX }] }),
    ]);
    assert.deepEqual(await step, { state: "linked", implementation: BOX });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "GET");
    assert.equal(
      calls[0]?.url,
      `https://sourcify.dev/server/v2/contract/${String(SEPOLIA)}/${PROXY}?fields=proxyResolution`,
    );
  });

  it("sends the lookup again after a 502, as a safe request (R-FLOW-6)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { step, calls } = await request([
      new Response("Bad Gateway", { status: 502 }),
      resolution({ isProxy: true, implementations: [{ address: BOX }] }),
    ]);
    await driveMockClock(step, () => {
      t.mock.timers.runAll();
    });
    assert.deepEqual(await step, { state: "linked", implementation: BOX });
    assert.equal(calls.length, 2);
  });

  it("gives not-linked with its reason for a proxy Sourcify has not verified", async () => {
    const { step } = await request([json({ match: null }, 404)]);
    assert.deepEqual(await step, {
      state: "not-linked",
      reason: "Sourcify has not verified the proxy: verify it there first.",
    });
  });

  it("throws unexpected-response for a 404 that is not JSON, or whose match is not null", async () => {
    for (const answer of [
      new Response("Not Found", { status: 404 }),
      json({ match: "exact_match" }, 404),
      json({ error: "not found" }, 404),
    ]) {
      const { step } = await request([answer]);
      assertUnexpected(
        await rejection(step),
        "sourcify",
        "Sourcify gave an answer to the proxy lookup that this client does not recognise (status 404).",
      );
    }
  });

  it("throws unexpected-response for a 200 that is not JSON", async () => {
    const { step } = await request([new Response("<html>busy</html>", { status: 200 })]);
    assertUnexpected(
      await rejection(step),
      "sourcify",
      "Sourcify gave an answer to the proxy lookup that this client does not recognise (status 200).",
    );
  });

  it("throws unexpected-response for a resolution with another 2xx status than 200", async () => {
    const { step } = await request([resolution({ isProxy: false }, 201)]);
    assertUnexpected(
      await rejection(step),
      "sourcify",
      "Sourcify gave an answer to the proxy lookup that this client does not recognise (status 201).",
    );
  });

  it("names Sourcify in proxy-link-unknown-state for several implementations", async () => {
    const { step } = await request([
      resolution({ isProxy: true, implementations: [{ address: BOX }, { address: PROXY }] }),
    ]);
    const error = await rejection(step);
    assert.equal(error.code, "proxy-link-unknown-state");
    assert.equal(
      error.details.code === "proxy-link-unknown-state" && error.details.backend,
      "sourcify",
    );
    assert.match(error.message, /^Sourcify reported a proxy link state/);
  });
});
