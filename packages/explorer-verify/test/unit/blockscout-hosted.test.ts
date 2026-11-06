// Blockscout's hosted multichain API, the backend `blockscout-hosted` (R-BE-3, R-SEC-1, R-SEC-2,
// R-AX-7, decision 0041): its route, where `apiKeys["blockscout-hosted"]` may go and where it goes
// in the request, and the hosted API's answers about the key, replayed from the live run of
// 2026-11-05. The instance backend `blockscout` keeps its own answers and never gets the key.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { blockscout, blockscoutHosted, refusal } from "../../src/backends/blockscout.ts";
import { blockscoutProxyLinker } from "../../src/backends/proxy-blockscout.ts";
import { ERROR_EXIT_CODES, ExplorerVerifyError } from "../../src/errors.ts";
import type { ErrorCode } from "../../src/errors.ts";
import { formatHandle } from "../../src/flow/format-handle.ts";
import { parseHandle } from "../../src/flow/handle.ts";
import {
  HOSTED_BLOCKSCOUT_HOST,
  keyFor,
  needsKey,
  readApiKeys,
  withKey,
} from "../../src/http/api-keys.ts";
import { validateInput } from "../../src/input/validate.ts";
import { checkRoute, readsTable, resolveRoute } from "../../src/routing/resolve.ts";
import type { RoutingTable } from "../../src/routing/resolve.ts";
import type { Handle, RouteOverride, VerifyEvent, VerifyInput } from "../../src/types.ts";
import { runCheckStatus, runLinkProxy, runVerify, runVerifyEach } from "../helpers/defaults.ts";
import { replay } from "../helpers/fake-fetch.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const SEPOLIA = 11155111;
const INSTANCE = "eth-sepolia.blockscout.com";
const HOSTED = `https://${HOSTED_BLOCKSCOUT_HOST}/${String(SEPOLIA)}/api`;
const HOSTED_ROUTE: RouteOverride = { backend: "blockscout-hosted" };
// The contract deployed for the live run, verified through the hosted API (2026-11-05).
const ADDRESS = "0x47740d3eb5c98ba53a3aba3a39df120a6f168403";
const GUID = "47740d3eb5c98ba53a3aba3a39df120a6f1684036aecdb58";
// Dummy keys. One is lowercase hex, which no provider-shaped pattern matches, so only the
// library's own knowledge of its secrets removes it. The other starts with proapi_, as real
// Blockscout keys do.
const HEX_KEY = "9f3c1a7be05d42e8b6a1c0d9e7f21b4a";
const PROAPI_KEY = "proapi_5e7a0c3d9b1f42e6a8c4d2b0f6e1a937";
const OTHER_KEY = "c0ffee11d00d22feed33beef44cafe55";
const TABLE: RoutingTable = {
  schemaVersion: 3,
  checked: "2026-11-05",
  chains: [
    {
      chainId: SEPOLIA,
      backends: [{ backend: "sourcify" }, { backend: "blockscout", instance: INSTANCE }],
    },
  ],
};
const PAGE = `https://${INSTANCE}/address/${ADDRESS}?tab=contract`;
const BACKENDS = { blockscout, "blockscout-hosted": blockscoutHosted };

/** The recorded answer of `test/fixtures/blockscout/2026-11-05-hosted-<name>.json`. */
function hosted(name: string): Response {
  const url = new URL(`../fixtures/blockscout/2026-11-05-hosted-${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null);
  const response: unknown = Reflect.get(parsed, "response");
  assert.ok(typeof response === "object" && response !== null);
  const status: unknown = Reflect.get(response, "status");
  const body: unknown = Reflect.get(response, "body");
  assert.ok(typeof status === "number");
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** A 402 with `error` set to `text`, as the hosted API answers. */
function paymentRequired(text: string): Response {
  return new Response(JSON.stringify({ error: text }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

function input(): VerifyInput {
  return validateInput({
    chainId: SEPOLIA,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "src/Probe96.sol": { content: "contract Probe96 {}" } },
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
      },
    },
    contractName: "src/Probe96.sol:Probe96",
  });
}

const HANDLE: Handle = {
  version: 1,
  backend: "blockscout-hosted",
  chainId: SEPOLIA,
  address: ADDRESS,
  jobId: GUID,
};

async function drive<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  const tracked = promise.then(
    (value) => value,
    (error: unknown) => {
      throw error;
    },
  );
  tracked.catch(() => {});
  await driveMockClock(tracked, () => {
    t.mock.timers.runAll();
  });
  return await tracked;
}

interface Run {
  readonly outcome: unknown;
  readonly calls: readonly Call[];
  readonly events: readonly VerifyEvent[];
  readonly lines: readonly string[];
}

/** Runs verify(), or checkStatus() for a handle, with the replayed answers and timers mocked. */
async function run(
  t: TestContext,
  steps: readonly Step[],
  options: { apiKeys?: Record<string, string>; route?: RouteOverride; resume?: Handle } = {},
): Promise<Run> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = replay(...steps);
  const events: VerifyEvent[] = [];
  const lines: string[] = [];
  const record = (message: string, fields?: unknown): void => {
    lines.push(`${message} ${JSON.stringify(fields)}`);
  };
  const verifyOptions = {
    fetch: fake.fetch,
    pollIntervalMs: 1_000,
    route: options.route ?? HOSTED_ROUTE,
    ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
    logger: { debug: record, info: record, warn: record, error: record },
    onEvent: (event: VerifyEvent): void => {
      events.push(event);
    },
  };
  const dependencies = { backends: BACKENDS, table: TABLE, random: () => 0 };
  const outcome = await drive(
    t,
    (options.resume === undefined
      ? runVerify(input(), verifyOptions, dependencies)
      : runCheckStatus(options.resume, verifyOptions, dependencies)
    ).catch((error: unknown) => error),
  );
  return { outcome, calls: fake.calls, events, lines };
}

/** The key is in no event, log line or outcome (R-SEC-1). */
function assertNotShown(r: Run, key: string): void {
  const outcome =
    r.outcome instanceof ExplorerVerifyError
      ? `${r.outcome.message} ${JSON.stringify(r.outcome.toJSON())} ${String(r.outcome.stack)}`
      : JSON.stringify(r.outcome);
  for (const text of [JSON.stringify(r.events), r.lines.join("\n"), outcome]) {
    assert.ok(!text.toLowerCase().includes(key.toLowerCase()), text.slice(0, 200));
  }
}

/**
 * Every request went to the hosted API with the key in the `authorization` header only, and the
 * key is in no URL, body, event, log line or outcome (R-SEC-1, R-SEC-2).
 */
function assertKeyedToHostedOnly(r: Run, key: string): void {
  assert.ok(r.calls.length > 0);
  for (const call of r.calls) {
    const url = new URL(call.url);
    assert.equal(url.origin, `https://${HOSTED_BLOCKSCOUT_HOST}`);
    assert.ok(url.pathname.startsWith(`/${String(SEPOLIA)}/api`), url.pathname);
    assert.equal(call.headers.get("authorization"), `Bearer ${key}`);
    assert.equal(call.headers.get("apikey"), null);
    assert.ok(!call.url.includes(key), "the URL holds the key");
    assert.ok(!(call.body ?? "").includes(key), "the body holds the key");
  }
  assertNotShown(r, key);
}

function errorOf(outcome: unknown): ExplorerVerifyError {
  assert.ok(outcome instanceof ExplorerVerifyError, `expected an error, got ${String(outcome)}`);
  return outcome;
}

/** Both keys of the keyFor tests. */
function apiKeys(): Record<string, string> {
  return { "blockscout-hosted": HEX_KEY, "etherscan-v2": OTHER_KEY };
}

describe("blockscout-hosted: the route (decision 0041)", () => {
  it("resolves to api.blockscout.com with the chain in the path, and the row's instance page", () => {
    const route = resolveRoute(SEPOLIA, HOSTED_ROUTE, { table: TABLE });
    assert.equal(route.backend, "blockscout-hosted");
    assert.equal(route.apiBase, HOSTED);
    assert.equal(route.requestUrl(""), HOSTED);
    assert.equal(route.requestUrl("/v2/smart-contracts/0x1"), `${HOSTED}/v2/smart-contracts/0x1`);
    assert.equal(route.tableHost, HOSTED_BLOCKSCOUT_HOST);
    assert.equal(route.overridden, false);
    assert.equal(needsKey(route.backend), true);
    assert.equal(route.explorerUrl?.(ADDRESS), PAGE);
    assert.equal(readsTable(checkRoute(SEPOLIA, HOSTED_ROUTE)), true);
  });

  it("routes a chain without a row, with no page, and without a loaded table", () => {
    const noRow = resolveRoute(1, HOSTED_ROUTE, { table: TABLE });
    assert.equal(noRow.apiBase, `https://${HOSTED_BLOCKSCOUT_HOST}/1/api`);
    assert.equal(noRow.explorerUrl, undefined);
    assert.equal(resolveRoute(1, HOSTED_ROUTE).apiBase, noRow.apiBase);
  });

  it("is never the routing table's choice, even with its key set", () => {
    const route = resolveRoute(SEPOLIA, undefined, {
      table: TABLE,
      apiKeys: { "blockscout-hosted": HEX_KEY },
    });
    assert.equal(route.backend, "sourcify");
    const instance = resolveRoute(SEPOLIA, { backend: "blockscout" }, { table: TABLE });
    assert.equal(instance.apiBase, `https://${INSTANCE}/api`);
  });

  it("refuses the hosted URL as a route.apiUrl of the instance backend, naming blockscout-hosted", () => {
    assert.throws(
      () => checkRoute(SEPOLIA, { backend: "blockscout", apiUrl: HOSTED }),
      (error: unknown) =>
        error instanceof ExplorerVerifyError &&
        error.details.code === "invalid-input" &&
        error.details.issues.some((issue) => issue.field === "route.apiUrl") &&
        error.hint.includes("blockscout-hosted"),
    );
  });

  it("needs /api at the end of a route.apiUrl, as the instance backend does", () => {
    assert.throws(
      () => checkRoute(SEPOLIA, { backend: "blockscout-hosted", apiUrl: "https://proxy.example" }),
      (error: unknown) =>
        error instanceof ExplorerVerifyError &&
        JSON.stringify(error.details).includes("must end in /api for blockscout-hosted"),
    );
  });

  it("takes its key in apiKeys; the instance backend takes none (decision 0016)", () => {
    const read = readApiKeys({ "blockscout-hosted": PROAPI_KEY, blockscout: OTHER_KEY });
    assert.deepEqual(read.keys, { "blockscout-hosted": PROAPI_KEY });
    assert.deepEqual(read.issues, [
      {
        field: "apiKeys.blockscout",
        message: "is not accepted: blockscout takes no API key in this version",
      },
    ]);
  });

  it("formats and parses its handle as ev1:blockscout-hosted:…", () => {
    const text = formatHandle(HANDLE);
    assert.equal(text, `ev1:blockscout-hosted:${String(SEPOLIA)}:${ADDRESS}:${GUID}`);
    assert.deepEqual(parseHandle(text), HANDLE);
  });
});

describe("keyFor and withKey: the hosted key goes only to api.blockscout.com (R-SEC-2)", () => {
  const hostedRoute = resolveRoute(SEPOLIA, HOSTED_ROUTE, { table: TABLE });

  it("binds the key to the hosted route's origin, for blockscout-hosted requests only", () => {
    const ctx = { route: hostedRoute, apiKeys };
    assert.equal(keyFor(ctx, "blockscout-hosted", HOSTED), HEX_KEY);
    assert.equal(
      keyFor(ctx, "blockscout-hosted", `${HOSTED}/v2/smart-contracts/${ADDRESS}`),
      HEX_KEY,
    );
    assert.equal(keyFor(ctx, "blockscout", HOSTED), undefined);
    assert.equal(keyFor(ctx, "etherscan-v2", HOSTED), undefined);
    assert.equal(keyFor(ctx, "blockscout-hosted", `https://${INSTANCE}/api`), undefined);
    assert.equal(
      keyFor(ctx, "blockscout-hosted", `https://${HOSTED_BLOCKSCOUT_HOST}:8443/1/api`),
      undefined,
    );
    assert.equal(
      keyFor(ctx, "blockscout-hosted", `http://${HOSTED_BLOCKSCOUT_HOST}/1/api`),
      undefined,
    );
  });

  it("never binds it to an instance or to a route.apiUrl, even the hosted URL", () => {
    const routes = [
      resolveRoute(SEPOLIA, { backend: "blockscout" }, { table: TABLE }),
      resolveRoute(SEPOLIA, {
        backend: "blockscout-hosted",
        apiUrl: "https://attacker.example/api",
      }),
      resolveRoute(SEPOLIA, { backend: "blockscout-hosted", apiUrl: HOSTED }),
    ];
    for (const route of routes) {
      for (const backend of ["blockscout", "blockscout-hosted"] as const) {
        assert.equal(keyFor({ route, apiKeys }, backend, route.apiBase), undefined);
        const req = { url: route.requestUrl(""), method: "GET", retry: "safe" } as const;
        assert.equal(withKey({ route, apiKeys }, backend, req), req);
      }
    }
  });

  it("sends route.apiKey only to its route.apiUrl, in the header", () => {
    const route = resolveRoute(SEPOLIA, {
      backend: "blockscout-hosted",
      apiUrl: "https://proxy.example/api",
      apiKey: PROAPI_KEY,
    });
    const req = { url: route.requestUrl(""), method: "GET", retry: "safe" } as const;
    assert.deepEqual(withKey({ route }, "blockscout-hosted", req).headers, {
      authorization: `Bearer ${PROAPI_KEY}`,
    });
    assert.throws(
      () => checkRoute(SEPOLIA, { backend: "blockscout-hosted", apiKey: PROAPI_KEY }),
      (error: unknown) =>
        error instanceof ExplorerVerifyError &&
        JSON.stringify(error.details).includes("route.apiKey") &&
        !JSON.stringify(error.toJSON()).includes(PROAPI_KEY),
    );
  });

  it("puts the key in the authorization header as Bearer, never in the URL or body", () => {
    const body = new URLSearchParams({
      module: "contract",
      action: "checkverifystatus",
      guid: GUID,
    });
    const req = {
      url: HOSTED,
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      retry: "safe",
    } as const;
    const keyed = withKey({ route: hostedRoute, apiKeys }, "blockscout-hosted", req);
    assert.deepEqual(keyed.headers, {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Bearer ${HEX_KEY}`,
    });
    assert.equal(keyed.url, HOSTED);
    assert.equal(keyed.body, body);
  });
});

describe("verify() on blockscout-hosted, replayed from 2026-11-05 (R-BE-3, R-FLOW-4)", () => {
  for (const key of [HEX_KEY, PROAPI_KEY]) {
    it(`verifies exact through lookup, submit, two polls and a grade lookup, key ${key.slice(0, 7)}…`, async (t) => {
      const r = await run(
        t,
        [
          hosted("lookup-unverified"),
          hosted("verifysourcecode-accepted"),
          hosted("checkverifystatus-pending"),
          hosted("checkverifystatus-pass"),
          hosted("lookup-after-pass"),
        ],
        { apiKeys: { "blockscout-hosted": key } },
      );
      assert.deepEqual(r.outcome, {
        status: "verified",
        backend: "blockscout-hosted",
        match: "exact",
        explorerUrl: PAGE,
      });
      assertKeyedToHostedOnly(r, key);
      assert.deepEqual(
        r.events.find((event) => event.type === "verify.routed"),
        {
          type: "verify.routed",
          backend: "blockscout-hosted",
          apiHost: HOSTED_BLOCKSCOUT_HOST,
          routedBy: "caller",
        },
      );
      const submitted = r.events.find((event) => event.type === "verify.submitted");
      assert.ok(JSON.stringify(submitted).includes(`ev1:blockscout-hosted:${String(SEPOLIA)}:`));
    });
  }

  it("ends failed for Fail - Unable to verify, never unexpected-response", async (t) => {
    const r = await run(
      t,
      [
        hosted("lookup-unverified"),
        hosted("verifysourcecode-wrong-source"),
        hosted("checkverifystatus-pending"),
        hosted("checkverifystatus-fail"),
      ],
      { apiKeys: { "blockscout-hosted": PROAPI_KEY } },
    );
    assert.deepEqual(r.outcome, {
      status: "failed",
      backend: "blockscout-hosted",
      reason: "Fail - Unable to verify",
    });
    assertKeyedToHostedOnly(r, PROAPI_KEY);
  });

  it("retries the hosted API's 429 and goes on (recorded 2026-11-05)", async (t) => {
    const r = await run(t, [hosted("rate-limited"), hosted("lookup-after-pass")], {
      apiKeys: { "blockscout-hosted": HEX_KEY },
    });
    assert.equal(Reflect.get(Object(r.outcome), "status"), "already-verified");
    assert.ok(r.events.some((event) => event.type === "verify.retry"));
    assertKeyedToHostedOnly(r, HEX_KEY);
  });

  it("resumes a blockscout-hosted handle on the hosted API with checkStatus()", async (t) => {
    const r = await run(t, [hosted("checkverifystatus-pass"), hosted("lookup-after-pass")], {
      apiKeys: { "blockscout-hosted": PROAPI_KEY },
      resume: HANDLE,
    });
    assert.equal(Reflect.get(Object(r.outcome), "status"), "verified");
    assertKeyedToHostedOnly(r, PROAPI_KEY);
  });

  it("reads 404 Not found and Address is not a smart-contract as an instance does", async (t) => {
    const r = await run(
      t,
      [hosted("lookup-not-found"), hosted("verifysourcecode-not-a-contract")],
      {
        apiKeys: { "blockscout-hosted": HEX_KEY },
      },
    );
    assert.equal(errorOf(r.outcome).code, "invalid-input");
    assertKeyedToHostedOnly(r, HEX_KEY);
  });

  it("sends no key to the instance when only apiKeys.blockscout-hosted is set", async (t) => {
    const r = await run(t, [hosted("lookup-after-pass")], {
      apiKeys: { "blockscout-hosted": PROAPI_KEY },
      route: { backend: "blockscout" },
    });
    assert.equal(Reflect.get(Object(r.outcome), "status"), "already-verified");
    for (const call of r.calls) {
      assert.equal(new URL(call.url).host, INSTANCE);
      assert.equal(call.headers.get("authorization"), null);
      assert.ok(!`${call.url}${call.body ?? ""}`.includes(PROAPI_KEY));
    }
    assertNotShown(r, PROAPI_KEY);
  });
});

describe("the hosted API's answers about the key and the chain (R-AX-7, decision 0041)", () => {
  const cases: readonly [string, () => Response, ErrorCode][] = [
    ["a wrong key: HTTP 401 Unauthorized", () => hosted("lookup-wrong-key"), "api-key-rejected"],
    [
      "a free-plan key on a featured chain: HTTP 402",
      () => hosted("lookup-plan-needed"),
      "api-key-rejected",
    ],
    [
      "a 402 to a request that carried a key, whatever its text",
      () => hosted("lookup-no-key"),
      "api-key-rejected",
    ],
    [
      "a chain the hosted API does not serve: HTTP 404 Network not supported",
      () => hosted("lookup-network-not-supported"),
      "unsupported-chain",
    ],
  ];
  for (const [label, answer, code] of cases) {
    it(`maps ${label} to ${code}, without the key or the explorer's text`, async (t) => {
      const r = await run(t, [answer()], { apiKeys: { "blockscout-hosted": PROAPI_KEY } });
      const error = errorOf(r.outcome);
      assert.equal(error.code, code);
      assert.equal(Reflect.get(error.details, "backend"), "blockscout-hosted");
      assert.equal(error.retryable, false);
      assert.equal(ERROR_EXIT_CODES[code], code === "unsupported-chain" ? 2 : 3);
      assert.equal(r.calls.length, 1);
      assert.ok(!error.message.includes("Featured") && !error.message.includes("missing"));
      assertNotShown(r, PROAPI_KEY);
    });
  }

  it("names the instance backend in the hint of a key refusal", async (t) => {
    const r = await run(t, [hosted("lookup-plan-needed")], {
      apiKeys: { "blockscout-hosted": HEX_KEY },
    });
    assert.match(errorOf(r.outcome).hint, /backend blockscout\b/);
  });

  it("maps a 402 to a submit and to a poll the same way", async (t) => {
    const submit = await run(
      t,
      [hosted("lookup-unverified"), hosted("verifysourcecode-wrong-key")],
      {
        apiKeys: { "blockscout-hosted": HEX_KEY },
      },
    );
    assert.equal(errorOf(submit.outcome).code, "api-key-rejected");
    t.mock.timers.reset();
    const poll = await run(t, [paymentRequired("Proceed with API key")], {
      apiKeys: { "blockscout-hosted": HEX_KEY },
      resume: HANDLE,
    });
    assert.equal(errorOf(poll.outcome).code, "api-key-rejected");
  });

  it("throws missing-api-key before any request with no key and no injected fetch", async (t) => {
    const spy = t.mock.method(globalThis, "fetch", () => Promise.reject(new Error("no request")));
    const outcome = await runVerify(
      input(),
      { route: HOSTED_ROUTE },
      { backends: BACKENDS, table: TABLE },
    ).catch((error: unknown) => error);
    const error = errorOf(outcome);
    assert.equal(error.code, "missing-api-key");
    assert.match(error.message, /api\.blockscout\.com: set apiKeys\.blockscout-hosted/);
    assert.equal(spy.mock.callCount(), 0);
  });

  it("throws missing-api-key before any request with an injected fetch too (decision 0046)", async (t) => {
    const r = await run(t, [hosted("lookup-no-key")]);
    const error = errorOf(r.outcome);
    assert.equal(error.code, "missing-api-key");
    assert.equal(r.calls.length, 0);
    // handlerUrl serves Etherscan only, so the hint names the hosted key, not handlerUrl.
    assert.doesNotMatch(`${error.message} ${error.hint}`, /handlerUrl/);
  });

  it("maps a 402 to missing-api-key without a key, to api-key-rejected with one or for a plan", async (t) => {
    // The flows never send a keyless request to the hosted API (decision 0046), so the keyless
    // 402 is read through refusal() directly.
    const route = resolveRoute(SEPOLIA, { backend: "blockscout-hosted" }, { table: TABLE });
    const noKey = hosted("lookup-no-key");
    const text = await noKey.text();
    const parsed: unknown = JSON.parse(text);
    const answer = {
      status: noKey.status,
      text,
      fields: new Map(typeof parsed === "object" && parsed !== null ? Object.entries(parsed) : []),
    };
    const keyless = refusal(
      { route, pollIntervalMs: 1_000, http: { backend: "blockscout-hosted", secrets: [] } },
      answer,
      SEPOLIA,
    );
    assert.equal(keyless?.code, "missing-api-key");
    const r = await run(t, [hosted("lookup-no-key")], {
      apiKeys: { "blockscout-hosted": HEX_KEY },
    });
    assert.equal(errorOf(r.outcome).code, "api-key-rejected");
    t.mock.timers.reset();
    const plan = await run(t, [hosted("lookup-plan-needed")], {
      apiKeys: { "blockscout-hosted": HEX_KEY },
    });
    assert.equal(errorOf(plan.outcome).code, "api-key-rejected");
  });
});

describe("the instance backend never reads a key answer (M1, decision 0041)", () => {
  for (const [label, answer] of [
    ["HTTP 401", () => hosted("lookup-wrong-key")],
    ["HTTP 402", () => hosted("lookup-no-key")],
    ["HTTP 404 Network not supported", () => hosted("lookup-network-not-supported")],
  ] as const) {
    it(`maps an instance's ${label} to unexpected-response, not a key error`, async (t) => {
      const r = await run(t, [answer()], { route: { backend: "blockscout" } });
      assert.equal(errorOf(r.outcome).code, "unexpected-response");
    });
  }
});

describe("verifyEach() and linkProxy() on blockscout-hosted (decision 0041)", () => {
  it("runs the hosted API and the instance as two named entries, each with its own route", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const fake = replay(hosted("lookup-after-pass"), hosted("lookup-after-pass"));
    const outcome = await drive(
      t,
      runVerifyEach(
        input(),
        {
          fetch: fake.fetch,
          apiKeys: { "blockscout-hosted": HEX_KEY },
          backends: ["blockscout-hosted", "blockscout"],
        },
        { backends: BACKENDS, table: TABLE, random: () => 0 },
      ),
    );
    assert.deepEqual(
      outcome.outcomes.map((each) => each.backend),
      ["blockscout-hosted", "blockscout"],
    );
    for (const call of fake.calls) {
      const expected = new URL(call.url).host === INSTANCE ? null : `Bearer ${HEX_KEY}`;
      assert.equal(call.headers.get("authorization"), expected);
    }
    assert.ok(!JSON.stringify(outcome).includes(HEX_KEY));
  });

  it('leaves blockscout-hosted out of backends: "all", even with its key', async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const fake = replay(hosted("lookup-after-pass"), hosted("lookup-after-pass"));
    const sourcifyLike = { ...blockscout, name: "sourcify" as const };
    const outcome = await drive(
      t,
      runVerifyEach(
        input(),
        { fetch: fake.fetch, apiKeys: { "blockscout-hosted": HEX_KEY }, backends: "all" },
        { backends: { ...BACKENDS, sourcify: sourcifyLike }, table: TABLE, random: () => 0 },
      ),
    );
    assert.deepEqual(
      outcome.outcomes.map((each) => each.backend),
      ["sourcify", "blockscout"],
    );
  });

  it("sends the proxy link requests with the key in the header", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const fake = replay(
      new Response(
        JSON.stringify({ message: "OK", result: `${ADDRESS.slice(2)}6aecdb59`, status: "1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      paymentRequired("Proceed with API key"),
    );
    const outcome = await drive(
      t,
      runLinkProxy(
        { chainId: SEPOLIA, address: ADDRESS },
        {
          fetch: fake.fetch,
          apiKeys: { "blockscout-hosted": PROAPI_KEY },
          route: HOSTED_ROUTE,
          pollIntervalMs: 1_000,
        },
        {
          linkers: { "blockscout-hosted": blockscoutProxyLinker },
          table: TABLE,
          random: () => 0,
        },
      ).catch((error: unknown) => error),
    );
    assert.equal(errorOf(outcome).code, "api-key-rejected");
    for (const call of fake.calls) {
      assert.equal(new URL(call.url).host, HOSTED_BLOCKSCOUT_HOST);
      assert.equal(call.headers.get("authorization"), `Bearer ${PROAPI_KEY}`);
      assert.ok(!`${call.url}${call.body ?? ""}`.includes(PROAPI_KEY));
    }
    assert.ok(!JSON.stringify(Object(outcome)).includes(PROAPI_KEY));
  });
});
