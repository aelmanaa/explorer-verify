// Tests for the rows of the shipped routing table (#60, #122, #165, R-RT-1, decisions 0024 and
// 0027). They read the research data of 2026-11-03, which holds a frozen copy of the Etherscan
// chainlist and the prior art's rows re-checked against Sourcify's chain list, so a dropped row or
// entry fails CI. The copy was updated on 2026-11-05, when chains 11124 and 43113 left the
// chainlist.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { DEFAULT_DEPENDENCIES } from "../../src/flow/verify.ts";
import {
  ETHERSCAN_API_URL,
  ROUTING_TABLE,
  SOURCIFY_API_URL,
  resolveRoute,
} from "../../src/routing/resolve.ts";
import type { Hex } from "../../src/types.ts";

const SEED_FILE = new URL(
  "../../../../docs/contributor/research/data/2026-11-03-routing-seed.json",
  import.meta.url,
);
const ADDRESS: Hex = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
// A made-up key. Never a real one (R-SEC-1).
const ETHERSCAN_KEY = "etherscan-dummy-key-122a";
const WITH_KEY = { apiKeys: { "etherscan-v2": ETHERSCAN_KEY } };

/** The fields of the research data these tests read. */
interface Seed {
  readonly checked: string;
  readonly rows: readonly { readonly chainId: number; readonly name: string }[];
  readonly etherscan: readonly {
    readonly chainId: number;
    readonly explorer: string;
    readonly paidPlan: boolean;
  }[];
  readonly priorArt: readonly { readonly chainId: number; readonly sourcify: boolean }[];
}

/** `value[key]` when `value` is an object, else `undefined`. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** The objects of the list at `value[key]`, each read with `read`. */
function listOf<T>(value: unknown, key: string, read: (item: unknown) => T): T[] {
  const list = field(value, key);
  assert.ok(Array.isArray(list), `${key} must be a list`);
  return list.map(read);
}

function numberOf(value: unknown, key: string): number {
  const found = field(value, key);
  assert.equal(typeof found, "number", key);
  return Number(found);
}

function textOf(value: unknown, key: string): string {
  const found = field(value, key);
  assert.equal(typeof found, "string", key);
  return String(found);
}

function flagOf(value: unknown, key: string): boolean {
  const found = field(value, key);
  assert.equal(typeof found, "boolean", key);
  return found === true;
}

const raw: unknown = JSON.parse(readFileSync(SEED_FILE, "utf8"));
const seed: Seed = {
  checked: textOf(raw, "checked"),
  rows: listOf(raw, "rows", (row) => ({
    chainId: numberOf(row, "chainId"),
    name: textOf(row, "name"),
  })),
  etherscan: listOf(raw, "etherscan", (chain) => ({
    chainId: numberOf(chain, "chainId"),
    explorer: textOf(chain, "explorer"),
    paidPlan: flagOf(chain, "paidPlan"),
  })),
  priorArt: listOf(raw, "priorArt", (chain) => ({
    chainId: numberOf(chain, "chainId"),
    sourcify: flagOf(chain, "sourcify"),
  })),
};
const tableIds = ROUTING_TABLE.chains.map((row) => row.chainId);

describe("routing table rows (R-RT-1)", () => {
  it("is dated 2026-11-05, when the rows were checked again against the chainlist", () => {
    // The research data is of 2026-11-03; the research note of 2026-11-04 records the later checks.
    assert.equal(seed.checked, "2026-11-03");
    assert.equal(ROUTING_TABLE.checked, "2026-11-05");
  });

  it("has a row for every chain id of the frozen Etherscan chainlist (R-RT-1)", () => {
    assert.equal(seed.etherscan.length, 55);
    const missing = seed.etherscan.filter((chain) => !tableIds.includes(chain.chainId));
    assert.deepEqual(missing, []);
  });

  it("keeps the paid-plan chains, which a keyless caller verifies on Sourcify (R-RT-1)", () => {
    const paid = seed.etherscan.filter((chain) => chain.paidPlan).map((chain) => chain.chainId);
    assert.deepEqual(
      paid.toSorted((a, b) => a - b),
      [10, 56, 97, 100, 4663, 5042, 8453, 43114, 84532, 11155420],
    );
    for (const chainId of paid) {
      assert.equal(resolveRoute(chainId).backend, "sourcify", String(chainId));
    }
  });

  it("gives each chain of the frozen chainlist an etherscan-v2 entry with its explorer host (R-RT-1, #122)", () => {
    for (const chain of seed.etherscan) {
      const row = ROUTING_TABLE.chains.find((each) => each.chainId === chain.chainId);
      const entries = row?.backends.filter((entry) => entry.backend === "etherscan-v2") ?? [];
      assert.deepEqual(
        entries,
        [{ backend: "etherscan-v2", explorer: chain.explorer }],
        String(chain.chainId),
      );
    }
  });

  it("lists etherscan-v2 first on a free-tier chain and after Sourcify on a paid-plan chain (R-RT-1, R-SEC-3, decision 0027)", () => {
    for (const chain of seed.etherscan) {
      const names = ROUTING_TABLE.chains
        .find((each) => each.chainId === chain.chainId)
        ?.backends.map((entry) => entry.backend);
      assert.deepEqual(
        names,
        chain.paidPlan ? ["sourcify", "etherscan-v2"] : ["etherscan-v2", "sourcify"],
        String(chain.chainId),
      );
    }
  });

  it("sends a caller with an Etherscan key to Etherscan on a free-tier chain, with the explorer page (R-RT-1, R-SEC-2)", () => {
    for (const chain of seed.etherscan.filter((each) => !each.paidPlan)) {
      const route = resolveRoute(chain.chainId, undefined, WITH_KEY);
      assert.equal(route.backend, "etherscan-v2", String(chain.chainId));
      assert.equal(route.apiBase, ETHERSCAN_API_URL);
      assert.equal(route.tableHost, "api.etherscan.io");
      assert.equal(route.overridden, false);
      assert.equal(
        route.explorerUrl?.(ADDRESS),
        `https://${chain.explorer}/address/${ADDRESS}#code`,
      );
    }
  });

  it("keeps a paid-plan chain on Sourcify with a key, and reaches Etherscan there through route.backend (R-RT-2, R-SEC-3, decision 0027)", () => {
    for (const chain of seed.etherscan.filter((each) => each.paidPlan)) {
      assert.equal(resolveRoute(chain.chainId, undefined, WITH_KEY).backend, "sourcify");
      const route = resolveRoute(chain.chainId, { backend: "etherscan-v2" }, WITH_KEY);
      assert.equal(route.backend, "etherscan-v2", String(chain.chainId));
      assert.equal(route.overridden, false);
      assert.equal(route.tableHost, "api.etherscan.io");
      assert.equal(
        route.explorerUrl?.(ADDRESS),
        `https://${chain.explorer}/address/${ADDRESS}#code`,
      );
    }
  });

  it("keeps 11124 and 43113, which left the chainlist on 2026-11-05, on Sourcify only, with or without a key (R-RT-1, #165)", () => {
    for (const chainId of [11124, 43113]) {
      assert.ok(!seed.etherscan.some((chain) => chain.chainId === chainId), String(chainId));
      const row = ROUTING_TABLE.chains.find((each) => each.chainId === chainId);
      assert.deepEqual(row?.backends, [{ backend: "sourcify" }], String(chainId));
      assert.equal(resolveRoute(chainId).backend, "sourcify", String(chainId));
      const route = resolveRoute(chainId, undefined, WITH_KEY);
      assert.equal(route.backend, "sourcify", String(chainId));
      assert.equal(route.tableHost, "sourcify.dev");
      assert.throws(() => resolveRoute(chainId, { backend: "etherscan-v2" }, WITH_KEY), {
        code: "unsupported-chain",
      });
    }
  });

  it("gives the rows outside the chainlist Sourcify only (R-RT-1)", () => {
    for (const row of ROUTING_TABLE.chains) {
      if (!seed.etherscan.some((chain) => chain.chainId === row.chainId)) {
        assert.deepEqual(row.backends, [{ backend: "sourcify" }], String(row.chainId));
      }
    }
  });

  it("has a row for each prior-art chain that Sourcify supports, and none for the others (R-RT-1)", () => {
    assert.equal(seed.priorArt.length, 67);
    for (const chain of seed.priorArt) {
      const listed = tableIds.includes(chain.chainId);
      const fromChainlist = seed.etherscan.some((each) => each.chainId === chain.chainId);
      assert.equal(listed, chain.sourcify || fromChainlist, String(chain.chainId));
    }
  });

  it("lists exactly the rows the research data names", () => {
    assert.deepEqual(
      tableIds,
      seed.rows.map((row) => row.chainId),
    );
    assert.equal(tableIds.length, 94);
  });

  it("lists Sourcify on every row, and only the backends with a client; Routescan, Blockscout and standalone explorers have no rows yet (R-RT-1)", () => {
    const clients = Object.keys(DEFAULT_DEPENDENCIES.backends);
    assert.deepEqual(clients, [
      "sourcify",
      "etherscan-v2",
      "etherscan-compatible",
      "routescan",
      "blockscout",
    ]);
    for (const row of ROUTING_TABLE.chains) {
      const names = row.backends.map((entry) => entry.backend);
      assert.ok(names.includes("sourcify"), String(row.chainId));
      assert.ok(!names.includes("routescan"), String(row.chainId));
      assert.ok(!names.includes("blockscout"), String(row.chainId));
      // No standalone host answered on 2026-11-03 or 2026-11-04 (#63).
      assert.ok(!names.includes("etherscan-compatible"), String(row.chainId));
      assert.ok(
        names.every((name) => clients.includes(name)),
        String(row.chainId),
      );
    }
  });
});

describe("routing table: named chains resolve as the research note says (R-RT-1)", () => {
  const named: [number, string][] = [
    [1, "Ethereum Mainnet"],
    [11155111, "Ethereum Sepolia"],
    [43113, "Avalanche Fuji"],
    [43114, "Avalanche C-Chain"],
    [80002, "Polygon Amoy"],
    [84532, "Base Sepolia"],
    [421614, "Arbitrum Sepolia"],
  ];
  for (const [chainId, name] of named) {
    it(`chain ${String(chainId)} (${name}) resolves to Sourcify without a key or a fallback (R-RT-1)`, () => {
      const route = resolveRoute(chainId);
      assert.equal(route.backend, "sourcify");
      assert.equal(route.apiBase, SOURCIFY_API_URL);
      assert.equal(route.overridden, false);
      assert.equal(route.tableHost, "sourcify.dev");
      assert.equal(
        route.explorerUrl?.(ADDRESS),
        `https://repo.sourcify.dev/${String(chainId)}/${ADDRESS}`,
      );
    });
  }

  it("chain 324 has no routescan or etherscan-v2 entry (R-RT-1)", () => {
    const row = ROUTING_TABLE.chains.find((each) => each.chainId === 324);
    const backends = row?.backends.map((entry) => entry.backend) ?? [];
    assert.ok(!backends.includes("routescan"));
    assert.ok(!backends.includes("etherscan-v2"));
    // Chain 324 is in neither the Etherscan chainlist nor the prior art, so it has no row.
    assert.equal(row, undefined);
  });
});
