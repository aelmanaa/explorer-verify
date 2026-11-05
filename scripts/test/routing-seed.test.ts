// Tests for the routing table comparison (#60, #122, R-RT-1, decision 0027). They use recorded
// answers of the two public lists, trimmed to a few chains (read on 2026-11-03), and a fake fetch:
// no network call.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  SEED_FILE,
  SOURCES,
  TABLE_FILE,
  compare,
  expectedRows,
  parseChainlist,
  parseSeed,
  parseSourcifyChains,
  parseTable,
  run,
} from "../routing-seed.ts";
import type { ChainlistEntry, Lists, TableRows } from "../routing-seed.ts";

const FIXTURES = new URL("fixtures/routing/", import.meta.url);
const CHAINLIST: unknown = JSON.parse(
  readFileSync(new URL("etherscan-chainlist.json", FIXTURES), "utf8"),
);
const SOURCIFY: unknown = JSON.parse(
  readFileSync(new URL("sourcify-chains.json", FIXTURES), "utf8"),
);

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
      rows: [1, 31, 8453, 43113, 11155111].map(rowOf),
    },
    seed: { etherscan: LIVE, priorArt: [31, 43113, 157] },
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
    assert.throws(() => parseSeed({ etherscan: [] }), /priorArt must be a list/);
  });

  it("reads the shipped table and the research data", () => {
    const root = new URL("../../", import.meta.url);
    const table = parseTable(JSON.parse(readFileSync(new URL(TABLE_FILE, root), "utf8")));
    const seed = parseSeed(JSON.parse(readFileSync(new URL(SEED_FILE, root), "utf8")));
    assert.equal(table.rows.length, 94);
    assert.equal(table.rows.filter((row) => row.backends.includes("etherscan-v2")).length, 55);
    assert.equal(seed.etherscan.length, 55);
    assert.equal(seed.priorArt.length, 67);
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
    // row has Sourcify, so the Sourcify set is the table's own chains.
    const root = new URL("../../", import.meta.url);
    const table = parseTable(JSON.parse(readFileSync(new URL(TABLE_FILE, root), "utf8")));
    const seed = parseSeed(JSON.parse(readFileSync(new URL(SEED_FILE, root), "utf8")));
    const sourcify = new Set(table.rows.map((row) => row.chainId));
    assert.deepEqual(compare({ table, seed, chainlist: seed.etherscan, sourcify }), []);
  });
});

describe("routing seed: the comparison (R-RT-1)", () => {
  it("expects a row for each Sourcify chain in the chainlist or the prior art", () => {
    // 157 is prior art but not supported by Sourcify; 324 is supported but in neither list.
    assert.deepEqual(expectedRows(lists()), [1, 31, 8453, 43113, 11155111]);
  });

  it("finds no difference when the table matches", () => {
    assert.deepEqual(compare(lists()), []);
  });

  it("reports a missing row and where the chain comes from", () => {
    const table = { checked: "2026-11-04", rows: [rowOf(1)] };
    assert.deepEqual(compare(lists({ table })), [
      "table: chain 31 has no row; Sourcify supports it and it is in the prior art",
      "table: chain 8453 has no row; Sourcify supports it and it is in the Etherscan chainlist",
      "table: chain 43113 has no row; Sourcify supports it and it is in the Etherscan chainlist",
      "table: chain 11155111 has no row; Sourcify supports it and it is in the Etherscan chainlist",
    ]);
  });

  it("reports a row without Sourcify, a row Sourcify dropped and a row from neither list", () => {
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
      "table: chain 324 is in neither the chainlist nor the prior art",
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
            rows: [rowOf(1), rowOf(31), paidOnly, rowOf(43113), rowOf(11155111)],
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

/** A fetch that answers from `answers` by URL and records each URL asked. */
function fakeFetch(answers: Record<string, Response>, asked: string[]): typeof globalThis.fetch {
  return async (request) => {
    const url = request instanceof Request ? request.url : String(request);
    asked.push(url);
    return answers[url] ?? assert.fail(`unexpected request to ${url}`);
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
          schemaVersion: 2,
          checked: "2026-11-04",
          chains: [1, 31, 8453, 43113, 11155111].map(rowOf).map((row) => ({
            chainId: row.chainId,
            backends: row.backends.map((backend) =>
              backend === "etherscan-v2" ? { backend, explorer: row.explorer } : { backend },
            ),
          })),
        },
      ],
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

  it("fetches the two lists, compares and notes what it did not compare", async () => {
    const asked: string[] = [];
    const result = await run(
      root,
      fakeFetch(
        {
          [SOURCES.etherscanChainlist]: Response.json(CHAINLIST),
          [SOURCES.sourcifyChains]: Response.json(SOURCIFY),
        },
        asked,
      ),
    );
    assert.deepEqual(asked.toSorted(), [SOURCES.etherscanChainlist, SOURCES.sourcifyChains]);
    assert.deepEqual(result.differences, []);
    assert.deepEqual(result.notes, [
      "table checked 2026-11-04; 5 rows",
      "routescan: not compared; its supported-chains page has no machine-readable list (see the research note)",
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
          },
          [],
        ),
      ),
      /https:\/\/api\.etherscan\.io\/v2\/chainlist answered HTTP 403/,
    );
  });
});
