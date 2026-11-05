// Tests for the standalone Etherscan-compatible part of the routing table (#170, R-RT-1, decision
// 0039). They use the committed probe data, small made-up alloy-chains answers and a fake fetch: no
// network call.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ALLOY_CHAINS,
  STANDALONE_FILE,
  fetchAlloyChains,
  isApi,
  parseAlloyChains,
  parseStandaloneProbe,
  standaloneDifferences,
  withEtherscanCompatible,
} from "../routing-etherscan-compatible.ts";
import type { StandaloneProbe } from "../routing-etherscan-compatible.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (file: string): unknown => JSON.parse(readFileSync(new URL(file, ROOT), "utf8"));

const BITLAYER = {
  chainId: 200901,
  name: "Bitlayer",
  api: "api.btrscan.com/scan/api",
  explorer: "www.btrscan.com",
};
const CORE = {
  chainId: 1116,
  name: "Core",
  api: "openapi.coredao.org/api",
  explorer: "scan.coredao.org",
};
const PROBE: StandaloneProbe = { checked: "2026-11-05", hosts: [BITLAYER], leftOut: [CORE] };

const blocked: typeof globalThis.fetch = async () => new Response("no", { status: 429 });

/** Probe data as the file holds it, with `edit` applied to the first routed host. */
function data(edit: (host: Record<string, unknown>) => void = () => {}): unknown {
  const host: Record<string, unknown> = { ...BITLAYER, needsKey: false };
  edit(host);
  return { checked: "2026-11-05", hosts: [host], leftOut: [CORE] };
}

describe("routing etherscan-compatible: the probe data (R-RT-1, #170)", () => {
  it("reads the committed data: Bitlayer routed, Core and Kaia left out", () => {
    const probe = parseStandaloneProbe(read(STANDALONE_FILE));
    assert.equal(probe.checked, "2026-11-05");
    assert.deepEqual(probe.hosts, [BITLAYER]);
    assert.deepEqual(
      probe.leftOut.map((host) => host.chainId),
      [1116, 8217],
    );
  });

  it("sorts the hosts by chain id", () => {
    const probe = parseStandaloneProbe({
      checked: "2026-11-05",
      hosts: [
        { ...BITLAYER, needsKey: false },
        { ...CORE, needsKey: false },
      ],
      leftOut: [],
    });
    assert.deepEqual(
      probe.hosts.map((host) => host.chainId),
      [1116, 200901],
    );
  });

  const broken: [string, unknown, RegExp][] = [
    ["data that is not an object", null, /hosts must be a list/],
    ["hosts that are not a list", { checked: "x", hosts: {}, leftOut: [] }, /hosts must be a list/],
    ["a chain id of zero", data((h) => (h["chainId"] = 0)), /chainId must be a positive integer/],
    ["a name that is not text", data((h) => (h["name"] = 1)), /name must be text/],
    ["an api with a scheme", data((h) => (h["api"] = "https://x.example/api")), /api must be/],
    ["an api with a port", data((h) => (h["api"] = "x.example:8443/api")), /api must be/],
    ["an api with a trailing slash", data((h) => (h["api"] = "x.example/api/")), /api must be/],
    ["an upper-case api", data((h) => (h["api"] = "X.example/api")), /api must be/],
    ["an api that is not a URL", data((h) => (h["api"] = "x .example")), /api must be/],
    [
      "an explorer with a path",
      data((h) => (h["explorer"] = "x.example/a")),
      /must be a host name$/,
    ],
    ["a routed host that needs a key", data((h) => (h["needsKey"] = true)), /needsKey false/],
    ["a routed host without needsKey", data((h) => delete h["needsKey"]), /needsKey false/],
    [
      "a chain listed twice",
      { checked: "2026-11-05", hosts: [{ ...BITLAYER, needsKey: false }], leftOut: [BITLAYER] },
      /listed twice/,
    ],
    ["a date that is not text", { hosts: [], leftOut: [] }, /checked must be text/],
  ];
  for (const [label, value, problem] of broken) {
    it(`refuses ${label}`, () => {
      assert.throws(() => parseStandaloneProbe(value), problem);
    });
  }

  it("reads a chain id written as decimal text, as the other probe files allow", () => {
    const probe = parseStandaloneProbe(data((h) => (h["chainId"] = "200901")));
    assert.equal(probe.hosts[0]?.chainId, 200901);
  });

  it("isApi takes a host with or without a path", () => {
    assert.equal(isApi("api.btrscan.com/scan/api"), true);
    assert.equal(isApi("openapi.coredao.org"), true);
    assert.equal(isApi("openapi.coredao.org/"), false);
    assert.equal(isApi("a.example/x?y=1"), false);
    assert.equal(isApi("a.example/b/../api"), false);
  });
});

describe("routing etherscan-compatible: alloy-chains' list (#170)", () => {
  it("reads each chain with an https etherscanApiUrl, by chain id", () => {
    assert.deepEqual(
      parseAlloyChains({
        chains: {
          "200901": { etherscanApiUrl: "https://api.btrscan.com/scan/api" },
          "1": { etherscanApiUrl: "https://api.etherscan.io/v2/api?chainid=1" },
          "5": { name: "no api" },
          "7": { etherscanApiUrl: "http://plain.example/api" },
        },
      }),
      [
        { chainId: 1, api: "api.etherscan.io/v2/api?chainid=1" },
        { chainId: 200901, api: "api.btrscan.com/scan/api" },
      ],
    );
  });

  it("refuses another shape", () => {
    assert.throws(() => parseAlloyChains({ chains: [] }), /chains must be an object/);
    assert.throws(() => parseAlloyChains(null), /chains must be an object/);
    assert.throws(() => parseAlloyChains({ chains: { x: {} } }), /x is not a chain id/);
  });

  it("fetches the list and fails on an answer other than HTTP 200", async () => {
    const asked: string[] = [];
    const fetch: typeof globalThis.fetch = async (url) => {
      asked.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      return Response.json({
        chains: { "200901": { etherscanApiUrl: `https://${BITLAYER.api}` } },
      });
    };
    assert.deepEqual(await fetchAlloyChains(fetch), [{ chainId: 200901, api: BITLAYER.api }]);
    assert.deepEqual(asked, [ALLOY_CHAINS]);
    await assert.rejects(fetchAlloyChains(blocked), /answered HTTP 429/);
  });
});

describe("routing etherscan-compatible: the entries (R-RT-1, #170, decision 0039)", () => {
  it("adds the entry last to an existing row, and a row of its own otherwise", () => {
    const rows = withEtherscanCompatible(
      [
        { chainId: 1, backends: [{ backend: "sourcify" }] },
        { chainId: 300000, backends: [{ backend: "sourcify" }] },
      ],
      {
        ...PROBE,
        hosts: [BITLAYER, { ...BITLAYER, chainId: 1 }],
      },
    );
    assert.deepEqual(rows, [
      {
        chainId: 1,
        backends: [
          { backend: "sourcify" },
          { backend: "etherscan-compatible", api: BITLAYER.api, explorer: BITLAYER.explorer },
        ],
      },
      {
        chainId: 200901,
        backends: [
          { backend: "etherscan-compatible", api: BITLAYER.api, explorer: BITLAYER.explorer },
        ],
      },
      { chainId: 300000, backends: [{ backend: "sourcify" }] },
    ]);
  });

  it("keeps an entry the row already has, and adds none for a chain left out", () => {
    const existing = [
      {
        chainId: 200901,
        backends: [
          { backend: "etherscan-compatible", api: "x.example/api", explorer: "x.example" },
        ],
      },
    ];
    assert.deepEqual(withEtherscanCompatible(existing, PROBE), existing);
    assert.deepEqual(withEtherscanCompatible([], { ...PROBE, hosts: [] }), []);
  });
});

describe("routing etherscan-compatible: the comparison (R-RT-1, #170, decision 0039)", () => {
  const table = [
    {
      chainId: 200901,
      backends: ["etherscan-compatible"],
      standalone: { api: BITLAYER.api, explorer: BITLAYER.explorer },
    },
  ];
  const live = [
    { chainId: 1116, api: CORE.api },
    { chainId: 200901, api: BITLAYER.api },
  ];

  it("finds no difference when the table, the probe and the list agree", () => {
    assert.deepEqual(standaloneDifferences(table, PROBE, live), []);
  });

  it("reports a routed host the table lacks or lists differently", () => {
    assert.deepEqual(standaloneDifferences([], PROBE, live), [
      {
        chainId: 200901,
        text: "table: chain 200901 has no etherscan-compatible entry; api.btrscan.com/scan/api answered on 2026-11-05",
      },
    ]);
    assert.deepEqual(
      standaloneDifferences([{ chainId: 200901, backends: ["sourcify"] }], PROBE, live).length,
      1,
    );
    for (const standalone of [
      { api: "api.btrscan.com/api", explorer: BITLAYER.explorer },
      { api: BITLAYER.api, explorer: "btrscan.com" },
      undefined,
    ]) {
      assert.deepEqual(
        standaloneDifferences(
          [
            {
              chainId: 200901,
              backends: ["etherscan-compatible"],
              ...(standalone === undefined ? {} : { standalone }),
            },
          ],
          PROBE,
          live,
        ),
        [
          {
            chainId: 200901,
            text: "table: chain 200901 etherscan-compatible entry differs from the probe: api.btrscan.com/scan/api, www.btrscan.com",
          },
        ],
      );
    }
  });

  it("reports an entry the probe does not route", () => {
    const rows = [
      ...table,
      { chainId: 1116, backends: ["etherscan-compatible"], standalone: { api: CORE.api } },
    ];
    assert.deepEqual(standaloneDifferences(rows, PROBE, live), [
      {
        chainId: 1116,
        text: "table: chain 1116 lists etherscan-compatible, which the probe of 2026-11-05 does not route",
      },
    ]);
  });

  it("asks for a new probe when a probed API moved or left alloy-chains' list", () => {
    assert.deepEqual(
      standaloneDifferences(table, PROBE, [{ chainId: 200901, api: "api.btrscan.com/api" }]),
      [
        {
          chainId: 1116,
          text: "alloy-chains: chain 1116 (Core) left the list; probe it",
        },
        {
          chainId: 200901,
          text: "alloy-chains: chain 200901 (Bitlayer) moved from api.btrscan.com/scan/api to api.btrscan.com/api; probe it",
        },
      ],
    );
  });
});
