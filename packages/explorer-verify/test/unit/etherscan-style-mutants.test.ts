// Tests added when the Etherscan-style clients joined mutation testing (#194; R-BE-2, R-BE-5,
// R-FLOW-6): each one fails on a code change in src/backends/routescan.ts or
// etherscan-compatible.ts that the other client tests let pass. Each test calls the client
// directly, with a fake fetch that answers in order; retry waits run on mock timers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { Backend } from "../../src/backends/backend.ts";
import { etherscanCompatible } from "../../src/backends/etherscan-compatible.ts";
import { routescan } from "../../src/backends/routescan.ts";
import type { RouteOverride } from "../../src/types.ts";
import type { Call } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { PROXY, SEPOLIA, json, setup } from "../helpers/proxy-link.ts";

/**
 * Looks the proxy up with `client` on `route` on mock timers: a 502 first, then the answer for a
 * contract that is not verified.
 */
async function lookupAfter502(
  t: TestContext,
  client: Backend,
  route: RouteOverride,
): Promise<{ outcome: unknown; calls: Call[] }> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { ctx, calls } = setup(route, [
    new Response("Bad Gateway", { status: 502 }),
    json({ status: "1", message: "OK", result: [{ SourceCode: "", ABI: "" }] }),
  ]);
  const pending = client.lookup({ chainId: SEPOLIA, address: PROXY }, ctx).then(
    (value: unknown) => value,
    (error: unknown) => error,
  );
  await driveMockClock(
    pending,
    () => {
      t.mock.timers.runAll();
    },
    { maxTurns: 1_000 },
  );
  return { outcome: await pending, calls };
}

describe("lookups of the Etherscan-style clients are safe to send again (R-FLOW-6)", () => {
  it("Routescan sends its GET lookup again after a 502", async (t) => {
    const r = await lookupAfter502(t, routescan, {
      backend: "routescan",
      apiUrl: "https://api.routescan.io/v2/network/testnet/evm/11155111/etherscan/api",
    });
    assert.equal(r.outcome, undefined);
    assert.deepEqual(
      r.calls.map((call) => call.method),
      ["GET", "GET"],
    );
  });

  it("a standalone Etherscan-compatible explorer sends its GET lookup again after a 502", async (t) => {
    const r = await lookupAfter502(t, etherscanCompatible, {
      backend: "etherscan-compatible",
      apiUrl: "https://explorer.example.org/api",
    });
    assert.equal(r.outcome, undefined);
    assert.deepEqual(
      r.calls.map((call) => call.method),
      ["GET", "GET"],
    );
  });
});
