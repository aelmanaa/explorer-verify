// Tests for the routing table comparison (#60, R-RT-1). They use recorded answers of the two public
// lists, trimmed to a few chains (read on 2026-11-03), and a fake fetch: no network call.
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
import type { ChainlistEntry, Lists } from "../routing-seed.ts";

const FIXTURES = new URL("fixtures/routing/", import.meta.url);
const CHAINLIST: unknown = JSON.parse(
  readFileSync(new URL("etherscan-chainlist.json", FIXTURES), "utf8"),
);
const SOURCIFY: unknown = JSON.parse(
  readFileSync(new URL("sourcify-chains.json", FIXTURES), "utf8"),
);

/** The recorded chainlist: chains 1, 8453, 43113 and 11155111. */
const LIVE = parseChainlist(CHAINLIST);

function lists(change: Partial<Lists> = {}): Lists {
  return {
    table: {
      checked: "2026-11-03",
      rows: [1, 31, 8453, 43113, 11155111].map((chainId) => ({ chainId, backends: ["sourcify"] })),
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
    assert.equal(seed.etherscan.length, 57);
    assert.equal(seed.priorArt.length, 67);
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
    const table = { checked: "2026-11-03", rows: [{ chainId: 1, backends: ["sourcify"] }] };
    assert.deepEqual(compare(lists({ table })), [
      "table: chain 31 has no row; Sourcify supports it and it is in the prior art",
      "table: chain 8453 has no row; Sourcify supports it and it is in the Etherscan chainlist",
      "table: chain 43113 has no row; Sourcify supports it and it is in the Etherscan chainlist",
      "table: chain 11155111 has no row; Sourcify supports it and it is in the Etherscan chainlist",
    ]);
  });

  it("reports a row without Sourcify, a row Sourcify dropped and a row from neither list", () => {
    const table = {
      checked: "2026-11-03",
      rows: [
        { chainId: 1, backends: ["etherscan-v2"] },
        { chainId: 31, backends: ["sourcify"] },
        { chainId: 324, backends: ["sourcify"] },
        { chainId: 999, backends: ["sourcify"] },
        { chainId: 8453, backends: ["sourcify"] },
        { chainId: 43113, backends: ["sourcify"] },
        { chainId: 11155111, backends: ["sourcify"] },
      ],
    };
    assert.deepEqual(compare(lists({ table })), [
      "table: chain 1 has no sourcify entry; Sourcify supports it",
      "table: chain 324 is in neither the chainlist nor the prior art",
      "table: chain 999 lists sourcify, which no longer supports it",
    ]);
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
      // 8453 left the chainlist and is not prior art, so its row has no source left either.
      "table: chain 8453 is in neither the chainlist nor the prior art",
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
          checked: "2026-11-03",
          chains: [1, 31, 8453, 43113, 11155111].map((chainId) => ({
            chainId,
            backends: [{ backend: "sourcify" }],
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
      "table checked 2026-11-03; 5 rows",
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
