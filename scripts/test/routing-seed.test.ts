// Tests for the routing table comparison (#60, #122, #166, R-RT-1, decisions 0027 and 0036). They use recorded
// answers of the two public lists, trimmed to a few chains (read on 2026-11-03), and a fake fetch:
// no network call.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  BLOCKSCOUT_FILE,
  BLOCKSCOUT_REGISTRY,
  blockscoutInstances,
  parseBlockscoutProbe,
  withBlockscout,
} from "../routing-blockscout.ts";
import {
  ALLOY_CHAINS,
  STANDALONE_FILE,
  parseStandaloneProbe,
  withEtherscanCompatible,
} from "../routing-etherscan-compatible.ts";
import { ROUTESCAN_FILE, ROUTESCAN_LISTS, withRoutescan } from "../routing-routescan.ts";
import {
  SEED_FILE,
  SOURCES,
  TABLE_FILE,
  compare,
  differences,
  expectedRows,
  fetchLists,
  output,
  parseChainlist,
  parseSeed,
  parseSourcifyChains,
  parseTable,
  run,
  tableOf,
} from "../routing-seed.ts";
import type { ChainlistEntry, Lists, RunResult, TableRows } from "../routing-seed.ts";

const FIXTURES = new URL("fixtures/routing/", import.meta.url);
const CHAINLIST: unknown = JSON.parse(
  readFileSync(new URL("etherscan-chainlist.json", FIXTURES), "utf8"),
);
const SOURCIFY: unknown = JSON.parse(
  readFileSync(new URL("sourcify-chains.json", FIXTURES), "utf8"),
);

/** Routescan's explorer lists, recorded on 2026-11-05 and trimmed to 4 and 3 chains. */
const ROUTESCAN_MAINNET: unknown = JSON.parse(
  readFileSync(new URL("routescan-mainnet.json", FIXTURES), "utf8"),
);
const ROUTESCAN_TESTNET: unknown = JSON.parse(
  readFileSync(new URL("routescan-testnet.json", FIXTURES), "utf8"),
);
/** A probe of those lists: chains 10 and 421614 answered `chain not supported`. */
const PROBE = {
  checked: "2026-11-05",
  served: [
    { chainId: 1, name: "Ethereum", network: "mainnet" },
    { chainId: 43113, name: "C-Chain Fuji", network: "testnet" },
    { chainId: 43114, name: "C-Chain", network: "mainnet" },
    { chainId: 68414, name: "Henesys", network: "mainnet" },
    { chainId: 11155111, name: "Sepolia", network: "testnet" },
  ],
  refused: [
    { chainId: 10, name: "OP Mainnet", network: "mainnet" },
    { chainId: 421614, name: "Arbitrum Sepolia", network: "testnet" },
  ],
} as const;

/** The recorded chainlist: chains 1, 8453, 43113 and 11155111. */
const LIVE = parseChainlist(CHAINLIST);

/**
 * The row the rules give `chainId`: Sourcify, and for a chainlist chain an `etherscan-v2` entry
 * with its explorer host, first on the free tier and after Sourcify on a paid plan.
 */
function rowOf(chainId: number): TableRows["rows"][number] {
  const chain = LIVE.find((each) => each.chainId === chainId);
  if (chain === undefined) {
    return { chainId, backends: ["sourcify"] };
  }
  return {
    chainId,
    backends: chain.paidPlan ? ["sourcify", "etherscan-v2"] : ["etherscan-v2", "sourcify"],
    explorer: chain.explorer,
  };
}

function lists(change: Partial<Lists> = {}): Lists {
  return {
    table: {
      checked: "2026-11-04",
      rows: [1, 31, 324, 8453, 43113, 11155111].map(rowOf),
    },
    seed: { etherscan: LIVE },
    chainlist: LIVE,
    sourcify: parseSourcifyChains(SOURCIFY),
    ...change,
  };
}

describe("routing seed: parsing the recorded lists (R-RT-1)", () => {
  it("reads the chainlist's ids, explorer hosts and paid-plan comments", () => {
    assert.deepEqual(LIVE, [
      { chainId: 1, name: "Ethereum Mainnet", explorer: "etherscan.io", paidPlan: false },
      { chainId: 8453, name: "Base Mainnet", explorer: "basescan.org", paidPlan: true },
      {
        chainId: 43113,
        name: "Avalanche Fuji Testnet",
        explorer: "testnet.snowscan.xyz",
        paidPlan: true,
      },
      {
        chainId: 11155111,
        name: "Sepolia Testnet",
        explorer: "sepolia.etherscan.io",
        paidPlan: false,
      },
    ]);
  });

  it("reads the chain ids Sourcify supports", () => {
    assert.deepEqual(
      [...parseSourcifyChains(SOURCIFY)].toSorted((a, b) => a - b),
      [1, 31, 324, 8453, 43113, 11155111],
    );
    assert.deepEqual(
      [
        ...parseSourcifyChains([
          { chainId: 5, supported: false },
          { chainId: 7, supported: true },
        ]),
      ],
      [7],
    );
  });

  it("refuses answers of another shape", () => {
    assert.throws(
      () => parseChainlist({ result: {} }),
      /Etherscan chainlist: result must be a list/,
    );
    assert.throws(() => parseChainlist([]), /result must be a list/);
    assert.throws(
      () => parseChainlist({ result: [{ chainid: "x" }] }),
      /chainid must be a positive integer/,
    );
    assert.throws(
      () => parseChainlist({ result: [{ chainid: "1", chainname: 1 }] }),
      /chainname must be text/,
    );
    assert.throws(() => parseSourcifyChains({}), /Sourcify chains: the answer must be a list/);
    assert.throws(
      () => parseSourcifyChains([{ chainId: 0, supported: true }]),
      /chainId must be a positive integer/,
    );
    assert.throws(() => parseTable({ checked: "2026-11-03" }), /chains must be a list/);
    assert.throws(() => parseSeed({ priorArt: [] }), /research data: etherscan must be a list/);
  });

  it("reads the shipped table and the research data", () => {
    const root = new URL("../../", import.meta.url);
    const table = parseTable(JSON.parse(readFileSync(new URL(TABLE_FILE, root), "utf8")));
    const seed = parseSeed(JSON.parse(readFileSync(new URL(SEED_FILE, root), "utf8")));
    assert.equal(table.rows.length, 326);
    assert.equal(table.rows.filter((row) => row.backends.includes("etherscan-v2")).length, 55);
    assert.deepEqual(
      table.rows.filter((row) => row.backends.includes("etherscan-compatible")),
      [
        {
          chainId: 200_901,
          backends: ["etherscan-compatible"],
          standalone: { api: "api.btrscan.com/scan/api", explorer: "www.btrscan.com" },
        },
      ],
    );
    assert.equal(table.rows.filter((row) => row.backends.includes("routescan")).length, 38);
    assert.equal(table.rows.filter((row) => row.backends.includes("blockscout")).length, 111);
    assert.equal(seed.etherscan.length, 55);
  });

  it("reads the explorer host of a row's etherscan-v2 entry", () => {
    const table = parseTable({
      checked: "2026-11-04",
      chains: [
        { chainId: 1, backends: [{ backend: "etherscan-v2", explorer: "etherscan.io" }] },
        { chainId: 2, backends: [{ backend: "etherscan-v2" }, { backend: "sourcify" }] },
        { chainId: 3, backends: [{ backend: "sourcify", explorer: "x.example" }] },
      ],
    });
    assert.deepEqual(table.rows, [
      { chainId: 1, backends: ["etherscan-v2"], explorer: "etherscan.io" },
      { chainId: 2, backends: ["etherscan-v2", "sourcify"] },
      { chainId: 3, backends: ["sourcify"] },
    ]);
  });

  it("finds no missing or stale etherscan-v2 entry in the shipped table, against the chainlist of 2026-11-04 (R-RT-1, #122)", () => {
    // The chainlist read on 2026-11-04 equals the research data's frozen copy of 2026-11-03 (see
    // the research note of 2026-11-04), so the frozen copy stands in for the live answer. Every
    // row but the Routescan-only ones has Sourcify, so the Sourcify set is those rows' chains.
    const root = new URL("../../", import.meta.url);
    const table = parseTable(JSON.parse(readFileSync(new URL(TABLE_FILE, root), "utf8")));
    const seed = parseSeed(JSON.parse(readFileSync(new URL(SEED_FILE, root), "utf8")));
    const sourcify = new Set(
      table.rows.filter((row) => row.backends.includes("sourcify")).map((row) => row.chainId),
    );
    assert.deepEqual(compare({ table, seed, chainlist: seed.etherscan, sourcify }), []);
  });
});

describe("routing seed: the comparison (R-RT-1)", () => {
  it("expects a row for each chain Sourcify supports (#166)", () => {
    // 324 is in neither the chainlist nor the prior art; Sourcify supports it, so it gets a row
    // (#166, decision 0036).
    assert.deepEqual(expectedRows(lists()), [1, 31, 324, 8453, 43113, 11155111]);
  });

  it("finds no difference when the table matches", () => {
    assert.deepEqual(compare(lists()), []);
  });

  it("reports a missing row for each chain Sourcify supports (#166)", () => {
    const table = { checked: "2026-11-04", rows: [rowOf(1)] };
    assert.deepEqual(compare(lists({ table })), [
      "table: chain 31 has no row; Sourcify supports it",
      "table: chain 324 has no row; Sourcify supports it",
      "table: chain 8453 has no row; Sourcify supports it",
      "table: chain 43113 has no row; Sourcify supports it",
      "table: chain 11155111 has no row; Sourcify supports it",
    ]);
  });

  it("reports a row without Sourcify and a row Sourcify dropped", () => {
    const table = {
      checked: "2026-11-04",
      rows: [
        { chainId: 1, backends: ["etherscan-v2"], explorer: "etherscan.io" },
        rowOf(31),
        rowOf(324),
        rowOf(999),
        rowOf(8453),
        rowOf(43113),
        rowOf(11155111),
      ],
    };
    assert.deepEqual(compare(lists({ table })), [
      "table: chain 1 has no sourcify entry; Sourcify supports it",
      "table: chain 999 lists sourcify, which no longer supports it",
    ]);
  });

  it("reports a missing, moved, misplaced or stale etherscan-v2 entry (#122, decision 0027)", () => {
    const table = {
      checked: "2026-11-04",
      rows: [
        // Free tier, explorer host missing.
        { chainId: 1, backends: ["etherscan-v2", "sourcify"] },
        rowOf(31),
        rowOf(324),
        // Paid plan, Etherscan first.
        { chainId: 8453, backends: ["etherscan-v2", "sourcify"], explorer: "basescan.org" },
        // Paid plan, no etherscan-v2 entry.
        { chainId: 43113, backends: ["sourcify"] },
        // Free tier, Etherscan second, another explorer host.
        { chainId: 11155111, backends: ["sourcify", "etherscan-v2"], explorer: "x.example" },
      ],
    };
    assert.deepEqual(compare(lists({ table })), [
      "table: chain 1 etherscan-v2 explorer is missing; the chainlist says etherscan.io",
      "table: chain 8453 lists etherscan-v2 before sourcify; it needs a paid plan",
      "table: chain 43113 has no etherscan-v2 entry; it is in the Etherscan chainlist",
      "table: chain 11155111 etherscan-v2 explorer is x.example; the chainlist says sepolia.etherscan.io",
      "table: chain 11155111 lists etherscan-v2 after another backend; it is free-tier",
    ]);
    // A paid-plan row without Sourcify: the missing Sourcify entry, and Etherscan with nothing
    // before it.
    const paidOnly = { chainId: 8453, backends: ["etherscan-v2"], explorer: "basescan.org" };
    assert.deepEqual(
      compare(
        lists({
          table: {
            checked: "2026-11-04",
            rows: [rowOf(1), rowOf(31), rowOf(324), paidOnly, rowOf(43113), rowOf(11155111)],
          },
        }),
      ),
      [
        "table: chain 8453 has no sourcify entry; Sourcify supports it",
        "table: chain 8453 lists etherscan-v2 with no sourcify entry first; it needs a paid plan",
      ],
    );
  });

  it("reports chainlist changes against the frozen copy", () => {
    const moved: ChainlistEntry[] = LIVE.flatMap((chain) =>
      chain.chainId === 8453
        ? []
        : chain.chainId === 1
          ? [{ ...chain, paidPlan: true, explorer: "etherscan.example" }]
          : chain.chainId === 43113
            ? [{ ...chain, paidPlan: false }]
            : [chain],
    );
    const added: ChainlistEntry = {
      chainId: 31,
      name: "Rootstock",
      explorer: "x.example",
      paidPlan: false,
    };
    assert.deepEqual(compare(lists({ chainlist: [...moved, added] })), [
      // The table still has the rows the old list gave: each change shows in the etherscan-v2
      // entries too.
      "table: chain 1 etherscan-v2 explorer is etherscan.io; the chainlist says etherscan.example",
      "table: chain 1 lists etherscan-v2 before sourcify; it needs a paid plan",
      "table: chain 31 has no etherscan-v2 entry; it is in the Etherscan chainlist",
      "table: chain 8453 lists etherscan-v2, which the chainlist no longer lists",
      "table: chain 43113 lists etherscan-v2 after another backend; it is free-tier",
      "etherscan: chain 1 now needs a paid plan",
      "etherscan: chain 1 explorer moved from etherscan.io to etherscan.example",
      "etherscan: chain 43113 is now free-tier",
      "etherscan: chain 31 (Rootstock) is new in the chainlist",
      "etherscan: chain 8453 left the chainlist",
    ]);
  });
});

describe("routing seed: the chain and list of each difference (R-RT-1, #171)", () => {
  it("gives each line its chain and the list it changed in, in the order compare() returns", () => {
    const table = {
      checked: "2026-11-04",
      rows: [
        { chainId: 1, backends: ["etherscan-v2"], explorer: "etherscan.io" },
        rowOf(8453),
        rowOf(324),
        rowOf(999),
        rowOf(43113),
        rowOf(11155111),
      ],
    };
    const changed = lists({ table, chainlist: LIVE.filter((chain) => chain.chainId !== 43113) });
    const found = differences(changed);
    assert.deepEqual(
      found.map((difference) => difference.text),
      compare(changed),
    );
    assert.deepEqual(
      found.map(({ chainId, list, text }) => `${String(chainId)} | ${list} | ${text}`),
      [
        "1 | Sourcify chain list | table: chain 1 has no sourcify entry; Sourcify supports it",
        "31 | Sourcify chain list | table: chain 31 has no row; Sourcify supports it",
        "999 | Sourcify chain list | table: chain 999 lists sourcify, which no longer supports it",
        "43113 | Etherscan chainlist | table: chain 43113 lists etherscan-v2, which the chainlist no longer lists",
        "43113 | Etherscan chainlist | etherscan: chain 43113 left the chainlist",
      ],
    );
  });
});

describe("routing seed: the command's output (R-RT-1, #171)", () => {
  const result: RunResult = {
    checked: "2026-11-04",
    notes: ["table checked 2026-11-04; 5 rows"],
    differences: [
      { chainId: 1, list: "Etherscan chainlist", text: "etherscan: chain 1 now needs a paid plan" },
    ],
  };

  it("prints the notes, each difference and a count as text, and exits 1 on a difference", () => {
    assert.deepEqual(output(result, false), {
      text: "table checked 2026-11-04; 5 rows\netherscan: chain 1 now needs a paid plan\nrouting table: 1 differences\n",
      exitCode: 1,
    });
    assert.deepEqual(output({ ...result, differences: [] }, false), {
      text: "table checked 2026-11-04; 5 rows\nrouting table: no differences\n",
      exitCode: 0,
    });
  });

  it("prints JSON with the date, notes and differences, and exits 0 either way (#171)", () => {
    const printed = output(result, true);
    assert.equal(printed.exitCode, 0);
    assert.deepEqual(JSON.parse(printed.text), result);
    assert.ok(printed.text.endsWith("}\n"));
  });
});

/** A fetch that answers from `answers` by URL and records each URL asked. */
function fakeFetch(answers: Record<string, Response>, asked: string[]): typeof globalThis.fetch {
  return async (request) => {
    const url = request instanceof Request ? request.url : String(request);
    asked.push(url);
    return answers[url] ?? assert.fail(`unexpected request to ${url}`);
  };
}

/** A Blockscout probe of one instance, and the registry answer that lists it (#169). */
const BLOCKSCOUT_PROBE = {
  checked: "2026-11-05",
  instances: [
    {
      chainId: 31,
      name: "Rootstock Testnet",
      source: "registry",
      listed: "rootstock-testnet.blockscout.com",
      instance: "rootstock-testnet.blockscout.com",
    },
  ],
};
/** A standalone probe of one API, and alloy-chains' answer that lists it (#170). */
const STANDALONE_PROBE = {
  checked: "2026-11-05",
  hosts: [
    {
      chainId: 200901,
      name: "Bitlayer",
      api: "api.btrscan.com/scan/api",
      explorer: "www.btrscan.com",
      needsKey: false,
    },
  ],
  leftOut: [],
};
const ALLOY = {
  chains: {
    "1": { etherscanApiUrl: "https://api.etherscan.io/v2/api?chainid=1" },
    "200901": { etherscanApiUrl: "https://api.btrscan.com/scan/api" },
  },
};
const REGISTRY = {
  "1": { name: "Ethereum", explorers: [{ url: "https://etherscan.io/", hostedBy: "self" }] },
  "31": {
    name: "Rootstock Testnet",
    explorers: [{ url: "https://rootstock-testnet.blockscout.com/", hostedBy: "blockscout" }],
  },
};

/** The answers of Routescan's two explorer lists, with another mainnet answer when given. */
function routescanAnswers(mainnet: unknown = ROUTESCAN_MAINNET): Record<string, Response> {
  return {
    [ROUTESCAN_LISTS.mainnet]: Response.json(mainnet),
    [ROUTESCAN_LISTS.testnet]: Response.json(ROUTESCAN_TESTNET),
  };
}

describe("routing seed: run() with a fake fetch (R-RT-1)", () => {
  let root = "";
  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "routing-seed-"));
    for (const [file, value] of [
      [
        TABLE_FILE,
        {
          schemaVersion: 3,
          checked: "2026-11-04",
          chains: withRoutescan(
            withEtherscanCompatible(
              withBlockscout(
                [1, 31, 324, 8453, 43113, 11155111].map(rowOf).map((row) => ({
                  chainId: row.chainId,
                  backends: row.backends.map((backend) =>
                    backend === "etherscan-v2" ? { backend, explorer: row.explorer } : { backend },
                  ),
                })),
                blockscoutInstances(parseBlockscoutProbe(BLOCKSCOUT_PROBE)),
                new Set([8453, 43113]),
              ),
              parseStandaloneProbe(STANDALONE_PROBE),
            ),
            PROBE,
          ),
        },
      ],
      [ROUTESCAN_FILE, PROBE],
      [BLOCKSCOUT_FILE, BLOCKSCOUT_PROBE],
      [STANDALONE_FILE, STANDALONE_PROBE],
      [
        SEED_FILE,
        {
          etherscan: LIVE,
          priorArt: [{ chainId: 31 }, { chainId: 43113 }],
        },
      ],
    ] as const) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), JSON.stringify(value));
    }
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("fetches the six lists, compares and notes what it compared (#168, #169, #170)", async () => {
    const asked: string[] = [];
    const result = await run(
      root,
      fakeFetch(
        {
          [SOURCES.etherscanChainlist]: Response.json(CHAINLIST),
          [SOURCES.sourcifyChains]: Response.json(SOURCIFY),
          [BLOCKSCOUT_REGISTRY]: Response.json(REGISTRY),
          [ALLOY_CHAINS]: Response.json(ALLOY),
          ...routescanAnswers(),
        },
        asked,
      ),
    );
    assert.deepEqual(asked.toSorted(), [
      SOURCES.etherscanChainlist,
      ROUTESCAN_LISTS.mainnet,
      ROUTESCAN_LISTS.testnet,
      BLOCKSCOUT_REGISTRY,
      ALLOY_CHAINS,
      SOURCES.sourcifyChains,
    ]);
    assert.deepEqual(result.differences, []);
    assert.equal(result.checked, "2026-11-04");
    assert.deepEqual(result.notes, [
      "table checked 2026-11-04; 9 rows",
      "routescan: entries compared with the API probe of 2026-11-05, and that probe with Routescan's explorer lists",
      "blockscout: entries compared with the instance probe of 2026-11-05, and that probe with Blockscout's chain registry",
      "etherscan-compatible: entries compared with the API probe of 2026-11-05, and that probe with alloy-chains' list",
    ]);
  });

  it("reports a standalone difference with alloy-chains' list (#170, decision 0039)", async () => {
    const result = await run(
      root,
      fakeFetch(
        {
          [SOURCES.etherscanChainlist]: Response.json(CHAINLIST),
          [SOURCES.sourcifyChains]: Response.json(SOURCIFY),
          [BLOCKSCOUT_REGISTRY]: Response.json(REGISTRY),
          [ALLOY_CHAINS]: Response.json({
            chains: { "200901": { etherscanApiUrl: "https://api.btrscan.com/api" } },
          }),
          ...routescanAnswers(),
        },
        [],
      ),
    );
    assert.deepEqual(result.differences, [
      {
        chainId: 200901,
        list: "alloy-chains list",
        text: "alloy-chains: chain 200901 (Bitlayer) moved from api.btrscan.com/scan/api to api.btrscan.com/api; probe it",
      },
    ]);
  });

  it("reports a Routescan difference with Routescan's list (#168, decision 0037)", async () => {
    const result = await run(
      root,
      fakeFetch(
        {
          [SOURCES.etherscanChainlist]: Response.json(CHAINLIST),
          [SOURCES.sourcifyChains]: Response.json(SOURCIFY),
          [BLOCKSCOUT_REGISTRY]: Response.json(REGISTRY),
          [ALLOY_CHAINS]: Response.json(ALLOY),
          ...routescanAnswers({ items: [] }),
        },
        [],
      ),
    );
    assert.deepEqual(
      result.differences.map((difference) => [difference.chainId, difference.list]),
      [
        [1, "Routescan chain list"],
        [43114, "Routescan chain list"],
        [68414, "Routescan chain list"],
      ],
    );
  });

  it("reports a Blockscout difference with the registry (#169, decision 0038)", async () => {
    const result = await run(
      root,
      fakeFetch(
        {
          [SOURCES.etherscanChainlist]: Response.json(CHAINLIST),
          [SOURCES.sourcifyChains]: Response.json(SOURCIFY),
          [BLOCKSCOUT_REGISTRY]: Response.json({}),
          [ALLOY_CHAINS]: Response.json(ALLOY),
          ...routescanAnswers(),
        },
        [],
      ),
    );
    assert.deepEqual(result.differences, [
      {
        chainId: 31,
        list: "Blockscout chain registry",
        text: "blockscout: chain 31 (Rootstock Testnet) left the registry; probe it",
      },
    ]);
  });

  it("fails on an answer other than HTTP 200", async () => {
    await assert.rejects(
      run(
        root,
        fakeFetch(
          {
            [SOURCES.etherscanChainlist]: new Response("blocked", { status: 403 }),
            [SOURCES.sourcifyChains]: Response.json(SOURCIFY),
            [BLOCKSCOUT_REGISTRY]: Response.json(REGISTRY),
            [ALLOY_CHAINS]: Response.json(ALLOY),
            ...routescanAnswers(),
          },
          [],
        ),
      ),
      /https:\/\/api\.etherscan\.io\/v2\/chainlist answered HTTP 403/,
    );
  });
});

describe("routing seed: the table the rules give (R-RT-1, #166, decision 0036)", () => {
  it("gives every Sourcify chain a row, with etherscan-v2 by the chain's plan", () => {
    const table = tableOf(
      { chainlist: LIVE, sourcify: parseSourcifyChains(SOURCIFY) },
      "2026-11-05",
    );
    assert.deepEqual(table, {
      schemaVersion: 3,
      checked: "2026-11-05",
      chains: [
        {
          chainId: 1,
          backends: [
            { backend: "etherscan-v2", explorer: "etherscan.io" },
            { backend: "sourcify" },
          ],
        },
        { chainId: 31, backends: [{ backend: "sourcify" }] },
        { chainId: 324, backends: [{ backend: "sourcify" }] },
        {
          chainId: 8453,
          backends: [
            { backend: "sourcify" },
            { backend: "etherscan-v2", explorer: "basescan.org" },
          ],
        },
        {
          chainId: 43113,
          backends: [
            { backend: "sourcify" },
            { backend: "etherscan-v2", explorer: "testnet.snowscan.xyz" },
          ],
        },
        {
          chainId: 11155111,
          backends: [
            { backend: "etherscan-v2", explorer: "sepolia.etherscan.io" },
            { backend: "sourcify" },
          ],
        },
      ],
    });
  });

  it("builds a table the comparison finds no difference in", () => {
    const live = { chainlist: LIVE, sourcify: parseSourcifyChains(SOURCIFY) };
    const table = parseTable(tableOf(live, "2026-11-05"));
    assert.deepEqual(compare({ ...live, table, seed: { etherscan: LIVE } }), []);
  });

  it("gives a chainlist chain Sourcify does not support an etherscan-v2 row, free tier or paid plan", () => {
    // Only 31 is supported here: 1 and 11155111 are free-tier, 8453 and 43113 need a paid plan.
    const live = { chainlist: LIVE, sourcify: new Set([31]) };
    const table = tableOf(live, "2026-11-05");
    assert.deepEqual(table.chains, [
      { chainId: 1, backends: [{ backend: "etherscan-v2", explorer: "etherscan.io" }] },
      { chainId: 31, backends: [{ backend: "sourcify" }] },
      { chainId: 8453, backends: [{ backend: "etherscan-v2", explorer: "basescan.org" }] },
      { chainId: 43113, backends: [{ backend: "etherscan-v2", explorer: "testnet.snowscan.xyz" }] },
      {
        chainId: 11155111,
        backends: [{ backend: "etherscan-v2", explorer: "sepolia.etherscan.io" }],
      },
    ]);
    // The comparison accepts those rows, paid-plan ones included, and reports one that is missing.
    const parsed = parseTable(table);
    assert.deepEqual(compare({ ...live, table: parsed, seed: { etherscan: LIVE } }), []);
    const without = { ...parsed, rows: parsed.rows.filter((row) => row.chainId !== 8453) };
    assert.deepEqual(differences({ ...live, table: without, seed: { etherscan: LIVE } }), [
      {
        chainId: 8453,
        list: "Etherscan chainlist",
        text: "table: chain 8453 has no row; it is in the Etherscan chainlist",
      },
    ]);
  });

  it("fetches both lists with fetchLists()", async () => {
    const asked: string[] = [];
    const live = await fetchLists(
      fakeFetch(
        {
          [SOURCES.etherscanChainlist]: Response.json(CHAINLIST),
          [SOURCES.sourcifyChains]: Response.json(SOURCIFY),
        },
        asked,
      ),
    );
    assert.deepEqual(asked.toSorted(), [SOURCES.etherscanChainlist, SOURCES.sourcifyChains]);
    assert.deepEqual(live.chainlist, LIVE);
    assert.deepEqual(
      [...live.sourcify].toSorted((a, b) => a - b),
      [1, 31, 324, 8453, 43113, 11155111],
    );
  });
});
