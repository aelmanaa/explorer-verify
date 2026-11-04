// The standalone Etherscan-compatible explorer client (R-BE-2). No standalone host answered live
// on 2026-11-03 or 2026-11-04, so the explorer's answers are Etherscan's, recorded live in
// test/fixtures/etherscan/ (the same API), and the deprecated-V1 answer is recorded from a retired
// Etherscan host in test/fixtures/etherscan-compatible/. Every request goes to a local fake
// explorer: a fake fetch on a loopback URL, or a node:http server on 127.0.0.1.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { inspect } from "node:util";

import type { Context, Target } from "../../src/backends/backend.ts";
import { etherscanCompatible } from "../../src/backends/etherscan-compatible.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { DEFAULT_DEPENDENCIES } from "../../src/flow/verify.ts";
import type { HttpContext } from "../../src/http/fetch.ts";
import { checkStatus, verify } from "../../src/index.ts";
import { validateInput } from "../../src/input/validate.ts";
import { resolveRoute } from "../../src/routing/resolve.ts";
import type { Handle, VerifyEvent, VerifyInput, VerifyOptions } from "../../src/types.ts";
import { replay } from "../helpers/fake-fetch.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

// Hedera Testnet: the prior art listed a standalone host for it, which did not resolve.
const CHAIN = 296;
const API = "http://127.0.0.1:8555/api";
const ADDRESS = "0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5";
const GUID = "cqmxkhtaudvs5yhbzgv5nryiczguab4g3ppjj6mb3gakhzxjcn";
// Fake keys. Never real ones (R-SEC-1).
const ROUTE_KEY = "dummy-standalone-key-63a7";
const ETHERSCAN_KEY = "dummy-etherscan-key-63b9";
const ROUTESCAN_KEY = "dummy-routescan-key-63c4";
const KEYS = [ROUTE_KEY, ETHERSCAN_KEY, ROUTESCAN_KEY];

/** The recorded response of `test/fixtures/<dir>/<name>.json`. */
function answer(dir: string, name: string): Response {
  const url = new URL(`../fixtures/${dir}/${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null);
  const response: unknown = Reflect.get(parsed, "response");
  assert.ok(typeof response === "object" && response !== null);
  const status: unknown = Reflect.get(response, "status");
  assert.ok(typeof status === "number");
  return new Response(JSON.stringify(Reflect.get(response, "body")), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const etherscanAnswer = (name: string): Response => answer("etherscan", name);
const NOT_VERIFIED = (): Response => etherscanAnswer("2026-11-03-getsourcecode-not-verified");
const VERIFIED = (): Response => etherscanAnswer("2026-11-03-getsourcecode-factory-child-verified");
const SUBMITTED = (): Response => etherscanAnswer("2026-11-03-verifysourcecode-factory-child");
const PENDING = (): Response =>
  etherscanAnswer("2026-11-03-checkverifystatus-factory-child-01-pending");
const PASS = (): Response => etherscanAnswer("2026-11-03-checkverifystatus-factory-child-02-pass");
const V1 = (): Response =>
  answer("etherscan-compatible", "2026-11-04-getsourcecode-retired-host-keyless");

/** A status 0 body with `result` set to `result`, as Etherscan's documented answers are. */
function text(result: string): Response {
  return new Response(JSON.stringify({ status: "0", message: "NOTOK", result }), { status: 200 });
}

function input(): VerifyInput {
  return validateInput({
    chainId: CHAIN,
    address: ADDRESS,
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
  });
}

const TARGET: Target = { chainId: CHAIN, address: input().address };

function handle(): Handle {
  return {
    version: 1,
    backend: "etherscan-compatible",
    chainId: CHAIN,
    address: TARGET.address,
    jobId: GUID,
  };
}

/** A client context for a route to `API`, with `route.apiKey` when `keyed`. */
function setup(steps: Step[], keyed = false): { ctx: Context; calls: Call[] } {
  const fake = replay(...steps);
  const http: HttpContext = {
    backend: "etherscan-compatible",
    fetch: fake.fetch,
    secrets: KEYS,
    random: () => 0,
  };
  const apiKeys = { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY };
  const route = resolveRoute(
    CHAIN,
    { backend: "etherscan-compatible", apiUrl: API, ...(keyed ? { apiKey: ROUTE_KEY } : {}) },
    { apiKeys },
  );
  return { ctx: { route, apiKeys: () => apiKeys, http }, calls: fake.calls };
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

function assertNoKey(seen: string): void {
  for (const key of KEYS) {
    assert.ok(!seen.toLowerCase().includes(key.toLowerCase()), `key ${key.slice(0, 9)} leaked`);
  }
}

describe("etherscan-compatible requests (R-BE-2, R-SEC-1, R-SEC-2)", () => {
  it("etherscan-compatible sends no chainid parameter (R-BE-2)", async () => {
    const s = setup([NOT_VERIFIED(), SUBMITTED(), PENDING()]);
    assert.equal(await etherscanCompatible.lookup(TARGET, s.ctx), undefined);
    assert.equal((await etherscanCompatible.submit(input(), s.ctx)).state, "submitted");
    assert.deepEqual(await etherscanCompatible.poll(handle(), s.ctx), { state: "pending" });
    assert.equal(s.calls.length, 3);
    for (const sent of s.calls) {
      assert.equal(sent.url, API);
      assert.equal(sent.method, "POST");
      assert.equal(sent.headers.get("content-type"), "application/x-www-form-urlencoded");
      assert.equal(new URL(sent.url).searchParams.has("chainid"), false);
      assert.equal(form(sent).has("chainid"), false);
      assert.equal(form(sent).get("module"), "contract");
    }
    assert.equal(form(s.calls[0]).get("action"), "getsourcecode");
    assert.equal(form(s.calls[0]).get("address"), TARGET.address);
    assert.equal(form(s.calls[1]).get("action"), "verifysourcecode");
    assert.equal(form(s.calls[1]).get("contractaddress"), TARGET.address);
    assert.equal(form(s.calls[2]).get("action"), "checkverifystatus");
    assert.equal(form(s.calls[2]).get("guid"), GUID);
  });

  it("a caller's query string is kept, and none is added (R-BE-2)", async () => {
    const fake = replay(NOT_VERIFIED());
    const route = resolveRoute(CHAIN, {
      backend: "etherscan-compatible",
      apiUrl: "https://explorer.example.org/api?network=testnet",
    });
    const ctx: Context = {
      route,
      http: { backend: "etherscan-compatible", fetch: fake.fetch, secrets: [] },
    };
    await etherscanCompatible.lookup(TARGET, ctx);
    assert.equal(fake.calls[0]?.url, "https://explorer.example.org/api?network=testnet");
  });

  it("etherscan-compatible sends the override's key only to the override's host (R-SEC-2)", async () => {
    const s = setup([NOT_VERIFIED(), SUBMITTED(), PASS()], true);
    await etherscanCompatible.lookup(TARGET, s.ctx);
    await etherscanCompatible.submit(input(), s.ctx);
    await etherscanCompatible.poll(handle(), s.ctx);
    assert.equal(s.calls.length, 3);
    for (const sent of s.calls) {
      assert.equal(new URL(sent.url).origin, new URL(API).origin);
      // In the form body only (R-SEC-1): never the URL or a header.
      assert.equal(form(sent).get("apikey"), ROUTE_KEY);
      assert.ok(!sent.url.includes(ROUTE_KEY));
      assert.ok(![...sent.headers.values()].some((value) => value.includes(ROUTE_KEY)));
      // The caller's apiKeys never go to a standalone host.
      assert.ok(!(sent.body ?? "").includes(ETHERSCAN_KEY));
      assert.ok(!(sent.body ?? "").includes(ROUTESCAN_KEY));
    }
  });

  it("without route.apiKey, no key is sent, even with apiKeys set (R-SEC-2)", async () => {
    const s = setup([NOT_VERIFIED()]);
    await etherscanCompatible.lookup(TARGET, s.ctx);
    assert.equal(form(s.calls[0]).has("apikey"), false);
    assertNoKey(JSON.stringify(s.calls));
  });

  it("a handle of another backend is refused before any request, and gets no key (R-SEC-2)", async () => {
    const s = setup([PASS()], true);
    const error = await errorOf(
      etherscanCompatible.poll({ ...handle(), backend: "etherscan-v2" }, s.ctx),
    );
    assert.equal(error.code, "invalid-input");
    assert.equal(s.calls.length, 0);
  });

  it("has no explorer page for a route override (R-FLOW-3)", () => {
    assert.equal(etherscanCompatible.explorerUrl(TARGET, setup([]).ctx), undefined);
  });
});

describe("etherscan-compatible answers (R-BE-2, R-FLOW-4)", () => {
  it("a deprecated V1 endpoint answer throws unexpected-response, never failed (R-FLOW-4)", async () => {
    // Recorded keyless from api-sepolia.basescan.org on 2026-11-04.
    const lookup = await errorOf(etherscanCompatible.lookup(TARGET, setup([V1()]).ctx));
    const submit = await errorOf(etherscanCompatible.submit(input(), setup([V1()]).ctx));
    const poll = await errorOf(etherscanCompatible.poll(handle(), setup([V1()]).ctx));
    for (const error of [lookup, submit, poll]) {
      assert.equal(error.code, "unexpected-response");
      assert.deepEqual(
        {
          backend: Reflect.get(error.details, "backend"),
          status: Reflect.get(error.details, "status"),
        },
        { backend: "etherscan-compatible", status: 200 },
      );
      assert.equal(
        error.message,
        "Etherscan-compatible explorer answered that the request went to Etherscan's deprecated v1 API.",
      );
      assert.equal(error.hint, "Use the etherscan-v2 backend without route.apiUrl.");
    }
  });

  it("a deprecated V1 endpoint answer ends verify() with unexpected-response and no submit (R-FLOW-4)", async () => {
    const fake = replay(V1());
    const error = await errorOf(
      verify(input(), {
        fetch: fake.fetch,
        route: { backend: "etherscan-compatible", apiUrl: API },
      }),
    );
    assert.equal(error.code, "unexpected-response");
    assert.equal(fake.calls.length, 1);
    assert.equal(form(fake.calls[0]).get("action"), "getsourcecode");
  });

  it("reads key and chain answers as the Etherscan client does", async () => {
    const cases: [Response, string][] = [
      [text("Missing/Invalid API Key"), "missing-api-key"],
      [text("Invalid API Key (#err2)"), "api-key-rejected"],
      [text("Max daily rate limit reached. 100 (100%) of 100 day/limit"), "quota-exceeded"],
      [text("Missing or unsupported chainid parameter (required for v2 api)"), "unsupported-chain"],
      [text("Some other text"), "unexpected-response"],
    ];
    for (const [response, code] of cases) {
      const error = await errorOf(etherscanCompatible.lookup(TARGET, setup([response], true).ctx));
      assert.equal(error.code, code);
      assert.equal(Reflect.get(error.details, "backend"), "etherscan-compatible");
      assertNoKey(`${error.message} ${error.hint} ${JSON.stringify(error)} ${inspect(error)}`);
    }
  });

  it("a verified lookup is an exact match", async () => {
    assert.equal(await etherscanCompatible.lookup(TARGET, setup([VERIFIED()]).ctx), "exact");
  });
});

describe("verify() and checkStatus() through a route override (R-FLOW-3, R-RT-2)", () => {
  it("the shipped clients include etherscan-compatible, loaded on first use (decision 0031)", async () => {
    const client = DEFAULT_DEPENDENCIES.backends["etherscan-compatible"];
    assert.equal(typeof client, "function");
    assert.equal(typeof client === "function" ? await client() : client, etherscanCompatible);
  });

  it("a recorded verify() run to a local fake explorer returns verified without explorerUrl (R-FLOW-3, R-RT-2)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const fake = replay(NOT_VERIFIED(), SUBMITTED(), PENDING(), PASS());
    const events: VerifyEvent[] = [];
    const lines: string[] = [];
    const record = (message: string, fields?: unknown): void => {
      lines.push(`${message} ${JSON.stringify(fields)}`);
    };
    const result = await drive(
      t,
      verify(input(), {
        fetch: fake.fetch,
        pollIntervalMs: 1_000,
        route: { backend: "etherscan-compatible", apiUrl: API, apiKey: ROUTE_KEY },
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
        logger: { debug: record, info: record, warn: record, error: record },
        onEvent: (event) => {
          events.push(event);
        },
      }),
    );
    assert.deepEqual(result, {
      status: "verified",
      backend: "etherscan-compatible",
      match: "exact",
    });
    assert.equal("explorerUrl" in result, false);
    assert.deepEqual(
      fake.calls.map((sent) => form(sent).get("action")),
      ["getsourcecode", "verifysourcecode", "checkverifystatus", "checkverifystatus"],
    );
    for (const sent of fake.calls) {
      assert.equal(sent.url, API);
      assert.equal(form(sent).get("apikey"), ROUTE_KEY);
    }
    const routed = events.find((event) => event.type === "verify.routed");
    assert.ok(routed !== undefined && routed.type === "verify.routed");
    assert.equal(routed.backend, "etherscan-compatible");
    assert.equal(routed.apiHost, "127.0.0.1:8555");
    assertNoKey(JSON.stringify([events, lines, result]));
  });

  it("an apiKeys entry for etherscan-compatible is refused (R-SEC-2)", async () => {
    const fake = replay(VERIFIED());
    const options: VerifyOptions = {
      fetch: fake.fetch,
      route: { backend: "etherscan-compatible", apiUrl: API },
    };
    Reflect.set(options, "apiKeys", { "etherscan-compatible": ROUTE_KEY });
    const error = await errorOf(verify(input(), options));
    assert.equal(error.code, "invalid-input");
    assert.deepEqual(
      error.details.code === "invalid-input" ? error.details.issues.map((i) => i.field) : [],
      ["apiKeys.etherscan-compatible"],
    );
    assert.equal(fake.calls.length, 0);
    assertNoKey(`${error.message} ${error.hint} ${JSON.stringify(error)} ${inspect(error)}`);
  });

  it("route.backend etherscan-compatible without route.apiUrl throws unsupported-chain: the table lists no standalone explorer", async () => {
    const fake = replay();
    const error = await errorOf(
      verify(input(), { fetch: fake.fetch, route: { backend: "etherscan-compatible" } }),
    );
    assert.deepEqual(error.details, {
      code: "unsupported-chain",
      chainId: CHAIN,
      backend: "etherscan-compatible",
    });
    assert.equal(fake.calls.length, 0);
  });

  it("checkStatus() resumes a job on a node:http fake explorer on 127.0.0.1, with no explorerUrl", async () => {
    const received: { method: string; url: string; body: string }[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        received.push({ method: req.method ?? "", url: req.url ?? "", body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "1", message: "OK", result: "Pass - Verified" }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address: AddressInfo | string | null = server.address();
      assert.ok(typeof address === "object" && address !== null);
      const result = await checkStatus(handle(), {
        route: {
          backend: "etherscan-compatible",
          apiUrl: `http://127.0.0.1:${String(address.port)}/api`,
          apiKey: ROUTE_KEY,
        },
      });
      assert.deepEqual(result, {
        status: "verified",
        backend: "etherscan-compatible",
        match: "exact",
      });
      assert.equal(received.length, 1);
      const [only] = received;
      assert.ok(only !== undefined);
      assert.equal(only.method, "POST");
      assert.equal(only.url, "/api");
      const body = new URLSearchParams(only.body);
      assert.equal(body.get("action"), "checkverifystatus");
      assert.equal(body.get("guid"), GUID);
      assert.equal(body.get("apikey"), ROUTE_KEY);
      assert.equal(body.has("chainid"), false);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
