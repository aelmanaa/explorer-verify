// A match the explorer made from another contract's source (#293, decision 0063; R-FLOW-1,
// R-FLOW-3, R-FLOW-4, R-AX-8, R-SRV-5). The lookup answers in test/fixtures/*/2026-11-10-* were
// recorded live on Ethereum Sepolia on 2026-11-10, read only: outside parties stored them 56 to 94
// seconds after each deployment, under other contract names and compiler versions.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { BACKEND_LABELS } from "../../src/backend-names.ts";
import type { Context } from "../../src/backends/backend.ts";
import { foundOf } from "../../src/backends/common.ts";
import { sourcify as sourcifyClient } from "../../src/clients/sourcify.ts";
import { verify as coreVerify } from "../../src/core/index.ts";
import { routingTable } from "../../src/core/table.ts";
import { toEnvelope } from "../../src/envelope.ts";
import { DEFAULT_DEPENDENCIES } from "../../src/flow/defaults.ts";
import { heldText, otherContract } from "../../src/flow/stored.ts";
import type {
  BackendName,
  DryRunOptions,
  DryRunResult,
  LogFields,
  StoredContract,
  VerifyEachOptions,
  VerifyEachResult,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
} from "../../src/index.ts";
import { redactLine } from "../../src/redact.ts";
import { createVerifyHandler } from "../../src/server/handler.ts";
import type { Hex, SolcCompiler, VerifyResult, ZksolcCompiler } from "../../src/types.ts";
import * as run from "../helpers/defaults.ts";
import { loadFixture, replay, responseOf } from "../helpers/fake-fetch.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { resolveRoute } from "../helpers/route.ts";
import { validateEnvelope } from "./envelope-schema.ts";

async function runVerify(value: VerifyInput, options: VerifyOptions): Promise<VerifyResult> {
  return await run.runVerify(value, options, DEFAULT_DEPENDENCIES);
}

async function runDryRun(value: VerifyInput, options: DryRunOptions): Promise<DryRunResult> {
  return await run.runDryRun(value, options, DEFAULT_DEPENDENCIES);
}

async function runVerifyEach(
  value: VerifyInput,
  options: VerifyEachOptions,
): Promise<VerifyEachResult> {
  return await run.runVerifyEach(value, options, DEFAULT_DEPENDENCIES);
}

const SEPOLIA = 11155111;
const BOX: Hex = "0xa67a1256b513afa0cbd89671bd0eca062117a3d9";
const PROXY: Hex = "0xfb56a32956ab007ea2a02c67609740a10f9ed362";
// The caller's contracts at the two addresses: their Etherscan records name them so.
const VERSION = "0.8.34+commit.80d5c536";
const JOB = "0f6c2a8e-5b1d-4c3e-9a7f-2d8e1b4c6a90";
const HANDLER = "https://verify.example.org/api";
// Fake keys. Never real ones (R-SEC-1).
const ETHERSCAN_KEY = "DUMMYETHERSCANKEYforeign293";
// A dummy key the caller passes in apiKeys and an explorer plants in the stored name (R-SEC-1).
const PLANTED = "DUMMYPLANTEDKEYforeign293abc";

function input(address: Hex, name: string, version = VERSION): VerifyInput {
  return {
    chainId: SEPOLIA,
    address,
    compiler: {
      kind: "solc",
      version,
      input: {
        language: "Solidity",
        sources: { [`src/${name}.sol`]: { content: `contract ${name} {}` } },
        settings: {},
      },
    },
    contractName: `src/${name}.sol:${name}`,
  };
}

/** A JSON response. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The recorded answer of `test/fixtures/<backend>/<name>.json`. */
function recorded(backend: string, name: string): Step {
  return loadFixture(backend, name);
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

interface Recorded {
  readonly backend: Exclude<
    BackendName,
    "etherscan-v2" | "etherscan-compatible" | "blockscout-hosted"
  >;
  readonly fixture: string;
  readonly address: Hex;
  readonly name: string;
  readonly stored: StoredContract;
  /** The explorer's answer to a submit that refuses it as already verified. */
  readonly refused: () => Response;
}

const SOURCIFY_REFUSED = (): Response =>
  json(409, {
    customCode: "already_verified",
    message: "The contract is already verified.",
    errorId: "00000000-0000-4000-8000-000000000293",
  });
const BLOCKSCOUT_REFUSED = (): Response =>
  json(200, {
    message: "Smart-contract already verified.",
    result: "Smart-contract already verified.",
    status: "0",
  });
const ROUTESCAN_REFUSED = (): Response =>
  json(200, { status: "0", message: "NOTOK", result: "Contract source code already verified" });

// The six recorded lookups of the issue: the address, the caller's contract, what the explorer holds.
const RECORDED: readonly Recorded[] = [
  {
    backend: "sourcify",
    fixture: "2026-11-10-lookup-simple-storage",
    address: BOX,
    name: "EvBox",
    stored: { name: "simplestorage2.sol:SimpleStorage", compilerVersion: "0.8.33+commit.64118f21" },
    refused: SOURCIFY_REFUSED,
  },
  {
    backend: "sourcify",
    fixture: "2026-11-10-lookup-fund-manager-proxy",
    address: PROXY,
    name: "EvProxy",
    stored: {
      name: "src/FundManagerProxy.sol:FundManagerProxy",
      compilerVersion: "0.8.27+commit.40a35a09",
    },
    refused: SOURCIFY_REFUSED,
  },
  {
    backend: "blockscout",
    fixture: "2026-11-10-lookup-simple-storage",
    address: BOX,
    name: "EvBox",
    stored: { name: "SimpleStorage", compilerVersion: "v0.8.31+commit.fd3a2265" },
    refused: BLOCKSCOUT_REFUSED,
  },
  {
    // The bytecode database's match: the same compiler as the caller's, another name.
    backend: "blockscout",
    fixture: "2026-11-10-lookup-auction-proxy",
    address: PROXY,
    name: "EvProxy",
    stored: { name: "AuctionProxy", compilerVersion: "v0.8.34+commit.80d5c536" },
    refused: BLOCKSCOUT_REFUSED,
  },
  {
    backend: "routescan",
    fixture: "2026-11-10-getsourcecode-simple-storage",
    address: BOX,
    name: "EvBox",
    stored: { name: "SimpleStorage", compilerVersion: "v0.8.33+commit.64118f21" },
    refused: ROUTESCAN_REFUSED,
  },
  {
    backend: "routescan",
    fixture: "2026-11-10-getsourcecode-fund-manager-proxy",
    address: PROXY,
    name: "EvProxy",
    stored: { name: "FundManagerProxy", compilerVersion: "v0.8.27+commit.40a35a09" },
    refused: ROUTESCAN_REFUSED,
  },
];

/** Sourcify's recorded lookup of the second address, then its refusal of the submit. */
function proxyRefused(): Step[] {
  return [recorded("sourcify", "2026-11-10-lookup-fund-manager-proxy"), SOURCIFY_REFUSED()];
}

/** An input for `src/Box.sol:Box`, or `contractName`, compiled with `version`. */
function solc(version: string, contractName = "src/Box.sol:Box"): VerifyInput {
  return { ...input(BOX, "Box", version), contractName };
}

/** The lookup steps after a refused submit: Blockscout and Routescan read the grade once more. */
function afterRefusal(row: Recorded): Step[] {
  return row.backend === "sourcify" ? [] : [recorded(row.backend, row.fixture)];
}

/** Whether a request is a submit. */
function isSubmit(call: Call): boolean {
  return call.method === "POST";
}

describe("verify() submits over a recorded match of another contract's source (R-FLOW-1, recorded 2026-11-10)", () => {
  for (const row of RECORDED) {
    it(`${row.backend}: ${row.name} at ${row.address}, where the explorer holds ${String(row.stored.name)}`, async () => {
      const fake = replay(recorded(row.backend, row.fixture), row.refused(), ...afterRefusal(row));
      const log = lines();
      const events: VerifyEvent[] = [];
      // The requests sent when verify.stored arrived: the lookup only (decision 0073).
      let sentAtStored = -1;
      const result = await runVerify(input(row.address, row.name), {
        fetch: fake.fetch,
        route: { backend: row.backend },
        logger: log.logger,
        onEvent: (event) => {
          events.push(event);
          if (event.type === "verify.stored") {
            sentAtStored = fake.calls.length;
          }
        },
      });
      assert.deepEqual(
        events.filter((event) => event.type === "verify.stored"),
        [{ type: "verify.stored", backend: row.backend, ...row.stored }],
      );
      assert.equal(sentAtStored, 1);
      assert.deepEqual(events.map((event) => event.type).slice(0, 4), [
        "verify.validated",
        "verify.routed",
        "verify.lookup",
        "verify.stored",
      ]);
      // The lookup, then the submit: a foreign match never ends the call before a submit.
      assert.equal(fake.calls[0]?.method, "GET");
      assert.ok(fake.calls[1] !== undefined && isSubmit(fake.calls[1]));
      assert.equal(fake.calls.length, 2 + afterRefusal(row).length);
      // The explorer refused the submit as already verified: the result says whose source it holds.
      assert.equal(result.status, "already-verified");
      assert.equal(result.backend, row.backend);
      assert.ok(result.status === "already-verified");
      assert.equal(result.match, "partial");
      assert.deepEqual(result.storedContract, row.stored);
      const info = log.seen.find(
        ([level, message]) => level === "info" && message.includes("another contract's"),
      );
      assert.ok(info !== undefined, "the info line names the other contract");
      assert.equal(
        info[1],
        `${BACKEND_LABELS[row.backend]} holds another contract's source (${String(row.stored.name)}, ${String(row.stored.compilerVersion)}); submitting this source.`,
      );
      assert.deepEqual(info[2], { backend: row.backend });
      const warn = log.seen.find(
        ([level, message]) => level === "warn" && message.includes("another contract"),
      );
      assert.ok(warn !== undefined, "the warn line names the other contract");
      assert.ok(warn[1].includes(String(row.stored.compilerVersion)), warn[1]);
      // Issue #356: only a refusal that names no contract, Sourcify's 409, keeps the first
      // lookup's contract, and only then does a warn line say it may be out of date.
      const stale = log.seen.filter(
        ([level, message]) => level === "warn" && message.includes("may be out of date"),
      );
      assert.equal(stale.length, row.backend === "sourcify" ? 1 : 0, row.backend);
    });
  }

  it("sourcify: a submit over the match that Sourcify verifies gives verified, with no stored contract", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const fake = replay(
      recorded("sourcify", "2026-11-10-lookup-simple-storage"),
      json(202, { verificationId: JOB }),
      json(200, {
        isJobCompleted: true,
        verificationId: JOB,
        contract: {
          match: "exact_match",
          creationMatch: "exact_match",
          runtimeMatch: "exact_match",
          chainId: String(SEPOLIA),
          address: BOX,
        },
      }),
    );
    const log = lines();
    const pending = runVerify(input(BOX, "EvBox"), {
      fetch: fake.fetch,
      route: { backend: "sourcify" },
      logger: log.logger,
    });
    await driveMockClock(pending, () => {
      t.mock.timers.runAll();
    });
    const result = await pending;
    assert.deepEqual(result, {
      status: "verified",
      backend: "sourcify",
      match: "exact",
      explorerUrl: `https://repo.sourcify.dev/${String(SEPOLIA)}/${BOX}`,
    });
    // The job verified the submitted source: its answer names no contract, and none is needed.
    assert.ok(!log.seen.some(([, message]) => message.includes("names no contract")));
  });

  it("the envelope and its schema keep storedContract (R-AX-5)", async () => {
    const [row] = RECORDED;
    assert.ok(row !== undefined);
    const fake = replay(recorded(row.backend, row.fixture), row.refused());
    const result = await runVerify(input(row.address, row.name), {
      fetch: fake.fetch,
      route: { backend: row.backend },
    });
    const envelope = toEnvelope(result);
    assert.deepEqual(validateEnvelope(JSON.parse(JSON.stringify(envelope))), []);
    assert.deepEqual(Reflect.get(Object(envelope.result), "storedContract"), row.stored);
  });
});

describe("verify() keeps already-verified for a match of this source (R-FLOW-1)", () => {
  it("etherscan-v2: ContractName EvBox and CompilerVersion v0.8.34 as in the input: no submit (recorded 2026-11-10)", async () => {
    const fake = replay(recorded("etherscan", "2026-11-10-getsourcecode-ev-box"));
    const result = await runVerify(input(BOX, "EvBox"), {
      fetch: fake.fetch,
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
    });
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: `https://sepolia.etherscan.io/address/${BOX}#code`,
    });
    assert.equal(fake.calls.length, 1);
  });

  it("etherscan-v2: the same record through the server handler's reduced answer (R-SRV-5)", async () => {
    const upstream = replay(recorded("etherscan", "2026-11-10-getsourcecode-ev-proxy"));
    const handler = createVerifyHandler({
      apiKey: ETHERSCAN_KEY,
      chains: [SEPOLIA],
      fetch: upstream.fetch,
    });
    const toHandler: typeof fetch = async (target, init) => {
      const url =
        typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
      return await handler(new Request(url, init));
    };
    const result = await runVerify(input(PROXY, "EvProxy"), {
      fetch: toHandler,
      handlerUrl: HANDLER,
    });
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: `https://sepolia.etherscan.io/address/${PROXY}#code`,
    });
    assert.equal(upstream.calls.length, 1);
  });

  it("etherscan-v2: another ContractName in the record makes verify() submit", async () => {
    const fake = replay(
      recorded("etherscan", "2026-11-10-getsourcecode-ev-box"),
      json(200, { status: "0", message: "NOTOK", result: "Contract source code already verified" }),
      recorded("etherscan", "2026-11-10-getsourcecode-ev-box"),
    );
    const result = await runVerify(input(BOX, "Other"), {
      fetch: fake.fetch,
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
    });
    assert.equal(fake.calls.length, 3);
    assert.equal(new URLSearchParams(fake.calls[1]?.body).get("action"), "verifysourcecode");
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "etherscan-v2",
      match: "partial",
      explorerUrl: `https://sepolia.etherscan.io/address/${BOX}#code`,
      storedContract: { name: "EvBox", compilerVersion: "v0.8.34+commit.80d5c536" },
    });
  });

  it("etherscan-v2: another compiler version makes verify() submit", async () => {
    const fake = replay(
      recorded("etherscan", "2026-11-10-getsourcecode-ev-box"),
      json(200, { status: "0", message: "NOTOK", result: "Contract source code already verified" }),
      recorded("etherscan", "2026-11-10-getsourcecode-ev-box"),
    );
    const result = await runVerify(input(BOX, "EvBox", "0.8.33+commit.64118f21"), {
      fetch: fake.fetch,
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
    });
    assert.equal(fake.calls.length, 3);
    assert.equal(result.status, "already-verified");
  });
});

describe("no path reports another contract's match as this source (R-FLOW-4)", () => {
  it("a failed job whose lookup finds another contract's exact match gives already-verified partial, not verified exact", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    // Etherscan's answer for a contract it has not verified: an empty SourceCode.
    const notVerified = json(200, {
      status: "1",
      message: "OK",
      result: [{ SourceCode: "", ABI: "Contract source code not verified", ContractName: "" }],
    });
    const fake = replay(
      notVerified,
      json(200, {
        status: "1",
        message: "OK",
        result: "abcdefghijklmnopqrstuvwxyz0123456789abcdefghij",
      }),
      json(200, {
        status: "0",
        message: "NOTOK",
        result: "Fail - Unable to verify. Compiled contract runtime bytecode does NOT match.",
      }),
      recorded("etherscan", "2026-11-10-getsourcecode-ev-box"),
    );
    const pending = runVerify(input(BOX, "Other"), {
      fetch: fake.fetch,
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
    });
    await driveMockClock(pending, () => {
      t.mock.timers.runAll();
    });
    const result: VerifyResult = await pending;
    assert.deepEqual(result, {
      status: "already-verified",
      backend: "etherscan-v2",
      match: "partial",
      explorerUrl: `https://sepolia.etherscan.io/address/${BOX}#code`,
      storedContract: { name: "EvBox", compilerVersion: "v0.8.34+commit.80d5c536" },
    });
  });

  it("a forgotten job whose lookup finds only the other contract's match throws job-not-found", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const fake = replay(
      recorded("sourcify", "2026-11-10-lookup-simple-storage"),
      json(202, { verificationId: JOB }),
      recorded("sourcify", "2026-11-02-job-not-found"),
      recorded("sourcify", "2026-11-10-lookup-simple-storage"),
    );
    const pending = runVerify(input(BOX, "EvBox"), {
      fetch: fake.fetch,
      route: { backend: "sourcify" },
    });
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await driveMockClock(pending, () => {
      t.mock.timers.runAll();
    });
    const error = await outcome;
    assert.ok(error instanceof Error);
    assert.equal(Reflect.get(error, "code"), "job-not-found");
    assert.match(error.message, /found only another contract's source/u);
  });

  it("a job that outlasts the budget, with only the other contract's match, throws not-confirmed", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const pendingJob = json(200, {
      isJobCompleted: false,
      verificationId: JOB,
      contract: {
        match: null,
        creationMatch: null,
        runtimeMatch: null,
        chainId: "11155111",
        address: BOX,
      },
    });
    const steps: Step[] = [
      recorded("sourcify", "2026-11-10-lookup-simple-storage"),
      json(202, { verificationId: JOB }),
    ];
    const fake = replay(...steps, ...Array.from({ length: 40 }, () => pendingJob.clone()));
    // The last lookup after the budget: the fake answers the next request with it.
    const lookupAgain = loadFixture("sourcify", "2026-11-10-lookup-simple-storage");
    const answering: typeof fetch = async (target, init) => {
      const url =
        typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
      return url.includes("/v2/contract/") && fake.calls.length >= 2
        ? responseOf(lookupAgain)
        : await fake.fetch(target, init);
    };
    const pending = runVerify(input(BOX, "EvBox"), {
      fetch: answering,
      route: { backend: "sourcify" },
      timeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await driveMockClock(pending, () => {
      t.mock.timers.runAll();
    });
    const error = await outcome;
    assert.ok(error instanceof Error);
    assert.equal(Reflect.get(error, "code"), "not-confirmed");
    assert.match(error.message, /a last lookup found only another contract's source/u);
  });
});

describe("dryRun(), verifyEach() and the core entry report the same (R-AX-8, R-RT-4, decision 0052)", () => {
  it("dryRun() gives the lookup's grade and storedContract: verify() would submit", async () => {
    const fake = replay(recorded("blockscout", "2026-11-10-lookup-auction-proxy"));
    const log = lines();
    const result = await runDryRun(input(PROXY, "EvProxy"), {
      fetch: fake.fetch,
      route: { backend: "blockscout" },
      logger: log.logger,
    });
    assert.deepEqual(result, {
      status: "dry-run",
      backend: "blockscout",
      apiHost: "eth-sepolia.blockscout.com",
      lookup: "partial",
      explorerUrl: `https://eth-sepolia.blockscout.com/address/${PROXY}?tab=contract`,
      routedBy: "caller",
      storedContract: { name: "AuctionProxy", compilerVersion: "v0.8.34+commit.80d5c536" },
    });
    assert.ok(
      log.seen.some(
        ([level, message]) =>
          level === "info" && message.includes("so a verification would submit."),
      ),
    );
    assert.deepEqual(validateEnvelope(JSON.parse(JSON.stringify(toEnvelope(result)))), []);
  });

  it("dryRun() of a match of this source has no storedContract", async () => {
    const fake = replay(recorded("etherscan", "2026-11-10-getsourcecode-ev-box"));
    const result = await runDryRun(input(BOX, "EvBox"), {
      fetch: fake.fetch,
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
    });
    assert.equal(result.lookup, "exact");
    assert.equal("storedContract" in result, false);
  });

  it("verifyEach() gives the same outcome as verify()", async () => {
    const fake = replay(
      recorded("routescan", "2026-11-10-getsourcecode-simple-storage"),
      ROUTESCAN_REFUSED(),
      recorded("routescan", "2026-11-10-getsourcecode-simple-storage"),
    );
    const each = await runVerifyEach(input(BOX, "EvBox"), {
      fetch: fake.fetch,
      backends: ["routescan"],
    });
    const [only] = each.outcomes;
    assert.ok(only !== undefined && only.result !== undefined);
    assert.ok(only.result.status === "already-verified");
    assert.deepEqual(only.result.storedContract, {
      name: "SimpleStorage",
      compilerVersion: "v0.8.33+commit.64118f21",
    });
  });

  it("the core entry gives the same result as the default entry", async () => {
    const fromCore = await coreVerify(input(PROXY, "EvProxy"), {
      fetch: replay(...proxyRefused()).fetch,
      route: { backend: "sourcify" },
      clients: [sourcifyClient()],
      table: routingTable,
    });
    const fromDefault = await runVerify(input(PROXY, "EvProxy"), {
      fetch: replay(...proxyRefused()).fetch,
      route: { backend: "sourcify" },
    });
    assert.deepEqual(fromCore, fromDefault);
    assert.ok(fromCore.status === "already-verified" && fromCore.storedContract !== undefined);
  });
});

describe("the comparison rule (decision 0063)", () => {
  it("compares a plain name with the part after the last colon", () => {
    assert.equal(otherContract({ name: "Box" }, solc(VERSION)), undefined);
    assert.deepEqual(otherContract({ name: "Other" }, solc(VERSION)), { name: "Other" });
    assert.deepEqual(otherContract({ name: "box" }, solc(VERSION)), { name: "box" });
  });

  it("compares a path:Name with the whole contractName", () => {
    assert.equal(otherContract({ name: "src/Box.sol:Box" }, solc(VERSION)), undefined);
    assert.deepEqual(otherContract({ name: "lib/Box.sol:Box" }, solc(VERSION)), {
      name: "lib/Box.sol:Box",
    });
  });

  it("compares versions without a leading v and in lower case", () => {
    assert.equal(
      otherContract({ compilerVersion: "v0.8.34+commit.80d5c536" }, solc(VERSION)),
      undefined,
    );
    assert.equal(
      otherContract({ compilerVersion: "V0.8.34+COMMIT.80D5C536" }, solc(VERSION)),
      undefined,
    );
    assert.deepEqual(otherContract({ compilerVersion: "v0.8.33+commit.64118f21" }, solc(VERSION)), {
      compilerVersion: "v0.8.33+commit.64118f21",
    });
  });

  it("compares only the release when one side has no commit", () => {
    assert.equal(otherContract({ compilerVersion: "v0.8.34" }, solc(VERSION)), undefined);
    assert.equal(
      otherContract({ compilerVersion: "v0.8.34+commit.80d5c536" }, solc("0.8.34")),
      undefined,
    );
    assert.deepEqual(otherContract({ compilerVersion: "0.8.3" }, solc(VERSION)), {
      compilerVersion: "0.8.3",
    });
    assert.deepEqual(otherContract({ compilerVersion: "v0.8.34+commit.00000000" }, solc(VERSION)), {
      compilerVersion: "v0.8.34+commit.00000000",
    });
  });

  it("reports both fields when either differs, and nothing when the answer names neither", () => {
    assert.deepEqual(
      otherContract({ name: "Box", compilerVersion: "v0.8.27+commit.40a35a09" }, solc(VERSION)),
      { name: "Box", compilerVersion: "v0.8.27+commit.40a35a09" },
    );
    assert.equal(otherContract({}, solc(VERSION)), undefined);
  });

  it("compares a zksolc input's solcVersion, as Blockscout stores it", () => {
    const solcInput = solc(VERSION);
    const compiler: SolcCompiler | ZksolcCompiler = {
      kind: "zksolc",
      version: "1.5.15",
      solcVersion: "0.8.24+commit.e11b9ed9",
      input: solcInput.compiler.input,
    };
    const zk: VerifyInput = { ...solcInput, compiler };
    assert.equal(otherContract({ compilerVersion: "v0.8.24+commit.e11b9ed9" }, zk), undefined);
    assert.deepEqual(otherContract({ compilerVersion: "v1.5.15" }, zk), {
      compilerVersion: "v1.5.15",
    });
  });

  it("reads only strings that are not empty", () => {
    const ctx = contextWith([]);
    assert.deepEqual(foundOf(ctx, "partial", "Box", "v0.8.34"), {
      match: "partial",
      name: "Box",
      compilerVersion: "v0.8.34",
    });
    assert.deepEqual(foundOf(ctx, "exact", "", undefined), { match: "exact" });
    assert.deepEqual(foundOf(ctx, "exact", 1, null), { match: "exact" });
  });

  // R-SEC-1: the stored name and version are explorer text that reaches results and logs.
  it("replaces control characters, redacts the call's keys and cuts the text to 300 characters", () => {
    const ctx = contextWith([PLANTED]);
    const found = foundOf(ctx, "partial", `A\r\u001b[2K\u007f\u009b${PLANTED}`, "x".repeat(400));
    assert.deepEqual(found, {
      match: "partial",
      name: "A��[2K��[redacted]",
      compilerVersion: "x".repeat(300),
    });
  });

  it("redactLine replaces C0, DEL and C1 only, at their edges", () => {
    assert.equal(redactLine("\u0000\u001f ~\u007f\u009f ", [], 300), "�� ~�� ");
  });
});

/** A context whose call holds `secrets`, for the readers of the stored contract. */
function contextWith(secrets: readonly string[]): Context {
  return {
    route: resolveRoute(SEPOLIA, { backend: "sourcify" }),
    http: { backend: "sourcify", secrets },
  };
}

/** An Etherscan lookup answer whose first result has `first` besides a non-empty SourceCode. */
function etherscanLookup(first: Record<string, string>): Response {
  return json(200, { status: "1", message: "OK", result: [{ SourceCode: "x", ...first }] });
}

/** A Sourcify lookup answer for the first address with `compilation`. */
function sourcifyLookup(compilation: unknown): Response {
  return json(200, { match: "match", chainId: String(SEPOLIA), address: BOX, compilation });
}

describe("a stored contract that names one field only (decision 0063)", () => {
  it("heldText lists the fields the explorer gives", () => {
    assert.equal(
      heldText("Sourcify", { name: "A", compilerVersion: "v1" }),
      "Sourcify holds another contract's source (A, v1)",
    );
    assert.equal(
      heldText("Routescan", { compilerVersion: "v1" }),
      "Routescan holds another contract's source (v1)",
    );
  });

  const cases: [Record<string, string>, StoredContract][] = [
    [{ ContractName: "Other", CompilerVersion: "" }, { name: "Other" }],
    [
      { ContractName: "", CompilerVersion: "v0.8.27+commit.40a35a09" },
      { compilerVersion: "v0.8.27+commit.40a35a09" },
    ],
  ];
  for (const [first, stored] of cases) {
    it(`etherscan-v2: ${JSON.stringify(stored)} reaches the result and the warn line`, async () => {
      const fake = replay(
        etherscanLookup(first),
        json(200, {
          status: "0",
          message: "NOTOK",
          result: "Contract source code already verified",
        }),
        etherscanLookup(first),
      );
      const log = lines();
      const result = await runVerify(input(BOX, "EvBox"), {
        fetch: fake.fetch,
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
        logger: log.logger,
      });
      assert.ok(result.status === "already-verified");
      assert.deepEqual(result.storedContract, stored);
      const warn = log.seen.find(([level]) => level === "warn");
      assert.deepEqual(warn?.slice(1), [
        `${heldText("Etherscan", stored)}, not this one.`,
        { backend: "etherscan-v2" },
      ]);
    });
  }

  // A lookup after the refused submit that names this source by one field wins over the other
  // contract the first lookup found.
  const own: Record<string, string>[] = [
    { ContractName: "EvBox", CompilerVersion: "" },
    { ContractName: "", CompilerVersion: "v0.8.34+commit.80d5c536" },
  ];
  for (const after of own) {
    it(`etherscan-v2: a refused submit whose lookup names this source by ${JSON.stringify(after)} gives no storedContract`, async () => {
      const fake = replay(
        etherscanLookup({ ContractName: "Other", CompilerVersion: "v0.8.27+commit.40a35a09" }),
        json(200, {
          status: "0",
          message: "NOTOK",
          result: "Contract source code already verified",
        }),
        etherscanLookup(after),
      );
      const result = await runVerify(input(BOX, "EvBox"), {
        fetch: fake.fetch,
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
      });
      assert.deepEqual(result, {
        status: "already-verified",
        backend: "etherscan-v2",
        match: "exact",
        explorerUrl: `https://sepolia.etherscan.io/address/${BOX}#code`,
      });
    });
  }

  it("sourcify: compilation.name stands in for a missing fullyQualifiedName, and no compilation names nothing", async () => {
    const byName = await runDryRun(input(BOX, "EvBox"), {
      fetch: replay(sourcifyLookup({ name: "SimpleStorage", compilerVersion: VERSION })).fetch,
      route: { backend: "sourcify" },
    });
    assert.deepEqual(byName.storedContract, { name: "SimpleStorage", compilerVersion: VERSION });
    const none = await runDryRun(input(BOX, "EvBox"), {
      fetch: replay(sourcifyLookup(undefined)).fetch,
      route: { backend: "sourcify" },
    });
    assert.equal(none.lookup, "partial");
    assert.equal("storedContract" in none, false);
  });
});

// R-SEC-1: an explorer can echo a key into the stored name or version; the result, the envelope,
// the dry run and the logs never carry it, nor a control character.
describe("a key in the stored contract never reaches the result (R-SEC-1, decision 0063)", () => {
  const name = `Other${PLANTED}\r\u001b[2K`;
  const version = `v0.8.1+${PLANTED}`;
  const etherscanStyle = (): Response =>
    json(200, {
      status: "1",
      message: "OK",
      result: [{ SourceCode: "x", ContractName: name, CompilerVersion: version }],
    });
  const blockscoutLookup = (): Response =>
    json(200, {
      is_verified: true,
      is_fully_verified: false,
      is_partially_verified: true,
      name,
      compiler_version: version,
    });
  const cases: [BackendName, () => Response, (() => Response) | undefined][] = [
    [
      "sourcify",
      () => sourcifyLookup({ fullyQualifiedName: name, compilerVersion: version }),
      undefined,
    ],
    ["blockscout", blockscoutLookup, BLOCKSCOUT_REFUSED],
    ["routescan", etherscanStyle, ROUTESCAN_REFUSED],
    ["etherscan-v2", etherscanStyle, ROUTESCAN_REFUSED],
  ];
  for (const [backend, lookup, refused] of cases) {
    it(`${backend}: verify(), toEnvelope(), dryRun() and the logs`, async () => {
      const options = { route: { backend }, apiKeys: { "etherscan-v2": PLANTED } };
      const steps: Step[] =
        refused === undefined ? [lookup(), SOURCIFY_REFUSED()] : [lookup(), refused(), lookup()];
      const log = lines();
      const result = await runVerify(input(BOX, "EvBox"), {
        ...options,
        fetch: replay(...steps).fetch,
        logger: log.logger,
      });
      assert.ok(result.status === "already-verified" && result.storedContract !== undefined);
      const dry = await runDryRun(input(BOX, "EvBox"), {
        ...options,
        fetch: replay(lookup()).fetch,
        logger: log.logger,
      });
      assert.ok(dry.storedContract !== undefined);
      for (const text of [
        JSON.stringify(result),
        JSON.stringify(toEnvelope(result)),
        JSON.stringify(dry),
        JSON.stringify(toEnvelope(dry)),
        JSON.stringify(log.seen),
      ]) {
        assert.ok(!text.includes(PLANTED), text);
        assert.ok(!text.includes("\u001b"), text);
      }
    });
  }
});

describe("the job's lookup and nameless answers (R-FLOW-4, decision 0063)", () => {
  it("blockscout: Pass - Verified with another contract's record gives already-verified partial", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const fake = replay(
      json(404, { message: "Not found" }),
      json(200, {
        status: "1",
        message: "OK",
        result: "a67a1256b513afa0cbd89671bd0eca062117a3d9abcd",
      }),
      json(200, { status: "1", message: "OK", result: "Pass - Verified" }),
      recorded("blockscout", "2026-11-10-lookup-simple-storage"),
    );
    const pending = runVerify(input(BOX, "EvBox"), {
      fetch: fake.fetch,
      route: { backend: "blockscout" },
    });
    await driveMockClock(pending, () => {
      t.mock.timers.runAll();
    });
    const result = await pending;
    assert.ok(result.status === "already-verified");
    assert.equal(result.match, "partial");
    assert.deepEqual(result.storedContract, {
      name: "SimpleStorage",
      compilerVersion: "v0.8.31+commit.fd3a2265",
    });
  });

  it("a match whose answer names no contract is taken as this source, and the log says so", async () => {
    const log = lines();
    const result = await runVerify(input(BOX, "EvBox"), {
      fetch: replay(sourcifyLookup(undefined)).fetch,
      route: { backend: "sourcify" },
      logger: log.logger,
    });
    assert.equal(result.status, "already-verified");
    assert.ok("match" in result && result.match === "partial");
    assert.ok(
      log.seen.some(
        ([level, message]) =>
          level === "info" &&
          message === "Sourcify names no contract; the match is taken as this source.",
      ),
    );
  });

  it("a match that names this source logs no nameless line", async () => {
    const log = lines();
    const result = await runVerify(input(BOX, "EvBox"), {
      fetch: replay(recorded("etherscan", "2026-11-10-getsourcecode-ev-box")).fetch,
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
      logger: log.logger,
    });
    assert.equal(result.status, "already-verified");
    assert.ok(!log.seen.some(([, message]) => message.includes("names no contract")));
  });

  it("sourcify: an empty fullyQualifiedName falls back to compilation.name", async () => {
    const dry = await runDryRun(input(BOX, "EvBox"), {
      fetch: replay(sourcifyLookup({ fullyQualifiedName: "", name: "SimpleStorage" })).fetch,
      route: { backend: "sourcify" },
    });
    assert.deepEqual(dry.storedContract, { name: "SimpleStorage" });
  });

  it("after a submit with no clear answer, another contract's match sends the submit again", async () => {
    const fake = replay(
      recorded("sourcify", "2026-11-10-lookup-simple-storage"),
      new Response("bad gateway", { status: 502 }),
      recorded("sourcify", "2026-11-10-lookup-simple-storage"),
      SOURCIFY_REFUSED(),
    );
    const result = await runVerify(input(BOX, "EvBox"), {
      fetch: fake.fetch,
      route: { backend: "sourcify" },
    });
    assert.deepEqual(
      fake.calls.map((call) => call.method),
      ["GET", "POST", "GET", "POST"],
    );
    assert.ok(result.status === "already-verified" && result.storedContract !== undefined);
  });
});
