// Tests for the rows of the shipped routing table (#60, R-RT-1, decision 0024). They read the
// research data of 2026-11-03, which holds a frozen copy of the Etherscan chainlist and the prior
// art's rows re-checked against Sourcify's chain list, so a dropped row fails CI.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { DEFAULT_DEPENDENCIES } from "../../src/flow/verify.ts";
import { ROUTING_TABLE, SOURCIFY_API_URL, resolveRoute } from "../../src/routing/resolve.ts";
import type { Hex } from "../../src/types.ts";

const SEED_FILE = new URL(
  "../../../../docs/contributor/research/data/2026-11-03-routing-seed.json",
  import.meta.url,
);
const ADDRESS: Hex = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

/** The fields of the research data these tests read. */
interface Seed {
  readonly checked: string;
  readonly rows: readonly { readonly chainId: number; readonly name: string }[];
  readonly etherscan: readonly { readonly chainId: number; readonly paidPlan: boolean }[];
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
    paidPlan: flagOf(chain, "paidPlan"),
  })),
  priorArt: listOf(raw, "priorArt", (chain) => ({
    chainId: numberOf(chain, "chainId"),
    sourcify: flagOf(chain, "sourcify"),
  })),
};
const tableIds = ROUTING_TABLE.chains.map((row) => row.chainId);

describe("routing table rows of 2026-11-03 (R-RT-1)", () => {
  it("has the research data's date", () => {
    assert.equal(ROUTING_TABLE.checked, seed.checked);
  });

  it("has a row for every chain id of the frozen Etherscan chainlist (R-RT-1)", () => {
    assert.equal(seed.etherscan.length, 57);
    const missing = seed.etherscan.filter((chain) => !tableIds.includes(chain.chainId));
    assert.deepEqual(missing, []);
  });

  it("keeps the paid-plan chains, which a keyless caller verifies on Sourcify (R-RT-1)", () => {
    const paid = seed.etherscan.filter((chain) => chain.paidPlan).map((chain) => chain.chainId);
    assert.deepEqual(
      paid.toSorted((a, b) => a - b),
      [10, 56, 97, 100, 4663, 5042, 8453, 43113, 43114, 84532, 11155420],
    );
    for (const chainId of paid) {
      assert.equal(resolveRoute(chainId).backend, "sourcify", String(chainId));
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

  it("lists only Sourcify, the one backend with a client in this release (R-RT-1)", () => {
    const clients = Object.keys(DEFAULT_DEPENDENCIES.backends);
    assert.deepEqual(clients, ["sourcify"]);
    for (const row of ROUTING_TABLE.chains) {
      assert.deepEqual(row.backends, [{ backend: "sourcify" }], String(row.chainId));
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
    it(`chain ${String(chainId)} (${name}) resolves to Sourcify without a fallback (R-RT-1)`, () => {
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
