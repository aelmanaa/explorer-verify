// A free-plan Etherscan key on the chains the Etherscan chainlist marks "Paid Plan required"
// (issue #135, R-BE-1, R-AX-7, R-SEC-1, decision 0027). The answers come from
// test/fixtures/etherscan/2026-11-04-*-paid-plan-*.json, recorded live on 2026-11-04 with a
// free-plan key on Base Sepolia (84532) and Base Mainnet (8453). The lookup and the status poll
// answered as on a free-tier chain. Etherscan's refusal text was recorded for an `account` call
// on 8453; a test that sends it as the answer to a client call says so.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { BackendName } from "../../src/backend-names.ts";
import type { Context } from "../../src/backends/backend.ts";
import { etherscan } from "../../src/backends/etherscan.ts";
import { ERROR_EXIT_CODES } from "../../src/envelope.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { keyErrorOf } from "../../src/http/api-keys.ts";
import { verify } from "../../src/index.ts";
import type { Handle, Hex, VerifyInput } from "../../src/index.ts";
import { replay } from "../helpers/fake-fetch.ts";
import type { Step } from "../helpers/fake-fetch.ts";
import { resolveRoute } from "../helpers/route.ts";

// A made-up key. Never a real one (R-SEC-1).
const KEY = "paidplandummykeyq7w3e9r1t5";
const BASE = 8453;
const BASE_SEPOLIA = 84532;
const DEAD: Hex = "0x000000000000000000000000000000000000dead";
const GUID = "a".repeat(50);
const REFUSAL =
  "Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage. https://etherscan.io/apis";
const HINT =
  'This chain needs a paid Etherscan API plan. Use a key on a paid plan, or verify on Sourcify, which needs no key: set route: { backend: "sourcify" }.';

const INPUT: VerifyInput = {
  chainId: BASE,
  address: DEAD,
  compiler: {
    kind: "solc",
    version: "0.8.24+commit.e11b9ed9",
    input: {
      language: "Solidity",
      sources: { "A.sol": { content: "contract A {}" } },
      settings: { optimizer: { enabled: false, runs: 200 } },
    },
  },
  contractName: "A.sol:A",
  constructorArgs: "0x",
};

/** The recorded body of `test/fixtures/etherscan/2026-11-04-<name>.json`. */
function recorded(name: string): unknown {
  const url = new URL(`../fixtures/etherscan/2026-11-04-${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null);
  const response: unknown = Reflect.get(parsed, "response");
  assert.ok(typeof response === "object" && response !== null);
  assert.equal(Reflect.get(response, "status"), 200);
  return Reflect.get(response, "body");
}

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** The refusal recorded for an `account` call, sent here as the answer to a client call. */
const refusal = (): Response => respond(recorded("account-balance-paid-plan-base"));

function context(chainId: number, steps: Step[]): { ctx: Context; calls: () => number } {
  const fake = replay(...steps);
  const apiKeys = { "etherscan-v2": KEY };
  return {
    ctx: {
      route: resolveRoute(chainId, { backend: "etherscan-v2" }, { apiKeys }),
      apiKeys: () => apiKeys,
      http: { backend: "etherscan-v2", fetch: fake.fetch, secrets: [KEY], random: () => 0 },
    },
    calls: () => fake.calls.length,
  };
}

function handle(chainId: number): Handle {
  return { version: 1, backend: "etherscan-v2", chainId, address: DEAD, jobId: GUID };
}

async function errorOf(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const outcome: unknown = await promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
  assert.ok(outcome instanceof ExplorerVerifyError, `expected an error, got ${String(outcome)}`);
  return outcome;
}

/** The error a free-plan key on a paid-plan chain gives: api-key-rejected with the plan hint. */
function assertPaidPlan(error: ExplorerVerifyError | undefined): void {
  assert.ok(error !== undefined);
  assert.deepEqual(error.details, { code: "api-key-rejected", backend: "etherscan-v2" });
  assert.equal(
    error.message,
    "etherscan-v2 answered that the API key's plan does not cover this chain.",
  );
  assert.equal(error.hint, HINT);
  assert.equal(error.retryable, false);
  assert.equal(ERROR_EXIT_CODES[error.code], 3);
  assert.equal(error.toJSON().hint, HINT);
  assert.ok(!JSON.stringify([error.message, error.hint, error.toJSON()]).includes(KEY));
}

describe("a free-plan key on a paid-plan chain: the recorded answers (#135, R-BE-1)", () => {
  const chains: readonly (readonly [number, string])[] = [
    [BASE_SEPOLIA, "base-sepolia"],
    [BASE, "base"],
  ];
  for (const [chainId, chain] of chains) {
    it(`lookup on ${String(chainId)} reads the recorded answer as not verified (recorded 2026-11-04)`, async () => {
      const { ctx, calls } = context(chainId, [
        respond(recorded(`getsourcecode-paid-plan-${chain}`)),
      ]);
      assert.equal(await etherscan.lookup({ chainId, address: DEAD }, ctx), undefined);
      assert.equal(calls(), 1);
    });

    it(`poll on ${String(chainId)} reads the recorded unknown guid as job-not-found (recorded 2026-11-04)`, async () => {
      const { ctx } = context(chainId, [respond(recorded(`checkverifystatus-paid-plan-${chain}`))]);
      const error = await errorOf(etherscan.poll(handle(chainId), ctx));
      assert.deepEqual(error.details, { code: "job-not-found", handle: handle(chainId) });
    });
  }
});

describe("a free-plan key on a paid-plan chain: the probe summary (#135)", () => {
  interface Row {
    chainid: number;
    module: string;
    action: string;
    status: string | null;
    result: string;
  }
  function rows(): Row[] {
    const url = new URL(
      "../fixtures/etherscan/2026-11-04-paid-plan-probe-summary.json",
      import.meta.url,
    );
    const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
    assert.ok(typeof parsed === "object" && parsed !== null);
    const results: unknown = Reflect.get(parsed, "results");
    assert.ok(Array.isArray(results));
    return results.map((entry: unknown): Row => {
      assert.ok(typeof entry === "object" && entry !== null);
      const field = (name: string): unknown => Reflect.get(entry, name);
      const chainid = field("chainid");
      const module = field("module");
      const action = field("action");
      const status = field("status");
      const result = field("result");
      assert.ok(typeof chainid === "number" && typeof module === "string");
      assert.ok(typeof action === "string" && typeof result === "string");
      assert.ok(typeof status === "string" || status === null);
      return { chainid, module, action, status, result };
    });
  }

  it("lookups and polls answered normally on all 11 paid-plan chains; the refusals map (recorded 2026-11-04)", () => {
    const all = rows();
    const lookups = all.filter((row) => row.action === "getsourcecode");
    const polls = all.filter((row) => row.action === "checkverifystatus");
    assert.equal(lookups.length, 11);
    assert.equal(polls.length, 11);
    assert.ok(lookups.every((row) => row.status === "1"));
    assert.ok(polls.every((row) => row.status === "0" && row.result === "Unable to locate guid"));
    const refused = all.filter((row) => row.result.startsWith("Free API access"));
    assert.deepEqual(
      refused.map((row) => `${String(row.chainid)} ${row.module} ${row.action}`),
      [10, 56, 97, 100, 4663, 5042, 8453, 43114].map((id) => `${String(id)} account balance`),
    );
    for (const row of refused) {
      const error = keyErrorOf("etherscan-v2", { status: row.status, result: row.result }, []);
      assert.equal(error?.hint, HINT);
    }
  });
});

describe("a free-plan key on a paid-plan chain: the refusal (#135, R-AX-7, R-SEC-1)", () => {
  it("keyErrorOf maps the recorded refusal to api-key-rejected with the plan hint (recorded 2026-11-04)", () => {
    const body = recorded("account-balance-paid-plan-base");
    assert.equal(Reflect.get(Object(body), "result"), REFUSAL);
    assertPaidPlan(keyErrorOf("etherscan-v2", body, [KEY]));
  });

  it("gives the plan hint to etherscan-v2 only: other backends keep the default hint", () => {
    const body = recorded("account-balance-paid-plan-base");
    assert.equal(keyErrorOf("etherscan-v2", body, [])?.hint, HINT);
    const others: readonly BackendName[] = ["routescan", "etherscan-compatible"];
    for (const backend of others) {
      const error = keyErrorOf(backend, body, []);
      assert.ok(error !== undefined, backend);
      assert.deepEqual(error.details, { code: "api-key-rejected", backend });
      assert.equal(
        error.message,
        `${backend} answered that the API key's plan does not cover this chain.`,
      );
      assert.notEqual(error.hint, HINT, backend);
      assert.ok(!error.hint.includes("Etherscan"), backend);
      assert.equal(error.retryable, false);
    }
  });

  it("keeps the default hint for the other key answers", () => {
    const error = keyErrorOf(
      "etherscan-v2",
      { status: "0", message: "NOTOK", result: "Invalid API Key (#err2)" },
      [],
    );
    assert.ok(error !== undefined);
    assert.notEqual(error.hint, HINT);
  });

  it("maps the refusal only at the start of a status 0 result", () => {
    for (const body of [
      { status: "1", message: "OK", result: REFUSAL },
      { status: "0", message: "NOTOK", result: `Error: ${REFUSAL}` },
    ]) {
      assert.equal(keyErrorOf("etherscan-v2", body, []), undefined, JSON.stringify(body));
    }
  });

  it("lookup, submit and poll throw it at once with one request, never unexpected-response", async () => {
    const lookup = context(BASE, [refusal()]);
    assertPaidPlan(await errorOf(etherscan.lookup({ chainId: BASE, address: DEAD }, lookup.ctx)));
    assert.equal(lookup.calls(), 1);

    const poll = context(BASE, [refusal()]);
    assertPaidPlan(await errorOf(etherscan.poll(handle(BASE), poll.ctx)));
    assert.equal(poll.calls(), 1);

    const submit = context(BASE, [refusal()]);
    assertPaidPlan(await errorOf(etherscan.submit(INPUT, submit.ctx)));
    assert.equal(submit.calls(), 1);
  });

  it("verify() with route.backend etherscan-v2 ends with the plan hint, the key only in bodies", async () => {
    const actions: string[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      assert.ok(typeof url === "string");
      assert.ok(!url.includes(KEY));
      assert.equal(new URL(url).searchParams.get("chainid"), String(BASE));
      assert.ok(init?.body instanceof URLSearchParams);
      assert.equal(init.body.get("apikey"), KEY);
      const action = init.body.get("action") ?? "";
      actions.push(action);
      return await Promise.resolve(
        action === "getsourcecode" ? respond(recorded("getsourcecode-paid-plan-base")) : refusal(),
      );
    };
    const error = await errorOf(
      verify(INPUT, {
        route: { backend: "etherscan-v2" },
        apiKeys: { "etherscan-v2": KEY },
        fetch,
      }),
    );
    assertPaidPlan(error);
    assert.deepEqual(actions, ["getsourcecode", "verifysourcecode"]);
  });
});
