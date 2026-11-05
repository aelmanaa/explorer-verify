// Tests added when the Etherscan client joined mutation testing (#194; R-BE-1, R-FLOW-4, R-FLOW-6,
// R-IN-5): each one fails on a code change in src/backends/etherscan.ts that the other Etherscan
// tests let pass. Each test calls the client directly, with a fake fetch that answers in order;
// retry waits run on mock timers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { Context, ResolvedInput } from "../../src/backends/backend.ts";
import { etherscan, rateLimited } from "../../src/backends/etherscan.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { validateInput } from "../../src/input/validate.ts";
import type { Handle, RouteOverride } from "../../src/types.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { BOX, PROXY, SEPOLIA, json, recorder, setup } from "../helpers/proxy-link.ts";
import type { SetupOptions } from "../helpers/proxy-link.ts";

const ETHERSCAN: RouteOverride = { backend: "etherscan-v2" };
const GUID = "wccgmdtjug6bss2mf166jzjtqcs4uchztznlevycg6mbwlxttz";
const HANDLE: Handle = {
  version: 1,
  backend: "etherscan-v2",
  chainId: SEPOLIA,
  address: PROXY,
  jobId: GUID,
};
const CODE = "0x6080604052";

/** An Etherscan answer: `status`, its usual message, and `result`. */
function answer(status: "0" | "1", result: unknown, http = 200): Response {
  return json({ status, message: status === "1" ? "OK" : "NOTOK", result }, http);
}

const NOT_VERIFIED = (): Response => answer("1", [{ SourceCode: "", ABI: "" }]);
const VERIFIED = (): Response => answer("1", [{ SourceCode: "contract Box {}" }]);
const HTML = (status: number): Response => new Response("<html>busy</html>", { status });

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

/** Runs `call` with an Etherscan context on mock timers, and gives what it settled with. */
async function run(
  t: TestContext,
  steps: Step[],
  call: (ctx: Context) => Promise<unknown>,
  options: SetupOptions = {},
): Promise<{ outcome: unknown; calls: Call[] }> {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const { ctx, calls } = setup(ETHERSCAN, steps, options);
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

function errorOf(outcome: unknown, code: string): ExplorerVerifyError {
  assert.ok(
    outcome instanceof ExplorerVerifyError,
    `expected an error, got ${JSON.stringify(outcome)}`,
  );
  assert.equal(outcome.code, code, outcome.message);
  return outcome;
}

/** The `action` and `address` of each form request. */
function actions(calls: Call[]): string[] {
  return calls.map((call) => {
    const form = new URLSearchParams(call.body);
    const address = form.get("address");
    return address === null
      ? String(form.get("action"))
      : `${String(form.get("action"))} ${address}`;
  });
}

const lookup = async (
  t: TestContext,
  steps: Step[],
): Promise<{ outcome: unknown; calls: Call[] }> =>
  await run(
    t,
    steps,
    async (ctx) => await etherscan.lookup({ chainId: SEPOLIA, address: PROXY }, ctx),
  );
const poll = async (t: TestContext, steps: Step[]): Promise<{ outcome: unknown; calls: Call[] }> =>
  await run(t, steps, async (ctx) => await etherscan.poll(HANDLE, ctx));
const creation = async (
  t: TestContext,
  steps: Step[],
): Promise<{ outcome: unknown; calls: Call[] }> =>
  await run(t, steps, async (ctx) => {
    assert.ok(etherscan.creationCode !== undefined);
    return await etherscan.creationCode({ chainId: SEPOLIA, address: PROXY }, ctx);
  });

const submit = async (
  t: TestContext,
  steps: Step[],
  options: SetupOptions = {},
): Promise<{ outcome: unknown; calls: Call[] }> =>
  await run(t, steps, async (ctx) => await etherscan.submit(input(), ctx), options);

/** A `getcontractcreation` record. */
function record(address: unknown, creationBytecode: unknown): Record<string, unknown> {
  return {
    contractAddress: address,
    contractCreator: BOX,
    txHash: `0x${"ab".repeat(32)}`,
    creationBytecode,
  };
}

/** Etherscan's answer for a contract it has no creation record of. */
function none(http: number): Response {
  return json({ status: "0", message: "No data found", result: null }, http);
}

describe("the Etherscan lookup (R-BE-1, R-FLOW-4)", () => {
  it("sends the lookup again after a 502, as a safe request (R-FLOW-6)", async (t) => {
    const r = await lookup(t, [HTML(502), VERIFIED()]);
    assert.equal(r.outcome, "exact");
    assert.equal(r.calls.length, 2);
  });

  it("names the lookup in unexpected-response", async (t) => {
    const r = await lookup(t, [HTML(200)]);
    assert.equal(
      errorOf(r.outcome, "unexpected-response").message,
      "Etherscan gave an answer to the lookup that this client does not recognise (status 200).",
    );
  });
});

describe("the Etherscan submit (R-BE-1, R-FLOW-4)", () => {
  it("sends the submit once on a network error, then looks the contract up at its address", async (t) => {
    const r = await submit(t, [new TypeError("socket hang up"), NOT_VERIFIED(), answer("1", GUID)]);
    assert.deepEqual(r.outcome, { state: "submitted", handle: HANDLE });
    assert.deepEqual(actions(r.calls), [
      "verifysourcecode",
      `getsourcecode ${PROXY}`,
      "verifysourcecode",
    ]);
  });

  it("logs why a 500 leaves the submit unconfirmed, naming the submit", async (t) => {
    const lines: [string, string, unknown][] = [];
    const r = await submit(t, [HTML(500), NOT_VERIFIED(), answer("1", GUID)], {
      logger: recorder(lines),
    });
    assert.deepEqual(r.outcome, { state: "submitted", handle: HANDLE });
    assert.ok(
      lines.some(
        ([level, message]) =>
          level === "warn" &&
          message.startsWith(
            "Etherscan submit: Etherscan gave an answer to the submit that this client does not recognise (status 500).",
          ),
      ),
      JSON.stringify(lines),
    );
  });

  it("throws unexpected-response for a 400 that is not JSON, with no lookup", async (t) => {
    const r = await submit(t, [HTML(400)]);
    assert.equal(
      errorOf(r.outcome, "unexpected-response").message,
      "Etherscan gave an answer to the submit that this client does not recognise (status 400).",
    );
    assert.equal(r.calls.length, 1);
  });

  it("reads a job id only from a 200 with status 1 and a text result", async (t) => {
    for (const each of [answer("1", GUID, 201), answer("0", GUID), answer("1", null)]) {
      const r = await submit(t, [each]);
      assert.equal(
        errorOf(r.outcome, "unexpected-response").message,
        `Etherscan gave an answer to the submit that this client does not recognise (status ${String(each.status)}).`,
      );
    }
  });

  it("says when Already Verified is not confirmed by the lookup", async (t) => {
    const r = await submit(t, [answer("0", "Already Verified"), NOT_VERIFIED()]);
    assert.equal(
      errorOf(r.outcome, "unexpected-response").message,
      "Etherscan answered that the contract is already verified, but a lookup found it not verified.",
    );
  });
});

describe("the Etherscan poll (R-BE-1, R-FLOW-4)", () => {
  it("reads each known text at the start of the result only", async (t) => {
    assert.deepEqual((await poll(t, [answer("0", "Pending in queue (2)")])).outcome, {
      state: "pending",
    });
    assert.deepEqual((await poll(t, [answer("1", "Pass - Verified (exact)")])).outcome, {
      state: "verified",
      match: "exact",
    });
    errorOf(
      (await poll(t, [answer("0", "Missing guid, check the request")])).outcome,
      "unexpected-response",
    );
  });

  it("names the job in unknown-state", async (t) => {
    const r = await poll(t, [answer("0", "Something new")]);
    assert.equal(
      errorOf(r.outcome, "unknown-state").message,
      `Etherscan reported a job state for ${GUID} that this client does not recognise; the result is not known.`,
    );
  });
});

describe("the Etherscan creation code (R-IN-5, R-FLOW-4)", () => {
  it("gives the code of the record for the contract, whatever the address case", async (t) => {
    const other = record(BOX, "0x6001");
    const own = record(`0x${PROXY.slice(2).toUpperCase()}`, CODE);
    const r = await creation(t, [answer("1", [null, other, own])]);
    assert.equal(r.outcome, CODE);
    assert.deepEqual(actions(r.calls), ["getcontractcreation"]);
    assert.equal(new URLSearchParams(r.calls[0]?.body).get("contractaddresses"), PROXY);
  });

  it("gives no code when no record is the contract's", async (t) => {
    assert.equal((await creation(t, [answer("1", [record(BOX, CODE)])])).outcome, undefined);
  });

  it("gives no code that is not 0x and whole bytes", async (t) => {
    for (const code of ["0x", "0x608", "6080", "zz0x6080", "0x6080zz", ["0x6080"], 6080]) {
      const r = await creation(t, [answer("1", [record(PROXY, code)])]);
      assert.equal(r.outcome, undefined, JSON.stringify(code));
    }
  });

  it("reads records only from a 200 with status 1", async (t) => {
    for (const each of [
      answer("1", [record(PROXY, CODE)], 201),
      answer("0", [record(PROXY, CODE)]),
    ]) {
      const r = await creation(t, [each]);
      assert.equal(
        errorOf(r.outcome, "unexpected-response").message,
        `Etherscan gave an answer to the creation code request that this client does not recognise (status ${String(each.status)}).`,
      );
    }
  });

  it("gives no code for No data found from a 200 only", async (t) => {
    assert.equal((await creation(t, [none(200)])).outcome, undefined);
    errorOf((await creation(t, [none(404)])).outcome, "unexpected-response");
    errorOf((await creation(t, [answer("0", "No data found")])).outcome, "unexpected-response");
  });

  it("throws unexpected-response for an answer that is not JSON", async (t) => {
    errorOf((await creation(t, [HTML(200)])).outcome, "unexpected-response");
  });
});

describe("rateLimited(): Etherscan's per-second limit answer (R-FLOW-6)", () => {
  const LIMIT = "Max calls per sec rate limit reached (5/sec)";

  it("reads the limit only from a text result that starts with it", () => {
    assert.equal(rateLimited(JSON.stringify({ status: "0", result: LIMIT })), true);
    assert.equal(rateLimited(JSON.stringify({ status: "0", result: `Note: ${LIMIT}` })), false);
    assert.equal(rateLimited(JSON.stringify({ status: "0", result: [LIMIT] })), false);
    assert.equal(rateLimited(JSON.stringify({ status: "0", message: LIMIT, result: "x" })), false);
    assert.equal(rateLimited(JSON.stringify(LIMIT)), false);
    assert.equal(rateLimited(`<html>${LIMIT}</html>`), false);
  });
});
