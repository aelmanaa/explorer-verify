// Standalone Etherscan-compatible entries in the routing table (#170, decision 0039): the schema 3
// entry and its derivation, the shipped Bitlayer row, how route.apiKey binds to a table host, and
// the missing-key check for an entry that needs a key (R-RT-1, R-RT-2, R-BE-2, R-SEC-1, R-SEC-2).
// Every request goes to a fake fetch; Bitlayer's answers are recorded in
// test/fixtures/etherscan-compatible/.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { Context } from "../../src/backends/backend.ts";
import { etherscanCompatible } from "../../src/backends/etherscan-compatible.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { DEFAULT_DEPENDENCIES, DEFAULT_LINK_DEPENDENCIES } from "../../src/flow/defaults.ts";
import { keyFor, keyMissing, requireKey } from "../../src/http/api-keys.ts";
import { linkProxy, verify } from "../../src/index.ts";
import { tableTarget } from "../../src/routing/resolve.ts";
import type { RoutingTable, TableEntry } from "../../src/routing/resolve.ts";
import { ROUTING_TABLE } from "../../src/routing/table.ts";
import type { Hex, VerifyInput } from "../../src/types.ts";
import { runLinkProxy, runVerify, runVerifyEach } from "../helpers/defaults.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import type { Call } from "../helpers/fake-fetch.ts";
import { jsKeys } from "../helpers/js-keys.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { resolveRoute } from "../helpers/route.ts";

const BITLAYER = 200_901;
const BITLAYER_API = "https://api.btrscan.com/scan/api";
const KEYED_CHAIN = 1116;
const KEYED_API = "https://openapi.example.org/api";
const ADDRESS: Hex = "0x80798fEd44d6ec40d283bD44DDb08A6Eb2d30BE5";
const LOWER: Hex = "0x80798fed44d6ec40d283bd44ddb08a6eb2d30be5";
const GUID = "cqmxkhtaudvs5yhbzgv5nryiczguab4g3ppjj6mb3gakhzxjcn";
// Made-up keys. Never real ones (R-SEC-1).
const ROUTE_KEY = "standalone-dummy-key-170a";
const ETHERSCAN_KEY = "etherscan-dummy-key-170b";

const STANDALONE: TableEntry = {
  backend: "etherscan-compatible",
  api: "api.btrscan.com/scan/api",
  explorer: "www.btrscan.com",
};
const KEYED: TableEntry = {
  backend: "etherscan-compatible",
  api: "openapi.example.org/api",
  needsKey: true,
};

/** A test table: a keyed standalone host alone, and one after Sourcify. */
const TABLE: RoutingTable = {
  schemaVersion: 3,
  checked: "2026-11-05",
  chains: [
    { chainId: KEYED_CHAIN, backends: [KEYED] },
    { chainId: 8217, backends: [{ backend: "sourcify" }, { ...KEYED }] },
    { chainId: BITLAYER, backends: [STANDALONE] },
  ],
};

function input(chainId: number): VerifyInput {
  return {
    chainId,
    address: ADDRESS,
    contractName: "src/A.sol:A",
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "src/A.sol": { content: "contract A {}" } },
        settings: {},
      },
    },
  };
}

function thrown(run: () => unknown): ExplorerVerifyError {
  try {
    run();
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError, `threw ${String(error)}`);
    return error;
  }
  return assert.fail("no error thrown");
}

async function rejection(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const outcome: unknown = await promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
  assert.ok(outcome instanceof ExplorerVerifyError, `expected an error, got ${String(outcome)}`);
  return outcome;
}

function errorText(error: ExplorerVerifyError): string {
  return `${error.message} ${error.hint} ${JSON.stringify(error)}`;
}

/** The fields of a request: the query of a GET, the form body of a POST. */
function fields(call: Call | undefined): URLSearchParams {
  assert.ok(call !== undefined, "no such request");
  return call.method === "GET"
    ? new URL(call.url).searchParams
    : new URLSearchParams(call.body ?? "");
}

const bitlayer = (name: string) =>
  loadFixture("etherscan-compatible", `2026-11-05-bitlayer-${name}`);
/** Etherscan's recorded answer in `test/fixtures/etherscan/<name>.json`: the same API. */
function etherscan(name: string): Response {
  const url = new URL(`../fixtures/etherscan/${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null);
  const response: unknown = Reflect.get(parsed, "response");
  assert.ok(typeof response === "object" && response !== null);
  const status: unknown = Reflect.get(response, "status");
  assert.ok(typeof status === "number");
  return new Response(JSON.stringify(Reflect.get(response, "body")), { status });
}

describe("tableTarget: the etherscan-compatible entry (schema 3, decision 0039)", () => {
  it("derives the API base from api and the page from explorer (R-RT-1, R-FLOW-3)", () => {
    const target = tableTarget(BITLAYER, STANDALONE) ?? assert.fail("no target");
    assert.equal(target.backend, "etherscan-compatible");
    assert.equal(target.apiUrl, BITLAYER_API);
    assert.equal(target.explorerUrl?.(ADDRESS), `https://www.btrscan.com/address/${ADDRESS}#code`);
    assert.equal(target.needsKey, false);
  });

  it("copies needsKey, and has no page without explorer", () => {
    const target = tableTarget(KEYED_CHAIN, KEYED) ?? assert.fail("no target");
    assert.equal(target.apiUrl, KEYED_API);
    assert.equal(target.explorerUrl, undefined);
    assert.equal(target.needsKey, true);
  });

  it("routes no entry without api, so its host gets no request", () => {
    assert.equal(tableTarget(BITLAYER, { backend: "etherscan-compatible" }), undefined);
    const table: RoutingTable = {
      ...TABLE,
      chains: [{ chainId: BITLAYER, backends: [{ backend: "etherscan-compatible" }] }],
    };
    assert.equal(
      thrown(() => resolveRoute(BITLAYER, undefined, { table })).code,
      "unsupported-chain",
    );
  });
});

describe("the shipped Bitlayer row (#170, R-RT-1)", () => {
  it("resolves 200901 to its standalone host without a route option", () => {
    const row = ROUTING_TABLE.chains.find((each) => each.chainId === BITLAYER);
    assert.deepEqual(row?.backends, [STANDALONE]);
    const route = resolveRoute(BITLAYER);
    assert.equal(route.backend, "etherscan-compatible");
    assert.equal(route.apiBase, BITLAYER_API);
    assert.equal(route.tableHost, "api.btrscan.com");
    assert.equal(route.overridden, false);
    assert.equal(route.needsKey, false);
    // A standalone host serves one chain: no chainid in the query.
    assert.equal(route.requestUrl(""), BITLAYER_API);
    assert.equal(route.explorerUrl?.(ADDRESS), `https://www.btrscan.com/address/${ADDRESS}#code`);
  });

  it("verify() on 200901 looks up with a keyless GET, submits with a POST and reports the page (R-BE-2, R-FLOW-3)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const fake = replay(
      bitlayer("getsourcecode-get-not-verified"),
      etherscan("2026-11-03-verifysourcecode-factory-child"),
      etherscan("2026-11-03-checkverifystatus-factory-child-02-pass"),
    );
    const running = verify(input(BITLAYER), {
      fetch: fake.fetch,
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
    });
    await driveMockClock(running, () => {
      t.mock.timers.runAll();
    });
    const result = await running;
    assert.deepEqual(result, {
      status: "verified",
      backend: "etherscan-compatible",
      match: "exact",
      explorerUrl: `https://www.btrscan.com/address/${ADDRESS.toLowerCase()}#code`,
    });
    assert.deepEqual(
      fake.calls.map((call) => [call.method, call.url.split("?")[0], fields(call).get("action")]),
      [
        ["GET", BITLAYER_API, "getsourcecode"],
        ["POST", BITLAYER_API, "verifysourcecode"],
        ["GET", BITLAYER_API, "checkverifystatus"],
      ],
    );
    // No key reaches the standalone host: apiKeys never holds one for it (R-SEC-2).
    for (const call of fake.calls) {
      assert.equal(fields(call).has("apikey"), false);
      assert.ok(!JSON.stringify([call.url, call.body]).includes(ETHERSCAN_KEY));
    }
  });

  it("Bitlayer refuses a POST lookup, which the client no longer sends keyless (live, 2026-11-05)", async () => {
    // The recorded answer to the POST that the client sent before #170: not an Etherscan answer.
    const fake = replay(bitlayer("getsourcecode-post-refused"));
    const error = await rejection(verify(input(BITLAYER), { fetch: fake.fetch }));
    assert.equal(error.code, "unexpected-response");
    assert.equal(fake.calls[0]?.method, "GET");
  });

  it("an unknown job on Bitlayer is not read as a verdict (R-FLOW-4)", async () => {
    const fake = replay(bitlayer("checkverifystatus-unknown-guid"));
    const ctx: Context = {
      route: resolveRoute(BITLAYER),
      http: { backend: "etherscan-compatible", fetch: fake.fetch, secrets: [] },
    };
    const error = await rejection(
      etherscanCompatible.poll(
        {
          version: 1,
          backend: "etherscan-compatible",
          chainId: BITLAYER,
          address: LOWER,
          jobId: GUID,
        },
        ctx,
      ),
    );
    assert.equal(error.code, "unexpected-response");
    assert.equal(fake.calls[0]?.method, "GET");
    assert.equal(fields(fake.calls[0]).get("guid"), GUID);
  });

  it("refuses route.apiKey for Bitlayer, whose entry takes no key, before any request (decision 0039)", async () => {
    // A keyed lookup is a form POST, which Bitlayer refuses with code 4405. The key is refused
    // first, so the recorded refusal is never reached.
    const fake = replay(bitlayer("getsourcecode-post-refused"));
    const error = await rejection(
      verify(input(BITLAYER), {
        fetch: fake.fetch,
        route: { backend: "etherscan-compatible", apiKey: ROUTE_KEY },
      }),
    );
    assert.deepEqual(error.details, {
      code: "invalid-input",
      issues: [
        { field: "route.apiKey", message: "is not accepted: this explorer takes no API key" },
      ],
    });
    assert.equal(
      error.hint,
      "The routing table's explorer for this chain takes no key, so leave out route.apiKey.",
    );
    assert.equal(fake.calls.length, 0);
    assert.ok(!errorText(error).includes(ROUTE_KEY));
    // With route.apiUrl, the key is bound to that host as before.
    const route = resolveRoute(BITLAYER, {
      backend: "etherscan-compatible",
      apiUrl: BITLAYER_API,
      apiKey: ROUTE_KEY,
    });
    assert.equal(route.apiKey(), ROUTE_KEY);
  });

  it("linkProxy() refuses Bitlayer's table entry on route.backend before any request, and allows route.apiUrl", async () => {
    const target = {
      chainId: BITLAYER,
      address: LOWER,
      expectedImplementation: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    } as const;
    for (const route of [undefined, { backend: "etherscan-compatible" }] as const) {
      const fake = replay();
      const error = await rejection(
        linkProxy(target, { fetch: fake.fetch, ...(route === undefined ? {} : { route }) }),
      );
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [{ field: "route.backend", message: "etherscan-compatible cannot link a proxy" }],
      });
      assert.match(error.hint, /etherscan-compatible with the explorer's route\.apiUrl/);
      assert.equal(fake.calls.length, 0);
    }
    // With route.apiUrl, the link request goes out; this answer ends it at once.
    const fake = replay(bitlayer("getsourcecode-post-refused"));
    await rejection(
      runLinkProxy(
        target,
        { fetch: fake.fetch, route: { backend: "etherscan-compatible", apiUrl: BITLAYER_API } },
        DEFAULT_LINK_DEPENDENCIES,
      ),
    );
    assert.equal(fake.calls.length, 1);
  });

  it("a keyless call to 200901 runs no missing-key check (decision 0016)", () => {
    const route = resolveRoute(BITLAYER);
    assert.equal(keyMissing({ route }, false), false);
  });
});

describe("a standalone entry that needs a key (#170, decision 0039)", () => {
  it("is skipped without a key when the row lists another backend (R-RT-1)", () => {
    const route = resolveRoute(8217, undefined, { table: TABLE });
    assert.equal(route.backend, "sourcify");
  });

  it("is taken when it is the only backend, and fails with missing-api-key before any request (R-SEC-2)", async (t) => {
    const route = resolveRoute(KEYED_CHAIN, undefined, { table: TABLE });
    assert.equal(route.backend, "etherscan-compatible");
    assert.equal(route.needsKey, true);
    const error = thrown(() => {
      requireKey({ route }, false, []);
    });
    assert.deepEqual(error.details, { code: "missing-api-key", backend: "etherscan-compatible" });
    assert.equal(
      error.message,
      "etherscan-compatible needs an API key and none is set for openapi.example.org: set route.apiKey.",
    );
    // Through verify(), with the default fetch: no request goes out.
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response("{}"));
    const thrownByVerify = await rejection(
      runVerify(input(KEYED_CHAIN), {}, { ...DEFAULT_DEPENDENCIES, table: TABLE }),
    );
    assert.equal(thrownByVerify.code, "missing-api-key");
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("names route.apiKey in the missing-key message for an override too", () => {
    const route = resolveRoute(
      KEYED_CHAIN,
      { backend: "etherscan-compatible", apiUrl: KEYED_API },
      { table: TABLE },
    );
    assert.equal(route.overridden, true);
    assert.equal(route.needsKey, true);
    const error = thrown(() => {
      requireKey({ route }, false, []);
    });
    assert.match(error.message, /: set route\.apiKey\.$/);
    // Another host than the table's: the table's needsKey does not apply.
    const other = resolveRoute(
      KEYED_CHAIN,
      { backend: "etherscan-compatible", apiUrl: "https://other.example.org/api" },
      { table: TABLE },
    );
    assert.equal(other.needsKey, false);
  });

  it("with an injected fetch, a keyed row still throws missing-api-key before any request (decision 0046)", async () => {
    const fake = replay(bitlayer("getsourcecode-post-refused"));
    const error = await rejection(
      runVerify(
        input(KEYED_CHAIN),
        { fetch: fake.fetch },
        { ...DEFAULT_DEPENDENCIES, table: TABLE },
      ),
    );
    assert.equal(error.code, "missing-api-key");
    assert.equal(fake.calls.length, 0);
  });

  it("handlerUrl does not cover a standalone explorer: its keyed row still needs route.apiKey (decision 0046)", async () => {
    const fake = replay(bitlayer("getsourcecode-post-refused"));
    const error = await rejection(
      runVerify(
        input(KEYED_CHAIN),
        {
          fetch: fake.fetch,
          handlerUrl: "https://dapp.example/api/verify",
          route: { backend: "etherscan-compatible" },
        },
        { ...DEFAULT_DEPENDENCIES, table: TABLE },
      ),
    );
    assert.equal(error.code, "missing-api-key");
    assert.equal(fake.calls.length, 0);
  });

  it("route.apiKey with route.backend etherscan-compatible and no apiUrl binds the key to the row's host (R-SEC-2)", async () => {
    const route = resolveRoute(
      KEYED_CHAIN,
      { backend: "etherscan-compatible", apiKey: ROUTE_KEY },
      { table: TABLE },
    );
    assert.equal(route.apiBase, KEYED_API);
    assert.equal(route.overridden, false);
    assert.equal(route.apiKey(), ROUTE_KEY);
    assert.equal(keyFor({ route }, "etherscan-compatible", KEYED_API), ROUTE_KEY);
    // Never to another origin, and never with another backend's request.
    assert.equal(
      keyFor({ route }, "etherscan-compatible", "https://other.example.org/api"),
      undefined,
    );
    assert.equal(keyFor({ route }, "etherscan-v2", KEYED_API), undefined);
    assert.equal(keyMissing({ route }, false), false);

    const fake = replay(etherscan("2026-11-03-getsourcecode-factory-child-verified"));
    const result = await runVerify(
      input(KEYED_CHAIN),
      { fetch: fake.fetch, route: { backend: "etherscan-compatible", apiKey: ROUTE_KEY } },
      { ...DEFAULT_DEPENDENCIES, table: TABLE },
    );
    assert.equal(result.status, "already-verified");
    const [call] = fake.calls;
    // With a key, the lookup is a form POST: the key is in the body, never the URL (R-SEC-1).
    assert.equal(call?.method, "POST");
    assert.equal(call.url, KEYED_API);
    assert.equal(new URLSearchParams(call.body).get("apikey"), ROUTE_KEY);
  });

  it("route.apiKey without apiUrl on a chain whose row lists no standalone host throws unsupported-chain, without the key", () => {
    for (const chainId of [8453, 999_999]) {
      const error = thrown(() =>
        resolveRoute(
          chainId,
          { backend: "etherscan-compatible", apiKey: ROUTE_KEY },
          { table: TABLE },
        ),
      );
      assert.equal(error.code, "unsupported-chain");
      assert.ok(!errorText(error).includes(ROUTE_KEY));
    }
    // With the Sourcify fallback too: the fallback serves only Sourcify.
    const fallback = thrown(() =>
      resolveRoute(
        999_999,
        { backend: "etherscan-compatible", apiKey: ROUTE_KEY },
        { table: TABLE, allowSourcifyFallback: true },
      ),
    );
    assert.equal(fallback.code, "unsupported-chain");
  });

  it("keeps refusing route.apiKey without apiUrl for the other keyed backends, and apiKeys for standalone hosts", async () => {
    for (const backend of ["etherscan-v2", "routescan"] as const) {
      const error = thrown(() => resolveRoute(1, { backend, apiKey: ROUTE_KEY }));
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [
          {
            field: "route.apiKey",
            message: "needs route.apiUrl: the key is sent only to that host",
          },
        ],
      });
      assert.ok(!errorText(error).includes(ROUTE_KEY));
    }
    const fake = replay();
    const error = await rejection(
      verify(input(BITLAYER), {
        fetch: fake.fetch,
        apiKeys: jsKeys("etherscan-compatible", ROUTE_KEY),
      }),
    );
    assert.equal(error.code, "invalid-input");
    assert.equal(fake.calls.length, 0);
  });
});

describe('verifyEach() with "all" and a standalone entry that needs a key (decision 0039)', () => {
  it("leaves the entry out without a key when the row lists another backend, as resolveRoute does", async () => {
    const fake = replay(loadFixture("sourcify", "2026-11-02-lookup-exact-match"));
    const result = await runVerifyEach(
      input(8217),
      { fetch: fake.fetch, backends: "all" },
      { ...DEFAULT_DEPENDENCIES, table: TABLE },
    );
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.backend),
      ["sourcify"],
    );
    assert.ok(fake.calls.every((call) => !call.url.startsWith(KEYED_API)));
  });

  it("keeps it when it is the only backend, and it ends in missing-api-key with no request", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response("{}"));
    const result = await runVerifyEach(
      input(KEYED_CHAIN),
      { backends: "all" },
      { ...DEFAULT_DEPENDENCIES, table: TABLE },
    );
    assert.equal(result.outcomes.length, 1);
    const [outcome] = result.outcomes;
    assert.ok(outcome !== undefined && "error" in outcome);
    assert.equal(outcome.backend, "etherscan-compatible");
    assert.equal(outcome.error.code, "missing-api-key");
    assert.equal(fetch.mock.callCount(), 0);
  });
});

describe("schema 2 tables (decision 0039)", () => {
  it("the resolver reads a schema 2 table as before", () => {
    const table: RoutingTable = {
      schemaVersion: 2,
      checked: "2026-11-03",
      chains: [
        {
          chainId: 11_155_111,
          backends: [
            { backend: "etherscan-v2", explorer: "sepolia.etherscan.io" },
            { backend: "sourcify" },
          ],
        },
      ],
    };
    const keyless = resolveRoute(11_155_111, undefined, { table });
    assert.equal(keyless.backend, "sourcify");
    const keyed = resolveRoute(11_155_111, undefined, {
      table,
      apiKeys: { "etherscan-v2": ETHERSCAN_KEY },
    });
    assert.equal(keyed.backend, "etherscan-v2");
    assert.equal(keyed.needsKey, false);
  });
});
