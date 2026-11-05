// Tests for the Routescan part of the routing table (#168, R-RT-1, decision 0037). They use
// Routescan's explorer lists recorded on 2026-11-05, trimmed to a few chains, the committed probe
// data and a fake fetch: no network call.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  PROBE_SPACING_MS,
  ROUTESCAN_FILE,
  ROUTESCAN_LISTS,
  fetchRoutescanList,
  parseRoutescanList,
  parseRoutescanProbe,
  probeRoutescan,
  probeUrl,
  routescanData,
  routescanDifferences,
  withRoutescan,
} from "../routing-routescan.ts";
import type { RoutescanChain, RoutescanProbe } from "../routing-routescan.ts";
import { TABLE_FILE, parseTable } from "../routing-seed.ts";

const FIXTURES = new URL("fixtures/routing/", import.meta.url);
const ROOT = new URL("../../", import.meta.url);
const read = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const MAINNET = read(new URL("routescan-mainnet.json", FIXTURES));
const TESTNET = read(new URL("routescan-testnet.json", FIXTURES));

/** The trimmed lists: 1, 10, 43114 and 68414 on mainnet; 43113, 421614 and 11155111 on testnet. */
const LISTED: RoutescanChain[] = [
  ...parseRoutescanList(MAINNET, "mainnet"),
  ...parseRoutescanList(TESTNET, "testnet"),
];

const PROBE: RoutescanProbe = {
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
};

const SERVED = Response.json({ status: "0", message: "NOTOK", result: "Verification not found" });
const REFUSED = Response.json({ status: "0", message: "chain not supported", result: null });

function fakeFetch(answers: Record<string, () => Response>, asked: string[]): typeof fetch {
  return async (request) => {
    const url = request instanceof Request ? request.url : String(request);
    asked.push(url);
    const answer = answers[url];
    return answer === undefined ? assert.fail(`unexpected request to ${url}`) : answer();
  };
}

const LIST_ANSWERS = {
  [ROUTESCAN_LISTS.mainnet]: () => Response.json(MAINNET),
  [ROUTESCAN_LISTS.testnet]: () => Response.json(TESTNET),
};

describe("routescan rows: reading the lists and the probe (R-RT-1, #168)", () => {
  it("reads each network's explorer list by evmChainId, ascending", () => {
    assert.deepEqual(
      LISTED.map((chain) => [chain.chainId, chain.network]),
      [
        [1, "mainnet"],
        [10, "mainnet"],
        [43114, "mainnet"],
        [68414, "mainnet"],
        [43113, "testnet"],
        [421614, "testnet"],
        [11155111, "testnet"],
      ],
    );
    assert.equal(LISTED.find((chain) => chain.chainId === 68414)?.name, "Henesys");
  });

  it("refuses lists and probe data of another shape", () => {
    assert.throws(
      () => parseRoutescanList({}, "mainnet"),
      /Routescan mainnet list: items must be a list/,
    );
    assert.throws(() => parseRoutescanList([], "mainnet"), /items must be a list/);
    assert.throws(
      () => parseRoutescanList({ items: [{ evmChainId: "0x1", name: "x" }] }, "testnet"),
      /Routescan testnet list: evmChainId must be a positive integer/,
    );
    assert.throws(
      () => parseRoutescanList({ items: [{ evmChainId: 5 }] }, "mainnet"),
      /name must be text/,
    );
    assert.throws(
      () => parseRoutescanProbe({ checked: "x" }),
      /Routescan probe: served must be a list/,
    );
    assert.throws(
      () =>
        parseRoutescanProbe({
          checked: "x",
          served: [{ chainId: 1, name: "a", network: "devnet" }],
          refused: [],
        }),
      /Routescan probe: network must be mainnet or testnet/,
    );
    assert.throws(
      () => parseRoutescanProbe({ served: [], refused: [] }),
      /Routescan probe: checked must be text/,
    );
  });

  it("reads the committed probe: 38 chains served, Henesys among them (#168)", () => {
    const probe = parseRoutescanProbe(read(new URL(ROUTESCAN_FILE, ROOT)));
    assert.equal(probe.checked, "2026-11-05");
    assert.equal(probe.served.length, 38);
    assert.deepEqual(
      probe.refused.map((chain) => chain.chainId),
      [10, 17000, 167008, 167009, 421614, 5278000, 11155420],
    );
    assert.deepEqual(
      probe.served.find((chain) => chain.chainId === 68414),
      { chainId: 68414, name: "Henesys", network: "mainnet" },
    );
  });

  it("fetches both lists, and fails on an answer other than HTTP 200", async () => {
    const asked: string[] = [];
    assert.deepEqual(await fetchRoutescanList(fakeFetch(LIST_ANSWERS, asked)), LISTED);
    assert.deepEqual(asked, [ROUTESCAN_LISTS.mainnet, ROUTESCAN_LISTS.testnet]);
    await assert.rejects(
      fetchRoutescanList(
        fakeFetch(
          { ...LIST_ANSWERS, [ROUTESCAN_LISTS.testnet]: () => new Response("", { status: 503 }) },
          [],
        ),
      ),
      /evm\/all\/blockchains answered HTTP 503/,
    );
  });
});

describe("routescan rows: the entries the probe gives (R-RT-1, #168, decision 0037)", () => {
  it("adds routescan last to existing rows and creates a row for a chain with none", () => {
    const rows = withRoutescan(
      [
        { chainId: 1, backends: [{ backend: "etherscan-v2" }, { backend: "sourcify" }] },
        { chainId: 31, backends: [{ backend: "sourcify" }] },
        { chainId: 43113, backends: [{ backend: "sourcify" }] },
      ],
      PROBE,
    );
    assert.deepEqual(rows, [
      {
        chainId: 1,
        backends: [
          { backend: "etherscan-v2" },
          { backend: "sourcify" },
          { backend: "routescan", network: "mainnet" },
        ],
      },
      { chainId: 31, backends: [{ backend: "sourcify" }] },
      {
        chainId: 43113,
        backends: [{ backend: "sourcify" }, { backend: "routescan", network: "testnet" }],
      },
      { chainId: 43114, backends: [{ backend: "routescan", network: "mainnet" }] },
      { chainId: 68414, backends: [{ backend: "routescan", network: "mainnet" }] },
      { chainId: 11155111, backends: [{ backend: "routescan", network: "testnet" }] },
    ]);
  });

  it("the shipped table has a routescan entry, last, for each served chain and for no other", () => {
    const table = parseTable(read(new URL(TABLE_FILE, ROOT)));
    const probe = parseRoutescanProbe(read(new URL(ROUTESCAN_FILE, ROOT)));
    assert.deepEqual(
      routescanDifferences(table.rows, probe, [...probe.served, ...probe.refused]),
      [],
    );
    assert.deepEqual(
      table.rows.find((row) => row.chainId === 68414),
      {
        chainId: 68414,
        backends: ["routescan"],
        network: "mainnet",
      },
    );
  });
});

describe("routescan rows: the comparison (R-RT-1, #168, #171)", () => {
  const rows = parseTable({ checked: "2026-11-05", chains: withRoutescan([], PROBE) }).rows;

  it("finds no difference when the table, the probe and the lists agree", () => {
    assert.deepEqual(routescanDifferences(rows, PROBE, LISTED), []);
  });

  it("reports a missing, moved, misplaced or unserved routescan entry", () => {
    const changed = [
      { chainId: 1, backends: ["sourcify"] },
      { chainId: 31, backends: ["routescan"], network: "mainnet" },
      { chainId: 43113, backends: ["routescan", "sourcify"], network: "testnet" },
      { chainId: 43114, backends: ["routescan"], network: "testnet" },
      { chainId: 68414, backends: ["routescan"] },
      ...rows.filter((row) => row.chainId === 11155111),
    ];
    assert.deepEqual(routescanDifferences(changed, PROBE, LISTED), [
      {
        chainId: 1,
        text: "table: chain 1 has no routescan entry; Routescan's API served it on 2026-11-05",
      },
      {
        chainId: 43113,
        text: "table: chain 43113 lists routescan before another backend; it comes last",
      },
      {
        chainId: 43114,
        text: "table: chain 43114 routescan network is testnet; the probe says mainnet",
      },
      {
        chainId: 68414,
        text: "table: chain 68414 routescan network is missing; the probe says mainnet",
      },
      {
        chainId: 31,
        text: "table: chain 31 lists routescan, which the probe of 2026-11-05 did not find served",
      },
    ]);
    assert.deepEqual(
      routescanDifferences(
        rows.filter((row) => row.chainId !== 68414),
        PROBE,
        LISTED,
      ),
      [
        {
          chainId: 68414,
          text: "table: chain 68414 has no routescan entry; Routescan's API served it on 2026-11-05",
        },
      ],
    );
  });

  it("reports a chain new in, moved between or gone from Routescan's lists", () => {
    const live: RoutescanChain[] = [
      ...LISTED.filter((chain) => chain.chainId !== 68414 && chain.chainId !== 10),
      { chainId: 10, name: "OP Mainnet", network: "testnet" },
      { chainId: 999, name: "New", network: "mainnet" },
    ];
    assert.deepEqual(routescanDifferences(rows, PROBE, live), [
      {
        chainId: 10,
        text: "routescan: chain 10 (OP Mainnet) moved from the mainnet list to the testnet list; probe its API",
      },
      {
        chainId: 999,
        text: "routescan: chain 999 (New) is new in the mainnet list; probe its API",
      },
      {
        chainId: 68414,
        text: "routescan: chain 68414 (Henesys) left the mainnet list; probe its API",
      },
    ]);
  });
});

describe("routescan rows: the probe (R-RT-1, #168)", () => {
  it("probes each listed chain on its network, spaced, and sorts served from refused", async () => {
    const asked: string[] = [];
    const waits: number[] = [];
    const answers: Record<string, () => Response> = { ...LIST_ANSWERS };
    for (const chain of LISTED) {
      const refused = PROBE.refused.some((each) => each.chainId === chain.chainId);
      answers[probeUrl(chain)] = () => (refused ? REFUSED.clone() : SERVED.clone());
    }
    const probe = await probeRoutescan(
      fakeFetch(answers, asked),
      async (ms) => {
        waits.push(ms);
      },
      "2026-11-05",
    );
    assert.deepEqual(probe, PROBE);
    assert.equal(asked.length, 2 + LISTED.length);
    assert.equal(
      asked[2],
      "https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api?module=contract&action=checkverifystatus&guid=abc",
    );
    assert.deepEqual(
      waits,
      Array.from({ length: LISTED.length - 1 }, () => PROBE_SPACING_MS),
    );
    assert.ok(PROBE_SPACING_MS >= 500, "Routescan's keyless tier allows 2 requests a second");
  });

  it("stops on an answer that is neither served nor refused", async () => {
    const answers: Record<string, () => Response> = {
      ...LIST_ANSWERS,
      [probeUrl(LISTED[0] ?? assert.fail())]: () =>
        Response.json({ status: "0", message: "NOTOK" }),
    };
    await assert.rejects(
      probeRoutescan(fakeFetch(answers, []), async () => {}, "2026-11-05"),
      /evm\/1\/etherscan\/api.* gave an answer that is neither served nor refused/,
    );
  });

  it("gives the research data file for a probe", () => {
    const data = routescanData(PROBE);
    assert.equal(data["checked"], "2026-11-05");
    assert.equal(
      data["request"],
      "GET https://api.routescan.io/v2/network/<network>/evm/<chain id>/etherscan/api?module=contract&action=checkverifystatus&guid=abc",
    );
    assert.deepEqual(parseRoutescanProbe(JSON.parse(JSON.stringify(data))), PROBE);
    assert.match(String(data["$comment"]), /decision 0037/);
  });
});
