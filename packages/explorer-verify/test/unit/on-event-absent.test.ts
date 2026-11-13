// verifyEach() and linkProxy() wrap the caller's onEvent to add a field or rename an event. Without
// onEvent there is nothing to wrap: a logger alone must not see the warning of a callback that
// threw (R-DX-5, R-DX-6, #384).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_DEPENDENCIES, DEFAULT_LINK_DEPENDENCIES } from "../../src/flow/defaults.ts";
import type { Hex, Logger, LogFields, VerifyInput } from "../../src/types.ts";
import { runLinkProxy, runVerifyEach } from "../helpers/defaults.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const SEPOLIA = 11155111;
const PROXY: Hex = "0xed5b8413e605598ef86cd7617f12701f74ca255c";
const BOX: Hex = "0x75038a8c55f5ec7196b54384fdbcffb1f2ce9920";
const GREETER: Hex = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const BLOCKSCOUT_API = "https://eth-sepolia.blockscout.com/api";

const nothing = (): void => undefined;

/** A logger that keeps every warning. */
function recording(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug: nothing,
      info: nothing,
      warn: (message: string, _fields?: LogFields) => {
        warnings.push(message);
      },
      error: nothing,
    },
  };
}

const INPUT: VerifyInput = {
  chainId: SEPOLIA,
  address: GREETER,
  compiler: {
    kind: "solc",
    version: "0.8.24+commit.e11b9ed9",
    input: {
      language: "Solidity",
      sources: { "src/Greeter.sol": { content: "contract Greeter {}" } },
      settings: {},
    },
  },
  contractName: "src/Greeter.sol:Greeter",
};

describe("a logger without onEvent (#384, R-DX-5)", () => {
  it("verifyEach() logs no callback warning", async () => {
    const { logger, warnings } = recording();
    const fake = replay(loadFixture("sourcify", "2026-11-02-lookup-exact-match"));
    const result = await runVerifyEach(
      INPUT,
      { backends: ["sourcify"], fetch: fake.fetch, logger },
      DEFAULT_DEPENDENCIES,
    );
    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0]?.ok, true);
    assert.deepEqual(warnings, []);
  });

  it("linkProxy() logs no callback warning, a retry included", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const { logger, warnings } = recording();
    const fake = replay(
      new Response("", { status: 503 }),
      loadFixture("blockscout", "2026-11-04-verifyproxycontract-accepted"),
      loadFixture("blockscout", "2026-11-04-checkproxyverification-linked"),
      new Response(
        JSON.stringify({
          is_verified: true,
          is_fully_verified: true,
          is_partially_verified: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const call = runLinkProxy(
      { chainId: SEPOLIA, address: PROXY },
      {
        timeoutMs: 60_000,
        pollIntervalMs: 3_000,
        route: { backend: "blockscout", apiUrl: BLOCKSCOUT_API },
        fetch: fake.fetch,
        logger,
      },
      DEFAULT_LINK_DEPENDENCIES,
    );
    await driveMockClock(call, () => {
      t.mock.timers.runAll();
    });
    const result = await call;
    assert.equal(result.status, "linked");
    assert.equal(fake.calls.at(-1)?.url, `${BLOCKSCOUT_API}/v2/smart-contracts/${BOX}`);
    // The retry warns on its own; no warning says a callback threw.
    assert.deepEqual(
      warnings.filter((message) => message.includes("onEvent")),
      [],
    );
  });
});
