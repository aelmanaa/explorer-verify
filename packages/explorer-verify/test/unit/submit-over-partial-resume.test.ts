// The handle of a submit over a partial match, its resume with checkStatus(), the warn line on the
// Etherscan family and the dry run with the option (#294, decision 0067; R-FLOW-4, R-FLOW-5,
// R-FLOW-7, R-AX-8). The Sepolia answers in test/fixtures/*/2026-11-11-* were recorded live.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { DEFAULT_DEPENDENCIES } from "../../src/flow/defaults.ts";
import { splitHandle } from "../../src/flow/format-handle.ts";
import {
  ExplorerVerifyError,
  formatHandle,
  isHandleString,
  parseHandle,
  tryParseHandle,
} from "../../src/index.ts";
import type {
  CheckStatusOptions,
  Handle,
  LogFields,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
} from "../../src/index.ts";
import type { Hex, VerifyResult } from "../../src/types.ts";
import * as run from "../helpers/defaults.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import type { Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const SEPOLIA = 11155111;
const BLOCKSCOUT_PROBE: Hex = "0xdce2c184bfa3baecf2fbfc85248563e6b03d5360";
const SIMILAR: Hex = "0xc00d59930cfe782876cb11d671738b2e5885fff0";
const VERSION = "0.8.30+commit.73712a01";
const BLOCKSCOUT_JOB = "dce2c184bfa3baecf2fbfc85248563e6b03d53606af41c8c";
const ETHERSCAN_JOB = "sbi7gfxxkkbzakcvtsyrdf7xexuhep5kclw8fj3nbyyvfsuhmm";
const ROUTESCAN_JOB = "539086e9-66ce-5c8a-86a8-e58746d157e1";
const BLOCKSCOUT_PAGE = `https://eth-sepolia.blockscout.com/address/${BLOCKSCOUT_PROBE}?tab=contract`;
const ETHERSCAN_PAGE = `https://sepolia.etherscan.io/address/${SIMILAR}#code`;
const ETHERSCAN_KEY = "0123456789abcdef0123456789abcdef";
const ROUTESCAN_KEY = "fedcba9876543210fedcba9876543210";
const FAIL_TEXT = "Fail - Unable to verify. Compiled contract runtime bytecode does NOT match.";

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

/** A handle of a submit over a partial match. */
function overHandle(backend: Handle["backend"], address: Hex, jobId: string): Handle {
  return { version: 1, backend, chainId: SEPOLIA, address, jobId, overPartial: true };
}

/** A JSON response. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The recorded answer of `test/fixtures/<backend>/2026-11-11-<name>.json`. */
function recorded(backend: string, name: string): Step {
  return loadFixture(backend, `2026-11-11-${name}`);
}

/** Answers of Etherscan's `checkverifystatus`. */
const etherscanStatus = (result: string, status = "0"): Response =>
  json(200, { status, message: status === "1" ? "OK" : "NOTOK", result });
const NOT_VERIFIED = (): Response =>
  json(200, {
    status: "1",
    message: "OK",
    result: [{ SourceCode: "", ABI: "Contract source code not verified", ContractName: "" }],
  });
const BLOCKSCOUT_PENDING = (): Response =>
  json(200, { message: "OK", result: "Pending in queue", status: "1" });

/** A logger that keeps each line with its level and fields. */
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

/** Runs `pending()` on the mock clock, so polls and budgets pass at once. */
async function onClock<T>(t: TestContext, pending: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const running = pending();
  await driveMockClock(running, () => {
    t.mock.timers.runAll();
  });
  return await running;
}

async function resume(
  t: TestContext,
  handle: Handle | string,
  options: CheckStatusOptions,
): Promise<VerifyResult> {
  return await onClock(
    t,
    async () => await run.runCheckStatus(handle, options, DEFAULT_DEPENDENCIES),
  );
}

async function verifyOver(
  t: TestContext,
  value: VerifyInput,
  options: VerifyOptions,
): Promise<VerifyResult> {
  return await onClock(t, async () => await run.runVerify(value, options, DEFAULT_DEPENDENCIES));
}

describe("R-FLOW-5: the handle of a submit over a partial match (decision 0067)", () => {
  const plain: Handle = {
    version: 1,
    backend: "blockscout",
    chainId: SEPOLIA,
    address: BLOCKSCOUT_PROBE,
    jobId: BLOCKSCOUT_JOB,
  };
  const line = `ev1:blockscout:${String(SEPOLIA)}:${BLOCKSCOUT_PROBE}:${BLOCKSCOUT_JOB}`;

  it("writes :over-partial at the end of the one-line form and reads it back", () => {
    const over = overHandle("blockscout", BLOCKSCOUT_PROBE, BLOCKSCOUT_JOB);
    assert.equal(formatHandle(over), `${line}:over-partial`);
    assert.deepEqual(parseHandle(`${line}:over-partial`), over);
    assert.deepEqual(tryParseHandle(`${line}:over-partial`), over);
    assert.equal(isHandleString(`${line}:over-partial`), true);
    assert.deepEqual(parseHandle(over), over);
  });

  it("splits the marker off the job id, so the job id alone is redacted", () => {
    assert.deepEqual(splitHandle(`${line}:over-partial`), {
      prefix: `ev1:blockscout:${String(SEPOLIA)}:${BLOCKSCOUT_PROBE}:`,
      jobId: BLOCKSCOUT_JOB,
      overPartial: true,
    });
    assert.deepEqual(splitHandle(line), {
      prefix: `ev1:blockscout:${String(SEPOLIA)}:${BLOCKSCOUT_PROBE}:`,
      jobId: BLOCKSCOUT_JOB,
    });
  });

  it("keeps every handle without the marker as it was", () => {
    assert.equal(formatHandle(plain), line);
    assert.deepEqual(parseHandle(line), plain);
    assert.equal("overPartial" in parseHandle(line), false);
    assert.equal(isHandleString(line), true);
  });

  it("refuses another sixth part and an overPartial that is not true", () => {
    assert.equal(tryParseHandle(`${line}:over`), undefined);
    assert.equal(tryParseHandle(`${line}:over-partial:x`), undefined);
    for (const value of [false, "true", 1]) {
      assert.throws(
        () => parseHandle({ ...plain, overPartial: value }),
        (error: unknown) => {
          assert.ok(error instanceof ExplorerVerifyError);
          assert.deepEqual(error.details, {
            code: "invalid-input",
            issues: [{ field: "overPartial", message: "must be true when present" }],
          });
          return true;
        },
      );
    }
  });

  it("verify() over a partial match gives the marker in the event and in not-confirmed", async (t) => {
    const events: VerifyEvent[] = [];
    let calls = 0;
    const answer: typeof fetch = async (_target, init) => {
      calls += 1;
      if ((init?.method ?? "GET") === "GET") {
        return lookupPartial();
      }
      return calls === 2 ? submitAccepted() : BLOCKSCOUT_PENDING();
    };
    const error = await verifyOver(t, input(BLOCKSCOUT_PROBE, "Probe294B"), {
      fetch: answer,
      route: { backend: "blockscout" },
      submitOverPartial: true,
      timeoutMs: 20_000,
      onEvent: (event) => {
        events.push(event);
      },
    }).then(
      () => assert.fail("expected not-confirmed"),
      (reason: unknown) => reason,
    );
    assert.ok(ExplorerVerifyError.is(error, "not-confirmed"));
    assert.deepEqual(
      error.details.handle,
      overHandle("blockscout", BLOCKSCOUT_PROBE, BLOCKSCOUT_JOB),
    );
    assert.equal(error.toJSON().handle, `${line}:over-partial`);
    const submitted = events.find((event) => event.type === "verify.submitted");
    assert.ok(submitted?.type === "verify.submitted");
    assert.equal(submitted.handle, `${line}:over-partial`);
  });
});

/** A job that never ends, and every lookup finding Blockscout's recorded partial match. */
const pendingOverPartial: typeof fetch = async (_target, init) =>
  (init?.method ?? "GET") === "GET" ? lookupPartial() : BLOCKSCOUT_PENDING();

/** Blockscout's recorded partial lookup of the probe, as a new response. */
function lookupPartial(): Response {
  const { response } = loadFixture("blockscout", "2026-11-11-lookup-probe-partial");
  return json(response.status, response.body);
}

/** Blockscout's recorded acceptance of the exact source over the partial match. */
function submitAccepted(): Response {
  const { response } = loadFixture("blockscout", "2026-11-11-verifysourcecode-exact-over-partial");
  return json(response.status, response.body);
}

describe("R-FLOW-4, R-FLOW-7: checkStatus() resumes a submit over a partial match as verify() ends it", () => {
  const blockscout = overHandle("blockscout", BLOCKSCOUT_PROBE, BLOCKSCOUT_JOB);
  const route = { backend: "blockscout" } as const;

  it("a rejected job keeps the partial match: already-verified, partial, with the warn line", async (t) => {
    const fake = replay(recorded("blockscout", "checkverifystatus-partial-over-partial-fail"));
    const log = lines();
    const result = await resume(t, blockscout, { fetch: fake.fetch, route, logger: log.logger });
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "blockscout",
      match: "partial",
      explorerUrl: BLOCKSCOUT_PAGE,
    });
    assert.deepEqual(
      log.seen.find(([level]) => level === "warn"),
      [
        "warn",
        "Blockscout rejected the submit over the partial match (Fail - Unable to verify); the partial match stays.",
        { backend: "blockscout" },
      ],
    );
  });

  it("the same job from a handle without the marker is failed, as before", async (t) => {
    const fake = replay(recorded("blockscout", "checkverifystatus-partial-over-partial-fail"));
    const { overPartial, ...plain } = blockscout;
    assert.equal(overPartial, true);
    const result = await resume(t, plain, { fetch: fake.fetch, route });
    assert.deepEqual(result, {
      status: "failed",
      backend: "blockscout",
      reason: "Fail - Unable to verify",
      reasonCode: "unknown",
    });
  });

  it("a forgotten job whose lookup finds only the partial match gives job-not-found", async (t) => {
    const fake = replay(
      loadFixture("blockscout", "2026-11-04-checkverifystatus-unknown-uid"),
      recorded("blockscout", "lookup-probe-partial"),
    );
    await assert.rejects(
      resume(t, formatHandle(blockscout), { fetch: fake.fetch, route }),
      (error) => {
        assert.ok(ExplorerVerifyError.is(error, "job-not-found"));
        assert.match(
          error.message,
          /a lookup found only the partial match that was there before the submit\.$/,
        );
        assert.deepEqual(error.details.handle, blockscout);
        return true;
      },
    );
  });

  it("a budget that runs out with only the partial match gives not-confirmed", async (t) => {
    await assert.rejects(
      resume(t, blockscout, { fetch: pendingOverPartial, route, timeoutMs: 20_000 }),
      (error) => {
        assert.ok(ExplorerVerifyError.is(error, "not-confirmed"));
        assert.match(
          error.message,
          /a last lookup found only the partial match that was there before the submit\.$/,
        );
        return true;
      },
    );
  });

  it("a forgotten job whose lookup finds an exact match gives verified, exact", async (t) => {
    const fake = replay(
      loadFixture("blockscout", "2026-11-04-checkverifystatus-unknown-uid"),
      recorded("blockscout", "lookup-probe-full-after-pass"),
    );
    const result = await resume(t, blockscout, { fetch: fake.fetch, route });
    assert.deepEqual(result, {
      status: "verified",
      backend: "blockscout",
      match: "exact",
      explorerUrl: BLOCKSCOUT_PAGE,
    });
  });

  it("Etherscan: Fail with a Similar Match lookup gives already-verified, partial, with the reason in the warn line", async (t) => {
    const fake = replay(
      etherscanStatus(FAIL_TEXT),
      loadFixture("etherscan", "2026-11-11-getsourcecode-similar-match"),
    );
    const log = lines();
    const result = await resume(t, overHandle("etherscan-v2", SIMILAR, ETHERSCAN_JOB), {
      fetch: fake.fetch,
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
      logger: log.logger,
    });
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "etherscan-v2",
      match: "partial",
      explorerUrl: ETHERSCAN_PAGE,
    });
    assert.ok(
      log.seen.some(
        ([level, message]) =>
          level === "warn" &&
          message ===
            `Etherscan rejected the submit over the partial match (${FAIL_TEXT}); the partial match stays.`,
      ),
    );
  });

  it("Routescan: a forgotten job always ends job-not-found, since every Routescan match is partial", async (t) => {
    const stored = json(200, {
      status: "1",
      message: "OK",
      result: [
        {
          SourceCode: "contract Probe294R {}",
          ContractName: "Probe294R",
          CompilerVersion: `v${VERSION}`,
        },
      ],
    });
    const fake = replay(etherscanStatus("Verification not found"), stored);
    await assert.rejects(
      resume(t, overHandle("routescan", SIMILAR, ROUTESCAN_JOB), {
        fetch: fake.fetch,
        route: { backend: "routescan" },
        apiKeys: { routescan: ROUTESCAN_KEY },
      }),
      (error) => {
        assert.ok(ExplorerVerifyError.is(error, "job-not-found"));
        return true;
      },
    );
  });
});

/** The options of a call over Etherscan's Similar Match. */
function similarOptions(logger?: ReturnType<typeof lines>["logger"]): VerifyOptions {
  return {
    apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
    submitOverPartial: true,
    ...(logger === undefined ? {} : { logger }),
  };
}

describe("R-FLOW-7: the Etherscan family over a partial match (decision 0067)", () => {
  it("Fail, then a lookup that still finds the partial match: already-verified, partial, with the reason in the warn line", async (t) => {
    const fake = replay(
      loadFixture("etherscan", "2026-11-11-getsourcecode-similar-match"),
      loadFixture("etherscan", "2026-11-11-verifysourcecode-over-similar-match"),
      etherscanStatus(FAIL_TEXT),
      loadFixture("etherscan", "2026-11-11-getsourcecode-similar-match"),
    );
    const log = lines();
    const result = await verifyOver(t, input(SIMILAR, "Probe294E"), {
      ...similarOptions(log.logger),
      fetch: fake.fetch,
    });
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "etherscan-v2",
      match: "partial",
      explorerUrl: ETHERSCAN_PAGE,
    });
    assert.deepEqual(
      log.seen.find(([level]) => level === "warn"),
      [
        "warn",
        `Etherscan rejected the submit over the partial match (${FAIL_TEXT}); the partial match stays.`,
        { backend: "etherscan-v2" },
      ],
    );
  });

  it("Fail, then a lookup that finds the contract not verified: failed, since the newer lookup wins", async (t) => {
    const fake = replay(
      loadFixture("etherscan", "2026-11-11-getsourcecode-similar-match"),
      loadFixture("etherscan", "2026-11-11-verifysourcecode-over-similar-match"),
      etherscanStatus(FAIL_TEXT),
      NOT_VERIFIED(),
    );
    const log = lines();
    const result = await verifyOver(t, input(SIMILAR, "Probe294E"), {
      ...similarOptions(log.logger),
      fetch: fake.fetch,
    });
    assert.deepEqual(result, {
      status: "failed",
      backend: "etherscan-v2",
      reason: FAIL_TEXT,
      reasonCode: "bytecode-mismatch",
    });
    assert.deepEqual(
      log.seen.find(([level]) => level === "warn"),
      [
        "warn",
        `Etherscan rejected the submit over the partial match (${FAIL_TEXT}), and a lookup then found the contract not verified.`,
        { backend: "etherscan-v2" },
      ],
    );
  });

  it("the same Fail without the option logs no such line", async (t) => {
    const fake = replay(
      NOT_VERIFIED(),
      loadFixture("etherscan", "2026-11-11-verifysourcecode-over-similar-match"),
      etherscanStatus(FAIL_TEXT),
      NOT_VERIFIED(),
    );
    const log = lines();
    const result = await verifyOver(t, input(SIMILAR, "Probe294E"), {
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
      logger: log.logger,
      fetch: fake.fetch,
    });
    assert.equal(result.status, "failed");
    assert.ok(!log.seen.some(([, message]) => message.includes("submit over the partial match")));
  });

  it("a lookup after the budget ran out that finds an exact match gives verified, exact", async (t) => {
    let calls = 0;
    const answer: typeof fetch = async (_target, init) => {
      calls += 1;
      if ((init?.method ?? "GET") === "GET") {
        // The first lookup finds the partial match; the one after polling finds it exact.
        if (calls === 1) {
          return lookupPartial();
        }
        const { response } = loadFixture("blockscout", "2026-11-11-lookup-probe-full-after-pass");
        return json(response.status, response.body);
      }
      return calls === 2 ? submitAccepted() : BLOCKSCOUT_PENDING();
    };
    const result = await verifyOver(t, input(BLOCKSCOUT_PROBE, "Probe294B"), {
      fetch: answer,
      route: { backend: "blockscout" },
      submitOverPartial: true,
      timeoutMs: 20_000,
    });
    assert.deepEqual(result, {
      status: "verified",
      backend: "blockscout",
      match: "exact",
      explorerUrl: BLOCKSCOUT_PAGE,
    });
  });
});

describe("R-AX-8: dryRun() with submitOverPartial says the call would submit over the partial match", () => {
  it("words the log line by the option", async () => {
    for (const [submitOverPartial, expected] of [
      [
        true,
        "Dry run: Blockscout holds a partial match of this source, so a verification with submitOverPartial would submit over it. Nothing was submitted.",
      ],
      [
        undefined,
        "Dry run: Blockscout already holds the contract (partial match), so a verification would not submit unless submitOverPartial is set.",
      ],
    ] as const) {
      const fake = replay(recorded("blockscout", "lookup-probe-partial"));
      const log = lines();
      const result = await run.runDryRun(
        input(BLOCKSCOUT_PROBE, "Probe294B"),
        {
          fetch: fake.fetch,
          route: { backend: "blockscout" },
          logger: log.logger,
          submitOverPartial,
        },
        DEFAULT_DEPENDENCIES,
      );
      assert.equal(result.lookup, "partial");
      assert.ok(
        log.seen.some(([level, message]) => level === "info" && message === expected),
        JSON.stringify(log.seen),
      );
    }
  });

  it("says an exact match never submits, with the option set", async () => {
    const fake = replay(recorded("blockscout", "lookup-probe-full-after-pass"));
    const log = lines();
    const result = await run.runDryRun(
      input(BLOCKSCOUT_PROBE, "Probe294B"),
      {
        fetch: fake.fetch,
        route: { backend: "blockscout" },
        logger: log.logger,
        submitOverPartial: true,
      },
      DEFAULT_DEPENDENCIES,
    );
    assert.equal(result.lookup, "exact");
    assert.ok(
      log.seen.some(
        ([level, message]) =>
          level === "info" &&
          message ===
            "Dry run: Blockscout already holds the contract (exact match), so a verification would not submit.",
      ),
      JSON.stringify(log.seen),
    );
  });
});
