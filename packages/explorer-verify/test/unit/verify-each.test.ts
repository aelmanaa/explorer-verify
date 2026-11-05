// verifyEach(): one call, several backends, one outcome per backend (R-RT-4, decision 0034). The
// backends run in parallel, so the fake fetch answers by host, each host from its own list of
// recorded answers, with a fresh Response per request.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { Backend } from "../../src/backends/backend.ts";
import { etherscanCompatible } from "../../src/backends/etherscan-compatible.ts";
import { etherscan } from "../../src/backends/etherscan.ts";
import { routescan } from "../../src/backends/routescan.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { exitCodeOf, toEnvelope } from "../../src/envelope.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { parseHandle } from "../../src/flow/handle.ts";
import { MAX_BACKENDS, runVerifyEach } from "../../src/flow/verify-each.ts";
import type { FlowDependencies } from "../../src/flow/verify.ts";
import { verifyEach } from "../../src/index.ts";
import type { RoutingTable } from "../../src/routing/resolve.ts";
import type {
  VerifyEachOptions,
  VerifyEachResult,
  VerifyEvent,
  VerifyInput,
} from "../../src/types.ts";
import { loadFixture, responseOf } from "../helpers/fake-fetch.ts";
import { driveMockClock, turnUntil } from "../helpers/mock-clock.ts";
import { validateEnvelope } from "./envelope-schema.ts";

const SEPOLIA = 11155111;
// The recorded Sourcify jobs: the Greeter verified exact; the other contract's job had a code the
// library does not know.
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const GREETER_JOB = "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const OTHER = "0xa6b01960ea6e942ada412c76456bc9465682f3ab";
const OTHER_JOB = "dea83eb0-3918-449b-a914-3038dd554b42";
// Fake keys. Never real ones (R-SEC-1).
const ETHERSCAN_KEY = "DUMMYETHERSCANKEYeach7w3e9r1t5";
const ROUTESCAN_KEY = "dummy-routescan-key-each-4k8m2";
const STANDALONE_KEY = "dummy-standalone-key-each-9p2x";

const TABLE: RoutingTable = {
  schemaVersion: 2,
  checked: "2026-11-04",
  chains: [
    {
      chainId: SEPOLIA,
      backends: [
        { backend: "etherscan-v2", explorer: "sepolia.etherscan.io" },
        { backend: "sourcify" },
        { backend: "routescan", network: "testnet" },
      ],
    },
  ],
};

const CLIENTS = { sourcify, "etherscan-v2": etherscan, routescan };

const DEPENDENCIES: FlowDependencies = { backends: CLIENTS, table: TABLE, random: () => 0 };

function input(address: string = GREETER): VerifyInput {
  return {
    chainId: SEPOLIA,
    address: `0x${address.slice(2)}`,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
    contractName: "contracts/Greeter.sol:Greeter",
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** A recorded answer, as a new Response each time it is called. */
function recorded(backend: string, name: string): () => Response {
  return () => responseOf(loadFixture(backend, name));
}

/** The status and JSON body of a recorded answer, as a new Response each time it is called. */
function recordedBody(backend: string, name: string): () => Response {
  return () => {
    const url = new URL(`../fixtures/${backend}/${name}.json`, import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
    assert.ok(typeof parsed === "object" && parsed !== null);
    const response: unknown = Reflect.get(parsed, "response");
    assert.ok(typeof response === "object" && response !== null);
    const status: unknown = Reflect.get(response, "status");
    assert.ok(typeof status === "number");
    return json(status, Reflect.get(response, "body"));
  };
}

const sourcifyNotVerified = (address: string) => (): Response =>
  json(404, { match: null, creationMatch: null, runtimeMatch: null, chainId: "11155111", address });
const sourcifyAccepted = (jobId: string) => (): Response => json(202, { verificationId: jobId });
const SOURCIFY_EXACT_JOB = recorded("sourcify", "2026-11-02-job-exact-match");
const SOURCIFY_UNKNOWN_JOB = recorded("sourcify", "2026-11-02-job-unknown-code");
const SOURCIFY_PENDING = recorded("sourcify", "2026-11-02-job-pending");
const SOURCIFY_LOOKUP_EXACT = recorded("sourcify", "2026-11-02-lookup-exact-match");
const ETHERSCAN_NOT_VERIFIED = recordedBody("etherscan", "2026-11-03-getsourcecode-not-verified");
const ETHERSCAN_SUBMITTED = recordedBody("etherscan", "2026-11-03-verifysourcecode-factory-child");
const ETHERSCAN_FAIL = recordedBody("etherscan", "2026-11-02-documented-checkverifystatus-fail");
const ETHERSCAN_PENDING = recordedBody(
  "etherscan",
  "2026-11-03-checkverifystatus-factory-child-01-pending",
);
const ETHERSCAN_VERIFIED = recordedBody("etherscan", "2026-11-04-getsourcecode-sepolia-greeter");
// Sourcify's exact lookup answer for the Greeter on a chain the test table has no row for.
const UNLISTED_LOOKUP = (): Response =>
  json(200, {
    match: "exact_match",
    creationMatch: "exact_match",
    runtimeMatch: "exact_match",
    chainId: "999999",
    address: GREETER,
  });
const ROUTESCAN_VERIFIED = recordedBody("routescan", "2026-11-03-getsourcecode-verified");

interface Sent {
  readonly url: string;
  readonly body: string;
  readonly headers: Headers;
}

/**
 * A fake fetch that answers each host from its own list, in order. The last answer of a host with
 * `repeat` answers every later request; any other request past the list rejects.
 */
function byHost(
  answers: Readonly<Record<string, readonly (() => Response)[]>>,
  repeat: readonly string[] = [],
): { fetch: typeof fetch; sent: Map<string, Sent[]> } {
  const sent = new Map<string, Sent[]>();
  const fake = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    const { host } = new URL(url);
    const list = sent.get(host) ?? [];
    const body = init?.body;
    list.push({
      url,
      body:
        typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : "",
      headers: new Headers(init?.headers),
    });
    sent.set(host, list);
    const steps = answers[host] ?? [];
    const step = steps[list.length - 1] ?? (repeat.includes(host) ? steps.at(-1) : undefined);
    if (step === undefined) {
      throw new Error(`unexpected request ${String(list.length)} to ${host}`);
    }
    return await Promise.resolve(step());
  };
  return { fetch: fake, sent };
}

interface Run {
  /** What the call resolved with, or `undefined` when it rejected. */
  readonly result: VerifyEachResult | undefined;
  /** What the call resolved or rejected with. */
  readonly outcome: unknown;
  readonly events: VerifyEvent[];
  readonly lines: string[];
}

/** Runs runVerifyEach() on mocked timers until it settles. */
async function run(
  t: TestContext,
  options: VerifyEachOptions,
  dependencies: FlowDependencies = DEPENDENCIES,
  value: VerifyInput = input(),
): Promise<Run> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const events: VerifyEvent[] = [];
  const lines: string[] = [];
  const record = (message: string, fields?: unknown): void => {
    lines.push(`${message} ${JSON.stringify(fields)}`);
  };
  const pending = runVerifyEach(
    value,
    {
      pollIntervalMs: 1_000,
      logger: { debug: record, info: record, warn: record, error: record },
      onEvent: (event) => {
        events.push(event);
      },
      ...options,
    },
    dependencies,
  ).then(
    (result) => ({ result, outcome: result }),
    (error: unknown) => ({ result: undefined, outcome: error }),
  );
  await driveMockClock(pending, () => {
    t.mock.timers.runAll();
  });
  return { ...(await pending), events, lines };
}

/** The result of a run that resolved. */
function resultOf(r: Run): VerifyEachResult {
  assert.ok(r.result !== undefined, String(r.outcome));
  return r.result;
}

function errorOf(outcome: unknown, code: string): ExplorerVerifyError {
  assert.ok(outcome instanceof ExplorerVerifyError, String(outcome));
  assert.equal(outcome.code, code, outcome.message);
  return outcome;
}

describe("verifyEach(): one outcome per backend (R-RT-4)", () => {
  it("returns Sourcify verified and Etherscan failed, each with its backend, in the order asked (recorded answers)", async (t) => {
    const fake = byHost({
      "sourcify.dev": [
        sourcifyNotVerified(GREETER),
        sourcifyAccepted(GREETER_JOB),
        SOURCIFY_EXACT_JOB,
      ],
      "api.etherscan.io": [
        ETHERSCAN_NOT_VERIFIED,
        ETHERSCAN_SUBMITTED,
        ETHERSCAN_FAIL,
        ETHERSCAN_NOT_VERIFIED,
      ],
    });
    const r = await run(t, {
      fetch: fake.fetch,
      backends: ["sourcify", "etherscan-v2"],
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
    });
    const { outcomes } = resultOf(r);
    assert.equal(outcomes.length, 2);
    const [first, second] = outcomes;
    assert.deepEqual(first, {
      backend: "sourcify",
      ok: true,
      result: {
        status: "verified",
        backend: "sourcify",
        match: "exact",
        explorerUrl: `https://repo.sourcify.dev/${String(SEPOLIA)}/${GREETER}`,
      },
    });
    assert.equal(second?.backend, "etherscan-v2");
    assert.equal(second?.ok, false);
    assert.ok(second !== undefined && "result" in second && second.result.status === "failed");
    // The envelope: ok false, exit code 1, valid against the shipped schema.
    const envelope = toEnvelope(resultOf(r));
    assert.deepEqual(validateEnvelope(envelope), []);
    assert.equal(envelope.ok, false);
    assert.equal(exitCodeOf(resultOf(r)), 1);
    // verify.validated once; every other event names its backend.
    assert.equal(r.events.filter((event) => event.type === "verify.validated").length, 1);
    const backends = new Set(
      r.events.flatMap((event) => ("backend" in event ? [event.backend] : [])),
    );
    assert.deepEqual([...backends].toSorted(), ["etherscan-v2", "sourcify"]);
    assert.equal(r.events.filter((event) => event.type === "verify.submitted").length, 2);
  });

  it("keeps the other outcomes when one backend ends in unknown-state (R-FLOW-4)", async (t) => {
    const fake = byHost({
      "sourcify.dev": [
        sourcifyNotVerified(OTHER),
        sourcifyAccepted(OTHER_JOB),
        SOURCIFY_UNKNOWN_JOB,
      ],
      "api.etherscan.io": [ETHERSCAN_VERIFIED],
    });
    const r = await run(
      t,
      { fetch: fake.fetch, backends: ["etherscan-v2", "sourcify"] },
      DEPENDENCIES,
      input(OTHER),
    );
    const [first, second] = resultOf(r).outcomes;
    assert.equal(first?.backend, "etherscan-v2");
    assert.equal(first?.ok, true);
    assert.ok(first !== undefined && "result" in first);
    assert.equal(first.result.status, "already-verified");
    assert.ok(second !== undefined && "error" in second);
    assert.equal(second.backend, "sourcify");
    assert.equal(second.error.code, "unknown-state");
    assert.equal(
      second.error.toJSON().handle,
      `ev1:sourcify:${String(SEPOLIA)}:${OTHER}:${OTHER_JOB}`,
    );
    assert.equal(exitCodeOf(resultOf(r)), 6);
  });

  it("sends each key only to its own host (R-SEC-1, R-SEC-2, decision 0016)", async (t) => {
    const fake = byHost({
      "sourcify.dev": [SOURCIFY_LOOKUP_EXACT],
      "api.etherscan.io": [ETHERSCAN_VERIFIED],
      "api.routescan.io": [ROUTESCAN_VERIFIED],
    });
    const r = await run(t, {
      fetch: fake.fetch,
      backends: ["sourcify", "etherscan-v2", "routescan"],
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY },
    });
    const { outcomes } = resultOf(r);
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.backend, outcome.ok]),
      [
        ["sourcify", true],
        ["etherscan-v2", true],
        ["routescan", true],
      ],
    );
    const text = (host: string): string =>
      (fake.sent.get(host) ?? [])
        .map((each) => `${each.url} ${each.body} ${JSON.stringify([...each.headers])}`)
        .join("\n");
    assert.ok(text("api.etherscan.io").includes(ETHERSCAN_KEY));
    assert.ok(!text("api.etherscan.io").includes(ROUTESCAN_KEY));
    assert.ok(text("api.routescan.io").includes(ROUTESCAN_KEY));
    assert.ok(!text("api.routescan.io").includes(ETHERSCAN_KEY));
    assert.ok(!text("sourcify.dev").includes(ETHERSCAN_KEY));
    assert.ok(!text("sourcify.dev").includes(ROUTESCAN_KEY));
    const printed = JSON.stringify([r.outcome, r.events, r.lines]);
    assert.ok(!printed.includes(ETHERSCAN_KEY) && !printed.includes(ROUTESCAN_KEY));
    assert.equal(exitCodeOf(resultOf(r)), 0);
    assert.equal(toEnvelope(resultOf(r)).ok, true);
  });

  it("gives a route.apiKey only to its entry's host, and removes it from every backend's output (R-SEC-1, R-SEC-2)", async (t) => {
    const fake = byHost(
      {
        "sourcify.dev": [(): Response => json(500, { message: `echo ${STANDALONE_KEY}` })],
        "explorer.example.org": [ETHERSCAN_VERIFIED],
      },
      ["sourcify.dev"],
    );
    const r = await run(
      t,
      {
        fetch: fake.fetch,
        backends: [
          "sourcify",
          {
            backend: "etherscan-compatible",
            apiUrl: "https://explorer.example.org/api",
            apiKey: STANDALONE_KEY,
          },
        ],
        timeoutMs: 5_000,
      },
      { ...DEPENDENCIES, backends: { ...CLIENTS, "etherscan-compatible": etherscanCompatible } },
    );
    const { outcomes } = resultOf(r);
    assert.equal(outcomes[1]?.backend, "etherscan-compatible");
    assert.ok(
      !JSON.stringify(
        fake.sent.get("sourcify.dev")?.map((each) => [...each.headers, each.body, each.url]),
      ).includes(STANDALONE_KEY),
    );
    assert.ok(
      JSON.stringify(fake.sent.get("explorer.example.org")?.map((each) => each.body)).includes(
        STANDALONE_KEY,
      ),
    );
    assert.ok(!JSON.stringify([r.outcome, r.events, r.lines]).includes(STANDALONE_KEY));
  });

  it("keeps the handle of a not-confirmed outcome, which resumes that backend alone (R-FLOW-5)", async (t) => {
    const fake = byHost(
      {
        "sourcify.dev": [
          sourcifyNotVerified(GREETER),
          sourcifyAccepted(GREETER_JOB),
          SOURCIFY_PENDING,
        ],
        "api.etherscan.io": [ETHERSCAN_VERIFIED],
      },
      ["sourcify.dev"],
    );
    // The last lookup after the budget answers "not verified" through the repeated pending
    // answer, which has no match: not-confirmed.
    const r = await run(t, {
      fetch: fake.fetch,
      backends: ["sourcify", "etherscan-v2"],
      timeoutMs: 4_000,
    });
    const [first, second] = resultOf(r).outcomes;
    assert.ok(first !== undefined && "error" in first);
    assert.equal(first.error.code, "not-confirmed");
    const handle = parseHandle(first.error.toJSON().handle);
    assert.deepEqual(handle, {
      version: 1,
      backend: "sourcify",
      chainId: SEPOLIA,
      address: GREETER,
      jobId: GREETER_JOB,
    });
    assert.equal(second?.ok, true);
    assert.equal(exitCodeOf(resultOf(r)), 4);
  });

  it("shares one time budget: every backend stops by the same deadline", async (t) => {
    const fake = byHost(
      {
        "sourcify.dev": [
          sourcifyNotVerified(GREETER),
          sourcifyAccepted(GREETER_JOB),
          SOURCIFY_PENDING,
        ],
        "api.etherscan.io": [ETHERSCAN_NOT_VERIFIED, ETHERSCAN_SUBMITTED, ETHERSCAN_PENDING],
      },
      ["sourcify.dev", "api.etherscan.io"],
    );
    const r = await run(t, {
      fetch: fake.fetch,
      backends: ["sourcify", "etherscan-v2"],
      timeoutMs: 5_000,
    });
    const codes = resultOf(r).outcomes.map((outcome) =>
      "error" in outcome ? outcome.error.code : outcome.result.status,
    );
    assert.deepEqual(codes, ["not-confirmed", "not-confirmed"]);
    // The clock started at 0: the call ends within the budget plus one poll interval.
    assert.ok(Date.now() <= 6_000, String(Date.now()));
  });

  it("rejects with signal.reason on abort, after the submitted events of every accepted job (R-FLOW-6)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const fake = byHost(
      {
        "sourcify.dev": [
          sourcifyNotVerified(GREETER),
          sourcifyAccepted(GREETER_JOB),
          SOURCIFY_PENDING,
        ],
        "api.etherscan.io": [ETHERSCAN_NOT_VERIFIED, ETHERSCAN_SUBMITTED, ETHERSCAN_PENDING],
      },
      ["sourcify.dev", "api.etherscan.io"],
    );
    const controller = new AbortController();
    const events: VerifyEvent[] = [];
    const pending = runVerifyEach(
      input(),
      {
        fetch: fake.fetch,
        signal: controller.signal,
        backends: ["sourcify", "etherscan-v2"],
        onEvent: (event) => {
          events.push(event);
        },
      },
      DEPENDENCIES,
    ).catch((error: unknown) => error);
    await turnUntil(() => events.filter((event) => event.type === "verify.submitted").length === 2);
    const reason = new Error("stop");
    controller.abort(reason);
    assert.equal(await pending, reason);
    const submitted = events.flatMap((event) =>
      event.type === "verify.submitted" ? [event.backend] : [],
    );
    assert.deepEqual(submitted.toSorted(), ["etherscan-v2", "sourcify"]);
  });

  it("rejects at once when the signal is already aborted, and sends nothing", async () => {
    const fake = byHost({});
    const reason = new Error("before");
    const outcome = await runVerifyEach(
      input(),
      { fetch: fake.fetch, signal: AbortSignal.abort(reason), backends: ["sourcify"] },
      DEPENDENCIES,
    ).catch((error: unknown) => error);
    assert.equal(outcome, reason);
    assert.equal(fake.sent.size, 0);
  });
});

describe("verifyEach(): backends and routes", () => {
  it('"all" runs every backend the row lists that has a client, in the row\'s order', async (t) => {
    const fake = byHost({
      "sourcify.dev": [SOURCIFY_LOOKUP_EXACT],
      "api.etherscan.io": [ETHERSCAN_VERIFIED],
    });
    const r = await run(
      t,
      { fetch: fake.fetch, backends: "all", apiKeys: { "etherscan-v2": ETHERSCAN_KEY } },
      { ...DEPENDENCIES, backends: { sourcify, "etherscan-v2": etherscan } },
    );
    assert.deepEqual(
      resultOf(r).outcomes.map((outcome) => outcome.backend),
      ["etherscan-v2", "sourcify"],
    );
  });

  it('"all" on a chain without a row throws unsupported-chain, or runs Sourcify with allowSourcifyFallback (R-RT-3)', async (t) => {
    const missing = await run(t, { backends: "all", fetch: byHost({}).fetch }, DEPENDENCIES, {
      ...input(),
      chainId: 999_999,
    });
    errorOf(missing.outcome, "unsupported-chain");
    t.mock.timers.reset();
    const fake = byHost({ "sourcify.dev": [UNLISTED_LOOKUP] });
    const r = await run(
      t,
      { backends: "all", fetch: fake.fetch, allowSourcifyFallback: true },
      DEPENDENCIES,
      { ...input(), chainId: 999_999 },
    );
    assert.deepEqual(
      resultOf(r).outcomes.map((outcome) => [outcome.backend, outcome.ok]),
      [["sourcify", true]],
    );
  });

  it('"all" throws unsupported-chain when no backend of the row has a client', async (t) => {
    const r = await run(
      t,
      { backends: "all", fetch: byHost({}).fetch },
      { backends: { blockscout: sourcify }, table: TABLE },
    );
    const error = errorOf(r.outcome, "unsupported-chain");
    assert.equal(
      error.details.code === "unsupported-chain" && error.details.backend,
      "etherscan-v2",
    );
  });

  it("gives an unsupported-chain outcome for a backend the row does not list, and runs the others", async (t) => {
    const fake = byHost({ "sourcify.dev": [SOURCIFY_LOOKUP_EXACT] });
    const r = await run(
      t,
      { fetch: fake.fetch, backends: ["blockscout", "sourcify"] },
      { ...DEPENDENCIES, backends: { ...CLIENTS, blockscout: sourcify } },
    );
    const [first, second] = resultOf(r).outcomes;
    assert.ok(first !== undefined && "error" in first);
    assert.equal(first.backend, "blockscout");
    assert.equal(first.error.code, "unsupported-chain");
    assert.match(first.error.hint, /backends\[0\]\.backend/);
    assert.doesNotMatch(first.error.hint, /\broute\./);
    assert.equal(second?.ok, true);
    assert.equal(exitCodeOf(resultOf(r)), 2);
  });

  it("gives a missing-api-key outcome for Etherscan without a key, and sends it nothing (R-AX-7)", async (t) => {
    // No injected fetch: globalThis.fetch is replaced for this test only.
    const fake = byHost({ "sourcify.dev": [SOURCIFY_LOOKUP_EXACT] });
    t.mock.method(globalThis, "fetch", fake.fetch);
    const r = await run(t, { backends: ["etherscan-v2", "sourcify"] });
    const [first, second] = resultOf(r).outcomes;
    assert.ok(first !== undefined && "error" in first);
    assert.equal(first.error.code, "missing-api-key");
    assert.equal(second?.ok, true);
    assert.equal(fake.sent.get("api.etherscan.io"), undefined);
    assert.equal(exitCodeOf(resultOf(r)), 3);
  });

  it("gives a network outcome, with the load's error as cause, when one client module fails to load, and runs the others (decision 0031)", async (t) => {
    const broken = new TypeError("chunk failed");
    const r = await run(
      t,
      {
        fetch: byHost({ "sourcify.dev": [SOURCIFY_LOOKUP_EXACT] }).fetch,
        backends: ["sourcify", "etherscan-v2"],
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
      },
      {
        ...DEPENDENCIES,
        backends: {
          sourcify,
          "etherscan-v2": async (): Promise<Backend> => await Promise.reject(broken),
        },
      },
    );
    const [first, second] = resultOf(r).outcomes;
    assert.equal(first?.ok, true);
    assert.ok(second !== undefined && "error" in second);
    assert.equal(second.backend, "etherscan-v2");
    assert.ok(second.error instanceof ExplorerVerifyError);
    assert.equal(second.error.code, "network");
    // The cause is a redacted copy: a plain Error with the original name and message.
    assert.ok(second.error.cause instanceof Error);
    assert.equal(second.error.cause.name, "TypeError");
    assert.equal(second.error.cause.message, "chunk failed");
    assert.equal(exitCodeOf(resultOf(r)), 5);
  });

  it("rejects with an error that is not an ExplorerVerifyError outside a client load: a bug", async (t) => {
    const bug = new TypeError("bug in a client");
    const broken: Backend = {
      ...sourcify,
      lookup: async () => await Promise.reject(bug),
    };
    const r = await run(
      t,
      { fetch: byHost({}).fetch, backends: ["sourcify"] },
      { ...DEPENDENCIES, backends: { sourcify: broken } },
    );
    assert.equal(r.outcome, bug);
  });

  it("passes a timeout of a client load through as that backend's outcome", async (t) => {
    const r = await run(
      t,
      {
        fetch: byHost({ "sourcify.dev": [SOURCIFY_LOOKUP_EXACT] }).fetch,
        backends: ["sourcify", "etherscan-v2"],
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
        timeoutMs: 50,
      },
      {
        ...DEPENDENCIES,
        backends: {
          sourcify,
          "etherscan-v2": async (): Promise<Backend> => await new Promise<Backend>(() => undefined),
        },
      },
    );
    const second = resultOf(r).outcomes[1];
    assert.ok(second !== undefined && "error" in second);
    assert.equal(second.error.code, "timeout");
  });

  it('"all" leaves out a backend that needs a key when none is set: keyless on Sepolia gives Sourcify only', async (t) => {
    const fake = byHost({ "sourcify.dev": [SOURCIFY_LOOKUP_EXACT] });
    t.mock.method(globalThis, "fetch", fake.fetch);
    const outcome = await verifyEach(input(), { backends: "all" });
    assert.deepEqual(
      outcome.outcomes.map((each) => each.backend),
      ["sourcify"],
    );
    assert.equal(fake.sent.get("api.etherscan.io"), undefined);
  });

  it('"all" leaves out a keyed backend even with an injected fetch; routescan takes a key but needs none, so it stays', async (t) => {
    const fake = byHost({
      "sourcify.dev": [SOURCIFY_LOOKUP_EXACT],
      "api.routescan.io": [ROUTESCAN_VERIFIED],
    });
    const r = await run(t, { fetch: fake.fetch, backends: "all" });
    assert.deepEqual(
      resultOf(r).outcomes.map((each) => each.backend),
      ["sourcify", "routescan"],
    );
  });

  it('"all" keeps every listed backend when all of them need a key and none is set', async (t) => {
    const table: RoutingTable = {
      schemaVersion: 2,
      checked: "2026-11-04",
      chains: [{ chainId: SEPOLIA, backends: [{ backend: "etherscan-v2" }] }],
    };
    t.mock.method(globalThis, "fetch", byHost({}).fetch);
    const r = await run(t, { backends: "all" }, { ...DEPENDENCIES, table });
    const [only] = resultOf(r).outcomes;
    assert.ok(only !== undefined && "error" in only);
    assert.equal(only.error.code, "missing-api-key");
  });

  it("keeps the ExplorerVerifyError of an error outcome, with its details", async (t) => {
    t.mock.method(globalThis, "fetch", byHost({}).fetch);
    const r = await run(t, { backends: ["etherscan-v2"] });
    const [only] = resultOf(r).outcomes;
    assert.ok(only !== undefined && "error" in only);
    assert.ok(only.error instanceof ExplorerVerifyError);
    assert.deepEqual(only.error.details, { code: "missing-api-key", backend: "etherscan-v2" });
    const envelope = toEnvelope(resultOf(r));
    assert.deepEqual(validateEnvelope(envelope), []);
    assert.ok("result" in envelope && "outcomes" in envelope.result);
    assert.deepEqual(envelope.result.outcomes[0], {
      backend: "etherscan-v2",
      ok: false,
      error: only.error.toJSON(),
    });
  });

  it("the package entry point runs the shipped clients", async () => {
    const outcome = await verifyEach(input(), {
      backends: ["sourcify"],
      fetch: byHost({ "sourcify.dev": [SOURCIFY_LOOKUP_EXACT] }).fetch,
    });
    assert.deepEqual(
      outcome.outcomes.map((each) => each.ok),
      [true],
    );
  });
});

/** A recorded answer whose `url` says it came from `url`, as a real fetch's answer does. */
function answeredFrom(url: string, make: () => Response): () => Response {
  return () => {
    const answer = make();
    Object.defineProperty(answer, "url", { value: url });
    return answer;
  };
}

/** A recorded Sourcify answer marked `redirected`, as a fetch that followed a redirect returns it. */
function markedRedirected(): Response {
  const answer = SOURCIFY_LOOKUP_EXACT();
  Object.defineProperty(answer, "redirected", { value: true });
  return answer;
}

// Decision 0035: each backend of verifyEach() gets the platform's fetch as its default, so an
// answer from another origin than the request is refused there; an injected fetch may send the
// request elsewhere on purpose, so the URL of its answer is not checked.
describe("verifyEach(): the origin of an answer (R-SEC-2, decision 0035)", () => {
  const ELSEWHERE = "https://elsewhere.example/server/v2/contract";

  it("refuses an answer from another origin through the default fetch, on every backend", async (t) => {
    const fake = byHost({
      "sourcify.dev": [answeredFrom(ELSEWHERE, SOURCIFY_LOOKUP_EXACT)],
      "api.routescan.io": [answeredFrom(ELSEWHERE, ROUTESCAN_VERIFIED)],
    });
    t.mock.method(globalThis, "fetch", fake.fetch);
    const outcome = await runVerifyEach(
      input(),
      { backends: ["sourcify", "routescan"] },
      DEPENDENCIES,
    );
    assert.equal(outcome.outcomes.length, 2);
    for (const each of outcome.outcomes) {
      assert.ok("error" in each, `${each.backend} read the answer`);
      assert.equal(each.error.code, "unexpected-response");
      assert.match(each.error.message, /redirect, which is not followed/);
    }
  });

  it("reads the same answers through an injected fetch, such as a server handler", async () => {
    const fake = byHost({
      "sourcify.dev": [answeredFrom(ELSEWHERE, SOURCIFY_LOOKUP_EXACT)],
      "api.routescan.io": [answeredFrom(ELSEWHERE, ROUTESCAN_VERIFIED)],
    });
    const outcome = await runVerifyEach(
      input(),
      { backends: ["sourcify", "routescan"], fetch: fake.fetch },
      DEPENDENCIES,
    );
    assert.deepEqual(
      outcome.outcomes.map((each) => [each.backend, each.ok]),
      [
        ["sourcify", true],
        ["routescan", true],
      ],
    );
  });

  it("still refuses an answer marked redirected through an injected fetch", async () => {
    const fake = byHost({ "sourcify.dev": [markedRedirected] });
    const outcome = await verifyEach(input(), { backends: ["sourcify"], fetch: fake.fetch });
    const [only] = outcome.outcomes;
    assert.ok(only !== undefined && "error" in only);
    assert.equal(only.error.code, "unexpected-response");
  });
});

/** Calls runVerifyEach() with options the types refuse, as untyped code can; returns what it threw. */
async function untyped(value: VerifyInput, options: unknown): Promise<unknown> {
  const pending: unknown = Reflect.apply(runVerifyEach, undefined, [value, options, DEPENDENCIES]);
  return await Promise.resolve(pending).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("verifyEach(): invalid options throw invalid-input before any request (R-IN-6)", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["no backends", {}, "backends"],
    ["an empty list", { backends: [] }, "backends"],
    ["a string other than all", { backends: "sourcify" }, "backends"],
    [
      `more than ${String(MAX_BACKENDS)} entries`,
      { backends: Array.from({ length: MAX_BACKENDS + 1 }, () => "sourcify") },
      "backends",
    ],
    ["an unknown name", { backends: ["sourcify", "nope"] }, "backends[1]"],
    [
      "an entry without a backend",
      { backends: [{ apiUrl: "https://a.example" }] },
      "backends[0].backend",
    ],
    ["an entry that is an array", { backends: [["sourcify"]] }, "backends[0]"],
    [
      "an entry that is a class instance",
      { backends: [new URL("https://sourcify.dev")] },
      "backends[0]",
    ],
    ["an entry that is not an object", { backends: [42] }, "backends[0]"],
    [
      "an apiUrl that is not a string",
      { backends: [{ backend: "sourcify", apiUrl: 1 }] },
      "backends[0].apiUrl",
    ],
    [
      "an apiKey that is not a string",
      { backends: [{ backend: "sourcify", apiKey: 1 }] },
      "backends[0].apiKey",
    ],
    ["a repeated backend", { backends: ["sourcify", "sourcify"] }, "backends[1]"],
    [
      "a repeated backend and apiUrl",
      {
        backends: [
          { backend: "sourcify", apiUrl: "https://a.example" },
          { backend: "sourcify", apiUrl: "https://a.example" },
        ],
      },
      "backends[1]",
    ],
    ["a top-level route", { backends: ["sourcify"], route: { backend: "sourcify" } }, "route"],
    [
      "a backend name and the same backend at its routing-table URL, in another case and with a trailing slash",
      { backends: ["sourcify", { backend: "sourcify", apiUrl: "https://SOURCIFY.dev/server/" }] },
      "backends[1]",
    ],
    [
      "Etherscan by name and at its own API URL",
      {
        backends: [
          "etherscan-v2",
          { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" },
        ],
      },
      "backends[1]",
    ],
    [
      "an entry's key that appears in the address",
      {
        backends: [
          "sourcify",
          {
            backend: "routescan",
            apiUrl: "https://explorer.example.org/api",
            apiKey: GREETER.slice(2, 14),
          },
        ],
      },
      "backends[1].apiKey",
    ],
    [
      "an apiKeys key that appears in the address",
      { backends: ["sourcify"], apiKeys: { routescan: GREETER.slice(10, 22) } },
      "apiKeys.routescan",
    ],
    [
      "an apiUrl that resolveRoute refuses",
      { backends: [{ backend: "sourcify", apiUrl: "ftp://a.example" }] },
      "backends[0].apiUrl",
    ],
  ];
  for (const [name, options, field] of cases) {
    it(`refuses ${name}, naming ${field}`, async () => {
      const fake = byHost({});
      const outcome = await untyped(input(), { fetch: fake.fetch, ...options });
      const error = errorOf(outcome, "invalid-input");
      assert.ok(error.details.code === "invalid-input");
      assert.ok(
        error.details.issues.some((issue) => issue.field === field),
        JSON.stringify(error.details.issues),
      );
      assert.equal(fake.sent.size, 0);
    });
  }

  it("accepts the same backend twice with different apiUrls", async (t) => {
    const fake = byHost({
      "a.example": [SOURCIFY_LOOKUP_EXACT],
      "b.example": [SOURCIFY_LOOKUP_EXACT],
    });
    const r = await run(t, {
      fetch: fake.fetch,
      backends: [
        { backend: "sourcify", apiUrl: "https://a.example" },
        { backend: "sourcify", apiUrl: "https://b.example" },
      ],
    });
    assert.deepEqual(
      resultOf(r).outcomes.map((each) => each.ok),
      [true, true],
    );
  });

  it("refuses options whose backends getter throws, without its text", async () => {
    const options = {
      get backends(): never {
        throw new Error("secret text");
      },
    };
    const outcome = await runVerifyEach(input(), options, DEPENDENCIES).catch(
      (error: unknown) => error,
    );
    const error = errorOf(outcome, "invalid-input");
    assert.ok(!error.message.includes("secret text"));
  });

  it("refuses a backends array whose entries cannot be read", async () => {
    const hostile = new Proxy(["sourcify"], {
      get(): never {
        throw new Error("trap");
      },
    });
    const error = errorOf(await untyped(input(), { backends: hostile }), "invalid-input");
    assert.ok(error.details.code === "invalid-input");
    assert.equal(error.details.issues[0]?.field, "backends");
  });

  it("passes on an error that is not an ExplorerVerifyError from route resolution unchanged", async () => {
    const broken = new TypeError("table");
    const table = {
      schemaVersion: 2,
      checked: "2026-11-04",
      get chains(): never {
        throw broken;
      },
    };
    const outcome = await runVerifyEach(
      input(),
      { backends: ["sourcify"], fetch: byHost({}).fetch },
      { backends: CLIENTS, table },
    ).catch((error: unknown) => error);
    assert.equal(outcome, broken);
  });

  it("names the entry, not route, in the issue and the hint of an entry's route error", async () => {
    const outcome = await untyped(input(), {
      backends: ["sourcify", { backend: "sourcify", apiUrl: "https://a.example", apiKey: "short" }],
    });
    const error = errorOf(outcome, "invalid-input");
    assert.ok(error.details.code === "invalid-input");
    assert.equal(error.details.issues[0]?.field, "backends[1].apiKey");
    assert.match(error.hint, /backends\[1\]\.apiKey/);
    assert.doesNotMatch(error.hint, /\broute\./);
  });

  it("never runs a getter on an unknown field of an entry, as verify() reads route", async (t) => {
    const fake = byHost({ "sourcify.dev": [SOURCIFY_LOOKUP_EXACT] });
    const entry: { backend: "sourcify"; readonly trap: never } = {
      backend: "sourcify",
      get trap(): never {
        throw new Error("secret text");
      },
    };
    const r = await run(t, { fetch: fake.fetch, backends: [entry] });
    assert.equal(resultOf(r).outcomes[0]?.ok, true);
  });

  it("refuses an entry whose backend getter throws, without its text", async () => {
    const entry = {
      get backend(): never {
        throw new Error("secret text");
      },
    };
    const error = errorOf(await untyped(input(), { backends: [entry] }), "invalid-input");
    assert.ok(error.details.code === "invalid-input");
    assert.deepEqual(error.details.issues, [
      { field: "backends[0]", message: "could not be read" },
    ]);
    assert.ok(!JSON.stringify(error.toJSON()).includes("secret text"));
  });

  it("ignores an unknown field in an entry, as resolveRoute does for route", async (t) => {
    const fake = byHost({ "sourcify.dev": [SOURCIFY_LOOKUP_EXACT] });
    const entry: { backend: "sourcify"; note: string } = { backend: "sourcify", note: "x" };
    const r = await run(t, { fetch: fake.fetch, backends: [entry] });
    assert.equal(resultOf(r).outcomes[0]?.ok, true);
  });

  it("refuses no options at all", async () => {
    const outcome = await untyped(input(), undefined);
    errorOf(outcome, "invalid-input");
  });

  it("refuses bad input before any request", async () => {
    const fake = byHost({});
    const outcome = await runVerifyEach(
      { ...input(), address: "0x12" },
      { fetch: fake.fetch, backends: ["sourcify"] },
      DEPENDENCIES,
    ).catch((error: unknown) => error);
    errorOf(outcome, "invalid-input");
    assert.equal(fake.sent.size, 0);
  });
});
