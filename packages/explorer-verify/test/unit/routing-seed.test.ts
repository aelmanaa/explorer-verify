// Tests for the rows of the shipped routing table (#60, #122, #165, #166, #168, #169, R-RT-1,
// decisions 0024, 0027, 0036, 0037 and 0038). They read the research data of 2026-11-03, which holds a frozen copy of the
// Etherscan chainlist, the prior art's rows re-checked against Sourcify's chain list and the
// table's rows, so a dropped row or entry fails CI. The copy was updated on 2026-11-05, when chains
// 11124 and 43113 left the chainlist and #166 added a row for every chain Sourcify supports. The
// Routescan entries come from the probe data of 2026-11-05 (#168), and the Blockscout entries from
// the instance probe of 2026-11-05 (#169), and the standalone entry from the API probe of 2026-11-05
// (#170).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { DEFAULT_DEPENDENCIES } from "../../src/flow/verify.ts";
import { keyFor } from "../../src/http/api-keys.ts";
import {
  ETHERSCAN_API_URL,
  ROUTING_TABLE,
  SOURCIFY_API_URL,
  resolveRoute,
  tableTarget,
} from "../../src/routing/resolve.ts";
import type { TableEntry } from "../../src/routing/resolve.ts";
import type { Hex } from "../../src/types.ts";

const SEED_FILE = new URL(
  "../../../../docs/contributor/research/data/2026-11-03-routing-seed.json",
  import.meta.url,
);
const ROUTESCAN_FILE = new URL(
  "../../../../docs/contributor/research/data/2026-11-05-routescan-chains.json",
  import.meta.url,
);
const STANDALONE_FILE = new URL(
  "../../../../docs/contributor/research/data/2026-11-05-etherscan-compatible-hosts.json",
  import.meta.url,
);
const ADDRESS: Hex = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
// A made-up key. Never a real one (R-SEC-1).
const ETHERSCAN_KEY = "etherscan-dummy-key-122a";
const WITH_KEY = { apiKeys: { "etherscan-v2": ETHERSCAN_KEY } };
const ROUTESCAN_KEY = "routescan-dummy-key-168a";

/** The fields of the research data these tests read. */
interface Seed {
  readonly checked: string;
  readonly rows: readonly {
    readonly chainId: number;
    readonly name: string;
    readonly from: readonly string[];
  }[];
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
    from: listOf(row, "from", (list) => {
      assert.equal(typeof list, "string", "from");
      return String(list);
    }),
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

/** The chains Routescan's API served in the probe of 2026-11-05, with their network. */
const routescan = listOf(JSON.parse(readFileSync(ROUTESCAN_FILE, "utf8")), "served", (chain) => ({
  chainId: numberOf(chain, "chainId"),
  network: textOf(chain, "network"),
}));

/** The host each Blockscout instance answered from in the probe of 2026-11-05 (#169). */
const blockscout = new Map<number, string>();
for (const item of listOf(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../../docs/contributor/research/data/2026-11-05-blockscout-instances.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
  "instances",
  (each) => each,
)) {
  const instance = field(item, "instance");
  if (typeof instance === "string") {
    blockscout.set(numberOf(item, "chainId"), instance);
  }
}

/** The chains whose standalone API answered the probe of 2026-11-05 (#170). */
const standalone = listOf(JSON.parse(readFileSync(STANDALONE_FILE, "utf8")), "hosts", (host) =>
  numberOf(host, "chainId"),
);

/**
 * A row's entries other than Routescan's, Blockscout's and the standalone ones, which #168, #169
 * and #170 added from probes.
 */
function withoutRoutescan(backends: readonly TableEntry[] | undefined): TableEntry[] | undefined {
  return backends?.filter(
    (entry) =>
      entry.backend !== "routescan" &&
      entry.backend !== "blockscout" &&
      entry.backend !== "etherscan-compatible",
  );
}

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
      const names = withoutRoutescan(
        ROUTING_TABLE.chains.find((each) => each.chainId === chain.chainId)?.backends,
      )?.map((entry) => entry.backend);
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
      assert.deepEqual(withoutRoutescan(row?.backends), [{ backend: "sourcify" }], String(chainId));
      assert.equal(resolveRoute(chainId).backend, "sourcify", String(chainId));
      const route = resolveRoute(chainId, undefined, WITH_KEY);
      assert.equal(route.backend, "sourcify", String(chainId));
      assert.equal(route.tableHost, "sourcify.dev");
      assert.throws(() => resolveRoute(chainId, { backend: "etherscan-v2" }, WITH_KEY), {
        code: "unsupported-chain",
      });
    }
  });

  it("gives the rows outside the chainlist Sourcify, Blockscout, Routescan or a mix (R-RT-1, decisions 0037 and 0038)", () => {
    for (const row of ROUTING_TABLE.chains) {
      if (!seed.etherscan.some((chain) => chain.chainId === row.chainId)) {
        const others = withoutRoutescan(row.backends);
        assert.ok(
          others?.length === 0 || (others?.length === 1 && others[0]?.backend === "sourcify"),
          String(row.chainId),
        );
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
    const ids = new Set([
      ...seed.rows.map((row) => row.chainId),
      ...routescan.map((chain) => chain.chainId),
      ...blockscout.keys(),
      ...standalone,
    ]);
    assert.deepEqual(
      tableIds,
      [...ids].toSorted((a, b) => a - b),
    );
    assert.equal(tableIds.length, 326);
    // 1 row from the standalone probe alone (#170): Bitlayer.
    assert.deepEqual(standalone, [200901]);
    // 94 rows from the chainlist or the prior art, and 194 from Sourcify's chain list alone (#166).
    const fromSourcify = seed.rows.filter((row) => row.from.includes("sourcify-chains"));
    assert.equal(fromSourcify.length, 194);
    // 26 rows from the Routescan probe alone (#168), and 11 from the Blockscout probe alone (#169).
    const withRoutescan = new Set([
      ...seed.rows.map((row) => row.chainId),
      ...routescan.map((c) => c.chainId),
    ]);
    assert.equal(withRoutescan.size - seed.rows.length, 26);
    assert.equal(ids.size - withRoutescan.size, 12);
  });

  it("gives every chain Sourcify supports a row: the 49 chains of #166 resolve to Sourcify without allowSourcifyFallback (R-RT-1, R-RT-3, decision 0036)", () => {
    // The chains #166 names: Foundry and Hardhat verify on them through Sourcify by default.
    const chains = [
      25, 30, 109, 177, 196, 204, 223, 232, 239, 295, 324, 388, 592, 964, 1088, 1111, 1116, 1135,
      1672, 1750, 1868, 1952, 2020, 2818, 3343, 4200, 4217, 8217, 16661, 33139, 34443, 36888, 36900,
      42793, 43111, 47763, 48900, 57073, 60808, 61901, 98866, 102030, 102031, 127001, 534352,
      5734951, 7777777, 728126428, 3448148188,
    ];
    assert.equal(chains.length, 49);
    for (const chainId of chains) {
      const row = ROUTING_TABLE.chains.find((each) => each.chainId === chainId);
      // 1088 and 43111 also list Routescan, after Sourcify (#168).
      assert.deepEqual(withoutRoutescan(row?.backends), [{ backend: "sourcify" }], String(chainId));
      const route = resolveRoute(chainId, undefined, WITH_KEY);
      assert.equal(route.backend, "sourcify", String(chainId));
      assert.equal(route.overridden, false);
      assert.equal(route.tableHost, "sourcify.dev");
      assert.equal(
        route.explorerUrl?.(ADDRESS),
        `https://repo.sourcify.dev/${String(chainId)}/${ADDRESS}`,
      );
    }
  });

  it("lists Sourcify on every row but the Blockscout-, Routescan- and standalone-only ones, and only the backends with a client; Bitlayer is the one standalone row (R-RT-1, #170)", () => {
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
      assert.ok(
        names.includes("sourcify") ||
          names.filter(
            (name) =>
              name !== "blockscout" && name !== "routescan" && name !== "etherscan-compatible",
          ).length === 0,
        String(row.chainId),
      );
      // Only Bitlayer's standalone API answered the keyless probe of 2026-11-05 (#170).
      assert.equal(
        names.includes("etherscan-compatible"),
        standalone.includes(row.chainId),
        String(row.chainId),
      );
      assert.ok(
        names.every((name) => clients.includes(name)),
        String(row.chainId),
      );
    }
  });
});

describe("routing table: the Routescan entries (R-RT-1, R-RT-2, #168, decision 0037)", () => {
  it("has a routescan entry, last, with the probe's network, on each of the 38 chains Routescan's API served", () => {
    assert.equal(routescan.length, 38);
    const listed = ROUTING_TABLE.chains.filter((row) =>
      row.backends.some((entry) => entry.backend === "routescan"),
    );
    assert.deepEqual(
      listed.map((row) => row.chainId),
      routescan.map((chain) => chain.chainId),
    );
    for (const chain of routescan) {
      const row = ROUTING_TABLE.chains.find((each) => each.chainId === chain.chainId);
      assert.deepEqual(
        row?.backends.at(-1),
        { backend: "routescan", network: chain.network },
        String(chain.chainId),
      );
    }
  });

  it("derives each entry's Routescan API URL from the chain id and the network", () => {
    for (const chain of routescan) {
      const row = ROUTING_TABLE.chains.find((each) => each.chainId === chain.chainId);
      const entry = row?.backends.find((each) => each.backend === "routescan");
      assert.ok(entry !== undefined, String(chain.chainId));
      const target = tableTarget(chain.chainId, entry);
      assert.equal(
        target?.apiUrl,
        `https://api.routescan.io/v2/network/${chain.network}/evm/${String(chain.chainId)}/etherscan/api`,
      );
      assert.equal(target.backend, "routescan");
    }
  });

  it("route: { backend: routescan } works without apiUrl on each chain, and binds apiKeys.routescan to api.routescan.io (R-RT-2, R-SEC-2)", () => {
    const apiKeys = { routescan: ROUTESCAN_KEY };
    for (const chain of routescan) {
      const route = resolveRoute(chain.chainId, { backend: "routescan" }, { apiKeys });
      const base = `https://api.routescan.io/v2/network/${chain.network}/evm/${String(chain.chainId)}/etherscan/api`;
      assert.equal(route.backend, "routescan", String(chain.chainId));
      assert.equal(route.apiBase, base);
      assert.equal(route.requestUrl(""), base);
      assert.equal(route.overridden, false);
      assert.equal(route.tableHost, "api.routescan.io");
      assert.equal(route.explorerUrl, undefined);
      assert.equal(
        keyFor({ route, apiKeys: () => apiKeys }, "routescan", route.requestUrl("")),
        ROUTESCAN_KEY,
      );
    }
  });

  it("sends a call with no option to Routescan on a Routescan-only row, such as 68414 (Henesys)", () => {
    const only = ROUTING_TABLE.chains.filter(
      (row) => row.backends.length === 1 && row.backends[0]?.backend === "routescan",
    );
    // 26 Routescan-only chains in the probe; 8021 (Numine) also lists Blockscout since #169.
    assert.equal(only.length, 25);
    assert.ok(only.some((row) => row.chainId === 68414));
    for (const row of only) {
      for (const choice of [undefined, WITH_KEY]) {
        const route = resolveRoute(row.chainId, undefined, choice);
        assert.equal(route.backend, "routescan", String(row.chainId));
        assert.equal(route.tableHost, "api.routescan.io");
      }
    }
    assert.equal(
      resolveRoute(68414).apiBase,
      "https://api.routescan.io/v2/network/mainnet/evm/68414/etherscan/api",
    );
  });

  it("keeps a keyless call on Sourcify, and a keyed one on Etherscan, where the row lists them before Routescan", () => {
    for (const chain of routescan) {
      const row = ROUTING_TABLE.chains.find((each) => each.chainId === chain.chainId);
      const first = row?.backends[0]?.backend;
      // A row without Sourcify goes to its first backend: Routescan, or Blockscout on 8021 (#169).
      if (first === "routescan" || first === "blockscout") {
        continue;
      }
      assert.equal(resolveRoute(chain.chainId).backend, "sourcify", String(chain.chainId));
      assert.equal(
        resolveRoute(chain.chainId, undefined, { apiKeys: { routescan: ROUTESCAN_KEY } }).backend,
        "sourcify",
        String(chain.chainId),
      );
      assert.equal(
        resolveRoute(chain.chainId, undefined, WITH_KEY).backend,
        first,
        String(chain.chainId),
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

  it("chain 324 has a Sourcify row and no routescan or etherscan-v2 entry (R-RT-1, #166)", () => {
    const row = ROUTING_TABLE.chains.find((each) => each.chainId === 324);
    const backends = row?.backends.map((entry) => entry.backend) ?? [];
    assert.ok(!backends.includes("routescan"));
    assert.ok(!backends.includes("etherscan-v2"));
    // Chain 324 is in neither the Etherscan chainlist nor the prior art. Since #166 it has a
    // Sourcify row, because Sourcify supports it (decision 0036); since #169 its Blockscout
    // instance follows (decision 0038).
    assert.deepEqual(row?.backends, [
      { backend: "sourcify" },
      { backend: "blockscout", instance: "zksync.blockscout.com" },
    ]);
  });
});

describe("routing table: the Blockscout entries (R-RT-1, R-RT-2, R-BE-3, #169, decision 0038)", () => {
  const answered = blockscout;

  it("has an entry for each of the 111 instances that answered, and for no other", () => {
    assert.equal(answered.size, 111);
    const listed = new Map(
      ROUTING_TABLE.chains.flatMap((row) =>
        row.backends
          .filter((entry) => entry.backend === "blockscout")
          .map((entry): [number, string | undefined] => [row.chainId, entry.instance]),
      ),
    );
    assert.deepEqual(listed, answered);
  });

  it("routes route: { backend: 'blockscout' } to each instance's API and contract page, with no apiUrl (R-RT-2)", () => {
    for (const [chainId, instance] of answered) {
      const route = resolveRoute(chainId, { backend: "blockscout" });
      assert.equal(route.backend, "blockscout", String(chainId));
      assert.equal(route.apiBase, `https://${instance}/api`);
      assert.equal(
        route.requestUrl(`/v2/smart-contracts/${ADDRESS}`),
        `https://${instance}/api/v2/smart-contracts/${ADDRESS}`,
      );
      assert.equal(
        route.explorerUrl?.(ADDRESS),
        `https://${instance}/address/${ADDRESS}?tab=contract`,
      );
      assert.equal(route.tableHost, instance);
      assert.equal(route.overridden, false);
    }
  });

  it("keeps Sourcify first where the row has it, and routes a Blockscout-only row to Blockscout (R-RT-1)", () => {
    for (const [chainId, instance] of answered) {
      const row = ROUTING_TABLE.chains.find((each) => each.chainId === chainId);
      const names = row?.backends.map((entry) => entry.backend) ?? [];
      const route = resolveRoute(chainId);
      if (names.includes("sourcify")) {
        assert.equal(route.backend, "sourcify", String(chainId));
      } else {
        assert.equal(route.backend, "blockscout", String(chainId));
        assert.equal(route.tableHost, instance);
      }
      // An Etherscan key never moves a call from Blockscout to a paid-plan Etherscan entry.
      const keyed = resolveRoute(chainId, undefined, WITH_KEY).backend;
      const paid = seed.etherscan.some((chain) => chain.chainId === chainId && chain.paidPlan);
      assert.ok(!(paid && keyed === "etherscan-v2"), String(chainId));
    }
  });

  it("covers every instance #169 lists, at the host the issue names", () => {
    const issue: [number, string][] = [
      [1, "eth.blockscout.com"],
      [10, "explorer.optimism.io"],
      [30, "rootstock.blockscout.com"],
      [31, "rootstock-testnet.blockscout.com"],
      [81, "shibuya.blockscout.com"],
      [100, "gnosisscan.io"],
      [130, "unichain.blockscout.com"],
      [177, "hsk.blockscout.com"],
      [239, "explorer.tac.build"],
      [300, "zksync-sepolia.blockscout.com"],
      [324, "zksync.blockscout.com"],
      [480, "worldchain-mainnet.explorer.alchemy.com"],
      [592, "astar.blockscout.com"],
      [1088, "andromeda-explorer.metis.io"],
      [1135, "blockscout.lisk.com"],
      [1301, "unichain-sepolia.blockscout.com"],
      [1750, "explorer.metall2.com"],
      [1868, "soneium.blockscout.com"],
      [1946, "soneium-minato.blockscout.com"],
      [2020, "explorer.roninchain.com"],
      [2391, "spb.explorer.tac.build"],
      [4326, "megaeth.blockscout.com"],
      [4801, "worldchain-sepolia.explorer.alchemy.com"],
      [10200, "gnosis-chiado.blockscout.com"],
      [33111, "apechain-curtis.blockscout.com"],
      [33139, "apechain.blockscout.com"],
      [34443, "explorer.mode.network"],
      [42220, "celo.blockscout.com"],
      [42793, "explorer.etherlink.com"],
      [43111, "explorer.hemi.xyz"],
      [46630, "explorer.testnet.chain.robinhood.com"],
      [47763, "xexplorer.neo.org"],
      [57073, "explorer.inkonchain.com"],
      [84532, "base-sepolia.blockscout.com"],
      [98866, "explorer.plume.org"],
      [98867, "testnet-explorer.plume.org"],
      [102030, "creditcoin.blockscout.com"],
      [102031, "creditcoin-testnet.blockscout.com"],
      [202601, "saigon-explorer.roninchain.com"],
      [534352, "scrollscan.com"],
      [560048, "eth-hoodi.blockscout.com"],
      [743111, "testnet.explorer.hemi.xyz"],
      [763373, "explorer-sepolia.inkonchain.com"],
      [5042002, "explorer.testnet.arc.io"],
      [11142220, "celo-sepolia.blockscout.com"],
      [11155111, "eth-sepolia.blockscout.com"],
      [11155420, "testnet-explorer.optimism.io"],
    ];
    assert.equal(issue.length, 47);
    for (const [chainId, instance] of issue) {
      assert.equal(answered.get(chainId), instance, String(chainId));
    }
  });

  it("has no entry for the instances that sent a challenge page to Node.js fetch on 2026-11-05", () => {
    for (const chainId of [137, 4663, 5042, 8453, 42161, 421614]) {
      assert.equal(answered.has(chainId), false, String(chainId));
      assert.throws(() => resolveRoute(chainId, { backend: "blockscout" }), {
        code: "unsupported-chain",
      });
    }
  });
});
