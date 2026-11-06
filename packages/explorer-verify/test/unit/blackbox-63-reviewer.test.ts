// Black-box review tests for #63: the etherscan-compatible backend, reached only through the
// public verify() and checkStatus(), with a fake fetch. Dummy keys only, no network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError, checkStatus, verify } from "../../src/index.ts";
import type { VerifyEvent, VerifyInput, VerifyOptions } from "../../src/types.ts";
import { jsKeys } from "../helpers/js-keys.ts";

const CHAIN = 296;
const ADDRESS = "0x80798fed44d6ec40d283bd44ddb08a6eb2d30be5";
const GUID = "cqmxkhtaudvs5yhbzgv5nryiczguab4g3ppjj6mb3gakhzxjcn";
const API = "https://explorer.example.org/api";
const ROUTE_KEY = "dummyRouteKeyBB63aa";
const ETHERSCAN_KEY = "dummyEtherscanKeyCC63";
const ROUTESCAN_KEY = "dummyRoutescanKeyDD63";
const ALL_KEYS = [ROUTE_KEY, ETHERSCAN_KEY, ROUTESCAN_KEY];

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: URLSearchParams;
  redirect: string | undefined;
}

type Reply = (sent: Sent) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const notVerified: Reply = () =>
  json({ status: "1", message: "OK", result: [{ SourceCode: "", ABI: "x" }] });
const verifiedExact: Reply = () =>
  json({ status: "1", message: "OK", result: [{ SourceCode: "contract A {}", ABI: "[]" }] });
const submitted: Reply = () => json({ status: "1", message: "OK", result: GUID });
const pass: Reply = () => json({ status: "1", message: "OK", result: "Pass - Verified" });
const text =
  (result: string, status = "0"): Reply =>
  () =>
    json({ status, message: "NOTOK", result });
const v1: Reply = text(
  "You are using a deprecated V1 endpoint, switch to Etherscan API V2 using https://docs.etherscan.io/v2-migration",
);

/** A fake fetch that answers in order and records every request. */
function fakeFetch(...replies: Reply[]): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const queue = [...replies];
  const impl = async (resource: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof resource === "string"
        ? resource
        : resource instanceof URL
          ? resource.href
          : resource.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const raw = init?.body;
    const body = new URLSearchParams(
      raw instanceof URLSearchParams ? raw.toString() : typeof raw === "string" ? raw : "",
    );
    const one: Sent = {
      url,
      method: init?.method ?? "GET",
      headers,
      body,
      redirect: init?.redirect,
    };
    sent.push(one);
    const next = queue.shift();
    assert.ok(next !== undefined, `unexpected extra request to ${url}`);
    return await Promise.resolve(next(one));
  };
  return { fetch: impl, sent };
}

function input(chainId = CHAIN): VerifyInput {
  return {
    chainId,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "src/A.sol": { content: "contract A {}" } },
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
    contractName: "src/A.sol:A",
  };
}

function recorder(): {
  options: Pick<VerifyOptions, "logger" | "onEvent">;
  lines: string[];
  events: VerifyEvent[];
} {
  const lines: string[] = [];
  const events: VerifyEvent[] = [];
  const record = (message: string, fields?: unknown): void => {
    lines.push(`${message} ${JSON.stringify(fields)}`);
  };
  return {
    lines,
    events,
    options: {
      logger: { debug: record, info: record, warn: record, error: record },
      onEvent: (event) => {
        events.push(event);
      },
    },
  };
}

function assertNoKeyIn(haystack: string, keys: readonly string[] = ALL_KEYS): void {
  for (const key of keys) {
    assert.equal(haystack.includes(key), false, "a key leaked");
  }
}

/** Every key-carrying place of a request other than the form body. */
function assertKeyOnlyInBody(sent: Sent, expected: string | undefined): void {
  assertNoKeyIn(sent.url);
  assertNoKeyIn(JSON.stringify(sent.headers));
  assert.equal(sent.headers["apikey"], undefined);
  assert.equal(sent.body.get("apikey") ?? undefined, expected);
  const others = ALL_KEYS.filter((key) => key !== expected);
  assertNoKeyIn(sent.body.toString(), others);
}

async function rejection(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ExplorerVerifyError, String(error));
    return error;
  }
  throw new Error("expected a rejection");
}

function errorText(error: ExplorerVerifyError): string {
  return [
    error.message,
    error.hint ?? "",
    String(error.stack),
    JSON.stringify(error),
    JSON.stringify(error.details),
  ].join("\n");
}

describe("blackbox #63: key binding through verify() and checkStatus()", () => {
  it("the route key reaches only route.apiUrl, only in the body; apiKeys never do; query kept", async () => {
    const apiUrl = `${API}?team=a1&mode=x`;
    const fake = fakeFetch(notVerified, submitted, pass);
    const rec = recorder();
    const result = await verify(input(), {
      fetch: fake.fetch,
      pollIntervalMs: 1_000,
      route: { backend: "etherscan-compatible", apiUrl, apiKey: ROUTE_KEY },
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY },
      ...rec.options,
    });
    assert.equal(result.status, "verified");
    assert.equal(result.backend, "etherscan-compatible");
    assert.equal("explorerUrl" in result, false);
    assert.deepEqual(
      fake.sent.map((sent) => sent.body.get("action")),
      ["getsourcecode", "verifysourcecode", "checkverifystatus"],
    );
    for (const sent of fake.sent) {
      assert.equal(sent.url, apiUrl, "query kept as written, nothing added");
      assert.equal(new URL(sent.url).searchParams.has("chainid"), false);
      assert.equal(sent.body.has("chainid"), false);
      assert.equal(sent.method, "POST");
      assert.equal(sent.redirect, "manual");
      assertKeyOnlyInBody(sent, ROUTE_KEY);
    }
    assertNoKeyIn(JSON.stringify([rec.events, rec.lines, result]));
  });

  it("apiKeys for etherscan-v2 and routescan never reach an etherscan-compatible route", async () => {
    const fake = fakeFetch(verifiedExact);
    const result = await verify(input(), {
      fetch: fake.fetch,
      route: { backend: "etherscan-compatible", apiUrl: API },
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY },
    });
    assert.equal(result.status, "already-verified");
    assert.equal(fake.sent.length, 1);
    const [sent] = fake.sent;
    assert.ok(sent !== undefined);
    assertKeyOnlyInBody(sent, undefined);
    // A keyless lookup is a GET to the API with its fields in the query (decision 0039).
    assert.equal(sent.url.split("?")[0], API);
  });

  it("apiKeys['etherscan-compatible'] throws invalid-input before any request, without the key", async () => {
    const fake = fakeFetch();
    const error = await rejection(
      verify(input(), {
        fetch: fake.fetch,
        route: { backend: "etherscan-compatible", apiUrl: API },
        apiKeys: jsKeys("etherscan-compatible", ROUTE_KEY),
      }),
    );
    assert.equal(error.code, "invalid-input");
    assert.equal(fake.sent.length, 0);
    assertNoKeyIn(errorText(error));
  });

  it("route.apiKey without route.apiUrl, on a chain whose row lists no standalone host, throws unsupported-chain without the key", async () => {
    // Decision 0039: without apiUrl the key is bound to the row's standalone host; 296 has none.
    const fake = fakeFetch();
    const error = await rejection(
      verify(input(), {
        fetch: fake.fetch,
        route: { backend: "etherscan-compatible", apiKey: ROUTE_KEY },
      }),
    );
    assert.equal(error.code, "unsupported-chain");
    assert.equal(fake.sent.length, 0);
    assertNoKeyIn(errorText(error));
  });

  it("route.backend etherscan-compatible without apiUrl throws unsupported-chain, no request", async () => {
    const fake = fakeFetch();
    const error = await rejection(
      verify(input(), { fetch: fake.fetch, route: { backend: "etherscan-compatible" } }),
    );
    assert.equal(error.code, "unsupported-chain");
    assert.equal(fake.sent.length, 0);
  });

  it("a redirect is not followed and the key goes nowhere else", async () => {
    const fake = fakeFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://evil.example/steal?k=${ROUTE_KEY}` },
        }),
    );
    const error = await rejection(
      verify(input(), {
        fetch: fake.fetch,
        route: { backend: "etherscan-compatible", apiUrl: API, apiKey: ROUTE_KEY },
      }),
    );
    assert.equal(error.code, "unexpected-response");
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0]?.url, API);
    assertNoKeyIn(errorText(error));
  });

  it("an explorer that echoes the key in an unknown answer: the error holds no key", async () => {
    const fake = fakeFetch(text(`weird answer for ${ROUTE_KEY} and ${ETHERSCAN_KEY}`, "1"));
    const rec = recorder();
    const error = await rejection(
      verify(input(), {
        fetch: fake.fetch,
        route: { backend: "etherscan-compatible", apiUrl: API, apiKey: ROUTE_KEY },
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
        ...rec.options,
      }),
    );
    assert.equal(error.code, "unexpected-response");
    assertNoKeyIn(errorText(error));
    assertNoKeyIn(JSON.stringify([rec.events, rec.lines]));
  });

  it("checkStatus() polls route.apiUrl with the route key in the body only", async () => {
    const fake = fakeFetch(pass);
    const rec = recorder();
    const result = await checkStatus(
      `ev1:etherscan-compatible:${String(CHAIN)}:${ADDRESS}:${GUID}`,
      {
        fetch: fake.fetch,
        route: { backend: "etherscan-compatible", apiUrl: API, apiKey: ROUTE_KEY },
        apiKeys: { "etherscan-v2": ETHERSCAN_KEY, routescan: ROUTESCAN_KEY },
        ...rec.options,
      },
    );
    assert.equal(result.status, "verified");
    assert.equal("explorerUrl" in result, false);
    assert.equal(fake.sent.length, 1);
    const [sent] = fake.sent;
    assert.ok(sent !== undefined);
    assert.equal(sent.url, API);
    assert.equal(sent.body.get("guid"), GUID);
    assertKeyOnlyInBody(sent, ROUTE_KEY);
    assertNoKeyIn(JSON.stringify([rec.events, rec.lines, result]));
  });

  it("checkStatus() of an etherscan-compatible handle on an etherscan-v2 route sends no key", async () => {
    const fake = fakeFetch();
    const error = await rejection(
      checkStatus(`ev1:etherscan-compatible:${String(CHAIN)}:${ADDRESS}:${GUID}`, {
        fetch: fake.fetch,
        route: { backend: "etherscan-v2", apiUrl: API, apiKey: ROUTE_KEY },
      }),
    );
    assert.ok(fake.sent.every((sent) => !sent.body.has("apikey")));
    assertNoKeyIn(errorText(error));
  });
});

describe("blackbox #63: answer mapping through checkStatus()", () => {
  const route = { backend: "etherscan-compatible" as const, apiUrl: API };
  const handle = `ev1:etherscan-compatible:${String(CHAIN)}:${ADDRESS}:${GUID}`;

  it("an unknown job state throws, never verified or failed", async () => {
    const fake = fakeFetch(text("Something new", "1"));
    const error = await rejection(checkStatus(handle, { fetch: fake.fetch, route }));
    assert.equal(error.code, "unknown-state");
  });

  it("a non-JSON 200 never reads as a verdict: not-confirmed after the lookup", async () => {
    const fake = fakeFetch(() => new Response("<html>ok</html>", { status: 200 }));
    const error = await rejection(
      checkStatus(handle, { fetch: fake.fetch, route, timeoutMs: 3_000 }),
    );
    assert.equal(error.code, "not-confirmed");
  });

  it("Fail with a lookup that is not verified is failed; with an exact lookup is verified", async () => {
    const failed = await checkStatus(handle, {
      fetch: fakeFetch(text("Fail - Unable to verify. Bytecode mismatch"), notVerified).fetch,
      route,
    });
    assert.equal(failed.status, "failed");
    const verified = await checkStatus(handle, {
      fetch: fakeFetch(text("Fail - Unable to verify"), verifiedExact).fetch,
      route,
    });
    assert.equal(verified.status, "verified");
  });

  it("Fail with an unreadable lookup ends not-confirmed, never failed", async () => {
    const fake = fakeFetch(text("Fail - Unable to verify"), text("odd", "1"));
    const error = await rejection(
      checkStatus(handle, { fetch: fake.fetch, route, timeoutMs: 3_000 }),
    );
    assert.equal(error.code, "not-confirmed");
  });

  it("key answers map to the key codes, naming etherscan-compatible", async () => {
    const cases: [string, string][] = [
      ["Missing/Invalid API Key", "missing-api-key"],
      ["Invalid API Key (#err2)|1", "api-key-rejected"],
      ["Max daily rate limit reached. 100000 (100%) of 100000 day/limit", "quota-exceeded"],
    ];
    for (const [answer, code] of cases) {
      const error = await rejection(
        checkStatus(handle, { fetch: fakeFetch(text(answer)).fetch, route }),
      );
      assert.equal(error.code, code);
      assert.equal(Reflect.get(error.details, "backend"), "etherscan-compatible");
    }
  });

  it("an unknown job maps to job-not-found, then the flow looks the contract up", async () => {
    const fake = fakeFetch(text("Unable to locate guid"), verifiedExact);
    const result = await checkStatus(handle, { fetch: fake.fetch, route });
    assert.equal(result.status, "verified");
    assert.equal(fake.sent.length, 2);
  });
});

describe("blackbox #63: the deprecated V1 answer on every Etherscan-style backend", () => {
  for (const backend of ["etherscan-compatible", "etherscan-v2", "routescan"] as const) {
    it(`${backend}: unexpected-response with the etherscan-v2 hint, never failed, no submit`, async () => {
      const fake = fakeFetch(v1);
      const error = await rejection(
        verify(input(), {
          fetch: fake.fetch,
          route: { backend, apiUrl: "https://api-sepolia.basescan.org/api", apiKey: ROUTE_KEY },
        }),
      );
      assert.equal(error.code, "unexpected-response");
      assert.equal(Reflect.get(error.details, "backend"), backend);
      assert.match(error.message, /deprecated v1 API/u);
      assert.equal(error.hint, "Use the etherscan-v2 backend without route.apiUrl.");
      assert.equal(fake.sent.length, 1);
      assertNoKeyIn(errorText(error));
    });
  }
});

describe("blackbox #63: etherscan-v2 table route unchanged", () => {
  it("POSTs to api.etherscan.io/v2/api?chainid=<id> with the apiKeys key in the body", async () => {
    const fake = fakeFetch(verifiedExact);
    const result = await verify(input(11155111), {
      fetch: fake.fetch,
      route: { backend: "etherscan-v2" },
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
    });
    assert.equal(result.status, "already-verified");
    const [sent] = fake.sent;
    assert.ok(sent !== undefined);
    assert.equal(sent.url, "https://api.etherscan.io/v2/api?chainid=11155111");
    assertKeyOnlyInBody(sent, ETHERSCAN_KEY);
  });
});
