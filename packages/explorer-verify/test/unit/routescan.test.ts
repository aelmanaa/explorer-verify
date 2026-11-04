// The Routescan client (R-BE-5). Every answer comes from a fixture in test/fixtures/routescan/,
// recorded live without a key on Avalanche Fuji (43113) on 2026-11-03 or 2026-11-04. Routescan's
// rate-limit answer has no recording: the probes did not reach it, so those tests use a 429 and
// Etherscan's text, and say so.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate } from "node:timers";
import { inspect } from "node:util";

import type { Context, Target } from "../../src/backends/backend.ts";
import { etherscan } from "../../src/backends/etherscan.ts";
import { routescan } from "../../src/backends/routescan.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { runCheckStatus } from "../../src/flow/status.ts";
import { DEFAULT_DEPENDENCIES, runVerify } from "../../src/flow/verify.ts";
import { request as send } from "../../src/http/fetch.ts";
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
} from "../../src/types.ts";
import { replay } from "../helpers/fake-fetch.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";

const FUJI = 43113;
const API = "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api";
// Probe B of 2026-11-03: deployed and verified on Fuji; its recorded submit gave GUID.
const ADDRESS = "0x636522C3785337399Aa9105498d2Bd95Dc01D749";
const GUID = "f111a4c8-368c-51d2-8163-c7ab477a1d91";
// A fake key. Never a real one (R-SEC-1).
const KEY = "DUMMYROUTESCANKEYz8x4c6v2b0n";
// The shipped table has no Routescan row yet, so these tests pass one.
const TABLE: RoutingTable = {
  schemaVersion: 2,
  checked: "2026-11-04",
  chains: [{ chainId: FUJI, backends: [{ backend: "routescan", network: "testnet" }] }],
};

interface Recorded {
  readonly request: { readonly body: unknown };
  readonly response: { readonly status: number; readonly body: unknown };
}

function fixture(name: string): Recorded {
  const url = new URL(`../fixtures/routescan/${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null);
  const request: unknown = Reflect.get(parsed, "request");
  const response: unknown = Reflect.get(parsed, "response");
  assert.ok(typeof request === "object" && request !== null);
  assert.ok(typeof response === "object" && response !== null);
  const status: unknown = Reflect.get(response, "status");
  assert.ok(typeof status === "number");
  return {
    request: { body: Reflect.get(request, "body") },
    response: { status, body: Reflect.get(response, "body") },
  };
}

/** The recorded response of `test/fixtures/routescan/<name>.json`. */
function answer(name: string): Response {
  const { status, body } = fixture(name).response;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// The answers, by the call and what they say.
const SUBMITTED = (): Response => answer("2026-11-03-verifysourcecode-keyless-form-post");
const PENDING = (): Response => answer("2026-11-03-checkverifystatus-pending-in-queue");
const PASS = (): Response => answer("2026-11-03-checkverifystatus-pass-verified-unique-url");
const NOT_FOUND = (): Response =>
  answer("2026-11-03-checkverifystatus-verification-not-found-unique-url");
const MISSING_GUID = (): Response => answer("2026-11-04-checkverifystatus-missing-guid-unique-url");
const VERIFIED = (): Response => answer("2026-11-04-getsourcecode-verified-unique-url");
const NOT_VERIFIED = (): Response => answer("2026-11-04-getsourcecode-not-verified-unique-url");
const NO_CHAIN_LOOKUP = (): Response => answer("2026-11-04-getsourcecode-chain-not-supported");
const NO_CHAIN_SUBMIT = (): Response =>
  answer("2026-11-04-verifysourcecode-form-post-chain-not-supported");
const NO_CHAIN_POLL = (): Response =>
  answer("2026-11-04-checkverifystatus-form-post-chain-not-supported");
const POST_LOOKUP = (): Response =>
  answer("2026-11-04-getsourcecode-form-post-invalid-querystring");
// Routescan's rate-limit answer is not recorded. Its docs say only "an error status".
const TOO_MANY = (): Response => new Response("", { status: 429 });
const ETHERSCAN_RATE_LIMIT = (): Response =>
  new Response(
    JSON.stringify({
      status: "0",
      message: "NOTOK",
      result: "Max calls per sec rate limit reached",
    }),
    { status: 200 },
  );

/** The input probe B submitted, read from its recorded request. */
function input(): VerifyInput {
  const body: unknown = fixture("2026-11-03-verifysourcecode-keyless-form-post").request.body;
  assert.ok(typeof body === "object" && body !== null);
  const fields: unknown = Reflect.get(body, "fields");
  assert.ok(typeof fields === "object" && fields !== null);
  const read = (field: string): string => {
    const value: unknown = Reflect.get(fields, field);
    assert.ok(typeof value === "string", field);
    return value;
  };
  return validateInput({
    chainId: FUJI,
    address: read("contractaddress"),
    compiler: {
      kind: "solc",
      version: read("compilerversion").slice(1),
      input: JSON.parse(read("sourceCode")),
    },
    contractName: read("contractname"),
    constructorArgs: `0x${read("constructorArguements")}`,
  });
}

const TARGET: Target = { chainId: FUJI, address: input().address };

function handle(jobId: string = GUID): Handle {
  return { version: 1, backend: "routescan", chainId: FUJI, address: TARGET.address, jobId };
}

interface Setup {
  ctx: Context;
  calls: Call[];
  events: VerifyEvent[];
  lines: string[];
}

function setup(
  steps: Step[],
  options: { route?: RouteOverride; keyed?: boolean; table?: RoutingTable } = {},
): Setup {
  const fake = replay(...steps);
  const events: VerifyEvent[] = [];
  const lines: string[] = [];
  const record = (message: string, fields?: unknown): void => {
    lines.push(`${message} ${JSON.stringify(fields)}`);
  };
  const secrets = [KEY];
  const http: HttpContext = {
    backend: "routescan",
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
  };
  const apiKeys = options.keyed === true ? { routescan: KEY } : {};
  return {
    ctx: {
      route: resolveRoute(FUJI, options.route, { apiKeys, table: options.table ?? TABLE }),
      apiKeys: () => apiKeys,
      http,
    },
    calls: fake.calls,
    events,
    lines,
  };
}

/** The call at `index`, which must exist. */
function call(calls: readonly Call[], index: number): Call {
  const found = calls[index];
  assert.ok(found !== undefined, `no request ${String(index)}`);
  return found;
}

/** Runs the mocked timers until `promise` settles; `setImmediate` is not mocked. */
async function drive<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  const state = { done: false };
  const tracked = promise.finally(() => {
    state.done = true;
  });
  tracked.catch(() => {});
  for (let round = 0; round < 200 && !state.done; round += 1) {
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

// --- requests ----------------------------------------------------------------------------------

describe("routescan requests (R-BE-5, R-SEC-1, R-SEC-2)", () => {
  it("requests use the row's full URL and send no chainid parameter (R-BE-5)", async () => {
    const s = setup([NOT_VERIFIED(), SUBMITTED(), PENDING()]);
    assert.equal(await routescan.lookup(TARGET, s.ctx), undefined);
    const submitted = await routescan.submit(input(), s.ctx);
    assert.equal(submitted.state, "submitted");
    assert.deepEqual(await routescan.poll(handle(), s.ctx), { state: "pending" });
    assert.equal(s.calls.length, 3);
    for (const sent of s.calls) {
      const url = new URL(sent.url);
      assert.equal(`${url.origin}${url.pathname}`, API);
      assert.equal(url.searchParams.has("chainid"), false, sent.url);
      assert.equal(new URLSearchParams(sent.body ?? "").has("chainid"), false);
    }
    const [lookup, submit, poll] = [call(s.calls, 0), call(s.calls, 1), call(s.calls, 2)];
    assert.equal(lookup.method, "GET");
    assert.equal(lookup.body, undefined);
    const lookupQuery = new URL(lookup.url).searchParams;
    assert.equal(lookupQuery.get("module"), "contract");
    assert.equal(lookupQuery.get("action"), "getsourcecode");
    assert.equal(lookupQuery.get("address"), TARGET.address);
    assert.equal(submit.method, "POST");
    assert.equal(submit.url, API);
    assert.equal(submit.headers.get("content-type"), "application/x-www-form-urlencoded");
    const body = new URLSearchParams(submit.body ?? "");
    assert.equal(body.get("module"), "contract");
    assert.equal(body.get("action"), "verifysourcecode");
    assert.equal(body.get("contractaddress"), ADDRESS.toLowerCase());
    assert.equal(poll.method, "GET");
    const pollQuery = new URL(poll.url).searchParams;
    assert.equal(pollQuery.get("action"), "checkverifystatus");
    assert.equal(pollQuery.get("guid"), GUID);
  });

  it("two polls never share a URL, even within the same millisecond (R-BE-5)", async (t) => {
    // Routescan's CDN served a cached Pending in queue 3044 s after the job had passed
    // (recorded 2026-11-03); a unique parameter got the real state.
    t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
    const s = setup([PENDING(), PENDING(), VERIFIED(), VERIFIED()]);
    await routescan.poll(handle(), s.ctx);
    await routescan.poll(handle(), s.ctx);
    await routescan.lookup(TARGET, s.ctx);
    await routescan.lookup(TARGET, s.ctx);
    const urls = s.calls.map((sent) => sent.url);
    assert.equal(new Set(urls).size, 4);
    for (const url of urls) {
      // Random characters only: no clock, counter or other process state.
      assert.match(new URL(url).searchParams.get("nocache") ?? "", /^[0-9a-z]+$/u);
      assert.ok(!url.includes("1000"), url);
    }
  });

  for (const [name, limit] of [
    ["HTTP 429", TOO_MANY],
    ["the HTTP-200 rate-limit text", ETHERSCAN_RATE_LIMIT],
  ] as const) {
    it(`a GET retried after ${name} gets a new nocache value; the rest of the URL is unchanged (R-BE-5, R-FLOW-6)`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const s = setup([limit(), limit(), PASS(), limit(), VERIFIED()]);
      await drive(t, routescan.poll(handle(), s.ctx));
      await drive(t, routescan.lookup(TARGET, s.ctx));
      const urls = s.calls.map((sent) => new URL(sent.url));
      assert.equal(new Set(urls.map((url) => url.href)).size, 5);
      for (const url of urls) {
        assert.equal(url.searchParams.getAll("nocache").length, 1);
        url.searchParams.delete("nocache");
      }
      assert.equal(new Set(urls.slice(0, 3).map((url) => url.href)).size, 1);
      assert.equal(new Set(urls.slice(3).map((url) => url.href)).size, 1);
    });
  }

  it("the HTTP layer adds freshQuery after ? on a URL without a query, and after & on one with a query", async () => {
    for (const [url, sep] of [
      ["https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api", "?"],
      ["https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api?a=1", "&"],
    ] as const) {
      const fake = replay(new Response("{}"), new Response("{}"));
      let n = 0;
      const ctx: HttpContext = { backend: "routescan", fetch: fake.fetch, secrets: [] };
      const freshQuery = (): string => {
        n += 1;
        return `nocache=x${String(n)}`;
      };
      await send(ctx, { url, method: "GET", retry: "safe", freshQuery });
      await send(ctx, { url, method: "GET", retry: "safe", freshQuery });
      assert.deepEqual(
        fake.calls.map((sent) => sent.url),
        [`${url}${sep}nocache=x1`, `${url}${sep}nocache=x2`],
      );
    }
  });

  it("a request without freshQuery, as every Etherscan request, is retried with the same URL and body", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = replay(TOO_MANY(), answer("2026-11-04-getsourcecode-verified-unique-url"));
    const route = resolveRoute(FUJI, {
      backend: "etherscan-v2",
      apiUrl: "https://proxy.example/api",
    });
    const ctx: Context = {
      route,
      http: { backend: "etherscan-v2", fetch: fake.fetch, secrets: [], random: () => 0 },
    };
    assert.equal(await drive(t, etherscan.lookup(TARGET, ctx)), "exact");
    assert.equal(fake.calls.length, 2);
    assert.equal(call(fake.calls, 0).url, call(fake.calls, 1).url);
    assert.equal(call(fake.calls, 0).body, call(fake.calls, 1).body);
    assert.equal(call(fake.calls, 0).url, "https://proxy.example/api?chainid=43113");
  });

  it("keeps the query of a route.apiUrl and adds the fields after it", async () => {
    const s = setup([VERIFIED()], {
      route: { backend: "routescan", apiUrl: `${API}?team=a` },
    });
    assert.equal(await routescan.lookup(TARGET, s.ctx), "exact");
    const url = new URL(call(s.calls, 0).url);
    assert.equal(`${url.origin}${url.pathname}`, API);
    assert.equal(url.searchParams.get("team"), "a");
    assert.equal(url.searchParams.get("action"), "getsourcecode");
  });

  it("the key goes in the apikey header and never in the URL or body (R-SEC-1)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = setup([NOT_VERIFIED(), TOO_MANY(), SUBMITTED(), NOT_FOUND()], { keyed: true });
    await routescan.lookup(TARGET, s.ctx);
    await drive(t, routescan.submit(input(), s.ctx));
    const error = await errorOf(routescan.poll(handle(), s.ctx));
    assert.equal(error.code, "job-not-found");
    assert.equal(s.calls.length, 4);
    for (const sent of s.calls) {
      assert.equal(sent.headers.get("apikey"), KEY);
      assert.ok(!sent.url.includes(KEY), sent.url);
      assert.ok(!(sent.body ?? "").includes(KEY));
      assert.equal(new URL(sent.url).searchParams.has("apikey"), false);
    }
    const shown = [error.message, JSON.stringify(error), inspect(error), ...s.lines].join("\n");
    assert.ok(!shown.includes(KEY));
  });

  it("without a key, no apikey header is sent (R-BE-5)", async () => {
    const s = setup([NOT_VERIFIED(), SUBMITTED(), PENDING()]);
    await routescan.lookup(TARGET, s.ctx);
    await routescan.submit(input(), s.ctx);
    await routescan.poll(handle(), s.ctx);
    for (const sent of s.calls) {
      assert.equal(sent.headers.has("apikey"), false);
    }
  });

  it("sends apiKeys.routescan to no server but the table's: a route.apiUrl elsewhere gets none (R-SEC-2)", async () => {
    const s = setup([VERIFIED()], {
      keyed: true,
      route: { backend: "routescan", apiUrl: "https://proxy.example/etherscan/api" },
    });
    await routescan.lookup(TARGET, s.ctx);
    assert.equal(call(s.calls, 0).headers.has("apikey"), false);
  });

  it("explorerUrl is undefined: the table has no Routescan page template yet", () => {
    assert.equal(routescan.explorerUrl(TARGET, setup([]).ctx), undefined);
  });
});

// --- answers -----------------------------------------------------------------------------------

describe("routescan answers (R-BE-5, R-FLOW-3, R-FLOW-4)", () => {
  it("maps a non-empty SourceCode to exact and an empty one to not verified (recorded 2026-11-04)", async () => {
    assert.equal(await routescan.lookup(TARGET, setup([VERIFIED()]).ctx), "exact");
    assert.equal(await routescan.lookup(TARGET, setup([NOT_VERIFIED()]).ctx), undefined);
  });

  it("maps the recorded keyless submit to a handle with the UUID job id (recorded 2026-11-03)", async () => {
    const outcome = await routescan.submit(input(), setup([SUBMITTED()]).ctx);
    assert.deepEqual(outcome, { state: "submitted", handle: handle() });
  });

  it("maps Pending in queue to pending and Pass - Verified to verified exact (recorded 2026-11-03)", async () => {
    assert.deepEqual(await routescan.poll(handle(), setup([PENDING()]).ctx), { state: "pending" });
    assert.deepEqual(await routescan.poll(handle(), setup([PASS()]).ctx), {
      state: "verified",
      match: "exact",
    });
  });

  for (const [request, steps, run] of [
    ["lookup", [NO_CHAIN_LOOKUP()], (ctx: Context) => routescan.lookup(TARGET, ctx)],
    ["submit", [NO_CHAIN_SUBMIT()], (ctx: Context) => routescan.submit(input(), ctx)],
    ["poll", [NO_CHAIN_POLL()], (ctx: Context) => routescan.poll(handle(), ctx)],
  ] as const) {
    it(`chain not supported maps to unsupported-chain, never failed: ${request} (R-BE-5, R-FLOW-4, recorded 2026-11-04)`, async () => {
      const s = setup([...steps]);
      const error = await errorOf(run(s.ctx));
      assert.deepEqual(error.details, {
        code: "unsupported-chain",
        backend: "routescan",
        chainId: FUJI,
      });
      assert.equal(error.message, "Routescan does not support chain 43113.");
      assert.equal(s.calls.length, 1);
    });
  }

  it("Verification not found throws job-not-found naming Routescan (recorded 2026-11-03)", async () => {
    const error = await errorOf(routescan.poll(handle(), setup([NOT_FOUND()]).ctx));
    assert.deepEqual(error.details, { code: "job-not-found", handle: handle() });
    assert.equal(error.message, `Routescan does not know the verification job ${GUID}.`);
  });

  it("Missing guid throws unexpected-response, not unknown-state (R-FLOW-4, recorded 2026-11-04)", async () => {
    const error = await errorOf(routescan.poll(handle(), setup([MISSING_GUID()]).ctx));
    assert.equal(error.code, "unexpected-response");
    assert.match(error.message, /^Routescan gave an answer to the job status request/u);
  });

  it("Invalid querystring request, the answer to a lookup sent as a form POST, throws unexpected-response, never not verified (recorded 2026-11-04)", async () => {
    const error = await errorOf(routescan.lookup(TARGET, setup([POST_LOOKUP()]).ctx));
    assert.equal(error.code, "unexpected-response");
  });

  it("checks the handle: one for another backend throws invalid-input and sends nothing", async () => {
    const s = setup([]);
    const error = await errorOf(routescan.poll({ ...handle(), backend: "etherscan-v2" }, s.ctx));
    assert.equal(error.code, "invalid-input");
    assert.equal(s.calls.length, 0);
  });

  for (const [name, limit] of [
    ["a 429", TOO_MANY],
    ["Etherscan's rate-limit text with HTTP 200", ETHERSCAN_RATE_LIMIT],
  ] as const) {
    it(`the rate-limit answer retries and never fails: ${name}, as no Routescan answer is recorded (R-BE-5, R-FLOW-6)`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const s = setup([limit(), PASS(), limit(), limit(), VERIFIED()]);
      assert.deepEqual(await drive(t, routescan.poll(handle(), s.ctx)), {
        state: "verified",
        match: "exact",
      });
      assert.equal(await drive(t, routescan.lookup(TARGET, s.ctx)), "exact");
      const retries = s.events.filter((event) => event.type === "verify.retry");
      assert.equal(retries.length, 3);
      for (const event of retries) {
        assert.equal(Reflect.get(event, "reason"), "rate-limited");
        assert.equal(event.backend, "routescan");
      }
    });
  }
});

// --- whole runs ----------------------------------------------------------------------------------

/** Runs runVerify() with the Routescan client on the test table, timers mocked. */
async function runFlow(
  t: TestContext,
  steps: Step[],
  options: VerifyOptions = {},
): Promise<{ outcome: unknown; calls: Call[] }> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = replay(...steps);
  const outcome = await drive(
    t,
    runVerify(
      input(),
      { fetch: fake.fetch, pollIntervalMs: 1_000, ...options },
      { backends: { routescan }, table: TABLE, random: () => 0 },
    ).catch((error: unknown) => error),
  );
  return { outcome, calls: fake.calls };
}

const action = (sent: Call): string | null =>
  new URL(sent.url).searchParams.get("action") ??
  new URLSearchParams(sent.body ?? "").get("action");

describe("verify() and checkStatus() with the Routescan client (R-BE-5, R-FLOW-2)", () => {
  it("the shipped clients include Routescan", () => {
    assert.equal(DEFAULT_DEPENDENCIES.backends.routescan, routescan);
  });

  it("runs lookup, submit and polls to verified exact without a key (recorded 2026-11-03)", async (t) => {
    const r = await runFlow(t, [NOT_VERIFIED(), SUBMITTED(), PENDING(), PASS()]);
    assert.deepEqual(r.outcome, { status: "verified", backend: "routescan", match: "exact" });
    assert.deepEqual(r.calls.map(action), [
      "getsourcecode",
      "verifysourcecode",
      "checkverifystatus",
      "checkverifystatus",
    ]);
  });

  it("Verification not found with a verified lookup returns verified (R-FLOW-2, recorded 2026-11-03)", async (t) => {
    const r = await runFlow(t, [NOT_VERIFIED(), SUBMITTED(), NOT_FOUND(), VERIFIED()]);
    assert.deepEqual(r.outcome, { status: "verified", backend: "routescan", match: "exact" });
    assert.equal(action(call(r.calls, 3)), "getsourcecode");
  });

  it("Verification not found with a lookup that finds no source throws job-not-found with the handle", async (t) => {
    const r = await runFlow(t, [NOT_VERIFIED(), SUBMITTED(), NOT_FOUND(), NOT_VERIFIED()]);
    assert.ok(r.outcome instanceof ExplorerVerifyError);
    assert.deepEqual(r.outcome.details, { code: "job-not-found", handle: handle() });
  });

  it("a pending status at the budget is resolved by the final lookup (R-FLOW-2)", async (t) => {
    // Routescan has said Pending in queue after the contract was verified (recorded 2026-11-03).
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const actions: (string | null)[] = [];
    const answerFor = (sent: Call): Response => {
      const name = action(sent);
      actions.push(name);
      return name === "verifysourcecode"
        ? SUBMITTED()
        : name === "checkverifystatus"
          ? PENDING()
          : actions.length === 1
            ? NOT_VERIFIED()
            : VERIFIED();
    };
    const fake: typeof fetch = async (url, init) => {
      const body = init?.body;
      return answerFor({
        url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
        method: init?.method ?? "GET",
        body: body instanceof URLSearchParams ? body.toString() : undefined,
        headers: new Headers(init?.headers),
      });
    };
    const outcome = await drive(
      t,
      runVerify(
        input(),
        { fetch: fake, pollIntervalMs: 1_000, timeoutMs: 3_500 },
        { backends: { routescan }, table: TABLE, random: () => 0 },
      ),
    );
    assert.deepEqual(outcome, { status: "verified", backend: "routescan", match: "exact" });
    assert.equal(actions.at(-1), "getsourcecode");
    assert.equal(actions.filter((name) => name === "getsourcecode").length, 2);
    assert.ok(actions.filter((name) => name === "checkverifystatus").length >= 2);
  });

  it("checkStatus() resumes a Routescan handle", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const fake = replay(PASS());
    const result = await drive(
      t,
      runCheckStatus(
        handle(),
        { fetch: fake.fetch },
        { backends: { routescan }, table: TABLE, random: () => 0 },
      ),
    );
    assert.deepEqual(result, { status: "verified", backend: "routescan", match: "exact" });
  });
});
