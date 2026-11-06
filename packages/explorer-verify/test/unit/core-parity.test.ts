// The flows through both entries (decision 0052): `explorer-verify` with its lazy loaders, and
// `explorer-verify/core` with every client and the routing table passed. Each scenario replays the
// same recorded answers through each entry and checks that both send the same requests and end
// the same way: the same result, or the same error with the same message and details.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { blockscout, blockscoutHosted, blockscoutProxyLink } from "../../src/clients/blockscout.ts";
import {
  etherscanCompatible,
  etherscanCompatibleProxyLink,
} from "../../src/clients/etherscan-compatible.ts";
import { etherscanV2, etherscanV2ProxyLink } from "../../src/clients/etherscan-v2.ts";
import { routescan } from "../../src/clients/routescan.ts";
import { sourcify, sourcifyProxyLink } from "../../src/clients/sourcify.ts";
import * as core from "../../src/core/index.ts";
import type { ExplorerClient, ProxyLinkClient } from "../../src/core/index.ts";
import { routingTable } from "../../src/core/table.ts";
import * as main from "../../src/index.ts";
import type {
  CheckStatusOptions,
  DryRunOptions,
  Handle,
  LinkProxyOptions,
  LinkProxyTarget,
  VerifyEachOptions,
  VerifyInput,
  VerifyOptions,
} from "../../src/index.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const SEPOLIA = 11155111;
const ARB_SEPOLIA = 421614;
const GREETER = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const D1 = "0x0a1b8e1aed0cf5c3d4f00b5e9d4a87f5e2c7d0a1";
const PROXY = "0xed5b8413e605598ef86cd7617f12701f74ca255c";
const BLOCKSCOUT_API = "https://eth-sepolia.blockscout.com/api";
// A fake key. Never a real one (R-SEC-1).
const KEY = "DUMMYKEYcoreparity0123456789ABCDEF";

const CLIENTS: readonly [ExplorerClient, ...ExplorerClient[]] = [
  sourcify(),
  etherscanV2(),
  etherscanCompatible(),
  routescan(),
  blockscout(),
  blockscoutHosted(),
];
const LINKS: readonly [ProxyLinkClient, ...ProxyLinkClient[]] = [
  sourcifyProxyLink(),
  etherscanV2ProxyLink(),
  etherscanCompatibleProxyLink(),
  blockscoutProxyLink(),
];

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
});

afterEach(() => {
  mock.timers.reset();
});

const sourcifyAnswer = (name: string): Step => loadFixture("sourcify", name);
/** The recorded response of `test/fixtures/etherscan/<name>.json`, which keeps no request URL. */
function etherscanAnswer(name: string): Step {
  const url = new URL(`../fixtures/etherscan/${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null);
  const response: unknown = Reflect.get(parsed, "response");
  assert.ok(typeof response === "object" && response !== null);
  const status: unknown = Reflect.get(response, "status");
  assert.ok(typeof status === "number");
  return json(Reflect.get(response, "body"), status);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function greeter(chainId = SEPOLIA, address = GREETER): VerifyInput {
  return {
    chainId,
    address: `0x${address.slice(2)}`,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "contracts/Greeter.sol": { content: "contract Greeter {}" } },
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
    contractName: "contracts/Greeter.sol:Greeter",
    constructorArgs: "0x",
  };
}

/** How a call ended, in a form `deepEqual` compares: the result, or the error's JSON. */
async function ending(call: Promise<unknown>): Promise<unknown> {
  const tracked = call.then(
    (result) => ({ result }),
    (error: unknown) =>
      error instanceof main.ExplorerVerifyError ? { error: error.toJSON() } : { thrown: error },
  );
  await driveMockClock(tracked, () => {
    mock.timers.runAll();
  });
  return await tracked;
}

/** One flow, run through each entry with a new replay of `steps`. */
interface Scenario {
  readonly name: string;
  /** The result's `status`, `outcomes` for `verifyEach()`, or the error's code. */
  readonly expect: string;
  readonly steps: () => Step[];
  readonly main: (fetch: typeof globalThis.fetch) => Promise<unknown>;
  readonly core: (fetch: typeof globalThis.fetch) => Promise<unknown>;
}

const verifyOptions = (
  fetch: typeof globalThis.fetch,
  extra: VerifyOptions = {},
): VerifyOptions => ({
  fetch,
  pollIntervalMs: 1_000,
  ...extra,
});

const SCENARIOS: Scenario[] = [
  {
    name: "verify() on Sourcify through the routing table: lookup, submit, two polls",
    expect: "verified",
    steps: () => [
      sourcifyAnswer("2026-11-02-lookup-not-verified"),
      sourcifyAnswer("2026-11-02-submit-accepted"),
      sourcifyAnswer("2026-11-02-job-pending"),
      sourcifyAnswer("2026-11-02-job-exact-match"),
    ],
    main: async (fetch) => await main.verify(greeter(), verifyOptions(fetch)),
    core: async (fetch) =>
      await core.verify(greeter(), {
        ...verifyOptions(fetch),
        clients: CLIENTS,
        table: routingTable,
      }),
  },
  {
    name: "verify() on Sourcify with route.apiUrl and no table in core",
    expect: "already-verified",
    steps: () => [sourcifyAnswer("2026-11-02-lookup-exact-match")],
    main: async (fetch) =>
      await main.verify(
        greeter(),
        verifyOptions(fetch, {
          route: { backend: "sourcify", apiUrl: "https://sourcify.dev/server" },
        }),
      ),
    core: async (fetch) =>
      await core.verify(greeter(), {
        ...verifyOptions(fetch, {
          route: { backend: "sourcify", apiUrl: "https://sourcify.dev/server" },
        }),
        clients: [sourcify()],
      }),
  },
  {
    name: "verify() that ends in a Sourcify error answer",
    expect: "unexpected-response",
    steps: () => [sourcifyAnswer("2026-11-02-lookup-internal-error")],
    main: async (fetch) => await main.verify(greeter(), verifyOptions(fetch)),
    core: async (fetch) =>
      await core.verify(greeter(), {
        ...verifyOptions(fetch),
        clients: CLIENTS,
        table: routingTable,
      }),
  },
  {
    name: "verify() on Etherscan v2 with a key: lookup, submit, two polls",
    expect: "verified",
    steps: () => [
      etherscanAnswer("2026-11-03-getsourcecode-not-verified"),
      etherscanAnswer("2026-11-03-verifysourcecode-factory-child"),
      etherscanAnswer("2026-11-03-checkverifystatus-factory-child-01-pending"),
      etherscanAnswer("2026-11-03-checkverifystatus-factory-child-02-pass"),
    ],
    main: async (fetch) =>
      await main.verify(
        greeter(ARB_SEPOLIA, D1),
        verifyOptions(fetch, {
          apiKeys: { "etherscan-v2": KEY },
          route: { backend: "etherscan-v2" },
        }),
      ),
    core: async (fetch) =>
      await core.verify(greeter(ARB_SEPOLIA, D1), {
        ...verifyOptions(fetch, {
          apiKeys: { "etherscan-v2": KEY },
          route: { backend: "etherscan-v2" },
        }),
        clients: CLIENTS,
        table: routingTable,
      }),
  },
  {
    name: "verify() on Etherscan v2 without a key: missing-api-key before any request",
    expect: "missing-api-key",
    steps: () => [],
    main: async (fetch) =>
      await main.verify(greeter(), verifyOptions(fetch, { route: { backend: "etherscan-v2" } })),
    core: async (fetch) =>
      await core.verify(greeter(), {
        ...verifyOptions(fetch, { route: { backend: "etherscan-v2" } }),
        clients: CLIENTS,
        table: routingTable,
      }),
  },
  {
    name: "verify() on a chain the table does not list: unsupported-chain",
    expect: "unsupported-chain",
    steps: () => [],
    main: async (fetch) => await main.verify(greeter(424_242_424_242), verifyOptions(fetch)),
    core: async (fetch) =>
      await core.verify(greeter(424_242_424_242), {
        ...verifyOptions(fetch),
        clients: CLIENTS,
        table: routingTable,
      }),
  },
  {
    name: "dryRun() on Sourcify through the routing table",
    expect: "dry-run",
    steps: () => [sourcifyAnswer("2026-11-02-lookup-exact-match")],
    main: async (fetch) => await main.dryRun(greeter(), { fetch } satisfies DryRunOptions),
    core: async (fetch) =>
      await core.dryRun(greeter(), { fetch, clients: CLIENTS, table: routingTable }),
  },
  {
    name: "checkStatus() on a Sourcify handle",
    expect: "verified",
    steps: () => [sourcifyAnswer("2026-11-02-job-exact-match")],
    main: async (fetch) =>
      await main.checkStatus(sourcifyHandle(), { fetch } satisfies CheckStatusOptions),
    core: async (fetch) =>
      await core.checkStatus(sourcifyHandle(), { fetch, clients: CLIENTS, table: routingTable }),
  },
  {
    name: "verifyEach() on Sourcify and a Blockscout instance",
    expect: "outcomes",
    steps: () => [sourcifyAnswer("2026-11-02-lookup-exact-match"), json(blockscoutVerified())],
    main: async (fetch) => await main.verifyEach(greeter(), eachOptions(fetch)),
    core: async (fetch) =>
      await core.verifyEach(greeter(), {
        ...eachOptions(fetch),
        clients: CLIENTS,
        table: routingTable,
      }),
  },
  {
    name: "linkProxy() on Sourcify",
    expect: "linked",
    steps: () => [
      sourcifyAnswer("2026-11-04-proxy-resolution-box-proxy"),
      sourcifyAnswer("2026-11-04-lookup-box"),
    ],
    main: async (fetch) => await main.linkProxy(proxyTarget(), linkOptions(fetch)),
    core: async (fetch) =>
      await core.linkProxy(proxyTarget(), {
        ...linkOptions(fetch),
        clients: LINKS,
        table: routingTable,
      }),
  },
  {
    name: "linkProxy() on Routescan: refused before any request",
    expect: "invalid-input",
    steps: () => [],
    main: async (fetch) =>
      await main.linkProxy(proxyTarget(), { fetch, route: { backend: "routescan" } }),
    core: async (fetch) =>
      await core.linkProxy(proxyTarget(), {
        fetch,
        route: { backend: "routescan" },
        clients: LINKS,
        table: routingTable,
      }),
  },
];

function sourcifyHandle(): Handle {
  return {
    version: 1,
    backend: "sourcify",
    chainId: SEPOLIA,
    address: `0x${GREETER.slice(2)}`,
    jobId: "ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718",
  };
}

function eachOptions(fetch: typeof globalThis.fetch): VerifyEachOptions {
  return {
    fetch,
    pollIntervalMs: 1_000,
    backends: ["sourcify", { backend: "blockscout", apiUrl: BLOCKSCOUT_API }],
  };
}

/** Blockscout's lookup answer for a verified contract, in the shape of its REST API. */
function blockscoutVerified(): Record<string, unknown> {
  return { is_verified: true, is_fully_verified: true, is_partially_verified: false };
}

function proxyTarget(): LinkProxyTarget {
  return { chainId: SEPOLIA, address: `0x${PROXY.slice(2)}` };
}

function linkOptions(fetch: typeof globalThis.fetch): LinkProxyOptions {
  return { fetch, pollIntervalMs: 1_000, route: { backend: "sourcify" } };
}

/** The result's `status`, `outcomes`, or the error's code, of an {@link ending}. */
function summary(end: unknown): unknown {
  const result: unknown = Reflect.get(Object(end), "result");
  if (result !== undefined) {
    return Reflect.get(Object(result), "status") ?? "outcomes";
  }
  return Reflect.get(Object(Reflect.get(Object(end), "error")), "code");
}

const requests = (calls: readonly Call[]): string[] =>
  calls.map((call) => `${call.method} ${call.url}`);

describe("the default entry and explorer-verify/core give the same results (decision 0052, R-FLOW-1 to R-FLOW-8)", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const first = replay(...scenario.steps());
      const fromMain = await ending(scenario.main(first.fetch));
      const second = replay(...scenario.steps());
      const fromCore = await ending(scenario.core(second.fetch));
      assert.deepEqual(fromCore, fromMain);
      assert.deepEqual(requests(second.calls), requests(first.calls));
      assert.equal(summary(fromMain), scenario.expect, JSON.stringify(fromMain));
    });
  }
});
