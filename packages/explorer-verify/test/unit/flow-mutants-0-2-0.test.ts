// Tests added after the full mutation run on 0.2.0 (#380; R-FLOW-8, R-RT-4, R-SRV-5, R-DX-5): each
// one fails on a change in src/flow/link-proxy.ts, src/backends/proxy-blockscout.ts,
// src/flow/verify.ts or src/flow/verify-each.ts that the other tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import type { BackendName } from "../../src/backend-names.ts";
import type { Backend } from "../../src/backends/backend.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { newError } from "../../src/error-hints.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { DEFAULT_DEPENDENCIES, DEFAULT_LINK_DEPENDENCIES } from "../../src/flow/defaults.ts";
import type { FlowDependencies } from "../../src/flow/verify.ts";
import { dryRun } from "../../src/index.ts";
import type { RoutingTable } from "../../src/routing/resolve.ts";
import type { Hex, VerifyEvent, VerifyInput } from "../../src/types.ts";
import { runDryRun, runLinkProxy, runVerifyEach } from "../helpers/defaults.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const SEPOLIA = 11155111;
const FUJI = 43113;
const ZKSYNC = 324;
const PROXY: Hex = "0xed5b8413e605598ef86cd7617f12701f74ca255c";
const BOX: Hex = "0x75038a8c55f5ec7196b54384fdbcffb1f2ce9920";
const GREETER: Hex = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const BLOCKSCOUT_API = "https://eth-sepolia.blockscout.com/api";
const HANDLER = "https://dapp.example/api/verify";
// A fake key. Never a real one (R-SEC-1).
const ROUTESCAN_KEY = "dummy-routescan-key-flow-0-2-0-9x4p";

const blockscout = (name: string): Step => loadFixture("blockscout", name);

/** A JSON answer. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** An answer with no body and `status`, which the HTTP layer may retry. */
function bare(status: number): Response {
  return new Response("", { status });
}

function solcInput(chainId = SEPOLIA, address: Hex = GREETER): VerifyInput {
  return {
    chainId,
    address,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "src/Greeter.sol": { content: "contract Greeter {}" } },
        settings: {},
      },
    },
    contractName: "src/Greeter.sol:Greeter",
  };
}

interface LinkRun {
  readonly status: string | undefined;
  readonly error: unknown;
  readonly calls: Call[];
  readonly events: VerifyEvent[];
}

/** Runs linkProxy() on the Blockscout instance against `steps`, on mock timers. */
async function link(t: TestContext, steps: Step[]): Promise<LinkRun> {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const fake = replay(...steps);
  const events: VerifyEvent[] = [];
  const call = runLinkProxy(
    { chainId: SEPOLIA, address: PROXY },
    {
      timeoutMs: 60_000,
      pollIntervalMs: 3_000,
      route: { backend: "blockscout", apiUrl: BLOCKSCOUT_API },
      fetch: fake.fetch,
      onEvent: (event) => {
        events.push(event);
      },
    },
    DEFAULT_LINK_DEPENDENCIES,
  );
  await driveMockClock(call, () => {
    t.mock.timers.runAll();
  });
  try {
    const result = await call;
    return { status: result.status, error: undefined, calls: fake.calls, events };
  } catch (error: unknown) {
    return { status: undefined, error, calls: fake.calls, events };
  }
}

/** The `action` of each form request, or the URL of each GET. */
function actions(run: LinkRun): string[] {
  return run.calls.map((call) =>
    call.method === "GET" ? call.url : String(new URLSearchParams(call.body).get("action")),
  );
}

describe("linkProxy(): retries (#380, R-FLOW-8, R-DX-5)", () => {
  it("reports a retried link request as proxy.retry, never as verify.retry", async (t) => {
    const run = await link(t, [
      bare(503),
      blockscout("2026-11-04-verifyproxycontract-accepted"),
      blockscout("2026-11-04-checkproxyverification-linked"),
      json({ is_verified: true, is_fully_verified: true, is_partially_verified: false }),
    ]);
    assert.equal(run.status, "linked", String(run.error));
    assert.deepEqual(actions(run), [
      "verifyproxycontract",
      "verifyproxycontract",
      "checkproxyverification",
      `${BLOCKSCOUT_API}/v2/smart-contracts/${BOX}`,
    ]);
    const retries = run.events.filter((event) => event.type.endsWith(".retry"));
    assert.equal(retries.length, 1);
    assert.equal(retries[0]?.type, "proxy.retry");
    assert.equal(retries[0]?.type === "proxy.retry" && retries[0].backend, "blockscout");
  });

  it("retries a 502 to the Blockscout status check, as for every safe request", async (t) => {
    const run = await link(t, [
      blockscout("2026-11-04-verifyproxycontract-accepted"),
      bare(502),
      blockscout("2026-11-04-checkproxyverification-linked"),
      json({ is_verified: true, is_fully_verified: true, is_partially_verified: false }),
    ]);
    assert.equal(run.status, "linked", String(run.error));
    assert.deepEqual(actions(run), [
      "verifyproxycontract",
      "checkproxyverification",
      "checkproxyverification",
      `${BLOCKSCOUT_API}/v2/smart-contracts/${BOX}`,
    ]);
    // The second check is a retry of the first, not a new poll.
    assert.deepEqual(
      run.events.filter((event) => event.type === "proxy.retry" || event.type === "proxy.poll"),
      [run.events.find((event) => event.type === "proxy.retry")],
    );
  });
});

describe("verify(): a key next to handlerUrl (#380, decision 0046)", () => {
  it("sends a Routescan key next to handlerUrl: the handler serves Etherscan only", async () => {
    const address: Hex = "0x0000000000000000000000000000000000000001";
    const fake = replay(
      loadFixture("routescan", "2026-11-04-getsourcecode-not-verified-unique-url"),
    );
    const result = await dryRun(solcInput(FUJI, address), {
      fetch: fake.fetch,
      handlerUrl: HANDLER,
      route: { backend: "routescan" },
      apiKeys: { routescan: ROUTESCAN_KEY },
    });
    assert.equal(result.backend, "routescan");
    assert.equal(result.lookup, "none");
    assert.equal(fake.calls.length, 1);
    assert.match(fake.calls[0]?.url ?? "", /^https:\/\/api\.routescan\.io\//);
    assert.equal(fake.calls[0]?.headers.get("apikey"), ROUTESCAN_KEY);
  });
});

describe("verify(): the verify.routed event (#380, R-DX-5)", () => {
  it("joins two skipped backends with a comma", async () => {
    const table: RoutingTable = {
      schemaVersion: 3,
      checked: "2026-11-12",
      chains: [
        {
          chainId: SEPOLIA,
          backends: [
            { backend: "etherscan-v2" },
            { backend: "etherscan-compatible", api: "scan.example/api", needsKey: true },
            { backend: "sourcify" },
          ],
        },
      ],
    };
    const fake = replay(loadFixture("sourcify", "2026-11-02-lookup-not-verified"));
    const events: VerifyEvent[] = [];
    const result = await runDryRun(
      solcInput(),
      {
        fetch: fake.fetch,
        onEvent: (event) => {
          events.push(event);
        },
      },
      { ...DEFAULT_DEPENDENCIES, table },
    );
    assert.equal(result.backend, "sourcify");
    assert.deepEqual(
      events.find((event) => event.type === "verify.routed"),
      {
        type: "verify.routed",
        backend: "sourcify",
        apiHost: "sourcify.dev",
        routedBy: "table",
        skipped: "etherscan-v2,etherscan-compatible",
      },
    );
  });
});

/** A table loader that never settles. */
async function never(): Promise<RoutingTable> {
  return await new Promise<RoutingTable>(() => undefined);
}

describe("verifyEach(): an abort while the routing table loads (#380, R-RT-4, R-FLOW-6)", () => {
  it("rejects with a timeout reason as is, and no entry runs", async () => {
    const controller = new AbortController();
    const reason = newError(
      { code: "timeout", backend: "sourcify", timeoutMs: 5 },
      "The caller's deadline passed.",
      { secrets: [] },
    );
    const events: VerifyEvent[] = [];
    const fake = replay();
    const outcome = await runVerifyEach(
      solcInput(),
      {
        backends: ["sourcify"],
        fetch: fake.fetch,
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event);
        },
      },
      {
        backends: { sourcify },
        table: async () => {
          controller.abort(reason);
          return await never();
        },
        random: () => 0,
      },
    ).then(
      (result: unknown) => result,
      (error: unknown) => error,
    );
    assert.equal(outcome, reason);
    assert.deepEqual(events, []);
    assert.equal(fake.calls.length, 0);
  });
});

describe('verifyEach(): "all" when no listed backend verifies the compiler kind (#380, decision 0057)', () => {
  it("keeps every listed backend, each ending in unsupported-compiler", async () => {
    // Blockscout verifies zksolc on chain 324, but this call has no Blockscout client, so neither
    // listed backend with a client verifies the input.
    const stand: Backend = { ...sourcify, name: "routescan" };
    const dependencies: FlowDependencies = {
      backends: { sourcify, routescan: stand },
      table: {
        schemaVersion: 3,
        checked: "2026-11-12",
        chains: [
          {
            chainId: ZKSYNC,
            backends: [
              { backend: "sourcify" },
              { backend: "blockscout", instance: "zksync.blockscout.com" },
              { backend: "routescan", network: "mainnet" },
            ],
          },
        ],
      },
      random: () => 0,
    };
    const fake = replay();
    const result = await runVerifyEach(
      {
        chainId: ZKSYNC,
        address: GREETER,
        compiler: {
          kind: "zksolc",
          version: "1.5.15",
          solcVersion: "0.8.24+commit.e11b9ed9",
          solcFork: "1.0.2",
          input: {
            language: "Solidity",
            sources: { "src/A.sol": { content: "contract A {}" } },
            settings: { optimizer: { mode: "3" } },
          },
        },
        contractName: "src/A.sol:A",
      },
      { backends: "all", fetch: fake.fetch },
      dependencies,
    );
    const seen: [BackendName, string | undefined][] = result.outcomes.map((outcome) => [
      outcome.backend,
      outcome.ok ? undefined : outcome.error?.code,
    ]);
    assert.deepEqual(seen, [
      ["sourcify", "unsupported-compiler"],
      ["routescan", "unsupported-compiler"],
    ]);
    assert.ok(
      result.outcomes.every(
        (outcome) => !outcome.ok && outcome.error instanceof ExplorerVerifyError,
      ),
    );
    assert.equal(fake.calls.length, 0);
  });
});
