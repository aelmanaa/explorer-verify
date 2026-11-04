// The Blockscout client for single-chain instances (R-BE-3). Every answer comes from a fixture in
// test/fixtures/blockscout/: recorded live on base-sepolia.blockscout.com on 2026-11-04 or, where a
// file's `source` says so, built from a documented text. A test that changes a recorded body says
// how. Each row of the lookup, submit and poll tables of issue #92 has a test here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";
import { inspect } from "node:util";

import type { Context, Target } from "../../src/backends/backend.ts";
import {
  EMPTY_SUBMIT_WINDOW_MS,
  MAX_EMPTY_SUBMITS,
  blockscout,
} from "../../src/backends/blockscout.ts";
import { REASON_LENGTH } from "../../src/backends/common.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { runCheckStatus } from "../../src/flow/status.ts";
import { DEFAULT_DEPENDENCIES, runVerify } from "../../src/flow/verify.ts";
import type { HttpContext } from "../../src/http/fetch.ts";
import { validateInput } from "../../src/input/validate.ts";
import { createObserver } from "../../src/observe.ts";
import { resolveRoute } from "../../src/routing/resolve.ts";
import type { RoutingTable } from "../../src/routing/resolve.ts";
import type {
  Handle,
  RouteOverride,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/types.ts";
import { replay } from "../helpers/fake-fetch.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { compileStrict } from "./envelope-schema.ts";

const BASE_SEPOLIA = 84532;
const INSTANCE = "base-sepolia.blockscout.com";
const API = `https://${INSTANCE}/api`;
// The contract of the recorded form-encoded submit, and its job id.
const ADDRESS = "0x0d7ba9133629d6732a3ef5a3f5f09c68dac4be65";
const GUID = "0d7ba9133629d6732a3ef5a3f5f09c68dac4be656aeaee3f";
// A made-up secret of the call: no request may carry it, and no output may show it (R-SEC-1).
const SECRET = "DUMMYSECRETb92k4m7p0q3";
const TABLE: RoutingTable = {
  schemaVersion: 2,
  checked: "2026-11-04",
  chains: [{ chainId: BASE_SEPOLIA, backends: [{ backend: "blockscout", instance: INSTANCE }] }],
};
const validateEvent = compileStrict(
  JSON.parse(readFileSync(new URL("../../schema/event.schema.json", import.meta.url), "utf8")),
);

/** The recorded or documented response of `test/fixtures/blockscout/<name>.json`. */
function answer(name: string, edit?: (body: Record<string, unknown>) => void): Response {
  const url = new URL(`../fixtures/blockscout/${name}.json`, import.meta.url);
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

/** A body in the shape of Blockscout's RPC answers, with `result` set to `result`. */
function text(result: unknown, status = "0", message = "NOTOK"): Response {
  return new Response(JSON.stringify({ message, result, status }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// The answers, by the call and what they say.
const FULL = (): Response => answer("2026-11-04-lookup-full");
const PARTIAL = (): Response => answer("2026-11-04-lookup-partial-no-metadata-hash");
const BYTECODE_DB = (): Response => answer("2026-11-04-lookup-partial-bytecode-database");
const UNVERIFIED = (): Response => answer("2026-11-04-lookup-unverified");
const NOT_FOUND = (): Response => answer("2026-11-04-lookup-not-found");
const SUBMITTED = (): Response => answer("2026-11-04-verifysourcecode-form");
const ALREADY = (): Response => answer("2026-11-04-verifysourcecode-already-verified");
const NOT_A_CONTRACT = (): Response => answer("2026-11-04-verifysourcecode-not-a-contract");
const EMPTY = (): Response => answer("2026-11-04-documented-verifysourcecode-empty");
const RATE_LIMIT = (): Response => answer("2026-11-04-verifysourcecode-rate-limit");
const PENDING = (): Response => answer("2026-11-04-documented-checkverifystatus-pending");
const PASS = (): Response => answer("2026-11-04-checkverifystatus-pass");
const FAIL = (): Response => answer("2026-11-04-checkverifystatus-fail");
const UNKNOWN_UID = (): Response => answer("2026-11-04-checkverifystatus-unknown-uid");

interface Setup {
  ctx: Context;
  calls: Call[];
  events: VerifyEvent[];
  lines: string[];
}

function setup(
  steps: Step[],
  options: { route?: RouteOverride; budgetMs?: number; pollIntervalMs?: number } = {},
): Setup {
  const fake = replay(...steps);
  const events: VerifyEvent[] = [];
  const lines: string[] = [];
  const record = (message: string, fields?: unknown): void => {
    lines.push(`${message} ${JSON.stringify(fields)}`);
  };
  const secrets = [SECRET];
  const http: HttpContext = {
    backend: "blockscout",
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
  return {
    ctx: {
      route: resolveRoute(BASE_SEPOLIA, options.route, { table: TABLE }),
      http,
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    },
    calls: fake.calls,
    events,
    lines,
  };
}

function rawInput(): Record<string, unknown> {
  return {
    chainId: BASE_SEPOLIA,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
      },
    },
    contractName: "contracts/Greeter.sol:Greeter",
    constructorArgs: "0x0000000000000000000000000000000000000000000000000000000000000001",
  };
}

function input(change: (raw: Record<string, unknown>) => void = () => {}): VerifyInput {
  const raw = rawInput();
  change(raw);
  return validateInput(raw);
}

const TARGET: Target = { chainId: BASE_SEPOLIA, address: input().address };

function handle(jobId: string = GUID): Handle {
  return { version: 1, backend: "blockscout", chainId: BASE_SEPOLIA, address: ADDRESS, jobId };
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
  for (let round = 0; round < 400 && !state.done; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (!state.done) {
      t.mock.timers.runAll();
    }
  }
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

/**
 * Every request went to the routing row's origin, and none carried a key in its URL, body or
 * headers (R-SEC-2, decision 0016).
 */
function assertKeyless(calls: readonly Call[]): void {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(url.origin, `https://${INSTANCE}`, call.url);
    assert.equal(url.search, "", call.url);
    assert.ok(!/apikey/i.test(call.url), call.url);
    assert.ok(!/apikey/i.test(call.body ?? ""), call.body);
    assert.equal(call.headers.get("apikey"), null);
    assert.equal(call.headers.get("x-api-key"), null);
    assert.equal(call.headers.get("authorization"), null);
  }
}

// --- lookup ------------------------------------------------------------------------------------

describe("blockscout lookup (R-BE-3, R-FLOW-1, R-FLOW-4)", () => {
  it("sends GET /api/v2/smart-contracts/{address} to the instance, with no key (R-SEC-2)", async () => {
    const s = setup([FULL()]);
    await blockscout.lookup(TARGET, s.ctx);
    assert.equal(s.calls[0]?.url, `${API}/v2/smart-contracts/${ADDRESS}`);
    assert.equal(s.calls[0]?.method, "GET");
    assert.equal(s.calls[0]?.body, undefined);
    assertKeyless(s.calls);
  });

  it("maps is_fully_verified to exact (recorded 2026-11-04)", async () => {
    assert.equal(await blockscout.lookup(TARGET, setup([FULL()]).ctx), "exact");
  });

  it("maps is_partially_verified to partial: a build without a metadata hash (recorded 2026-11-04, R-FLOW-7)", async () => {
    assert.equal(await blockscout.lookup(TARGET, setup([PARTIAL()]).ctx), "partial");
  });

  it("maps a partial match from the bytecode database to partial (recorded 2026-11-04)", async () => {
    assert.equal(await blockscout.lookup(TARGET, setup([BYTECODE_DB()]).ctx), "partial");
  });

  it("maps a 200 with only the contract's code to not verified (recorded 2026-11-04)", async () => {
    assert.equal(await blockscout.lookup(TARGET, setup([UNVERIFIED()]).ctx), undefined);
  });

  it("maps is_verified false to not verified", async () => {
    const edited = answer("2026-11-04-lookup-full", (body) => {
      body["is_verified"] = false;
      body["is_fully_verified"] = false;
    });
    assert.equal(await blockscout.lookup(TARGET, setup([edited]).ctx), undefined);
  });

  it("maps a 404 Not found to not verified (recorded 2026-11-04)", async () => {
    assert.equal(await blockscout.lookup(TARGET, setup([NOT_FOUND()]).ctx), undefined);
  });

  it("throws unexpected-response for a 200 with is_verified true and neither flag set, never a match (R-FLOW-4)", async () => {
    for (const edit of [
      (body: Record<string, unknown>) => {
        body["is_fully_verified"] = false;
      },
      (body: Record<string, unknown>) => {
        delete body["is_fully_verified"];
        delete body["is_partially_verified"];
      },
      (body: Record<string, unknown>) => {
        body["is_fully_verified"] = "true";
      },
    ]) {
      const error = await errorOf(
        blockscout.lookup(TARGET, setup([answer("2026-11-04-lookup-full", edit)]).ctx),
      );
      assert.ok(error.details.code === "unexpected-response");
      assert.equal(error.details.status, 200);
    }
  });

  it("throws for every other answer, never not verified (R-FLOW-4)", async () => {
    const cases: [string, Response][] = [
      ["a 422 for an address the instance refuses", answer("2026-11-04-lookup-invalid-address")],
      [
        "an HTML error page",
        new Response("<html><body>Bad gateway</body></html>", { status: 500 }),
      ],
      ["a 404 with another message", new Response('{"message":"Gone"}', { status: 404 })],
      ["a 404 that is not JSON", new Response("Not found", { status: 404 })],
      ["a 200 that is not JSON", new Response("<html></html>", { status: 200 })],
      ["a 200 without any field", new Response("{}", { status: 200 })],
      [
        "a 200 with a flag but no is_verified",
        answer("2026-11-04-lookup-unverified", (body) => {
          body["is_fully_verified"] = false;
        }),
      ],
      [
        "a 200 with the partial flag but no is_verified",
        answer("2026-11-04-lookup-unverified", (body) => {
          body["is_partially_verified"] = false;
        }),
      ],
      ["a 200 with is_verified null", new Response('{"is_verified":null}', { status: 200 })],
      ["a 403", new Response('{"message":"Forbidden"}', { status: 403 })],
    ];
    for (const [what, response] of cases) {
      const error = await errorOf(blockscout.lookup(TARGET, setup([response]).ctx));
      assert.equal(error.code, "unexpected-response", what);
      assert.match(error.message, /Blockscout gave an answer to the lookup/, what);
    }
  });

  it("retries a 429 and then reads the answer (recorded 2026-11-04, R-FLOW-6)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([RATE_LIMIT(), FULL()], { budgetMs: 60_000 });
    assert.equal(await drive(t, blockscout.lookup(TARGET, s.ctx)), "exact");
    assert.equal(s.calls.length, 2);
    assert.ok(s.events.some((event) => event.type === "verify.retry"));
  });
});

// --- submit ------------------------------------------------------------------------------------

describe("blockscout submit (R-BE-3, R-FLOW-2, R-FLOW-7)", () => {
  it("sends verifysourcecode as a form POST to the instance's /api, with no key (R-SEC-2)", async () => {
    const s = setup([SUBMITTED()]);
    await blockscout.submit(input(), s.ctx);
    const call = s.calls[0];
    assert.equal(call?.url, API);
    assert.equal(call.method, "POST");
    assert.equal(call.headers.get("content-type"), "application/x-www-form-urlencoded");
    const fields = Object.fromEntries(form(call));
    assert.deepEqual(Object.keys(fields), [
      "module",
      "action",
      "codeformat",
      "sourceCode",
      "contractaddress",
      "contractname",
      "compilerversion",
      "constructorArguments",
    ]);
    assert.equal(fields["module"], "contract");
    assert.equal(fields["action"], "verifysourcecode");
    assert.equal(fields["codeformat"], "solidity-standard-json-input");
    assert.equal(fields["contractaddress"], ADDRESS);
    assert.equal(fields["contractname"], "contracts/Greeter.sol:Greeter");
    assert.equal(fields["compilerversion"], "v0.8.24+commit.e11b9ed9");
    // Blockscout 12 refuses constructor arguments that are not 0x-prefixed hex.
    assert.equal(
      fields["constructorArguments"],
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
    assertKeyless(s.calls);
  });

  it("sends only language, sources and settings of the input", async () => {
    const s = setup([SUBMITTED()]);
    const extra = input((raw) => {
      const compiler = raw["compiler"];
      assert.ok(typeof compiler === "object" && compiler !== null);
      const source = Reflect.get(compiler, "input");
      assert.ok(typeof source === "object" && source !== null);
      Reflect.set(source, "extra", "dropped");
    });
    await blockscout.submit(extra, s.ctx);
    const sent: unknown = JSON.parse(form(s.calls[0]).get("sourceCode") ?? "");
    assert.ok(typeof sent === "object" && sent !== null);
    assert.deepEqual(Object.keys(sent), ["language", "sources", "settings"]);
  });

  it("sends no constructorArguments when the input has none, or an empty value", async () => {
    for (const args of [undefined, "0x"]) {
      const s = setup([SUBMITTED()]);
      await blockscout.submit(
        input((raw) => {
          if (args === undefined) {
            delete raw["constructorArgs"];
          } else {
            raw["constructorArgs"] = args;
          }
        }),
        s.ctx,
      );
      assert.equal(form(s.calls[0]).get("constructorArguments"), null, String(args));
      assert.equal(form(s.calls[0]).get("autodetectConstructorArguments"), null);
    }
  });

  it("compilerversion has one leading v for a version given with one", async () => {
    const s = setup([SUBMITTED()]);
    const given = input();
    await blockscout.submit(
      { ...given, compiler: { ...given.compiler, version: "v0.8.24+commit.e11b9ed9" } },
      s.ctx,
    );
    assert.equal(form(s.calls[0]).get("compilerversion"), "v0.8.24+commit.e11b9ed9");
  });

  it("maps status 1 with a guid to a handle, for the form-encoded and the multipart recordings (recorded 2026-11-04)", async () => {
    for (const name of [
      "2026-11-04-verifysourcecode-form",
      "2026-11-04-verifysourcecode-multipart",
      "2026-11-04-verifysourcecode-no-metadata-hash",
    ]) {
      const outcome = await blockscout.submit(input(), setup([answer(name)]).ctx);
      assert.ok(outcome.state === "submitted", name);
      assert.equal(outcome.handle.backend, "blockscout");
      assert.equal(outcome.handle.chainId, BASE_SEPOLIA);
      assert.equal(outcome.handle.address, ADDRESS);
      assert.match(outcome.handle.jobId, /^[0-9a-f]{48}$/);
    }
    const first = await blockscout.submit(input(), setup([SUBMITTED()]).ctx);
    assert.deepEqual(first, { state: "submitted", handle: handle() });
  });

  it("maps Smart-contract already verified. to already-verified with the grade a lookup reads (recorded 2026-11-04)", async () => {
    const s = setup([ALREADY(), FULL()]);
    assert.deepEqual(await blockscout.submit(input(), s.ctx), {
      state: "already-verified",
      match: "exact",
    });
    assert.equal(s.calls[1]?.method, "GET");
  });

  it("throws unexpected-response when the lookup after already verified finds it not verified", async () => {
    const error = await errorOf(blockscout.submit(input(), setup([ALREADY(), NOT_FOUND()]).ctx));
    assert.equal(error.code, "unexpected-response");
    assert.match(error.message, /already verified, but a lookup found it not verified/);
  });

  it("throws invalid-input naming address for Address is not a smart-contract (recorded 2026-11-04)", async () => {
    const s = setup([NOT_A_CONTRACT()]);
    const error = await errorOf(blockscout.submit(input(), s.ctx));
    assert.ok(error.details.code === "invalid-input");
    assert.deepEqual(
      error.details.issues.map((issue) => issue.field),
      ["address"],
    );
    assert.match(error.hint, /chainId, address and route.apiUrl/);
    assert.equal(s.calls.length, 1);
  });

  it("throws unexpected-response with a redacted excerpt for any other text, never failed (R-FLOW-4, R-SEC-1)", async () => {
    for (const response of [
      text(`contractname is required. ${SECRET}`),
      text("Invalid address hash"),
      text("Missing sourceCode or contractaddress fields"),
      text("not a guid!", "1", "OK"),
      text(["x"], "1", "OK"),
      text(GUID, "0"),
      new Response(JSON.stringify({ status: "1", message: "OK", result: GUID }), { status: 201 }),
    ]) {
      const error = await errorOf(blockscout.submit(input(), setup([response]).ctx));
      assert.ok(error.details.code === "unexpected-response");
      assert.ok(!error.details.excerpt.includes(SECRET));
      assert.ok(!inspect(error, { depth: 5 }).includes(SECRET));
    }
  });

  it("retries a 429 and then reads the answer (recorded 2026-11-04, R-FLOW-6)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([RATE_LIMIT(), SUBMITTED()], { budgetMs: 60_000 });
    const outcome = await drive(t, blockscout.submit(input(), s.ctx));
    assert.equal(outcome.state, "submitted");
    assert.equal(s.calls.length, 2);
  });

  it("looks the contract up after a 502 and returns already-verified when it is verified", async () => {
    const s = setup([new Response("bad gateway", { status: 502 }), PARTIAL()]);
    assert.deepEqual(await blockscout.submit(input(), s.ctx), {
      state: "already-verified",
      match: "partial",
    });
    assert.equal(s.calls.length, 2);
  });

  it("submits once more after a 200 that is not JSON and a lookup that finds nothing", async () => {
    const s = setup([new Response("<html></html>", { status: 200 }), NOT_FOUND(), SUBMITTED()]);
    assert.equal((await blockscout.submit(input(), s.ctx)).state, "submitted");
    assert.deepEqual(
      s.calls.map((call) => call.method),
      ["POST", "GET", "POST"],
    );
  });
});

describe("blockscout submit: the empty answer right after a deployment (R-FLOW-7)", () => {
  it("looks the contract up, waits and submits again, with a warn line and a verify.retry event", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([EMPTY(), NOT_FOUND(), SUBMITTED()], {
      budgetMs: 120_000,
      pollIntervalMs: 5_000,
    });
    const outcome = await drive(t, blockscout.submit(input(), s.ctx));
    assert.deepEqual(outcome, { state: "submitted", handle: handle() });
    assert.equal(Date.now(), 5_000);
    // A whole new submit, after a lookup: never a poll.
    assert.deepEqual(
      s.calls.map((call) => `${call.method} ${form(call).get("action") ?? "lookup"}`),
      ["POST verifysourcecode", "GET lookup", "POST verifysourcecode"],
    );
    assert.deepEqual(s.events, [
      {
        type: "verify.retry",
        backend: "blockscout",
        attempt: 2,
        reason: "empty-submit",
        delayMs: 5_000,
      },
    ]);
    for (const event of s.events) {
      assert.deepEqual(validateEvent(event), [], JSON.stringify(event));
    }
    assert.ok(
      s.lines.some((line) =>
        line.includes("Blockscout gave no job id yet; submitting again in 5000 ms"),
      ),
    );
  });

  it("returns already-verified when the lookup after an empty answer finds a match", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([EMPTY(), PARTIAL()], { budgetMs: 120_000 });
    assert.deepEqual(await drive(t, blockscout.submit(input(), s.ctx)), {
      state: "already-verified",
      match: "partial",
    });
    // 3000 ms without a pollIntervalMs.
    assert.equal(Date.now(), 3_000);
  });

  it("reads an absent and a null result as empty too", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const absent = new Response('{"status":"1","message":"OK"}', { status: 200 });
    const s = setup([absent, NOT_FOUND(), text(null, "1", "OK"), NOT_FOUND(), SUBMITTED()]);
    assert.equal((await drive(t, blockscout.submit(input(), s.ctx))).state, "submitted");
    assert.equal(s.events.length, 2);
  });

  it(`stops after ${String(MAX_EMPTY_SUBMITS)} submits with unexpected-response: the instance's /api allows few requests`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    // Submits at 0, 5 000, 10 000 and 15 000 ms, each but the last followed by a lookup.
    const steps: Step[] = [];
    for (let submit = 0; submit < MAX_EMPTY_SUBMITS; submit += 1) {
      steps.push(EMPTY(), ...(submit < MAX_EMPTY_SUBMITS - 1 ? [NOT_FOUND()] : []));
    }
    const s = setup(steps, { budgetMs: 600_000, pollIntervalMs: 5_000 });
    const error = await errorOf(drive(t, blockscout.submit(input(), s.ctx)));
    assert.ok(error.details.code === "unexpected-response");
    assert.equal(error.details.status, 200);
    assert.equal(error.message, "Blockscout gave no job id after 4 submits.");
    assert.match(error.hint, /call verify\(\) again later/);
    assert.equal(s.calls.length, 2 * MAX_EMPTY_SUBMITS - 1);
    assert.equal(Date.now(), 15_000);
    assert.ok(s.lines.some((line) => line.includes("(submit 4 of at most 4)")));
  });

  it(`cuts a long pollIntervalMs to the ${String(EMPTY_SUBMIT_WINDOW_MS)} ms window, then stops`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([EMPTY(), NOT_FOUND(), EMPTY()], {
      budgetMs: 600_000,
      pollIntervalMs: 60_000,
    });
    const error = await errorOf(drive(t, blockscout.submit(input(), s.ctx)));
    assert.equal(error.message, "Blockscout gave no job id after 2 submits.");
    // One wait of 30 000 ms, not 60 000: the second submit is the last the window allows.
    assert.equal(Date.now(), EMPTY_SUBMIT_WINDOW_MS);
    assert.deepEqual(
      s.events.map((event) => (event.type === "verify.retry" ? event.delayMs : -1)),
      [EMPTY_SUBMIT_WINDOW_MS],
    );
    assert.equal(s.calls.length, 3);
  });

  it("throws timeout when the next submit would pass the budget, and says one submit", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([EMPTY()], { budgetMs: 4_000, pollIntervalMs: 5_000 });
    const error = await errorOf(drive(t, blockscout.submit(input(), s.ctx)));
    assert.deepEqual(error.details, { code: "timeout", backend: "blockscout", timeoutMs: 4_000 });
    assert.equal(
      error.message,
      "Blockscout gave no job id after 1 submit, within the 4000 ms budget.",
    );
  });

  it("rejects with the signal's reason when aborted during the wait, with no further lookup or submit (R-FLOW-6)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const controller = new AbortController();
    const reason = new Error("stopped by the caller");
    const s = setup([EMPTY(), NOT_FOUND(), SUBMITTED()], { budgetMs: 60_000 });
    const ctx: Context = { ...s.ctx, http: { ...s.ctx.http, signal: controller.signal } };
    const pending = blockscout.submit(input(), ctx);
    pending.catch(() => {});
    // Let the first submit finish and the wait start, then abort.
    for (let round = 0; round < 20 && s.events.length === 0; round += 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    assert.equal(s.events.length, 1, "the wait has started");
    controller.abort(reason);
    const outcome: unknown = await pending.then(
      () => "resolved",
      (error: unknown) => error,
    );
    assert.equal(outcome, reason);
    t.mock.timers.runAll();
    assert.equal(s.calls.length, 1);
  });

  it("submits again without a budget or an observer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([EMPTY(), NOT_FOUND(), SUBMITTED()]);
    const { observer: _dropped, ...http } = s.ctx.http;
    const outcome = await drive(t, blockscout.submit(input(), { ...s.ctx, http }));
    assert.equal(outcome.state, "submitted");
    assert.deepEqual(s.events, []);
  });

  it("throws the lookup's error after an empty answer, never a submit without a lookup (R-FLOW-4)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const s = setup([EMPTY(), new Response("{}", { status: 200 })], { budgetMs: 60_000 });
    const error = await errorOf(drive(t, blockscout.submit(input(), s.ctx)));
    assert.equal(error.code, "unexpected-response");
    // The message says the empty answer may hide an accepted submit, as after any unclear submit.
    assert.match(error.message, /may already have been accepted\.$/);
    assert.equal(s.calls.length, 2);
  });
});

// --- poll --------------------------------------------------------------------------------------

describe("blockscout poll (R-BE-3, R-FLOW-2, R-FLOW-4)", () => {
  it("sends checkverifystatus as a form POST to the instance's /api, with no key (R-SEC-2)", async () => {
    const s = setup([PENDING()]);
    assert.deepEqual(await blockscout.poll(handle(), s.ctx), { state: "pending" });
    assert.equal(s.calls[0]?.url, API);
    assert.deepEqual(Object.fromEntries(form(s.calls[0])), {
      module: "contract",
      action: "checkverifystatus",
      guid: GUID,
    });
    assertKeyless(s.calls);
  });

  it("maps Pass - Verified to verified with the grade a lookup reads (recorded 2026-11-04)", async () => {
    const exact = setup([PASS(), FULL()]);
    assert.deepEqual(await blockscout.poll(handle(), exact.ctx), {
      state: "verified",
      match: "exact",
    });
    assert.equal(exact.calls[1]?.url, `${API}/v2/smart-contracts/${ADDRESS}`);
    // A build without a metadata hash: partial is the best outcome, never failed (R-FLOW-7).
    assert.deepEqual(await blockscout.poll(handle(), setup([PASS(), PARTIAL()]).ctx), {
      state: "verified",
      match: "partial",
    });
  });

  it("throws unknown-state when the lookup after Pass - Verified finds no match (R-FLOW-4)", async () => {
    const error = await errorOf(blockscout.poll(handle(), setup([PASS(), UNVERIFIED()]).ctx));
    assert.ok(error.details.code === "unknown-state");
    assert.deepEqual(error.details.handle, handle());
    assert.match(error.message, /verified, but a lookup found the contract not verified/);
  });

  it("maps Fail - Unable to verify to failed with the explorer's text (recorded 2026-11-04)", async () => {
    const s = setup([FAIL()]);
    assert.deepEqual(await blockscout.poll(handle(), s.ctx), {
      state: "failed",
      reason: "Fail - Unable to verify",
    });
    assert.equal(s.calls.length, 1);
    assert.ok("Fail - Unable to verify".length <= REASON_LENGTH);
  });

  it("throws job-not-found for Unknown UID, whose status is 1 (recorded 2026-11-04, R-FLOW-4)", async () => {
    const error = await errorOf(blockscout.poll(handle(), setup([UNKNOWN_UID()]).ctx));
    assert.deepEqual(error.details, { code: "job-not-found", handle: handle() });
  });

  it("throws unknown-state for any other text, and never returns verified (R-FLOW-4)", async () => {
    for (const result of ["Pass - verified", "Verified", "OK", "", "Pending", "Fail"]) {
      const error = await errorOf(blockscout.poll(handle(), setup([text(result, "1", "OK")]).ctx));
      assert.ok(error.details.code === "unknown-state", result);
      assert.match(error.message, /does not recognise/);
    }
  });

  it("throws unexpected-response for a result that is not text, a 500 or a body that is not JSON", async () => {
    for (const response of [
      text(["Pass - Verified"], "1", "OK"),
      new Response(JSON.stringify({ status: "1", result: "Pass - Verified" }), { status: 500 }),
      new Response("<html>error</html>", { status: 200 }),
    ]) {
      const error = await errorOf(blockscout.poll(handle(), setup([response]).ctx));
      assert.equal(error.code, "unexpected-response");
    }
  });

  it("refuses a handle of another backend or with an odd job id before any request", async () => {
    const s = setup([]);
    const other = await errorOf(blockscout.poll({ ...handle(), backend: "sourcify" }, s.ctx));
    assert.ok(other.details.code === "invalid-input");
    assert.deepEqual(
      other.details.issues.map((issue) => issue.message),
      ["must be blockscout for the Blockscout client"],
    );
    const odd = await errorOf(blockscout.poll(handle("a&apikey=x"), s.ctx));
    assert.equal(odd.code, "invalid-input");
    assert.equal(s.calls.length, 0);
  });
});

// --- explorer page and route ---------------------------------------------------------------------

describe("blockscout explorerUrl and route (R-FLOW-3, R-SEC-2)", () => {
  it("derives the instance's contract page from the routing table", () => {
    assert.equal(
      blockscout.explorerUrl(TARGET, setup([]).ctx),
      `https://${INSTANCE}/address/${ADDRESS}?tab=contract`,
    );
  });

  it("is undefined for a route.apiUrl, which names the instance", () => {
    const { ctx } = setup([], {
      route: { backend: "blockscout", apiUrl: "https://explorer.example.org/api" },
    });
    assert.equal(blockscout.explorerUrl(TARGET, ctx), undefined);
  });

  it("sends every request of a route.apiUrl to that instance, its query kept", async () => {
    const s = setup([FULL()], {
      route: { backend: "blockscout", apiUrl: "https://explorer.example.org/api/?token=abc" },
    });
    await blockscout.lookup(TARGET, s.ctx);
    assert.equal(
      s.calls[0]?.url,
      `https://explorer.example.org/api/v2/smart-contracts/${ADDRESS}?token=abc`,
    );
  });

  it("refuses a route.apiUrl that does not end in /api, naming route.apiUrl", () => {
    for (const apiUrl of [
      "https://eth-sepolia.blockscout.com",
      "https://eth-sepolia.blockscout.com/api/v2",
      "https://eth-sepolia.blockscout.com/apis",
    ]) {
      assert.throws(
        () => resolveRoute(BASE_SEPOLIA, { backend: "blockscout", apiUrl }),
        (error: unknown) =>
          error instanceof ExplorerVerifyError &&
          error.details.code === "invalid-input" &&
          error.details.issues.some(
            (issue) =>
              issue.field === "route.apiUrl" && issue.message === "must end in /api for blockscout",
          ) &&
          error.hint.includes("/api") &&
          !error.message.includes("eth-sepolia"),
        apiUrl,
      );
    }
    // Other backends keep any path.
    assert.equal(
      resolveRoute(BASE_SEPOLIA, { backend: "sourcify", apiUrl: "https://example.org/server" })
        .apiBase,
      "https://example.org/server",
    );
  });

  it("refuses a key for blockscout, in route.apiKey or apiKeys, before any request (decision 0016)", async () => {
    assert.throws(
      () =>
        resolveRoute(BASE_SEPOLIA, {
          backend: "blockscout",
          apiUrl: API,
          apiKey: "dummy-blockscout-key-92",
        }),
      (error: unknown) =>
        error instanceof ExplorerVerifyError &&
        error.details.code === "invalid-input" &&
        error.details.issues.some((issue) => issue.field === "route.apiKey"),
    );
    const fake = replay();
    const error = await errorOf(
      runVerify(
        input(),
        { fetch: fake.fetch, apiKeys: { blockscout: "dummy-blockscout-key-92" } },
        { backends: { blockscout }, table: TABLE, random: () => 0 },
      ),
    );
    assert.equal(error.code, "invalid-input");
    assert.equal(fake.calls.length, 0);
  });

  it("is a client of verify() and checkStatus()", () => {
    assert.equal(DEFAULT_DEPENDENCIES.backends.blockscout, blockscout);
  });
});

// --- a whole verify() run ------------------------------------------------------------------------

interface FlowRun {
  outcome: unknown;
  events: VerifyEvent[];
  calls: Call[];
  lines: string[];
}

/** Runs runVerify(), or runCheckStatus() for a handle, with the Blockscout client, timers mocked. */
async function runFlow(t: TestContext, steps: Step[], resume?: Handle): Promise<FlowRun> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = replay(...steps);
  const events: VerifyEvent[] = [];
  const lines: string[] = [];
  const record = (message: string, fields?: unknown): void => {
    lines.push(`${message} ${JSON.stringify(fields)}`);
  };
  const options: VerifyOptions = {
    fetch: fake.fetch,
    pollIntervalMs: 1_000,
    logger: { debug: record, info: record, warn: record, error: record },
    onEvent: (event) => {
      events.push(event);
    },
  };
  const dependencies = { backends: { blockscout }, table: TABLE, random: () => 0 };
  const outcome = await drive(
    t,
    (resume === undefined
      ? runVerify(input(), options, dependencies)
      : runCheckStatus(resume, options, dependencies)
    ).catch((error: unknown) => error),
  );
  for (const event of events) {
    assert.deepEqual(validateEvent(event), [], JSON.stringify(event));
  }
  return { outcome, events, calls: fake.calls, lines };
}

const PAGE = `https://${INSTANCE}/address/${ADDRESS}?tab=contract`;

describe("verify() with the Blockscout client (R-FLOW-1, R-FLOW-2, R-FLOW-7, R-DX-6, R-SEC-2)", () => {
  it("runs lookup, submit, two polls and a grade lookup, and returns verified exact (recorded 2026-11-04)", async (t) => {
    const r = await runFlow(t, [UNVERIFIED(), SUBMITTED(), PENDING(), PASS(), FULL()]);
    const expected: VerifyResult = {
      status: "verified",
      backend: "blockscout",
      match: "exact",
      explorerUrl: PAGE,
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
    assertKeyless(r.calls);
  });

  it("returns verified partial for a build without a metadata hash, never failed (R-FLOW-7)", async (t) => {
    const r = await runFlow(t, [UNVERIFIED(), SUBMITTED(), PASS(), PARTIAL()]);
    assert.deepEqual(r.outcome, {
      status: "verified",
      backend: "blockscout",
      match: "partial",
      explorerUrl: PAGE,
    });
  });

  it("submits again after an empty answer and verifies (R-FLOW-7)", async (t) => {
    const r = await runFlow(t, [NOT_FOUND(), EMPTY(), NOT_FOUND(), SUBMITTED(), PASS(), FULL()]);
    assert.ok(typeof r.outcome === "object" && r.outcome !== null);
    assert.equal(Reflect.get(r.outcome, "status"), "verified");
    assert.ok(
      r.events.some((event) => event.type === "verify.retry" && event.reason === "empty-submit"),
    );
    assertKeyless(r.calls);
  });

  it("returns already-verified from the first lookup without a submit, exact or partial (R-FLOW-1)", async (t) => {
    for (const [response, match] of [
      [FULL(), "exact"],
      [PARTIAL(), "partial"],
    ] as const) {
      t.mock.timers.reset();
      const r = await runFlow(t, [response]);
      assert.deepEqual(r.outcome, {
        status: "already-verified",
        backend: "blockscout",
        match,
        explorerUrl: PAGE,
      });
      assert.equal(r.calls.length, 1);
    }
  });

  it("looks the contract up after Unknown UID, then throws job-not-found (R-FLOW-4)", async (t) => {
    const r = await runFlow(t, [UNVERIFIED(), SUBMITTED(), UNKNOWN_UID(), UNVERIFIED()]);
    assert.ok(r.outcome instanceof ExplorerVerifyError);
    assert.equal(r.outcome.code, "job-not-found");
    assert.equal(r.calls.length, 4);
  });

  it("returns failed for Fail - Unable to verify", async (t) => {
    const r = await runFlow(t, [UNVERIFIED(), SUBMITTED(), FAIL()]);
    assert.deepEqual(r.outcome, {
      status: "failed",
      backend: "blockscout",
      reason: "Fail - Unable to verify",
    });
  });

  it("resumes a stored handle with checkStatus() (R-FLOW-5)", async (t) => {
    const r = await runFlow(t, [PASS(), FULL()], handle());
    assert.deepEqual(r.outcome, {
      status: "verified",
      backend: "blockscout",
      match: "exact",
      explorerUrl: PAGE,
    });
    assertKeyless(r.calls);
  });
});
