// Black-box tests for issue #122: the routing table's Etherscan v2 entries (R-RT-1, R-SEC-2,
// decision 0027). Every call goes through `verify()` from the package entry point with a fake
// `fetch` (or a mocked `globalThis.fetch`) that answers like Etherscan or Sourcify with "already
// verified".
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { inspect } from "node:util";

import { ExplorerVerifyError, verify } from "../../src/index.ts";
import type {
  Hex,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../../src/index.ts";
import table from "../../src/routing/table.json" with { type: "json" };
import { driveMockClock } from "../helpers/mock-clock.ts";

const KEY = "zz9dummyetherscankeyqq7xv";
const ROUTE_KEY = "yy8routekeydummyvalue55";
const ADDRESS: Hex = "0x6355ef85c81f3545ad9cb404f3defb7f219810ec";
const VERSION = "0.8.24+commit.e11b9ed9";
const FREE = 11_155_111;
const PAID = 84_532;
const NO_ETHERSCAN = 31;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

function drive<T>(pending: Promise<T>): Promise<T> {
  void driveMockClock(pending, () => {
    mock.timers.runAll();
  });
  return pending;
}

async function errorOf(promise: Promise<VerifyResult>): Promise<ExplorerVerifyError> {
  try {
    const result = await drive(promise);
    return assert.fail(`expected an error, got ${JSON.stringify(result)}`);
  } catch (error) {
    if (error instanceof ExplorerVerifyError) {
      return error;
    }
    throw error;
  }
}

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: string;
  readonly body: string;
}

function bodyText(body: BodyInit | null | undefined): string {
  if (body === undefined || body === null) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return inspect(body);
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Answers "already verified" from both Etherscan-shaped and Sourcify-shaped servers. */
function fake(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn: typeof fetch = async (target, init) => {
    const url = new URL(target instanceof Request ? target.url : String(target));
    const method = (
      target instanceof Request ? target.method : (init?.method ?? "GET")
    ).toUpperCase();
    const body = target instanceof Request ? await target.clone().text() : bodyText(init?.body);
    const headers = JSON.stringify([
      ...new Headers(target instanceof Request ? target.headers : init?.headers).entries(),
    ]);
    calls.push({ method, url, headers, body });
    const action = new URLSearchParams(body).get("action") ?? url.searchParams.get("action");
    if (action === "getsourcecode") {
      return reply({
        status: "1",
        message: "OK",
        result: [
          {
            SourceCode: '{{"language":"Solidity","sources":{}}}',
            ABI: "[]",
            ContractName: "Tiny",
            CompilerVersion: `v${VERSION}`,
            SimilarMatch: "",
          },
        ],
      });
    }
    const lookup = /\/v2\/contract\/(\d+)\/(0x[0-9a-fA-F]{40})$/u.exec(url.pathname);
    if (method === "GET" && lookup !== null) {
      return reply({
        match: "exact_match",
        creationMatch: "exact_match",
        runtimeMatch: "exact_match",
        chainId: lookup[1],
        address: lookup[2],
        verifiedAt: "2026-11-03T10:00:00Z",
        matchId: "1",
      });
    }
    throw new Error(`unexpected request ${method} ${url.href}`);
  };
  return { fetch: fn, calls };
}

function makeInput(chainId: number): VerifyInput {
  return {
    chainId,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: VERSION,
      input: {
        language: "Solidity",
        sources: { "contracts/Tiny.sol": { content: "contract Tiny {}" } },
        settings: { optimizer: { enabled: false, runs: 200 } },
      },
    },
    contractName: "contracts/Tiny.sol:Tiny",
  };
}

async function run(
  chainId: number,
  options: VerifyOptions,
  useGlobal = false,
): Promise<{ result: VerifyResult; calls: Call[]; events: VerifyEvent[] }> {
  const f = fake();
  const events: VerifyEvent[] = [];
  if (useGlobal) {
    mock.method(globalThis, "fetch", f.fetch);
  }
  const result = await drive(
    verify(makeInput(chainId), {
      ...(useGlobal ? {} : { fetch: f.fetch }),
      onEvent: (event) => {
        events.push(event);
      },
      ...options,
    }),
  );
  return { result, calls: f.calls, events };
}

function assertNoKey(calls: readonly Call[], key: string): void {
  for (const call of calls) {
    assert.ok(!call.url.href.includes(key), `key in URL ${call.url.href}`);
    assert.ok(!call.headers.includes(key), "key in headers");
    assert.ok(!call.body.includes(key), "key in body");
  }
}

function assertEtherscanCalls(calls: readonly Call[], chainId: number, key: string): void {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.method, "POST");
    assert.equal(`${call.url.origin}${call.url.pathname}`, "https://api.etherscan.io/v2/api");
    assert.equal(call.url.search, `?chainid=${String(chainId)}`);
    assert.ok(!call.url.href.includes(key));
    assert.ok(!call.headers.includes(key));
    assert.equal(new URLSearchParams(call.body).get("apikey"), key);
  }
}

function explorerOf(chainId: number): string | undefined {
  const row = table.chains.find((each) => each.chainId === chainId);
  const entry = row?.backends.find((each) => each.backend === "etherscan-v2");
  return entry !== undefined && "explorer" in entry ? entry.explorer : undefined;
}

describe("#122 free-tier chain", () => {
  it("apiKeys sends a POST to api.etherscan.io with the key in the body only, and sets explorerUrl", async () => {
    const { result, calls, events } = await run(FREE, { apiKeys: { "etherscan-v2": KEY } });
    assert.equal(result.backend, "etherscan-v2");
    assert.equal(result.status, "already-verified");
    assert.equal(result.explorerUrl, `https://sepolia.etherscan.io/address/${ADDRESS}#code`);
    assertEtherscanCalls(calls, FREE, KEY);
    const routed = events.find((each) => each.type === "verify.routed");
    assert.ok(routed !== undefined && JSON.stringify(routed).includes("etherscan-v2"));
    assert.ok(!JSON.stringify(events).includes(KEY));
  });

  it("without a key goes to Sourcify and sends no key (injected fetch)", async () => {
    const { result, calls } = await run(FREE, {});
    assert.equal(result.backend, "sourcify");
    assert.ok(calls.every((call) => call.url.host === "sourcify.dev"));
  });

  it("without a key and without fetch goes to Sourcify, no missing-api-key", async () => {
    const { result, calls } = await run(FREE, {}, true);
    assert.equal(result.backend, "sourcify");
    assert.ok(calls.every((call) => call.url.host === "sourcify.dev"));
  });

  it("apiKeys for another backend only does not reach Etherscan", async () => {
    const { result, calls } = await run(FREE, { apiKeys: { routescan: KEY } });
    assert.equal(result.backend, "sourcify");
    assertNoKey(calls, KEY);
  });

  it("route.backend sourcify with an Etherscan key goes to Sourcify and sends no key", async () => {
    const { result, calls } = await run(FREE, {
      apiKeys: { "etherscan-v2": KEY },
      route: { backend: "sourcify" },
    });
    assert.equal(result.backend, "sourcify");
    assertNoKey(calls, KEY);
  });
});

describe("#122 paid-plan chain", () => {
  it("with a key still goes to Sourcify and sends no key", async () => {
    const { result, calls } = await run(PAID, { apiKeys: { "etherscan-v2": KEY } });
    assert.equal(result.backend, "sourcify");
    assertNoKey(calls, KEY);
  });

  it('route.backend "etherscan-v2" with apiKeys goes to Etherscan with the key and explorerUrl', async () => {
    const { result, calls } = await run(PAID, {
      apiKeys: { "etherscan-v2": KEY },
      route: { backend: "etherscan-v2" },
    });
    assert.equal(result.backend, "etherscan-v2");
    assert.equal(result.status, "already-verified");
    assert.equal(result.explorerUrl, `https://${String(explorerOf(PAID))}/address/${ADDRESS}#code`);
    assert.equal(explorerOf(PAID), "sepolia.basescan.org");
    assertEtherscanCalls(calls, PAID, KEY);
  });

  it('route.backend "etherscan-v2" without a key and without fetch throws missing-api-key before any request', async () => {
    const f = fake();
    mock.method(globalThis, "fetch", f.fetch);
    const error = await errorOf(verify(makeInput(PAID), { route: { backend: "etherscan-v2" } }));
    assert.equal(error.code, "missing-api-key");
    assert.equal(f.calls.length, 0);
  });

  it('route.backend "etherscan-v2" without a key, with a proxy fetch, sends no key (server handler case)', async () => {
    const { result, calls } = await run(PAID, { route: { backend: "etherscan-v2" } });
    assert.equal(result.backend, "etherscan-v2");
    for (const call of calls) {
      assert.equal(new URLSearchParams(call.body).get("apikey"), null);
    }
  });
});

describe("#122 every chainlist row", () => {
  const rows = table.chains.filter((row) =>
    row.backends.some((each) => each.backend === "etherscan-v2"),
  );
  it("has 57 rows: 46 Etherscan-first, 11 Sourcify-first", () => {
    assert.equal(rows.length, 57);
    assert.equal(rows.filter((row) => row.backends[0]?.backend === "etherscan-v2").length, 46);
    assert.equal(rows.filter((row) => row.backends[0]?.backend === "sourcify").length, 11);
  });
  for (const row of rows) {
    const first = row.backends[0]?.backend;
    it(`chain ${String(row.chainId)} with a key routes to ${String(first)}`, async () => {
      const { result, calls } = await run(row.chainId, { apiKeys: { "etherscan-v2": KEY } });
      assert.equal(result.backend, first);
      if (first === "etherscan-v2") {
        assertEtherscanCalls(calls, row.chainId, KEY);
        assert.equal(
          result.status !== "failed" ? result.explorerUrl : undefined,
          `https://${String(explorerOf(row.chainId))}/address/${ADDRESS}#code`,
        );
      } else {
        assertNoKey(calls, KEY);
      }
    });
  }
});

describe("#122 a chain without an Etherscan entry", () => {
  it("apiKeys alone goes to Sourcify, no key", async () => {
    const { result, calls } = await run(NO_ETHERSCAN, { apiKeys: { "etherscan-v2": KEY } });
    assert.equal(result.backend, "sourcify");
    assertNoKey(calls, KEY);
  });
  it('route.backend "etherscan-v2" throws unsupported-chain and sends nothing', async () => {
    const f = fake();
    const error = await errorOf(
      verify(makeInput(NO_ETHERSCAN), {
        fetch: f.fetch,
        apiKeys: { "etherscan-v2": KEY },
        route: { backend: "etherscan-v2" },
      }),
    );
    assert.equal(error.code, "unsupported-chain");
    assert.equal(f.calls.length, 0);
    assert.ok(!inspect(error).includes(KEY));
  });
});

describe("#122 route.apiUrl overrides keep the 0016/0023 key rules", () => {
  it("apiUrl = the table's own Etherscan URL: apiKeys not sent (proxy fetch), explorerUrl kept", async () => {
    const { result, calls } = await run(FREE, {
      apiKeys: { "etherscan-v2": KEY },
      route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" },
    });
    assert.equal(result.backend, "etherscan-v2");
    assertNoKey(calls, KEY);
    assert.equal(
      result.status !== "failed" ? result.explorerUrl : undefined,
      `https://sepolia.etherscan.io/address/${ADDRESS}#code`,
    );
  });

  it("apiUrl = the table URL, apiKeys only, no fetch: missing-api-key, nothing sent", async () => {
    const f = fake();
    mock.method(globalThis, "fetch", f.fetch);
    const error = await errorOf(
      verify(makeInput(FREE), {
        apiKeys: { "etherscan-v2": KEY },
        route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" },
      }),
    );
    assert.equal(error.code, "missing-api-key");
    assert.equal(f.calls.length, 0);
    assert.ok(!inspect(error).includes(KEY));
  });

  it("apiUrl elsewhere with apiKeys: the key never reaches the other host", async () => {
    const { calls, result } = await run(FREE, {
      apiKeys: { "etherscan-v2": KEY },
      route: { backend: "etherscan-v2", apiUrl: "https://proxy.example.org/v2/api" },
    });
    assert.ok(calls.every((call) => call.url.host === "proxy.example.org"));
    assertNoKey(calls, KEY);
    assert.ok(result.status === "failed" || result.explorerUrl === undefined);
  });

  it("apiUrl elsewhere with route.apiKey: route key goes there in the body; apiKeys key never", async () => {
    const { calls, result } = await run(PAID, {
      apiKeys: { "etherscan-v2": KEY },
      route: {
        backend: "etherscan-v2",
        apiUrl: "https://proxy.example.org/v2/api",
        apiKey: ROUTE_KEY,
      },
    });
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(call.url.host, "proxy.example.org");
      assert.equal(new URLSearchParams(call.body).get("apikey"), ROUTE_KEY);
      assert.ok(!call.url.href.includes(ROUTE_KEY));
      assert.equal(call.url.searchParams.get("chainid"), String(PAID));
    }
    assertNoKey(calls, KEY);
    assert.ok(result.status === "failed" || result.explorerUrl === undefined);
  });

  it("route.apiKey without apiUrl throws invalid-input and sends nothing", async () => {
    const f = fake();
    const error = await errorOf(
      verify(makeInput(FREE), {
        fetch: f.fetch,
        route: { backend: "etherscan-v2", apiKey: ROUTE_KEY },
      }),
    );
    assert.equal(error.code, "invalid-input");
    assert.equal(f.calls.length, 0);
    assert.ok(!inspect(error).includes(ROUTE_KEY));
  });
});
