// The Etherscan v2 client (R-BE-1). Every answer comes from a fixture in
// test/fixtures/etherscan/: recorded live on 2026-11-03 or 2026-11-04, or, where a file's `source`
// says so, built from a documented text. A test that changes a recorded body says how.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { inspect } from "node:util";

import type { Context, Target } from "../../src/backends/backend.ts";
import { REASON_LENGTH } from "../../src/backends/common.ts";
import { MAX_NOT_INDEXED_TRIES, etherscan, reasonCodeOf } from "../../src/backends/etherscan.ts";
import { ERROR_EXIT_CODES } from "../../src/envelope.ts";
import { ERROR_HINTS } from "../../src/error-hints.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import type { HttpContext } from "../../src/http/fetch.ts";
import { checkStatus } from "../../src/index.ts";
import { validateInput } from "../../src/input/validate.ts";
import { createObserver } from "../../src/observe.ts";
import type { RoutingTable } from "../../src/routing/resolve.ts";
import { createVerifyHandler } from "../../src/server/handler.ts";
import type {
  FailureReasonCode,
  Handle,
  RouteOverride,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/types.ts";
import { runVerify } from "../helpers/defaults.ts";
import { replay } from "../helpers/fake-fetch.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { resolveRoute } from "../helpers/route.ts";
import { compileStrict } from "./envelope-schema.ts";

const ARB_SEPOLIA = 421614;
const API = "https://api.etherscan.io/v2/api";
// Probe D1 of 2026-11-03: verified on Arbitrum Sepolia; its recorded submit gave GUID.
const D1 = "0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5";
const GUID = "cqmxkhtaudvs5yhbzgv5nryiczguab4g3ppjj6mb3gakhzxjcn";
// The contract the recorded lookups name: `ContractName` and `CompilerVersion` (decision 0063).
const CHILD = { name: "ProbeDChild", compilerVersion: "v0.8.24+commit.e11b9ed9" };
// Fake keys. Never real ones (R-SEC-1).
const KEY = "DUMMYETHERSCANKEYq7w3e9r1t5y";
const TABLE: RoutingTable = {
  schemaVersion: 2,
  checked: "2026-11-03",
  chains: [
    {
      chainId: ARB_SEPOLIA,
      backends: [{ backend: "etherscan-v2", explorer: "sepolia.arbiscan.io" }],
    },
  ],
};
const validateEvent = compileStrict(
  JSON.parse(readFileSync(new URL("../../schema/event.schema.json", import.meta.url), "utf8")),
);

/** The recorded or documented response of `test/fixtures/etherscan/<name>.json`. */
function answer(name: string, edit?: (body: Record<string, unknown>) => void): Response {
  const url = new URL(`../fixtures/etherscan/${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null);
  const response: unknown = Reflect.get(parsed, "response");
  assert.ok(typeof response === "object" && response !== null);
  const status: unknown = Reflect.get(response, "status");
  const body: unknown = structuredClone(Reflect.get(response, "body"));
  assert.ok(typeof status === "number" && typeof body === "object" && body !== null);
  const copy: Record<string, unknown> = { ...body };
  edit?.(copy);
  return new Response(JSON.stringify(copy), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** A body with `result` set to `text`, as the documented answers are. */
function text(result: string, status = "0"): Response {
  return new Response(
    JSON.stringify({ status, message: status === "1" ? "OK" : "NOTOK", result }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// The answers, by the call and what they say.
const SUBMITTED = (): Response => answer("2026-11-03-verifysourcecode-factory-child");
const ALREADY = (): Response => answer("2026-11-04-verifysourcecode-already-verified");
const NO_CODE = (): Response => answer("2026-11-04-verifysourcecode-no-code");
const SUBMIT_RATE_LIMIT = (): Response => answer("2026-11-04-verifysourcecode-rate-limit");
const LOOKUP_RATE_LIMIT = (): Response => answer("2026-11-04-getsourcecode-rate-limit");
const PENDING = (): Response => answer("2026-11-03-checkverifystatus-factory-child-01-pending");
const PASS = (): Response => answer("2026-11-03-checkverifystatus-factory-child-02-pass");
const FAIL = (): Response => answer("2026-11-02-documented-checkverifystatus-fail");
const EXACT = (): Response => answer("2026-11-03-getsourcecode-factory-child-verified");
const SIMILAR = (): Response => answer("2026-11-03-getsourcecode-similar-match");
const NOT_VERIFIED = (): Response => answer("2026-11-03-getsourcecode-not-verified");

interface Setup {
  ctx: Context;
  calls: Call[];
  events: VerifyEvent[];
  lines: string[];
}

function setup(
  steps: Step[],
  options: {
    route?: RouteOverride;
    budgetMs?: number;
    pollIntervalMs?: number;
    indexWaitMs?: number;
  } = {},
): Setup {
  const fake = replay(...steps);
  const events: VerifyEvent[] = [];
  const lines: string[] = [];
  const record = (message: string, fields?: unknown): void => {
    lines.push(`${message} ${JSON.stringify(fields)}`);
  };
  const secrets = [KEY];
  const http: HttpContext = {
    backend: "etherscan-v2",
    fetch: fake.fetch,
    secrets,
    random: () => 0,
    observer: createObserver({
      logger: { debug: record, info: record, warn: record, error: record },
      onEvent: (event) => {
        events.push(event);
      },
      secrets,
    }),
    ...(options.budgetMs === undefined
      ? {}
      : { budget: { deadline: Date.now() + options.budgetMs, timeoutMs: options.budgetMs } }),
  };
  const apiKeys = { "etherscan-v2": KEY };
  return {
    ctx: {
      route: resolveRoute(ARB_SEPOLIA, options.route, { apiKeys, table: TABLE }),
      apiKeys: () => apiKeys,
      http,
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.indexWaitMs === undefined ? {} : { indexWaitMs: options.indexWaitMs }),
    },
    calls: fake.calls,
    events,
    lines,
  };
}

function rawInput(): Record<string, unknown> {
  return {
    chainId: ARB_SEPOLIA,
    address: D1,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "src/ProbeDChild.sol": { content: "contract ProbeDChild {}" } },
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
      },
    },
    contractName: "src/ProbeDChild.sol:ProbeDChild",
    constructorArgs: "0x0000000000000000000000000000000000000000000000000000000000000001",
  };
}

function input(change: (raw: Record<string, unknown>) => void = () => {}): VerifyInput {
  const raw = rawInput();
  change(raw);
  return validateInput(raw);
}

const TARGET: Target = { chainId: ARB_SEPOLIA, address: input().address };

function handle(jobId: string = GUID): Handle {
  return {
    version: 1,
    backend: "etherscan-v2",
    chainId: ARB_SEPOLIA,
    address: TARGET.address,
    jobId,
  };
}

function form(call: Call | undefined): URLSearchParams {
  assert.ok(call !== undefined, "no such request");
  return new URLSearchParams(call.body ?? "");
}

/** Runs the mocked timers until `promise` settles; `setImmediate` is not mocked. */
async function drive<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  const state = { done: false };
  const tracked = promise.finally(() => {
    state.done = true;
  });
  tracked.catch(() => {});
  await driveMockClock(tracked, () => {
    t.mock.timers.runAll();
  });
  return await tracked;
}

async function errorOf(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const outcome: unknown = await promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
  assert.ok(outcome instanceof ExplorerVerifyError, `expected an error, got ${String(outcome)}`);
  return outcome;
}

/** Every text an error, its events and log lines show, for the key check. */
function surfaces(error: ExplorerVerifyError | undefined, setupDone: Setup): string {
  return [
    error === undefined ? "" : `${error.message} ${error.hint} ${JSON.stringify(error)}`,
    error === undefined ? "" : inspect(error, { depth: 5 }),
    JSON.stringify(setupDone.events),
    setupDone.lines.join("\n"),
  ].join("\n");
}

function assertKeyOnlyInBodies(calls: readonly Call[]): void {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.ok(!call.url.includes(KEY), `key in URL ${call.url}`);
    assert.equal(call.method, "POST");
    assert.equal(new URL(call.url).searchParams.get("chainid"), String(ARB_SEPOLIA));
    assert.equal(form(call).get("apikey"), KEY);
  }
}

// --- lookup ------------------------------------------------------------------------------------

describe("etherscan lookup (R-BE-1, R-FLOW-1, R-FLOW-4)", () => {
  it("sends getsourcecode as a form POST to the v2 API with chainid in the query and the key in the body (R-SEC-1)", async () => {
    const s = setup([EXACT()]);
    await etherscan.lookup(TARGET, s.ctx);
    assert.equal(s.calls[0]?.url, `${API}?chainid=${String(ARB_SEPOLIA)}`);
    assert.equal(s.calls[0]?.headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.deepEqual(Object.fromEntries(form(s.calls[0])), {
      module: "contract",
      action: "getsourcecode",
      address: TARGET.address,
      apikey: KEY,
    });
  });

  it("maps a non-empty SourceCode with an empty SimilarMatch to exact (recorded 2026-11-03)", async () => {
    assert.equal((await etherscan.lookup(TARGET, setup([EXACT()]).ctx))?.match, "exact");
  });

  it("maps a non-empty SimilarMatch to partial (recorded 2026-11-03, R-FLOW-3)", async () => {
    assert.equal((await etherscan.lookup(TARGET, setup([SIMILAR()]).ctx))?.match, "partial");
  });

  it("maps a first result without SimilarMatch, as the server handler may relay it, to exact", async () => {
    const reduced = answer("2026-11-03-getsourcecode-factory-child-verified", (body) => {
      body["result"] = [{ SourceCode: "[source not relayed by explorer-verify/server]" }];
    });
    assert.equal((await etherscan.lookup(TARGET, setup([reduced]).ctx))?.match, "exact");
  });

  it("throws unexpected-response for a SimilarMatch that is present but not text, never exact (R-FLOW-4)", async () => {
    for (const similar of [null, 0, 1, true, ["0x"], {}]) {
      // The recorded Similar Match answer, with SimilarMatch replaced.
      const response = answer("2026-11-03-getsourcecode-similar-match", (body) => {
        const result: unknown = body["result"];
        assert.ok(Array.isArray(result));
        const first: unknown = result[0];
        assert.ok(typeof first === "object" && first !== null);
        body["result"] = [{ ...first, SimilarMatch: similar }];
      });
      const error = await errorOf(etherscan.lookup(TARGET, setup([response]).ctx));
      assert.equal(error.code, "unexpected-response", JSON.stringify(similar));
    }
  });

  it("retries only a body whose result starts with the rate-limit text, not one that merely holds it", async () => {
    const quoted = answer("2026-11-03-getsourcecode-factory-child-verified", (body) => {
      body["result"] = [
        { SourceCode: "// Max calls per sec rate limit reached", SimilarMatch: "" },
      ];
    });
    const asSource = setup([quoted]);
    assert.equal((await etherscan.lookup(TARGET, asSource.ctx))?.match, "exact");
    assert.equal(asSource.calls.length, 1);
    const html = setup([
      new Response("<p>Max calls per sec rate limit reached</p>", { status: 200 }),
    ]);
    assert.equal((await errorOf(etherscan.lookup(TARGET, html.ctx))).code, "unexpected-response");
    assert.equal(html.calls.length, 1);
  });

  it("maps an empty SourceCode to not verified (recorded 2026-11-03)", async () => {
    assert.equal(await etherscan.lookup(TARGET, setup([NOT_VERIFIED()]).ctx), undefined);
  });

  const malformed: [string, (body: Record<string, unknown>) => void][] = [
    ["result as a JSON string of the array", (b) => (b["result"] = JSON.stringify(b["result"]))],
    ["an empty result array", (b) => (b["result"] = [])],
    ["a first result without SourceCode", (b) => (b["result"] = [{ ABI: "[]" }])],
    ["a first result that is not an object", (b) => (b["result"] = ["x"])],
    ["status 0 with the array", (b) => (b["status"] = "0")],
    ["no result", (b) => delete b["result"]],
  ];
  for (const [name, edit] of malformed) {
    it(`throws unexpected-response for ${name}, never not verified (R-FLOW-4)`, async () => {
      const error = await errorOf(
        etherscan.lookup(
          TARGET,
          setup([answer("2026-11-03-getsourcecode-not-verified", edit)]).ctx,
        ),
      );
      assert.equal(error.code, "unexpected-response");
    });
  }

  it("throws unexpected-response for a body that is not JSON and for a 403", async () => {
    for (const response of [
      new Response("<html>busy</html>", { status: 200 }),
      new Response(JSON.stringify({ status: "1", result: [{ SourceCode: "" }] }), { status: 403 }),
    ]) {
      const error = await errorOf(etherscan.lookup(TARGET, setup([response]).ctx));
      assert.equal(error.code, "unexpected-response");
    }
  });

  it("lookup rate-limit answer throws and is never read as not verified (R-FLOW-4, R-FLOW-6)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup([1, 2, 3, 4, 5].map(() => LOOKUP_RATE_LIMIT()));
    const error = await errorOf(drive(t, etherscan.lookup(TARGET, s.ctx)));
    assert.deepEqual(error.details, { code: "rate-limited", backend: "etherscan-v2", attempts: 5 });
    assert.equal(s.calls.length, 5);
  });

  it("throws the key and limit errors at once, with one request (recorded 2026-11-03, documented 2026-11-02)", async () => {
    const cases: [string, string][] = [
      ["2026-11-03-getsourcecode-no-key", "missing-api-key"],
      ["2026-11-03-getsourcecode-invalid-key", "api-key-rejected"],
      ["2026-11-02-documented-getsourcecode-daily-limit", "quota-exceeded"],
    ];
    for (const [name, code] of cases) {
      const s = setup([answer(name)]);
      const error = await errorOf(etherscan.lookup(TARGET, s.ctx));
      assert.deepEqual(error.details, { code, backend: "etherscan-v2" }, name);
      assert.equal(s.calls.length, 1);
    }
  });

  it("throws unsupported-chain for the chainid answer (recorded 2026-11-04)", async () => {
    const error = await errorOf(
      etherscan.lookup(TARGET, setup([answer("2026-11-04-getsourcecode-unsupported-chainid")]).ctx),
    );
    assert.deepEqual(error.details, {
      code: "unsupported-chain",
      backend: "etherscan-v2",
      chainId: ARB_SEPOLIA,
    });
  });

  it("deprecated V1 endpoint answer throws unexpected-response (recorded 2026-11-04)", async () => {
    const error = await errorOf(
      etherscan.lookup(TARGET, setup([answer("2026-11-04-getsourcecode-v1-endpoint")]).ctx),
    );
    assert.equal(error.code, "unexpected-response");
    assert.match(error.message, /v1 API/);
  });
});

// --- submit ------------------------------------------------------------------------------------

describe("etherscan submit (R-BE-1, R-FLOW-2, R-FLOW-7)", () => {
  it("maps status 1 with a GUID to a handle (recorded 2026-11-03)", async () => {
    const s = setup([SUBMITTED()]);
    assert.deepEqual(await etherscan.submit(input(), s.ctx), {
      state: "submitted",
      handle: handle(),
    });
    assertKeyOnlyInBodies(s.calls);
  });

  it("sends the Standard JSON input with only language, sources and settings", async () => {
    const s = setup([SUBMITTED()]);
    const raw = rawInput();
    Reflect.set(Object(Reflect.get(Object(raw["compiler"]), "input")), "extra", { a: 1 });
    await etherscan.submit(validateInput(raw), s.ctx);
    const sent = form(s.calls[0]);
    assert.equal(sent.get("action"), "verifysourcecode");
    assert.equal(sent.get("codeformat"), "solidity-standard-json-input");
    assert.equal(sent.get("contractaddress"), TARGET.address);
    assert.equal(sent.get("contractname"), "src/ProbeDChild.sol:ProbeDChild");
    const source: unknown = JSON.parse(sent.get("sourceCode") ?? "");
    assert.ok(typeof source === "object" && source !== null);
    assert.deepEqual(Object.keys(source), ["language", "sources", "settings"]);
  });

  it("submit body carries both constructor-argument spellings as bare hex, and neither when empty", async () => {
    const s = setup([SUBMITTED(), SUBMITTED(), SUBMITTED()]);
    await etherscan.submit(input(), s.ctx);
    const hex = "0000000000000000000000000000000000000000000000000000000000000001";
    assert.equal(form(s.calls[0]).get("constructorArguments"), hex);
    assert.equal(form(s.calls[0]).get("constructorArguements"), hex);
    await etherscan.submit(
      input((raw) => delete raw["constructorArgs"]),
      s.ctx,
    );
    await etherscan.submit(
      input((raw) => (raw["constructorArgs"] = "0x")),
      s.ctx,
    );
    for (const call of s.calls.slice(1)) {
      assert.equal(form(call).has("constructorArguments"), false);
      assert.equal(form(call).has("constructorArguements"), false);
    }
  });

  it("compilerversion has one leading v for input given with and without it", async () => {
    const s = setup([SUBMITTED(), SUBMITTED()]);
    const bare = input();
    await etherscan.submit(bare, s.ctx);
    // A ResolvedInput that skipped validateInput may still carry the v.
    await etherscan.submit(
      { ...bare, compiler: { ...bare.compiler, version: "v0.8.24+commit.e11b9ed9" } },
      s.ctx,
    );
    for (const call of s.calls) {
      assert.equal(form(call).get("compilerversion"), "v0.8.24+commit.e11b9ed9");
    }
  });

  it("a source path containing &apikey=x reaches the explorer as data (R-SEC-1)", async () => {
    const s = setup([SUBMITTED()]);
    const path = "src/a.sol&apikey=x&action=getsourcecode";
    await etherscan.submit(
      input((raw) => {
        raw["contractName"] = `${path}:A`;
        Reflect.set(Object(Reflect.get(Object(raw["compiler"]), "input")), "sources", {
          [path]: { content: "contract A {}" },
        });
      }),
      s.ctx,
    );
    const sent = form(s.calls[0]);
    assert.deepEqual(sent.getAll("apikey"), [KEY]);
    assert.deepEqual(sent.getAll("action"), ["verifysourcecode"]);
    assert.equal(sent.get("contractname"), `${path}:A`);
    const source: unknown = JSON.parse(sent.get("sourceCode") ?? "");
    assert.ok(typeof source === "object" && source !== null);
    const sources: unknown = Reflect.get(source, "sources");
    assert.ok(typeof sources === "object" && sources !== null && Object.hasOwn(sources, path));
  });

  it("throws unexpected-response for status 1 with a result that is not a GUID", async () => {
    for (const result of ["not a guid", "", "a".repeat(129)]) {
      const s = setup([
        answer("2026-11-03-verifysourcecode-factory-child", (b) => (b["result"] = result)),
      ]);
      const error = await errorOf(etherscan.submit(input(), s.ctx));
      assert.equal(error.code, "unexpected-response", result);
    }
  });

  it("submit maps Contract source code already verified to already-verified (recorded 2026-11-04, R-FLOW-7)", async () => {
    const s = setup([ALREADY(), EXACT()]);
    assert.deepEqual(await etherscan.submit(input(), s.ctx), {
      state: "already-verified",
      match: "exact",
      ...CHILD,
    });
    assert.equal(form(s.calls[1]).get("action"), "getsourcecode");
  });

  it("submit maps Already Verified to already-verified with the grade the lookup reads (documented, R-FLOW-7)", async () => {
    const s = setup([text("Already Verified"), SIMILAR()]);
    assert.deepEqual(await etherscan.submit(input(), s.ctx), {
      state: "already-verified",
      match: "partial",
      ...CHILD,
    });
  });

  it("throws unexpected-response when the lookup after already verified finds it not verified", async () => {
    const error = await errorOf(etherscan.submit(input(), setup([ALREADY(), NOT_VERIFIED()]).ctx));
    assert.equal(error.code, "unexpected-response");
    assert.match(error.message, /already verified, but a lookup found it not verified/);
  });

  it("retries Unable to locate ContractCode every pollIntervalMs, then submits (recorded 2026-11-04, R-FLOW-7)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([NO_CODE(), NO_CODE(), SUBMITTED()], {
      budgetMs: 60_000,
      pollIntervalMs: 5_000,
    });
    const outcome = await drive(t, etherscan.submit(input(), s.ctx));
    assert.equal(outcome.state, "submitted");
    assert.equal(s.calls.length, 3);
    assert.equal(Date.now(), 10_000);
    assert.deepEqual(
      s.events,
      [2, 3].map((attempt) => ({
        type: "verify.retry",
        backend: "etherscan-v2",
        attempt,
        reason: "not-indexed",
        delayMs: 5_000,
      })),
    );
    for (const event of s.events) {
      assert.deepEqual(validateEvent(event), [], JSON.stringify(event));
    }
    assert.ok(
      s.lines.some((line) =>
        line.includes(
          "found no contract code at the address yet; submitting again in 5000 ms (submit 2)",
        ),
      ),
    );
  });

  it("waits 3000 ms between those submits without a pollIntervalMs", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([NO_CODE(), SUBMITTED()], { budgetMs: 60_000 });
    await drive(t, etherscan.submit(input(), s.ctx));
    assert.equal(Date.now(), 3_000);
  });

  it("throws not-indexed, not timeout, when the next of those submits would pass the budget (decision 0066)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([NO_CODE(), NO_CODE()], { budgetMs: 8_000, pollIntervalMs: 5_000 });
    const error = await errorOf(drive(t, etherscan.submit(input(), s.ctx)));
    assert.deepEqual(error.details, {
      code: "not-indexed",
      backend: "etherscan-v2",
      submits: 2,
      elapsedMs: 5_000,
    });
    assert.equal(s.calls.length, 2);
    assert.equal(
      error.message,
      "Etherscan found no contract code at the address after 2 submits, within the 8 s budget.",
    );
    assert.match(error.hint, /^Check the chain and the address \(chainId, address\)\./);
    assert.equal(error.retryable, true);
  });

  it(`stops after ${String(MAX_NOT_INDEXED_TRIES)} of those submits without indexWaitMs, with not-indexed (decision 0066)`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    // A large budget, so the cap ends the loop; one more step would fail the replay.
    const steps = Array.from({ length: MAX_NOT_INDEXED_TRIES }, () => NO_CODE());
    const s = setup(steps, { budgetMs: 10_000_000, pollIntervalMs: 1_000 });
    const error = await errorOf(drive(t, etherscan.submit(input(), s.ctx)));
    assert.deepEqual(error.details, {
      code: "not-indexed",
      backend: "etherscan-v2",
      submits: 10,
      elapsedMs: 9_000,
    });
    assert.equal(s.calls.length, MAX_NOT_INDEXED_TRIES);
    assert.equal(s.events.length, MAX_NOT_INDEXED_TRIES - 1);
    assert.equal(
      error.message,
      "Etherscan found no contract code at the address after 10 submits.",
    );
    assert.equal(error.hint, ERROR_HINTS["not-indexed"]);
  });

  it("with indexWaitMs, sends more than 10 of those submits, with no cap in the log line (R-FLOW-7)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const steps = Array.from({ length: MAX_NOT_INDEXED_TRIES + 2 }, () => NO_CODE());
    const s = setup([...steps, SUBMITTED()], {
      budgetMs: 60_000,
      pollIntervalMs: 1_000,
      indexWaitMs: 20_000,
    });
    const outcome = await drive(t, etherscan.submit(input(), s.ctx));
    assert.equal(outcome.state, "submitted");
    assert.equal(s.calls.length, MAX_NOT_INDEXED_TRIES + 3);
    assert.equal(Date.now(), 12_000);
    assert.equal(s.events.length, MAX_NOT_INDEXED_TRIES + 2);
    assert.ok(
      s.lines.some((line) => line.includes("submitting again in 1000 ms (submit 12) {")),
      s.lines.join("\n"),
    );
    assert.ok(!s.lines.some((line) => line.includes("of at most")));
  });

  it("with indexWaitMs, never cuts a wait: it stops when a whole pollIntervalMs no longer fits", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    // Submits at 0, 2000 and 4000; at 4000 only 500 ms of indexWaitMs is left, so none follows.
    const steps = Array.from({ length: 3 }, () => NO_CODE());
    const s = setup(steps, { budgetMs: 60_000, pollIntervalMs: 2_000, indexWaitMs: 4_500 });
    const error = await errorOf(drive(t, etherscan.submit(input(), s.ctx)));
    assert.deepEqual(error.details, {
      code: "not-indexed",
      backend: "etherscan-v2",
      submits: 3,
      elapsedMs: 4_000,
    });
    assert.deepEqual(
      s.events.map((event) => (event.type === "verify.retry" ? event.delayMs : undefined)),
      [2_000, 2_000],
    );
    assert.equal(error.message, "Etherscan found no contract code at the address after 3 submits.");
  });

  it("with indexWaitMs, sends the last submit when a whole pollIntervalMs fits exactly", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    // Submits at 0, 2000 and 4000: the wait after 2000 ends exactly at indexWaitMs.
    const steps = Array.from({ length: 3 }, () => NO_CODE());
    const s = setup(steps, { budgetMs: 60_000, pollIntervalMs: 2_000, indexWaitMs: 4_000 });
    const error = await errorOf(drive(t, etherscan.submit(input(), s.ctx)));
    assert.equal(s.calls.length, 3);
    assert.deepEqual(error.details, {
      code: "not-indexed",
      backend: "etherscan-v2",
      submits: 3,
      elapsedMs: 4_000,
    });
  });

  it("with an indexWaitMs shorter than pollIntervalMs, sends one submit and no near-duplicate", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([NO_CODE()], { budgetMs: 60_000, pollIntervalMs: 3_000, indexWaitMs: 1 });
    const error = await errorOf(drive(t, etherscan.submit(input(), s.ctx)));
    assert.equal(s.calls.length, 1);
    assert.deepEqual(error.details, {
      code: "not-indexed",
      backend: "etherscan-v2",
      submits: 1,
      elapsedMs: 0,
    });
    assert.equal(s.events.length, 0);
  });

  it("keeps the wait and the count of the first try after a submit without a clear answer (decision 0066)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    // No code three times, a 502 that may hide an accepted submit, the lookup that finds nothing,
    // then no code again. The submit sent after the lookup belongs to the same wait.
    const s = setup(
      [
        NO_CODE(),
        NO_CODE(),
        NO_CODE(),
        new Response("Bad Gateway", { status: 502 }),
        NOT_VERIFIED(),
        NO_CODE(),
      ],
      { budgetMs: 60_000, pollIntervalMs: 3_000, indexWaitMs: 10_000 },
    );
    const error = await errorOf(drive(t, etherscan.submit(input(), s.ctx)));
    assert.deepEqual(error.details, {
      code: "not-indexed",
      backend: "etherscan-v2",
      submits: 4,
      elapsedMs: 9_000,
    });
    assert.equal(Date.now(), 9_000);
    assert.deepEqual(
      s.calls.map((call) => form(call).get("action")),
      [
        "verifysourcecode",
        "verifysourcecode",
        "verifysourcecode",
        "verifysourcecode",
        "getsourcecode",
        "verifysourcecode",
      ],
    );
  });

  it("with indexWaitMs longer than the budget, the budget ends the wait with not-indexed", async (t) => {
    // A clock that does not start at 0, so elapsedMs is measured from the first submit.
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 50_000 });
    const steps = Array.from({ length: 3 }, () => NO_CODE());
    const s = setup(steps, { budgetMs: 5_000, pollIntervalMs: 2_000, indexWaitMs: 60_000 });
    const error = await errorOf(drive(t, etherscan.submit(input(), s.ctx)));
    assert.deepEqual(error.details, {
      code: "not-indexed",
      backend: "etherscan-v2",
      submits: 3,
      elapsedMs: 4_000,
    });
    assert.match(error.message, /after 3 submits, within the 5 s budget\.$/);
  });

  it("stops when the next submit would land exactly on the budget's deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    // Submits at 0 and 2000; one more at 4000 would land on the deadline, so none is sent.
    const s = setup([NO_CODE(), NO_CODE()], {
      budgetMs: 4_000,
      pollIntervalMs: 2_000,
      indexWaitMs: 60_000,
    });
    const error = await errorOf(drive(t, etherscan.submit(input(), s.ctx)));
    assert.deepEqual(error.details, {
      code: "not-indexed",
      backend: "etherscan-v2",
      submits: 2,
      elapsedMs: 2_000,
    });
    assert.equal(s.calls.length, 2);
  });

  it("sends those submits again with a context that has no observer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([NO_CODE(), SUBMITTED()]);
    const { observer: _unused, ...http } = s.ctx.http;
    const outcome = await drive(t, etherscan.submit(input(), { ...s.ctx, http }));
    assert.equal(outcome.state, "submitted");
    assert.equal(s.calls.length, 2);
  });

  it("sends those submits again without a budget too, up to the cap, never failed", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([NO_CODE(), SUBMITTED()]);
    const outcome = await drive(t, etherscan.submit(input(), s.ctx));
    assert.equal(outcome.state, "submitted");
    assert.equal(Date.now(), 3_000);
  });

  it("rate-limit answer with HTTP 200 retries and is never failed or not verified (recorded 2026-11-04, R-FLOW-6)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup([SUBMIT_RATE_LIMIT(), SUBMITTED()]);
    const outcome = await drive(t, etherscan.submit(input(), s.ctx));
    assert.equal(outcome.state, "submitted");
    assert.deepEqual(s.events, [
      {
        type: "verify.retry",
        backend: "etherscan-v2",
        attempt: 2,
        reason: "rate-limited",
        delayMs: 500,
      },
    ]);
  });

  it("throws rate-limited once the retries of that answer stop", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup([1, 2, 3, 4, 5].map(() => SUBMIT_RATE_LIMIT()));
    const error = await errorOf(drive(t, etherscan.submit(input(), s.ctx)));
    assert.equal(error.code, "rate-limited");
    assert.match(error.message, /answered 200 \(rate limited\) after 5 attempts/);
  });

  it("throws quota-exceeded at once for a daily limit (documented 2026-11-02)", async () => {
    const s = setup([answer("2026-11-02-documented-verifysourcecode-daily-limit")]);
    const error = await errorOf(etherscan.submit(input(), s.ctx));
    assert.equal(error.code, "quota-exceeded");
    assert.equal(s.calls.length, 1);
  });

  it("throws the key errors and unsupported-chain for a submit", async () => {
    const cases: [Response, string][] = [
      [text("Missing/Invalid API Key"), "missing-api-key"],
      [text("Invalid API Key (#err2)"), "api-key-rejected"],
      [answer("2026-11-04-getsourcecode-unsupported-chainid"), "unsupported-chain"],
      [answer("2026-11-04-getsourcecode-v1-endpoint"), "unexpected-response"],
    ];
    for (const [response, code] of cases) {
      const error = await errorOf(etherscan.submit(input(), setup([response]).ctx));
      assert.equal(error.code, code);
    }
  });

  it("throws unexpected-response for any other status 0 answer, with a redacted excerpt, never failed (R-FLOW-4)", async () => {
    const s = setup([text(`Fail - Unable to verify. Error: bad source ${KEY}`)]);
    const error = await errorOf(etherscan.submit(input(), s.ctx));
    assert.equal(error.code, "unexpected-response");
    assert.ok(
      error.details.code === "unexpected-response" && error.details.excerpt.includes("bad source"),
    );
    assert.ok(!surfaces(error, s).includes(KEY));
  });

  it("looks the contract up after a 502 and returns already-verified when it is verified", async () => {
    const s = setup([new Response("bad gateway", { status: 502 }), EXACT()]);
    assert.deepEqual(await etherscan.submit(input(), s.ctx), {
      state: "already-verified",
      match: "exact",
      ...CHILD,
    });
    assert.equal(s.calls.length, 2);
    assert.ok(s.lines.some((line) => line.includes("Looking the contract up")));
  });

  it("submits once more after a 200 that is not JSON and a lookup that finds nothing", async () => {
    const s = setup([new Response("<html></html>", { status: 200 }), NOT_VERIFIED(), SUBMITTED()]);
    const outcome = await etherscan.submit(input(), s.ctx);
    assert.equal(outcome.state, "submitted");
    assert.deepEqual(
      s.calls.map((call) => form(call).get("action")),
      ["verifysourcecode", "getsourcecode", "verifysourcecode"],
    );
  });

  it("throws unexpected-response for a 403 without a lookup", async () => {
    const s = setup([new Response("{}", { status: 403 })]);
    assert.equal((await errorOf(etherscan.submit(input(), s.ctx))).code, "unexpected-response");
    assert.equal(s.calls.length, 1);
  });
});

// --- poll ----------------------------------------------------------------------------------------

describe("etherscan poll (R-BE-1, R-FLOW-2, R-FLOW-4)", () => {
  it("poll maps Pending in queue to pending, then Pass - Verified to verified exact (recorded 2026-11-03)", async () => {
    const s = setup([PENDING(), PASS()]);
    assert.deepEqual(await etherscan.poll(handle(), s.ctx), { state: "pending" });
    assert.deepEqual(await etherscan.poll(handle(), s.ctx), { state: "verified", match: "exact" });
    assert.deepEqual(Object.fromEntries(form(s.calls[0])), {
      module: "contract",
      action: "checkverifystatus",
      guid: GUID,
      apikey: KEY,
    });
    assertKeyOnlyInBodies(s.calls);
  });

  it("maps both already-verified texts to already-verified without a match (R-FLOW-7)", async () => {
    const s = setup([
      answer("2026-11-02-documented-checkverifystatus-already-verified"),
      text("Contract source code already verified"),
    ]);
    assert.deepEqual(await etherscan.poll(handle(), s.ctx), { state: "already-verified" });
    assert.deepEqual(await etherscan.poll(handle(), s.ctx), { state: "already-verified" });
  });

  it("Fail - Unable to verify with an exact lookup returns verified (documented 2026-11-02)", async () => {
    const s = setup([FAIL(), EXACT()]);
    assert.deepEqual(await etherscan.poll(handle(), s.ctx), {
      state: "verified",
      match: "exact",
      ...CHILD,
    });
    assert.equal(form(s.calls[1]).get("action"), "getsourcecode");
  });

  it("Fail - Unable to verify with a partial lookup returns already-verified partial: the submitted source was rejected", async () => {
    const s = setup([FAIL(), SIMILAR()]);
    assert.deepEqual(await etherscan.poll(handle(), s.ctx), {
      state: "already-verified",
      match: "partial",
      ...CHILD,
      reason:
        "Fail - Unable to verify. Compiled contract runtime bytecode does NOT match the on-chain runtime bytecode.",
    });
  });

  it("Fail - Unable to verify with a not-verified lookup returns failed with the explorer's text", async () => {
    const s = setup([FAIL(), NOT_VERIFIED()]);
    assert.deepEqual(await etherscan.poll(handle(), s.ctx), {
      state: "failed",
      reason:
        "Fail - Unable to verify. Compiled contract runtime bytecode does NOT match the on-chain runtime bytecode.",
      reasonCode: "bytecode-mismatch",
      notVerified: true,
    });
  });

  it("the recorded deployment bytecode mismatch with a not-verified lookup returns failed with its text (R-FLOW-4, live matrix 2026-11-04)", async () => {
    const s = setup([
      answer("2026-11-04-checkverifystatus-fail-bytecode-mismatch"),
      NOT_VERIFIED(),
    ]);
    assert.deepEqual(await etherscan.poll(handle(), s.ctx), {
      state: "failed",
      reason:
        "Fail - Unable to verify. Compiled contract deployment bytecode does NOT match the transaction deployment bytecode.",
      reasonCode: "bytecode-mismatch",
      notVerified: true,
    });
  });

  it("cuts and redacts the failed reason (R-SEC-1)", async () => {
    const s = setup([text(`Fail - Unable to verify ${KEY} ${"x".repeat(1000)}`), NOT_VERIFIED()]);
    const outcome = await etherscan.poll(handle(), s.ctx);
    assert.ok(outcome.state === "failed");
    assert.ok(outcome.reason.length <= REASON_LENGTH);
    assert.ok(!outcome.reason.includes(KEY));
  });

  it("throws the lookup's error after Fail - Unable to verify, never failed (R-FLOW-4)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup([FAIL(), ...[1, 2, 3, 4, 5].map(() => LOOKUP_RATE_LIMIT())]);
    const error = await errorOf(drive(t, etherscan.poll(handle(), s.ctx)));
    assert.equal(error.code, "rate-limited");
  });

  it("throws job-not-found for Unable to locate guid and Invalid GUID length (recorded 2026-11-04)", async () => {
    for (const name of [
      "2026-11-04-checkverifystatus-unknown-guid",
      "2026-11-04-checkverifystatus-short-guid",
    ]) {
      const error = await errorOf(etherscan.poll(handle(), setup([answer(name)]).ctx));
      assert.deepEqual(error.details, { code: "job-not-found", handle: handle() }, name);
    }
  });

  it("unknown poll string throws unknown-state and never returns verified (R-FLOW-4)", async () => {
    for (const result of ["Verified", "OK", "pass - verified", "In progress, maybe", ""]) {
      const error = await errorOf(etherscan.poll(handle(), setup([text(result, "1")]).ctx));
      assert.ok(error.details.code === "unknown-state", result);
      assert.deepEqual(error.details.handle, handle());
    }
  });

  it("Routescan's bytecode-mismatch text stays unknown-state for Etherscan, which has not been recorded giving it (R-FLOW-4, #164)", async () => {
    const result =
      "Error: Compilation successful, but bytecode does not match with deployed bytecode for address 0xA7B0158753812cDF1905d70802AF3BDDDe934A57, please check your parameters";
    const error = await errorOf(etherscan.poll(handle(), setup([text(result)]).ctx));
    assert.equal(error.code, "unknown-state");
  });

  it("throws unexpected-response for a result that is not text, a 500 or a body that is not JSON", async () => {
    for (const response of [
      new Response(JSON.stringify({ status: "1", result: ["x"] }), { status: 200 }),
      new Response(JSON.stringify({ status: "0", result: "Pending in queue" }), { status: 500 }),
      new Response("not json", { status: 200 }),
    ]) {
      const error = await errorOf(etherscan.poll(handle(), setup([response]).ctx));
      assert.equal(error.code, "unexpected-response");
    }
  });

  it("throws the key and chain errors for a poll", async () => {
    const error = await errorOf(
      etherscan.poll(handle(), setup([text("Missing/Invalid API Key")]).ctx),
    );
    assert.equal(error.code, "missing-api-key");
  });

  it("refuses a handle of another backend or with an odd job id before any request", async () => {
    const s = setup([]);
    const other = await errorOf(etherscan.poll({ ...handle(), backend: "sourcify" }, s.ctx));
    assert.ok(other.details.code === "invalid-input");
    assert.deepEqual(
      other.details.issues.map((issue) => issue.message),
      ["must be etherscan-v2 for the Etherscan client"],
    );
    const odd = await errorOf(etherscan.poll(handle("a&apikey=x"), s.ctx));
    assert.equal(odd.code, "invalid-input");
    assert.equal(s.calls.length, 0);
  });
});

// --- explorer page -------------------------------------------------------------------------------

describe("etherscan explorerUrl (R-FLOW-3)", () => {
  it("uses the routing table's explorer host", () => {
    assert.equal(
      etherscan.explorerUrl(TARGET, setup([]).ctx),
      `https://sepolia.arbiscan.io/address/${TARGET.address}#code`,
    );
  });

  it("is undefined for a route the caller moved to another server", () => {
    const ctx = setup([], {
      route: { backend: "etherscan-v2", apiUrl: "https://proxy.example/api" },
    }).ctx;
    assert.equal(etherscan.explorerUrl(TARGET, ctx), undefined);
  });
});

// --- a whole verify() run ------------------------------------------------------------------------

/** Runs runVerify() with the Etherscan client on the test table, timers mocked. */
async function runFlow(
  t: TestContext,
  steps: Step[],
  extra: VerifyOptions = {},
): Promise<{ outcome: unknown; events: VerifyEvent[]; calls: Call[]; lines: string[] }> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = replay(...steps);
  const events: VerifyEvent[] = [];
  const lines: string[] = [];
  const record = (message: string, fields?: unknown): void => {
    lines.push(`${message} ${JSON.stringify(fields)}`);
  };
  const outcome = await drive(
    t,
    runVerify(
      input(),
      {
        fetch: fake.fetch,
        apiKeys: { "etherscan-v2": KEY },
        pollIntervalMs: 1_000,
        logger: { debug: record, info: record, warn: record, error: record },
        onEvent: (event) => {
          events.push(event);
        },
        ...extra,
      },
      { backends: { "etherscan-v2": etherscan }, table: TABLE, random: () => 0 },
    ).catch((error: unknown) => error),
  );
  for (const event of events) {
    assert.deepEqual(validateEvent(event), [], JSON.stringify(event));
  }
  return { outcome, events, calls: fake.calls, lines };
}

describe("verify() with the Etherscan client (R-FLOW-1, R-FLOW-2, R-DX-6, R-SEC-1)", () => {
  it("runs lookup, submit, two polls and returns verified exact, with the events in order (recorded 2026-11-03)", async (t) => {
    const r = await runFlow(t, [NOT_VERIFIED(), SUBMITTED(), PENDING(), PASS()]);
    const expected: VerifyResult = {
      status: "verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: `https://sepolia.arbiscan.io/address/${TARGET.address}#code`,
    };
    assert.deepEqual(r.outcome, expected);
    assert.deepEqual(
      r.events.map((event) => event.type),
      [
        "verify.validated",
        "verify.routed",
        "verify.lookup",
        "verify.submitted",
        "verify.poll",
        "verify.result",
      ],
    );
    assert.deepEqual(
      r.calls.map((call) => form(call).get("action")),
      ["getsourcecode", "verifysourcecode", "checkverifystatus", "checkverifystatus"],
    );
  });

  it("no request URL contains the key across a full verify run, and no event, log line or result shows it (R-SEC-1)", async (t) => {
    const r = await runFlow(t, [
      NOT_VERIFIED(),
      SUBMIT_RATE_LIMIT(),
      SUBMITTED(),
      PENDING(),
      PASS(),
    ]);
    assertKeyOnlyInBodies(r.calls);
    const shown = [JSON.stringify(r.outcome), JSON.stringify(r.events), r.lines.join("\n")].join(
      "\n",
    );
    assert.ok(!shown.includes(KEY));
    assert.ok(
      r.events.some((event) => event.type === "verify.retry" && event.reason === "rate-limited"),
    );
  });

  it("redacts the key from an error that repeats it (R-SEC-1)", async (t) => {
    const r = await runFlow(t, [text(`Something new ${KEY}`)]);
    assert.ok(r.outcome instanceof ExplorerVerifyError);
    assert.equal(r.outcome.code, "unexpected-response");
    const shown = [
      r.outcome.message,
      JSON.stringify(r.outcome),
      inspect(r.outcome, { depth: 5 }),
      JSON.stringify(r.events),
      r.lines.join("\n"),
    ].join("\n");
    assert.ok(!shown.includes(KEY));
  });

  it("R-FLOW-7: waits indexWaitMs for a new deployment, then verifies (recorded 2026-11-04 and 2026-11-03)", async (t) => {
    // 15 answers of no contract code, 3 s apart: more than the 10 submits sent without indexWaitMs.
    const notIndexed = Array.from({ length: 15 }, () => NO_CODE());
    const r = await runFlow(t, [NOT_VERIFIED(), ...notIndexed, SUBMITTED(), PENDING(), PASS()], {
      indexWaitMs: 60_000,
      pollIntervalMs: 3_000,
    });
    const expected: VerifyResult = {
      status: "verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: `https://sepolia.arbiscan.io/address/${TARGET.address}#code`,
    };
    assert.deepEqual(r.outcome, expected);
    const retries = r.events.filter((event) => event.type === "verify.retry");
    assert.equal(retries.length, 15);
    assert.ok(retries.every((event) => event.reason === "not-indexed" && event.delayMs === 3_000));
    assert.equal(r.calls.length, 1 + 15 + 1 + 2);
    // The last submit went out at 45 s, and the two polls 3 s apart after it.
    assert.equal(Date.now(), 51_000);
  });

  it("R-FLOW-4: throws not-indexed, retryable, exit code 4 and no handle, when indexWaitMs ends (recorded 2026-11-04)", async (t) => {
    const notIndexed = Array.from({ length: 6 }, () => NO_CODE());
    const r = await runFlow(t, [NOT_VERIFIED(), ...notIndexed], { indexWaitMs: 5_000 });
    assert.ok(r.outcome instanceof ExplorerVerifyError);
    assert.deepEqual(r.outcome.details, {
      code: "not-indexed",
      backend: "etherscan-v2",
      submits: 6,
      elapsedMs: 5_000,
    });
    assert.equal(r.outcome.retryable, true);
    assert.ok(!("handle" in r.outcome.details));
    assert.equal(ERROR_EXIT_CODES[r.outcome.code], 4);
    assert.equal(
      r.events.filter((event) => event.type === "verify.retry" && event.reason === "not-indexed")
        .length,
      5,
    );
    assert.ok(!r.events.some((event) => event.type === "verify.submitted"));
  });

  it("returns already-verified from the first lookup without a submit (R-FLOW-1)", async (t) => {
    const r = await runFlow(t, [SIMILAR()]);
    assert.ok(typeof r.outcome === "object" && r.outcome !== null);
    assert.equal(Reflect.get(r.outcome, "status"), "already-verified");
    assert.equal(Reflect.get(r.outcome, "match"), "partial");
    assert.equal(r.calls.length, 1);
  });
});

// --- through the server handler -----------------------------------------------------------------

describe("the Etherscan client through createVerifyHandler (R-SRV-5, R-SEC-1)", () => {
  it("verifies through a self-hosted handler that holds the key: the client sends none", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const upstream = replay(NOT_VERIFIED(), SUBMITTED(), PENDING(), PASS());
    const handler = createVerifyHandler({
      apiKey: KEY,
      chains: [ARB_SEPOLIA],
      fetch: upstream.fetch,
    });
    const HANDLER = "https://verify.example.org/api";
    const seen: string[] = [];
    // The client's fetch: every request goes to the handler, as a server route would pass it.
    const toHandler: typeof fetch = async (target, init) => {
      const url =
        typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
      seen.push(`${url} ${init?.body instanceof URLSearchParams ? init.body.toString() : ""}`);
      return await handler(new Request(url, init));
    };
    const outcome = await drive(
      t,
      runVerify(
        input(),
        {
          fetch: toHandler,
          handlerUrl: HANDLER,
          pollIntervalMs: 1_000,
        },
        { backends: { "etherscan-v2": etherscan }, table: TABLE, random: () => 0 },
      ),
    );
    // The route is the routing table's, so the result links the explorer page (decision 0046).
    assert.deepEqual(outcome, {
      status: "verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: `https://sepolia.arbiscan.io/address/${D1.toLowerCase()}#code`,
    });
    assert.equal(seen.length, 4);
    for (const line of seen) {
      assert.ok(line.startsWith(`${HANDLER}?chainid=${String(ARB_SEPOLIA)} `), line);
      assert.ok(!line.includes(KEY) && !line.includes("apikey"), line);
    }
    // The handler added the key, in the body, on its way to Etherscan.
    assertKeyOnlyInBodies(upstream.calls);
    assert.deepEqual(
      upstream.calls.map((call) => form(call).get("action")),
      ["getsourcecode", "verifysourcecode", "checkverifystatus", "checkverifystatus"],
    );
  });

  it("resumes the handle through checkStatus() against the same handler", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const upstream = replay(PASS());
    const handler = createVerifyHandler({
      apiKey: KEY,
      chains: [ARB_SEPOLIA],
      fetch: upstream.fetch,
    });
    const outcome = await drive(
      t,
      checkStatus(handle(), {
        fetch: async (target, init) =>
          await handler(new Request(target instanceof Request ? target : String(target), init)),
        handlerUrl: "https://verify.example.org/api",
      }),
    );
    // The route is the routing table's, so the result links the explorer page (decision 0046).
    assert.deepEqual(outcome, {
      status: "verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: `https://sepolia.arbiscan.io/address/${D1.toLowerCase()}#code`,
    });
    assertKeyOnlyInBodies(upstream.calls);
  });
});

// References: R-FLOW-4, decision 0073.
describe("Etherscan: the reason code of a rejected job", () => {
  // The recorded mismatch, then the texts of Etherscan's documented verification errors
  // (docs.etherscan.io, Common Verification Errors, read 2026-11-12), each after the Fail prefix.
  const cases: readonly (readonly [string, FailureReasonCode])[] = [
    [
      "Fail - Unable to verify. Compiled contract deployment bytecode does NOT match the transaction deployment bytecode.",
      "bytecode-mismatch",
    ],
    [
      'Fail - Unable to verify. Source "@openzeppelin/contracts/ERC20.sol" not found: File import callback not supported',
      "missing-source",
    ],
    [
      'Fail - Unable to verify. Solidity Compilation Error: Source "lib/A.sol" not found: File not found.',
      "missing-source",
    ],
    [
      "Fail - Unable to verify. Please check if the correct constructor argument was entered",
      "constructor-args",
    ],
    ["Fail - Unable to verify. Library was required but suitable match not found", "libraries"],
    [
      "Fail - Unable to verify. Unable to locate ContractName , did you specify the correct Contract Name ?",
      "contract-name",
    ],
    [
      "Fail - Unable to verify. Please check if the correct bytecodehash was specified via standard-json verification.",
      "bytecode-mismatch",
    ],
    [
      "Fail - Unable to verify. Solidity Compilation Error: Identifier not found or not unique",
      "compiler",
    ],
    [
      "Fail - Unable to verify. Invalid or not supported solc version, see https://etherscan.io/solcversions for list",
      "compiler",
    ],
    ["Fail - Unable to verify", "unknown"],
  ];
  for (const [result, reasonCode] of cases) {
    it(`${reasonCode}: ${result.slice(24, 80)}`, async () => {
      const s = setup([
        answer("2026-11-04-checkverifystatus-fail-bytecode-mismatch", (body) => {
          body.result = result;
        }),
        NOT_VERIFIED(),
      ]);
      assert.deepEqual(await etherscan.poll(handle(), s.ctx), {
        state: "failed",
        reason: result,
        reasonCode,
        notVerified: true,
      });
    });
  }

  it("reads the cause from the whole text, before the reason is cut to its length", () => {
    const long = `${"x".repeat(REASON_LENGTH)} Source "a.sol" not found`;
    assert.equal(reasonCodeOf(long), "missing-source");
  });
});
