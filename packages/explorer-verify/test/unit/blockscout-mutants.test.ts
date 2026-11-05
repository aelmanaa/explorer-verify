// Tests added when the Blockscout client joined mutation testing (#194; R-BE-4, R-FLOW-4,
// R-FLOW-6): each one fails on a code change in src/backends/blockscout.ts that the other
// Blockscout tests let pass. Each test calls the client directly, with a fake fetch that answers
// in order; retry waits run on mock timers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { Context, ResolvedInput } from "../../src/backends/backend.ts";
import { blockscout } from "../../src/backends/blockscout.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { validateInput } from "../../src/input/validate.ts";
import type { Handle, RouteOverride } from "../../src/types.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { PROXY, SEPOLIA, json, recorder, setup } from "../helpers/proxy-link.ts";
import type { SetupOptions } from "../helpers/proxy-link.ts";

const BLOCKSCOUT: RouteOverride = {
  backend: "blockscout",
  apiUrl: "https://eth-sepolia.blockscout.com/api",
};
const LOOKUP_URL = `https://eth-sepolia.blockscout.com/api/v2/smart-contracts/${PROXY}`;
const JOB = "ed5b8413e605598ef86cd7617f12701f74ca255c6aeb80cb";
const HANDLE: Handle = {
  version: 1,
  backend: "blockscout",
  chainId: SEPOLIA,
  address: PROXY,
  jobId: JOB,
};
const FULL = (): Response =>
  json({ is_verified: true, is_fully_verified: true, is_partially_verified: false });
const NOT_FOUND = (): Response => json({ message: "Not found" }, 404);
const BAD_GATEWAY = (): Response => new Response("Bad Gateway", { status: 502 });
/** An answer of Blockscout's RPC API. */
const rpc = (status: string, result: unknown, http = 200): Response =>
  json({ status, message: status === "1" ? "OK" : "NOTOK", result }, http);

function input(): ResolvedInput {
  return validateInput({
    chainId: SEPOLIA,
    address: PROXY,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "contracts/Box.sol": { content: "contract Box {}" } },
        settings: {},
      },
    },
    contractName: "contracts/Box.sol:Box",
  });
}

/** Runs `call` with the client's context on mock timers, and gives what it settled with. */
async function run(
  t: TestContext,
  steps: Step[],
  call: (ctx: Context) => Promise<unknown>,
  options: SetupOptions = {},
): Promise<{ outcome: unknown; calls: Call[] }> {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { ctx, calls } = setup(BLOCKSCOUT, steps, options);
  const pending = call(ctx).then(
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

const lookup = async (
  t: TestContext,
  steps: Step[],
): Promise<{ outcome: unknown; calls: Call[] }> =>
  await run(
    t,
    steps,
    async (ctx) => await blockscout.lookup({ chainId: SEPOLIA, address: PROXY }, ctx),
  );
const submit = async (
  t: TestContext,
  steps: Step[],
): Promise<{ outcome: unknown; calls: Call[] }> =>
  await run(t, steps, async (ctx) => await blockscout.submit(input(), ctx));
const poll = async (t: TestContext, steps: Step[]): Promise<{ outcome: unknown; calls: Call[] }> =>
  await run(t, steps, async (ctx) => await blockscout.poll(HANDLE, ctx));

function errorOf(outcome: unknown, code: string): ExplorerVerifyError {
  assert.ok(
    outcome instanceof ExplorerVerifyError,
    `expected an error, got ${JSON.stringify(outcome)}`,
  );
  assert.equal(outcome.code, code, outcome.message);
  return outcome;
}

/** The method and URL of each request, with the form's action for a POST. */
function sent(calls: Call[]): string[] {
  return calls.map((call) =>
    call.method === "GET"
      ? `GET ${call.url}`
      : `POST ${String(new URLSearchParams(call.body).get("action"))}`,
  );
}

describe("the Blockscout lookup (R-BE-4, R-FLOW-4)", () => {
  it("sends the lookup again after a 502, as a safe request (R-FLOW-6)", async (t) => {
    const r = await lookup(t, [BAD_GATEWAY(), FULL()]);
    assert.equal(r.outcome, "exact");
    assert.deepEqual(sent(r.calls), [`GET ${LOOKUP_URL}`, `GET ${LOOKUP_URL}`]);
  });

  it("reads Not found as not verified only from a 404", async (t) => {
    assert.equal((await lookup(t, [NOT_FOUND()])).outcome, undefined);
    errorOf((await lookup(t, [json({ message: "Not found" })])).outcome, "unexpected-response");
  });

  it("reads the verification fields only from a 200", async (t) => {
    const full = json({ is_verified: true, is_fully_verified: true }, 404);
    errorOf((await lookup(t, [full])).outcome, "unexpected-response");
  });

  it("reads a contract with only its code as not verified only when is_verified is absent", async (t) => {
    const odd = json({ is_verified: "true", deployed_bytecode: "0x60" });
    errorOf((await lookup(t, [odd])).outcome, "unexpected-response");
    assert.equal((await lookup(t, [json({ deployed_bytecode: "0x60" })])).outcome, undefined);
  });
});

describe("the Blockscout submit (R-BE-4, R-FLOW-4)", () => {
  it("sends the submit once on a network error, then looks the contract up before sending it again", async (t) => {
    const r = await submit(t, [new TypeError("socket hang up"), NOT_FOUND(), rpc("1", JOB)]);
    assert.deepEqual(r.outcome, { state: "submitted", handle: HANDLE });
    assert.deepEqual(sent(r.calls), [
      "POST verifysourcecode",
      `GET ${LOOKUP_URL}`,
      "POST verifysourcecode",
    ]);
  });

  it("logs why a 500 leaves the submit unconfirmed, naming the submit", async (t) => {
    const lines: [string, string, unknown][] = [];
    const r = await run(
      t,
      [new Response("Internal Server Error", { status: 500 }), NOT_FOUND(), rpc("1", JOB)],
      async (ctx) => await blockscout.submit(input(), ctx),
      { logger: recorder(lines) },
    );
    assert.deepEqual(r.outcome, { state: "submitted", handle: HANDLE });
    assert.ok(
      lines.some(
        ([level, message]) =>
          level === "warn" &&
          message.startsWith(
            "Blockscout submit: Blockscout gave an answer to the submit that this client does not recognise (status 500).",
          ),
      ),
      JSON.stringify(lines),
    );
  });

  it("throws unexpected-response for a 400 that is not JSON, with no lookup", async (t) => {
    const r = await submit(t, [new Response("<html>Bad Request</html>", { status: 400 })]);
    assert.equal(
      errorOf(r.outcome, "unexpected-response").message,
      "Blockscout gave an answer to the submit that this client does not recognise (status 400).",
    );
    assert.equal(r.calls.length, 1);
  });

  it("reads an empty result as empty only from a 200 with status 1", async (t) => {
    for (const answer of [rpc("1", "", 400), rpc("0", "")]) {
      const r = await submit(t, [answer]);
      errorOf(r.outcome, "unexpected-response");
      assert.equal(r.calls.length, 1);
    }
  });

  it("looks the contract up at its address after Already verified", async (t) => {
    const r = await submit(t, [rpc("0", "Smart-contract already verified."), FULL()]);
    assert.deepEqual(r.outcome, { state: "already-verified", match: "exact" });
    assert.deepEqual(sent(r.calls), ["POST verifysourcecode", `GET ${LOOKUP_URL}`]);
  });

  it("says when Already verified is not confirmed by the lookup", async (t) => {
    const r = await submit(t, [rpc("0", "Smart-contract already verified."), NOT_FOUND()]);
    assert.equal(
      errorOf(r.outcome, "unexpected-response").message,
      "Blockscout answered that the contract is already verified, but a lookup found it not verified.",
    );
  });

  it("names the address when Blockscout answers that it is not a contract", async (t) => {
    const r = await submit(t, [rpc("0", "Address is not a smart-contract")]);
    const error = errorOf(r.outcome, "invalid-input");
    assert.equal(error.message, "The input is invalid: address.");
    assert.deepEqual(error.details, {
      code: "invalid-input",
      issues: [{ field: "address", message: "is not a contract, Blockscout answered" }],
    });
  });
});

describe("the Blockscout poll (R-BE-4, R-FLOW-4)", () => {
  it("sends the status request again after a 502, as a safe request (R-FLOW-6)", async (t) => {
    const r = await poll(t, [BAD_GATEWAY(), rpc("1", "Pending in queue")]);
    assert.deepEqual(r.outcome, { state: "pending" });
    assert.equal(r.calls.length, 2);
  });

  it("names the status request in unexpected-response", async (t) => {
    const r = await poll(t, [new Response("<html>busy</html>", { status: 200 })]);
    assert.equal(
      errorOf(r.outcome, "unexpected-response").message,
      "Blockscout gave an answer to the job status request that this client does not recognise (status 200).",
    );
  });

  it("names the job Blockscout does not know", async (t) => {
    const r = await poll(t, [rpc("0", "Unknown UID")]);
    assert.equal(
      errorOf(r.outcome, "job-not-found").message,
      `Blockscout does not know the verification job ${JOB}.`,
    );
  });
});
