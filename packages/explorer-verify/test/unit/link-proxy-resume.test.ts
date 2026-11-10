// linkProxy() with resumeJobId: a pending link is checked again with the job id of its
// proxy-link-pending error, and no new link request is sent (R-FLOW-8, R-SEC-1, R-SRV-3,
// decision 0065). Etherscan's answers were recorded on Ethereum Sepolia on 2026-11-04, its pending
// answer comes from its documentation (2026-11-03), and Blockscout's on 2026-11-04, in
// test/fixtures/<backend>/. Every request goes to a fake fetch. Checks and waits run on mock timers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { LinkVerdict, ProxyLinker } from "../../src/backends/backend.ts";
import { etherscanV2ProxyLink } from "../../src/clients/etherscan-v2.ts";
import { linkProxy as coreLinkProxy } from "../../src/core/index.ts";
import { ERROR_EXIT_CODES } from "../../src/envelope.ts";
import { ExplorerVerifyError, detailsFromJson } from "../../src/errors.ts";
import { DEFAULT_LINK_DEPENDENCIES } from "../../src/flow/defaults.ts";
import type { LinkDependencies } from "../../src/flow/link-proxy.ts";
import { linkProxyOptionKeys } from "../../src/flow/link-proxy.ts";
import { linkProxy } from "../../src/index.ts";
import { createVerifyHandler } from "../../src/server/handler.ts";
import type { LinkProxyOptions, LinkProxyResult } from "../../src/types.ts";
import { runLinkProxy } from "../helpers/defaults.ts";
import { etherscanFixture, fakeExplorer, json } from "../helpers/fake-explorer.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { validateEnvelope } from "./envelope-schema.ts";

const SEPOLIA = 11155111;
const PROXY = "0xed5b8413e605598ef86cd7617f12701f74ca255c";
const OTHER_PROXY = "0xfa0e910758d502780263871f92a85736597b87f4";
const BOX = "0x75038a8c55f5ec7196b54384fdbcffb1f2ce9920";
// The guid of the recorded verifyproxycontract answer, and the uid of Blockscout's.
const GUID = "wccgmdtjug6bss2mf166jzjtqcs4uchztznlevycg6mbwlxttz";
const UID = "ed5b8413e605598ef86cd7617f12701f74ca255c6aeb80cb";
const HANDLER = "https://dapp.example/api/verify";
// Fake keys, lowercase hex. Never real ones (R-SEC-1).
const KEY = "deadbeef0123456789abcdef94a10003";
const HANDLER_KEY = "cafebabe0123456789abcdef94b20004";

const etherscan = (name: string): Step => loadFixture("etherscan", name);
const REQUESTED = (): Step => etherscan("2026-11-04-verifyproxycontract-linked");
const LINKED = (): Step => etherscan("2026-11-04-checkproxyverification-linked");
const PENDING_0 = (): Step =>
  etherscan("2026-11-03-documented-checkproxyverification-pending-status-0");
const UNKNOWN_GUID = (): Step => etherscan("2026-11-04-checkproxyverification-unknown-guid");
const BS_LINKED = (): Step => loadFixture("blockscout", "2026-11-04-checkproxyverification-linked");

const ETHERSCAN: LinkProxyOptions = {
  route: { backend: "etherscan-v2" },
  apiKeys: { "etherscan-v2": KEY },
};
const BLOCKSCOUT: LinkProxyOptions = {
  route: { backend: "blockscout", apiUrl: "https://eth-sepolia.blockscout.com/api" },
};

interface Run {
  readonly outcome: { readonly result?: LinkProxyResult; readonly error?: unknown };
  readonly calls: Call[];
  /** The mock clock's time when each request was sent. */
  readonly times: number[];
  readonly lines: string[];
}

/** Runs linkProxy() against `steps` on mock timers, until it settles. */
async function run(
  t: TestContext,
  steps: Step[],
  options: LinkProxyOptions,
  dependencies: LinkDependencies = DEFAULT_LINK_DEPENDENCIES,
): Promise<Run> {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = replay(...steps);
  const times: number[] = [];
  const lines: string[] = [];
  const log = (message: string, fields?: unknown): void => {
    lines.push(`${message} ${JSON.stringify(fields)}`);
  };
  const call = runLinkProxy(
    { chainId: SEPOLIA, address: PROXY },
    {
      timeoutMs: 20_000,
      pollIntervalMs: 3_000,
      logger: { debug: log, info: log, warn: log, error: log },
      ...options,
      fetch: async (input, init) => {
        times.push(Date.now());
        return await fake.fetch(input, init);
      },
    },
    dependencies,
  );
  await driveMockClock(call, () => {
    t.mock.timers.runAll();
  });
  try {
    return { outcome: { result: await call }, calls: fake.calls, times, lines };
  } catch (error: unknown) {
    return { outcome: { error }, calls: fake.calls, times, lines };
  }
}

function errorOf(r: Run, code: ExplorerVerifyError["code"]): ExplorerVerifyError {
  const { error } = r.outcome;
  assert.ok(
    error instanceof ExplorerVerifyError,
    `expected an error, got ${JSON.stringify(r.outcome.result)}`,
  );
  assert.equal(error.code, code, error.message);
  return error;
}

/** The `action` of each form request, or the URL of each GET. */
function actions(r: Run): string[] {
  return r.calls.map((call) =>
    call.method === "GET" ? call.url : String(new URLSearchParams(call.body).get("action")),
  );
}

/** The `jobId` of a `proxy-link-pending` error. */
function jobIdOf(error: ExplorerVerifyError): string {
  assert.ok(ExplorerVerifyError.is(error, "proxy-link-pending"));
  const { jobId } = error.details;
  assert.ok(jobId !== undefined, "every proxy-link-pending of this release has a job id");
  return jobId;
}

/** Asserts `invalid-input` on `resumeJobId` with this message, and that no request was sent. */
function refusedJobId(r: Run, message: RegExp): ExplorerVerifyError {
  const error = errorOf(r, "invalid-input");
  assert.ok(ExplorerVerifyError.is(error, "invalid-input"));
  assert.deepEqual(
    error.details.issues.map((issue) => issue.field),
    ["resumeJobId"],
  );
  assert.match(error.details.issues[0]?.message ?? "", message);
  assert.match(error.hint, /details\.jobId of a proxy-link-pending error/);
  assert.equal(r.calls.length, 0);
  return error;
}

describe("linkProxy() resumes a pending link with resumeJobId (R-FLOW-8, decision 0065)", () => {
  it("R-FLOW-8: replays the recorded pending answer until the budget, then resumes the job id with no verifyproxycontract", async (t) => {
    const pending = Array.from({ length: 20 }, () => PENDING_0());
    const first = await run(t, [REQUESTED(), ...pending], { ...ETHERSCAN, timeoutMs: 10_000 });
    const error = errorOf(first, "proxy-link-pending");
    assert.deepEqual(error.details, {
      code: "proxy-link-pending",
      backend: "etherscan-v2",
      jobId: GUID,
    });
    assert.equal(error.retryable, true);
    assert.equal(ERROR_EXIT_CODES[error.code], 4);
    const serialized = error.toJSON();
    assert.ok(serialized.code === "proxy-link-pending");
    assert.equal(serialized.details.jobId, GUID);
    assert.match(error.hint, /resumeJobId set to details\.jobId/);

    const resumed = await run(t, [LINKED()], { ...ETHERSCAN, resumeJobId: jobIdOf(error) });
    assert.deepEqual(resumed.outcome.result, {
      status: "linked",
      backend: "etherscan-v2",
      implementation: BOX,
      implementationVerified: true,
      explorerUrl: `https://sepolia.etherscan.io/address/${PROXY}#code`,
    });
    assert.deepEqual(actions(resumed), ["checkproxyverification"]);
    assert.equal(new URLSearchParams(resumed.calls[0]?.body).get("guid"), GUID);
    // A resumed link is checked at once, not after pollIntervalMs.
    assert.deepEqual(resumed.times, [0]);
    assert.ok(
      resumed.lines.includes(
        `Checking the etherscan-v2 proxy link of job ${GUID}; no new link request {"backend":"etherscan-v2"}`,
      ),
      resumed.lines.join("\n"),
    );
  });

  it("checks every pollIntervalMs after the first check, and ends pending again with the same job id", async (t) => {
    const pending = Array.from({ length: 20 }, () => PENDING_0());
    const r = await run(t, pending, { ...ETHERSCAN, timeoutMs: 10_000, resumeJobId: GUID });
    assert.equal(jobIdOf(errorOf(r, "proxy-link-pending")), GUID);
    assert.deepEqual(r.times, [0, 3_000, 6_000, 9_000]);
    assert.deepEqual(new Set(actions(r)), new Set(["checkproxyverification"]));
  });

  it("checks once even when the budget is shorter than pollIntervalMs", async (t) => {
    const r = await run(t, [LINKED()], {
      ...ETHERSCAN,
      timeoutMs: 1_000,
      pollIntervalMs: 5_000,
      resumeJobId: GUID,
    });
    assert.equal(r.outcome.result?.status, "linked");
  });

  it("ends with proxy-link-unknown-state when Etherscan no longer knows the job id", async (t) => {
    const r = await run(t, [UNKNOWN_GUID()], { ...ETHERSCAN, resumeJobId: GUID });
    const error = errorOf(r, "proxy-link-unknown-state");
    assert.equal(ERROR_EXIT_CODES[error.code], 6);
    assert.deepEqual(actions(r), ["checkproxyverification"]);
  });

  it("resumes a Blockscout uid for the proxy with no verifyproxycontract", async (t) => {
    const verified = json({
      is_verified: true,
      is_fully_verified: true,
      is_partially_verified: false,
    });
    const r = await run(t, [BS_LINKED(), verified], { ...BLOCKSCOUT, resumeJobId: UID });
    assert.equal(r.outcome.result?.status, "linked", String(r.outcome.error));
    assert.equal(actions(r)[0], "checkproxyverification");
    assert.equal(new URLSearchParams(r.calls[0]?.body).get("guid"), UID);
  });

  it("ends a link that was not resumed with its job id, so the first call's error resumes it", async (t) => {
    const fake: ProxyLinker = {
      request: async () => await Promise.resolve({ state: "submitted", jobId: "job7" }),
      check: async (): Promise<LinkVerdict> => await Promise.resolve({ state: "pending" }),
      acceptsJobId: () => true,
    };
    const r = await run(t, [], { route: { backend: "sourcify" } }, { linkers: { sourcify: fake } });
    assert.equal(jobIdOf(errorOf(r, "proxy-link-pending")), "job7");
  });
});

describe("linkProxy() refuses a resumeJobId it cannot check, before any request (decision 0065)", () => {
  it("refuses it on Sourcify, which starts no link job", async (t) => {
    const r = await run(t, [], { route: { backend: "sourcify" }, resumeJobId: GUID });
    const error = refusedJobId(r, /^sourcify starts no link job, so there is none to resume$/);
    assert.equal(
      error.message,
      "The resumeJobId option is invalid: sourcify starts no link job, so there is none to resume.",
    );
  });

  it("refuses Routescan as for any proxy link", async (t) => {
    const r = await run(t, [], { route: { backend: "routescan" }, resumeJobId: GUID });
    const error = errorOf(r, "invalid-input");
    assert.ok(ExplorerVerifyError.is(error, "invalid-input"));
    assert.equal(error.details.issues[0]?.field, "route.backend");
    assert.equal(r.calls.length, 0);
  });

  it("refuses a job id that is not of the backend's form, never echoing it", async (t) => {
    const cases: [LinkProxyOptions, string, string][] = [
      [ETHERSCAN, "abc", "etherscan-v2"],
      [ETHERSCAN, GUID.toUpperCase(), "etherscan-v2"],
      [ETHERSCAN, `${GUID}0`, "etherscan-v2"],
      [BLOCKSCOUT, GUID, "blockscout"],
      [BLOCKSCOUT, `${OTHER_PROXY.slice(2)}6aeb80cb`, "blockscout"],
      [BLOCKSCOUT, `${PROXY.slice(2)}6aeb80cb6aeb80cb0`, "blockscout"],
    ];
    for (const [options, jobId, backend] of cases) {
      const r = await run(t, [], { ...options, resumeJobId: jobId });
      const error = refusedJobId(
        r,
        new RegExp(`^is not a link job id that ${backend} gives for this proxy$`),
      );
      assert.equal(
        error.message,
        `The resumeJobId option is invalid: it is not a link job id that ${backend} gives for this proxy.`,
      );
      assert.ok(!JSON.stringify([error.message, error.toJSON()]).includes(jobId), jobId);
    }
  });

  it("refuses a value that is not 1 to 100 letters and digits, never echoing it", async () => {
    for (const jobId of [42, "", "a b", "x".repeat(101), `${KEY}-1`, null]) {
      const fake = replay();
      // Passed untyped, as a JavaScript caller would.
      const call: unknown = Reflect.apply(runLinkProxy, undefined, [
        { chainId: SEPOLIA, address: PROXY },
        { ...ETHERSCAN, fetch: fake.fetch, resumeJobId: jobId },
        DEFAULT_LINK_DEPENDENCIES,
      ]);
      const error = await Promise.resolve(call).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      assert.ok(ExplorerVerifyError.is(error, "invalid-input"), String(error));
      assert.deepEqual(error.details.issues, [
        { field: "resumeJobId", message: "must be 1 to 100 letters and digits" },
      ]);
      assert.equal(
        error.message,
        "The resumeJobId option is invalid: it must be 1 to 100 letters and digits.",
      );
      assert.match(error.hint, /details\.jobId of a proxy-link-pending error/);
      assert.ok(!JSON.stringify(error).includes(KEY));
      assert.equal(fake.calls.length, 0);
    }
  });

  it("links as before when no options are passed at all", async () => {
    const linked: ProxyLinker = {
      request: async () => await Promise.resolve({ state: "linked", implementation: BOX }),
      check: async (): Promise<LinkVerdict> => await Promise.resolve({ state: "pending" }),
    };
    const result = await runLinkProxy({ chainId: SEPOLIA, address: PROXY }, undefined, {
      ...DEFAULT_LINK_DEPENDENCIES,
      linkers: { sourcify: linked, "etherscan-v2": linked, blockscout: linked },
    });
    assert.equal(result.status, "linked");
  });

  it("accepts 100 letters and digits as far as the backend's own check", async (t) => {
    const r = await run(t, [], { ...ETHERSCAN, resumeJobId: "a".repeat(100) });
    refusedJobId(r, /gives for this proxy$/);
  });

  it("lists resumeJobId among the option keys, and leaves an absent one as no resume", async (t) => {
    assert.ok(linkProxyOptionKeys().includes("resumeJobId"));
    const r = await run(t, [REQUESTED(), LINKED()], { ...ETHERSCAN, resumeJobId: undefined });
    assert.deepEqual(actions(r), ["verifyproxycontract", "checkproxyverification"]);
  });
});

describe("details.jobId is redacted with the call's keys (R-SEC-1)", () => {
  it("removes a key from the job id of proxy-link-pending, in the error and its JSON", async (t) => {
    const fake: ProxyLinker = {
      request: async () => await Promise.resolve({ state: "submitted", jobId: `job${KEY}` }),
      check: async (): Promise<LinkVerdict> => await Promise.resolve({ state: "pending" }),
    };
    const r = await run(t, [], ETHERSCAN, { linkers: { "etherscan-v2": fake } });
    const error = errorOf(r, "proxy-link-pending");
    const jobId = jobIdOf(error);
    assert.ok(!jobId.includes(KEY), jobId);
    assert.ok(jobId.startsWith("job"), jobId);
    assert.ok(!JSON.stringify(error).includes(KEY));
    // A 34-character job id of letters and digits is kept, as a handle's is.
    const kept = "JOB0123456789ABCDEFGHIJKLMNOPQRSTU";
    const other: ProxyLinker = {
      ...fake,
      request: async () => ({ state: "submitted", jobId: kept }),
    };
    const r2 = await run(t, [], ETHERSCAN, { linkers: { "etherscan-v2": other } });
    assert.equal(jobIdOf(errorOf(r2, "proxy-link-pending")), kept);
  });
});

/** linkProxy() with handlerUrl and resumeJobId; its fetch hands each request to a real handler. */
async function throughHandler(
  allowProxyLink: boolean,
): Promise<{ outcome: unknown; upstream: URLSearchParams[] }> {
  const explorer = fakeExplorer(
    json(etherscanFixture("2026-11-04-checkproxyverification-linked").body),
  );
  const handler = createVerifyHandler({
    apiKey: HANDLER_KEY,
    chains: [SEPOLIA],
    allowProxyLink,
    fetch: explorer.fetch,
  });
  const outcome = await linkProxy(
    { chainId: SEPOLIA, address: PROXY },
    {
      handlerUrl: HANDLER,
      resumeJobId: GUID,
      fetch: async (target, init) => {
        const url = typeof target === "string" ? target : target instanceof URL ? target.href : "";
        assert.ok(url.startsWith(`${HANDLER}?`), url);
        return await handler(new Request(url, init));
      },
    },
  ).catch((error: unknown) => error);
  return { outcome, upstream: explorer.calls.map((call) => call.form) };
}

describe("resumeJobId through the server handler (R-SRV-3)", () => {
  it("resumes when allowProxyLink is on: only checkproxyverification reaches the explorer, with the operator's key", async () => {
    const { outcome, upstream } = await throughHandler(true);
    assert.equal(Reflect.get(Object(outcome), "status"), "linked", String(outcome));
    assert.deepEqual(
      upstream.map((form) => form.get("action")),
      ["checkproxyverification"],
    );
    assert.equal(upstream[0]?.get("guid"), GUID);
    assert.equal(upstream[0]?.get("apikey"), HANDLER_KEY);
  });

  it("is refused with handler-refused when allowProxyLink is off, and nothing reaches the explorer", async () => {
    const { outcome, upstream } = await throughHandler(false);
    assert.ok(ExplorerVerifyError.is(outcome, "handler-refused"), String(outcome));
    assert.equal(outcome.details.handlerCode, "action-not-allowed");
    assert.deepEqual(upstream, []);
  });
});

describe("resumeJobId through explorer-verify/core (decision 0052)", () => {
  it("accepts resumeJobId and checks the job with the client the caller passes", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const fake = replay(LINKED());
    const call = coreLinkProxy(
      { chainId: SEPOLIA, address: PROXY },
      {
        clients: [etherscanV2ProxyLink()],
        route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" },
        apiKeys: { "etherscan-v2": KEY },
        resumeJobId: GUID,
        fetch: fake.fetch,
      },
    );
    await driveMockClock(call, () => {
      t.mock.timers.runAll();
    });
    assert.equal((await call).status, "linked");
    assert.deepEqual(
      fake.calls.map((c) => new URLSearchParams(c.body).get("action")),
      ["checkproxyverification"],
    );
  });
});

/** A 0.1.0-shaped proxy-link-pending envelope with these extra details. */
function pendingEnvelope(details: Record<string, unknown>): unknown {
  return {
    schemaVersion: 1,
    ok: false,
    error: {
      code: "proxy-link-pending",
      message: "The link of the proxy is not confirmed.",
      hint: "Call linkProxy() again later.",
      docsUrl:
        "https://github.com/aelmanaa/explorer-verify/blob/main/docs/user/reference/errors/proxy-link-pending.md",
      retryable: true,
      details: { code: "proxy-link-pending", backend: "etherscan-v2", ...details },
    },
  };
}

describe("details.jobId in JSON (R-AX-5, R-SEC-1)", () => {
  const own = { handle: undefined, handles: undefined };

  /** The `jobId` that detailsFromJson keeps of a proxy-link-pending error object. */
  function readJobId(
    jobId: unknown,
    secrets: readonly string[] = [],
    foreign = false,
  ): string | undefined {
    return detailsFromJson(
      "proxy-link-pending",
      { code: "proxy-link-pending", backend: "blockscout", jobId },
      secrets,
      { ...own, foreign },
    )?.jobId;
  }

  it("keeps a job id, leaves out a missing or non-string one, and removes a key", () => {
    assert.deepEqual(
      detailsFromJson("proxy-link-pending", { code: "proxy-link-pending", jobId: UID }, [], own),
      { code: "proxy-link-pending", backend: "etherscan-compatible", jobId: UID },
    );
    assert.deepEqual(
      detailsFromJson("proxy-link-pending", { code: "proxy-link-pending", jobId: 7 }, [], own),
      { code: "proxy-link-pending", backend: "etherscan-compatible" },
    );
    assert.equal(readJobId(undefined), undefined);
    assert.equal(readJobId(`job${KEY}`, [KEY]), "job[redacted]");
  });

  it("validates a 0.1.0 envelope without jobId against the schema, and one with it", () => {
    assert.deepEqual(validateEnvelope(pendingEnvelope({})), []);
    assert.deepEqual(validateEnvelope(pendingEnvelope({ jobId: GUID })), []);
    assert.notDeepEqual(validateEnvelope(pendingEnvelope({ jobId: 7 })), []);
  });

  it("builds an error without a job id, as code of an earlier release does", () => {
    const error = new ExplorerVerifyError(
      { code: "proxy-link-pending", backend: "etherscan-v2" },
      "pending",
      { secrets: [] },
    );
    assert.deepEqual(error.details, { code: "proxy-link-pending", backend: "etherscan-v2" });
  });

  it("cuts a job id to 1,000 characters", () => {
    assert.equal(readJobId("a".repeat(5_000), [], true)?.length, 1_000);
    assert.equal(readJobId("a".repeat(5_000))?.length, 1_000);
  });

  it("redacts the job id when the error is built, and cuts it to 1,000 characters", () => {
    const error = new ExplorerVerifyError(
      { code: "proxy-link-pending", backend: "etherscan-v2", jobId: `job${KEY}` },
      "pending",
      { secrets: [KEY] },
    );
    assert.ok(ExplorerVerifyError.is(error, "proxy-link-pending"));
    assert.equal(error.details.jobId, "job[redacted]");
    const long = new ExplorerVerifyError(
      { code: "proxy-link-pending", backend: "etherscan-v2", jobId: "a".repeat(5_000) },
      "pending",
      { secrets: [] },
    );
    assert.ok(ExplorerVerifyError.is(long, "proxy-link-pending"));
    assert.equal(long.details.jobId?.length, 1_000);
  });
});
