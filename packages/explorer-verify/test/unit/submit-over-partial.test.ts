// The submitOverPartial option (#294, decision 0067; R-FLOW-1, R-FLOW-4, R-FLOW-7, R-IN-6). The
// answers in test/fixtures/{sourcify,blockscout}/2026-11-11-* were recorded live on Ethereum
// Sepolia on 2026-11-11, from contracts deployed for the probe: a partial match of the contract's
// own source first, then a submit over it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { DEFAULT_DEPENDENCIES } from "../../src/flow/defaults.ts";
import { eachOptionKeys } from "../../src/flow/verify-each.ts";
import { verifyOptionKeys } from "../../src/flow/verify.ts";
import { ExplorerVerifyError } from "../../src/index.ts";
import type {
  CheckStatusOptions,
  LogFields,
  VerifyEachOptions,
  VerifyEachResult,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
} from "../../src/index.ts";
import type { Hex, VerifyResult } from "../../src/types.ts";
import * as run from "../helpers/defaults.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const SEPOLIA = 11155111;
// The probe contracts of 2026-11-11: one for Sourcify, one for Blockscout.
const SOURCIFY_PROBE: Hex = "0x6c7ff2cf19865fa06523c01bc76dc4c68f16a7b1";
const BLOCKSCOUT_PROBE: Hex = "0xdce2c184bfa3baecf2fbfc85248563e6b03d5360";
// The second of two identical Etherscan probes: Etherscan gave it a Similar Match of the first.
const SIMILAR: Hex = "0xc00d59930cfe782876cb11d671738b2e5885fff0";
const VERSION = "0.8.30+commit.73712a01";
const SOURCIFY_PAGE = `https://repo.sourcify.dev/${String(SEPOLIA)}/${SOURCIFY_PROBE}`;
const BLOCKSCOUT_PAGE = `https://eth-sepolia.blockscout.com/address/${BLOCKSCOUT_PROBE}?tab=contract`;
const ETHERSCAN_KEY = "0123456789abcdef0123456789abcdef";
const ROUTESCAN_KEY = "fedcba9876543210fedcba9876543210";

function input(address: Hex, name: string): VerifyInput {
  return {
    chainId: SEPOLIA,
    address,
    compiler: {
      kind: "solc",
      version: VERSION,
      input: {
        language: "Solidity",
        sources: { [`src/${name}.sol`]: { content: `contract ${name} {}` } },
        settings: {},
      },
    },
    contractName: `src/${name}.sol:${name}`,
  };
}

const sourcifyInput = (): VerifyInput => input(SOURCIFY_PROBE, "Probe294S");
const blockscoutInput = (): VerifyInput => input(BLOCKSCOUT_PROBE, "Probe294B");

/** The recorded answer of `test/fixtures/<backend>/2026-11-11-<name>.json`. */
function recorded(backend: string, name: string): Step {
  return loadFixture(backend, `2026-11-11-${name}`);
}

/** A JSON response. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A logger that keeps each line with its level. */
function lines(): {
  logger: Record<"debug" | "info" | "warn" | "error", (m: string, f?: LogFields) => void>;
  seen: [string, string, LogFields | undefined][];
} {
  const seen: [string, string, LogFields | undefined][] = [];
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      seen.push([level, message, fields]);
    };
  return {
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    seen,
  };
}

/** Runs `verify()` on the mock clock, so polls do not wait. */
async function verifyOnClock(
  t: TestContext,
  value: VerifyInput,
  options: VerifyOptions,
): Promise<VerifyResult> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const pending = run.runVerify(value, options, DEFAULT_DEPENDENCIES);
  await driveMockClock(pending, () => {
    t.mock.timers.runAll();
  });
  return await pending;
}

/** Whether a request is a submit. */
function submits(calls: readonly Call[]): number {
  return calls.filter(
    (call) =>
      (call.method === "POST" && call.url.includes("/v2/verify/")) ||
      new URLSearchParams(call.body).get("action") === "verifysourcecode",
  ).length;
}

describe("R-FLOW-1: submitOverPartial submits over a partial match of this source (recorded 2026-11-11)", () => {
  it("R-FLOW-1: Sourcify's match lookup with submitOverPartial gives one submit and verified, exact from the job", async (t) => {
    const fake = replay(
      recorded("sourcify", "lookup-probe-partial"),
      recorded("sourcify", "submit-exact-over-partial"),
      recorded("sourcify", "job-exact-over-partial"),
    );
    const log = lines();
    const events: VerifyEvent[] = [];
    const result = await verifyOnClock(t, sourcifyInput(), {
      fetch: fake.fetch,
      route: { backend: "sourcify" },
      submitOverPartial: true,
      logger: log.logger,
      onEvent: (event) => {
        events.push(event);
      },
    });
    assert.deepEqual(result, {
      status: "verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: SOURCIFY_PAGE,
    });
    assert.equal(submits(fake.calls), 1);
    assert.equal(fake.calls.length, 3);
    assert.ok(
      log.seen.some(
        ([level, message]) =>
          level === "info" &&
          message ===
            "sourcify holds a partial match of this source; submitting over it (submitOverPartial).",
      ),
    );
    // The lookup event reports the grade the lookup found, as without the option.
    assert.deepEqual(
      events.find((event) => event.type === "verify.lookup"),
      { type: "verify.lookup", backend: "sourcify", lookup: "partial" },
    );
  });

  it("R-FLOW-1: the same lookup without the option returns already-verified, partial, with no submit", async () => {
    for (const submitOverPartial of [undefined, false]) {
      const fake = replay(recorded("sourcify", "lookup-probe-partial"));
      const result = await run.runVerify(
        sourcifyInput(),
        { fetch: fake.fetch, route: { backend: "sourcify" }, submitOverPartial },
        DEFAULT_DEPENDENCIES,
      );
      assert.deepEqual(result, {
        status: "already-verified",
        backend: "sourcify",
        match: "partial",
        explorerUrl: SOURCIFY_PAGE,
      });
      assert.equal(fake.calls.length, 1);
    }
  });

  it("R-FLOW-1: an exact lookup with the option sends no submit", async () => {
    const fake = replay(recorded("blockscout", "lookup-probe-full-after-pass"));
    const result = await run.runVerify(
      blockscoutInput(),
      { fetch: fake.fetch, route: { backend: "blockscout" }, submitOverPartial: true },
      DEFAULT_DEPENDENCIES,
    );
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "blockscout",
      match: "exact",
      explorerUrl: BLOCKSCOUT_PAGE,
    });
    assert.equal(fake.calls.length, 1);
  });

  it("Blockscout: the exact source over the partial match gives verified, exact", async (t) => {
    const fake = replay(
      recorded("blockscout", "lookup-probe-partial"),
      recorded("blockscout", "verifysourcecode-exact-over-partial"),
      recorded("blockscout", "checkverifystatus-exact-over-partial-pass"),
      recorded("blockscout", "lookup-probe-full-after-pass"),
    );
    const result = await verifyOnClock(t, blockscoutInput(), {
      fetch: fake.fetch,
      route: { backend: "blockscout" },
      submitOverPartial: true,
    });
    assert.deepEqual(result, {
      status: "verified",
      backend: "blockscout",
      match: "exact",
      explorerUrl: BLOCKSCOUT_PAGE,
    });
    assert.equal(submits(fake.calls), 1);
  });

  it("a match of another contract's source submits with or without the option, as before", async (t) => {
    const fake = replay(
      loadFixture("sourcify", "2026-11-10-lookup-simple-storage"),
      json(409, { customCode: "already_verified", message: "The contract is already verified." }),
    );
    const result = await verifyOnClock(
      t,
      input("0xa67a1256b513afa0cbd89671bd0eca062117a3d9", "EvBox"),
      {
        fetch: fake.fetch,
        route: { backend: "sourcify" },
        submitOverPartial: true,
      },
    );
    assert.equal(result.status, "already-verified");
    assert.ok(result.status === "already-verified");
    assert.equal(result.match, "partial");
    assert.deepEqual(result.storedContract, {
      name: "simplestorage2.sol:SimpleStorage",
      compilerVersion: "0.8.33+commit.64118f21",
    });
  });
});

describe("R-FLOW-7: a refused submit over a partial match keeps already-verified, never failed (recorded 2026-11-11)", () => {
  it("R-FLOW-7: Sourcify's already_verified job after a partial lookup gives already-verified with the lookup's grade", async (t) => {
    const fake = replay(
      recorded("sourcify", "lookup-probe-partial"),
      recorded("sourcify", "submit-partial-over-partial"),
      recorded("sourcify", "job-partial-over-partial-already-verified"),
      recorded("sourcify", "lookup-probe-partial-after-job"),
    );
    const log = lines();
    const result = await verifyOnClock(t, sourcifyInput(), {
      fetch: fake.fetch,
      route: { backend: "sourcify" },
      submitOverPartial: true,
      logger: log.logger,
    });
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "sourcify",
      match: "partial",
      explorerUrl: SOURCIFY_PAGE,
    });
    assert.equal(submits(fake.calls), 1);
    // An already-verified answer is no rejection: no warn line.
    assert.ok(!log.seen.some(([level]) => level === "warn"), JSON.stringify(log.seen));
  });

  it("R-FLOW-7: Blockscout's Fail - Unable to verify over the partial match gives already-verified, partial", async (t) => {
    const fake = replay(
      recorded("blockscout", "lookup-probe-partial"),
      recorded("blockscout", "verifysourcecode-partial-over-partial"),
      recorded("blockscout", "checkverifystatus-partial-over-partial-fail"),
    );
    const log = lines();
    const result = await verifyOnClock(t, blockscoutInput(), {
      fetch: fake.fetch,
      route: { backend: "blockscout" },
      submitOverPartial: true,
      logger: log.logger,
    });
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "blockscout",
      match: "partial",
      explorerUrl: BLOCKSCOUT_PAGE,
    });
    const warn = log.seen.find(([level]) => level === "warn");
    assert.deepEqual(warn, [
      "warn",
      "blockscout rejected the submit over the partial match (Fail - Unable to verify); the partial match stays.",
      { backend: "blockscout" },
    ]);
  });

  it("the same Fail without a submit over a partial match is still failed", async (t) => {
    const fake = replay(
      loadFixture("blockscout", "2026-11-04-lookup-not-found"),
      recorded("blockscout", "verifysourcecode-partial-over-partial"),
      recorded("blockscout", "checkverifystatus-partial-over-partial-fail"),
    );
    const result = await verifyOnClock(t, blockscoutInput(), {
      fetch: fake.fetch,
      route: { backend: "blockscout" },
      submitOverPartial: true,
    });
    assert.deepEqual(result, {
      status: "failed",
      backend: "blockscout",
      reason: "Fail - Unable to verify",
    });
  });

  it("Sourcify's 409 after a lookup that still answered match gives already-verified, exact", async (t) => {
    const fake = replay(
      recorded("sourcify", "lookup-probe-partial-lagging"),
      recorded("sourcify", "submit-exact-already-verified"),
    );
    const result = await verifyOnClock(t, sourcifyInput(), {
      fetch: fake.fetch,
      route: { backend: "sourcify" },
      submitOverPartial: true,
    });
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: SOURCIFY_PAGE,
    });
  });

  it("R-FLOW-7: Etherscan's Already Verified job over its Similar Match gives already-verified, partial (recorded)", async (t) => {
    const fake = replay(
      loadFixture("etherscan", "2026-11-11-getsourcecode-similar-match"),
      loadFixture("etherscan", "2026-11-11-verifysourcecode-over-similar-match"),
      loadFixture("etherscan", "2026-11-11-checkverifystatus-over-similar-match-pending"),
      loadFixture("etherscan", "2026-11-11-checkverifystatus-over-similar-match-already-verified"),
      loadFixture("etherscan", "2026-11-11-getsourcecode-similar-match"),
    );
    const result = await verifyOnClock(t, input(SIMILAR, "Probe294E"), {
      fetch: fake.fetch,
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
      submitOverPartial: true,
    });
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "etherscan-v2",
      match: "partial",
      explorerUrl: `https://sepolia.etherscan.io/address/${SIMILAR}#code`,
    });
    assert.equal(submits(fake.calls), 1);
  });

  it("Etherscan: an already-verified submit answer after a Similar Match lookup gives already-verified, partial", async (t) => {
    const fake = replay(
      loadFixture("etherscan", "2026-11-11-getsourcecode-similar-match"),
      json(200, { status: "0", message: "NOTOK", result: "Contract source code already verified" }),
      loadFixture("etherscan", "2026-11-11-getsourcecode-similar-match"),
    );
    const result = await verifyOnClock(t, input(SIMILAR, "Probe294E"), {
      fetch: fake.fetch,
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
      submitOverPartial: true,
    });
    assert.equal(result.status, "already-verified");
    assert.ok(result.status === "already-verified");
    assert.equal(result.match, "partial");
    assert.equal(submits(fake.calls), 1);
  });

  it("Routescan: every match is partial, so the option submits over it and Pass - Verified gives verified, partial", async (t) => {
    const stored = (): Response =>
      json(200, {
        status: "1",
        message: "OK",
        result: [
          {
            SourceCode: "contract Probe294S {}",
            ContractName: "Probe294S",
            CompilerVersion: `v${VERSION}`,
          },
        ],
      });
    const fake = replay(
      stored(),
      json(200, { status: "1", message: "OK", result: "539086e9-66ce-5c8a-86a8-e58746d157e1" }),
      json(200, { status: "1", message: "OK", result: "Pass - Verified" }),
    );
    const result = await verifyOnClock(t, sourcifyInput(), {
      fetch: fake.fetch,
      route: { backend: "routescan" },
      apiKeys: { routescan: ROUTESCAN_KEY },
      submitOverPartial: true,
    });
    assert.equal(result.status, "verified");
    assert.ok(result.status === "verified");
    assert.equal(result.match, "partial");
    assert.equal(submits(fake.calls), 1);
  });
});

describe("R-FLOW-4: after a submit over a partial match, that match does not confirm the job", () => {
  it("a lookup after the budget ran out that finds only the earlier partial match gives not-confirmed", async (t) => {
    let calls = 0;
    // The lookup, the accepted submit, then pending polls until the budget runs out; every GET
    // after the first is the lookup after polling, which finds the partial match again.
    const answer: typeof fetch = async (_target, init) => {
      calls += 1;
      if ((init?.method ?? "GET") === "GET") {
        return recordedResponse("lookup-probe-partial");
      }
      return calls === 2
        ? recordedResponse("verifysourcecode-exact-over-partial")
        : json(200, { status: "1", message: "OK", result: "Pending in queue" });
    };
    await assert.rejects(
      verifyOnClock(t, blockscoutInput(), {
        fetch: answer,
        route: { backend: "blockscout" },
        submitOverPartial: true,
        timeoutMs: 20_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ExplorerVerifyError);
        assert.equal(error.code, "not-confirmed");
        assert.match(
          error.message,
          /a last lookup found only the partial match that was there before the submit\.$/,
        );
        return true;
      },
    );
  });

  it("a forgotten job whose lookup finds only the earlier partial match gives job-not-found", async (t) => {
    const fake = replay(
      recorded("blockscout", "lookup-probe-partial"),
      recorded("blockscout", "verifysourcecode-exact-over-partial"),
      loadFixture("blockscout", "2026-11-04-checkverifystatus-unknown-uid"),
      recorded("blockscout", "lookup-probe-partial"),
    );
    await assert.rejects(
      verifyOnClock(t, blockscoutInput(), {
        fetch: fake.fetch,
        route: { backend: "blockscout" },
        submitOverPartial: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ExplorerVerifyError);
        assert.equal(error.code, "job-not-found");
        assert.match(
          error.message,
          /and a lookup found only the partial match that was there before the submit\.$/,
        );
        return true;
      },
    );
  });

  it("a forgotten job whose lookup finds an exact match gives verified, exact", async (t) => {
    const fake = replay(
      recorded("blockscout", "lookup-probe-partial"),
      recorded("blockscout", "verifysourcecode-exact-over-partial"),
      loadFixture("blockscout", "2026-11-04-checkverifystatus-unknown-uid"),
      recorded("blockscout", "lookup-probe-full-after-pass"),
    );
    const result = await verifyOnClock(t, blockscoutInput(), {
      fetch: fake.fetch,
      route: { backend: "blockscout" },
      submitOverPartial: true,
    });
    assert.deepEqual(result, {
      status: "verified",
      backend: "blockscout",
      match: "exact",
      explorerUrl: BLOCKSCOUT_PAGE,
    });
  });

  it("a submit with no clear answer sends the submit again when the lookup finds only the partial match", async (t) => {
    const fake = replay(
      recorded("sourcify", "lookup-probe-partial"),
      new Response("bad gateway", { status: 502 }),
      recorded("sourcify", "lookup-probe-partial"),
      recorded("sourcify", "submit-exact-over-partial"),
      recorded("sourcify", "job-exact-over-partial"),
    );
    const result = await verifyOnClock(t, sourcifyInput(), {
      fetch: fake.fetch,
      route: { backend: "sourcify" },
      submitOverPartial: true,
    });
    assert.equal(result.status, "verified");
    assert.equal(submits(fake.calls), 2);
  });
});

/** The recorded Blockscout answer `2026-11-11-<name>` as a new `Response`. */
function recordedResponse(name: string): Response {
  const { response } = loadFixture("blockscout", `2026-11-11-${name}`);
  return json(response.status, response.body);
}

describe("R-IN-6: submitOverPartial in the strict option keys (decision 0047)", () => {
  it("verify(), verifyEach(), dryRun(), checkStatus() and linkProxy() accept the key", () => {
    assert.ok(verifyOptionKeys().includes("submitOverPartial"));
    assert.ok(eachOptionKeys().includes("submitOverPartial"));
  });

  it("a value that is not a boolean throws invalid-input naming the option", async () => {
    for (const value of ["true", 1, null]) {
      const options: VerifyOptions = { fetch: async () => assert.fail("no request expected") };
      Reflect.set(options, "submitOverPartial", value);
      await assert.rejects(
        run.runVerify(sourcifyInput(), options, DEFAULT_DEPENDENCIES),
        (error: unknown) => {
          assert.ok(error instanceof ExplorerVerifyError);
          assert.deepEqual(error.details, {
            code: "invalid-input",
            issues: [{ field: "submitOverPartial", message: "must be a boolean" }],
          });
          return true;
        },
      );
    }
  });

  it("a misspelled key names the option", async () => {
    const options: VerifyOptions = { fetch: async () => assert.fail("no request expected") };
    Reflect.set(options, "submitOverPartials", true);
    await assert.rejects(
      run.runVerify(sourcifyInput(), options, DEFAULT_DEPENDENCIES),
      (error: unknown) => {
        assert.ok(error instanceof ExplorerVerifyError);
        assert.deepEqual(error.details, {
          code: "invalid-input",
          issues: [
            {
              field: "submitOverPartials",
              message: "is not a known option; did you mean submitOverPartial?",
            },
          ],
        });
        return true;
      },
    );
  });

  it("checkStatus() accepts an options object built for verify() with the option", async () => {
    const fake = replay(loadFixture("sourcify", "2026-11-02-job-exact-match"));
    const options: CheckStatusOptions = { fetch: fake.fetch };
    Reflect.set(options, "submitOverPartial", true);
    const result = await run.runCheckStatus(
      {
        version: 1,
        backend: "sourcify",
        chainId: SEPOLIA,
        address: "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc",
        jobId: "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718",
      },
      options,
      DEFAULT_DEPENDENCIES,
    );
    assert.equal(result.status, "verified");
  });

  it("verifyEach() passes the option to each backend", async (t) => {
    const fake = replay(
      recorded("sourcify", "lookup-probe-partial"),
      recorded("sourcify", "submit-exact-over-partial"),
      recorded("sourcify", "job-exact-over-partial"),
    );
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const options: VerifyEachOptions = {
      fetch: fake.fetch,
      backends: ["sourcify"],
      submitOverPartial: true,
    };
    const pending = run.runVerifyEach(sourcifyInput(), options, DEFAULT_DEPENDENCIES);
    await driveMockClock(pending, () => {
      t.mock.timers.runAll();
    });
    const result: VerifyEachResult = await pending;
    const [first] = result.outcomes;
    assert.ok(first !== undefined && first.ok);
    assert.equal(first.result.status, "verified");
    assert.equal(submits(fake.calls), 1);
  });
});
