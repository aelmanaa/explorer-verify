// Tests for the Blockscout part of the routing table (#169, R-RT-1, decision 0038). They use the
// committed probe data, small made-up registry answers and a fake fetch: no network call.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  BLOCKSCOUT_FILE,
  BLOCKSCOUT_REGISTRY,
  blockscoutDifferences,
  blockscoutInstances,
  fetchBlockscoutRegistry,
  parseBlockscoutProbe,
  parseBlockscoutRegistry,
  withBlockscout,
} from "../routing-blockscout.ts";
import type { BlockscoutProbe, RegistryExplorer } from "../routing-blockscout.ts";
import {
  STANDALONE_FILE,
  parseStandaloneProbe,
  withEtherscanCompatible,
} from "../routing-etherscan-compatible.ts";
import { ROUTESCAN_FILE, parseRoutescanProbe, withRoutescan } from "../routing-routescan.ts";
import { SEED_FILE, TABLE_FILE, parseSeed, parseTable } from "../routing-seed.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (file: string): unknown => JSON.parse(readFileSync(new URL(file, ROOT), "utf8"));

/** A `table.json` entry other than Blockscout's and Routescan's. */
type BaseEntry = { backend: "sourcify" } | { backend: "etherscan-v2"; explorer: string };

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function listOf(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

/** One candidate of the probe data, with the fields the parser reads. */
function candidate(
  chainId: number,
  instance: string | null,
  source = "registry",
  listed = instance ?? "x.example",
): Record<string, unknown> {
  return { chainId, name: `Chain ${String(chainId)}`, source, listed, instance };
}

const PROBE: BlockscoutProbe = parseBlockscoutProbe({
  checked: "2026-11-05",
  instances: [
    candidate(1, "eth.blockscout.com"),
    candidate(10, "explorer.optimism.io"),
    candidate(137, null, "registry", "polygon.blockscout.com"),
    candidate(1313161554, "explorer.mainnet.aurora.dev", "hardhat"),
  ],
});

const REGISTRY: RegistryExplorer[] = [
  { chainId: 1, name: "Ethereum", host: "eth.blockscout.com" },
  { chainId: 10, name: "OP Mainnet", host: "explorer.optimism.io" },
  { chainId: 137, name: "Polygon PoS", host: "polygon.blockscout.com" },
];

/** Parses probe data of the given candidates. */
function parse(instances: unknown): BlockscoutProbe {
  return parseBlockscoutProbe({ checked: "2026-11-05", instances });
}

describe("routing blockscout: the probe data (R-RT-1, #169)", () => {
  it("reads every candidate, and the host of each that answered", () => {
    assert.equal(PROBE.checked, "2026-11-05");
    assert.deepEqual(
      PROBE.candidates.map((each) => [each.chainId, each.source, each.instance]),
      [
        [1, "registry", "eth.blockscout.com"],
        [10, "registry", "explorer.optimism.io"],
        [137, "registry", undefined],
        [1313161554, "hardhat", "explorer.mainnet.aurora.dev"],
      ],
    );
    assert.deepEqual(
      blockscoutInstances(PROBE),
      new Map([
        [1, "eth.blockscout.com"],
        [10, "explorer.optimism.io"],
        [1313161554, "explorer.mainnet.aurora.dev"],
      ]),
    );
  });

  it("refuses data of another shape", () => {
    assert.throws(() => parseBlockscoutProbe({}), /Blockscout probe: instances must be a list/);
    assert.throws(
      () => parseBlockscoutProbe({ instances: [] }),
      /Blockscout probe: checked must be text/,
    );
    assert.throws(() => parse([candidate(0, null)]), /chainId must be a positive integer/);
    assert.throws(
      () => parse([candidate(1, null, "elsewhere")]),
      /chain 1 source must be one of registry, hardhat, registry-self-hosted/,
    );
    assert.throws(
      () => parse([candidate(1, null, "registry", "x.example/api")]),
      /listed must be a host name/,
    );
    for (const instance of [
      undefined,
      1,
      "",
      "https://eth.blockscout.com",
      "eth.blockscout.com/api",
      "eth.blockscout.com:443",
      "eth.blockscout.com:8443",
      "Eth.Blockscout.com",
      "user@eth.blockscout.com",
      "eth blockscout",
    ]) {
      assert.throws(
        () => parse([{ ...candidate(1, null), instance }]),
        /Blockscout probe: chain 1 instance must be a host name or null/,
        String(instance),
      );
    }
    assert.throws(
      () => parse([candidate(1, "a.example"), candidate(1, "b.example")]),
      /Blockscout probe: chain 1 is listed twice/,
    );
    assert.throws(() => parse([{ ...candidate(1, null), name: 1 }]), /name must be text/);
  });

  it("reads the committed probe: 125 candidates, 111 that answered", () => {
    const probe = parseBlockscoutProbe(read(BLOCKSCOUT_FILE));
    assert.equal(probe.candidates.length, 125);
    assert.equal(blockscoutInstances(probe).size, 111);
  });
});

describe("routing blockscout: the registry (R-RT-1, #169)", () => {
  it("keeps the first explorer hosted by Blockscout of each chain, by host", () => {
    assert.deepEqual(
      parseBlockscoutRegistry({
        "10": {
          name: "OP Mainnet",
          explorers: [
            { url: "https://optimistic.etherscan.io/", hostedBy: "self" },
            { url: "https://explorer.optimism.io/", hostedBy: "Blockscout" },
            { url: "https://other.example/", hostedBy: "blockscout" },
          ],
        },
        "1": {
          name: "Ethereum",
          explorers: [{ url: "https://eth.blockscout.com/", hostedBy: "blockscout" }],
        },
        "5": { name: "Self", explorers: [{ url: "https://self.example/", hostedBy: "self" }] },
        "6": { explorers: "none" },
        "7": { explorers: [{ url: "https://seven.example/", hostedBy: "blockscout" }] },
        "8": { name: "No host field", explorers: [{ url: "https://eight.example/" }] },
      }),
      [
        { chainId: 1, name: "Ethereum", host: "eth.blockscout.com" },
        { chainId: 7, name: "", host: "seven.example" },
        { chainId: 10, name: "OP Mainnet", host: "explorer.optimism.io" },
      ],
    );
  });

  it("refuses an answer of another shape", () => {
    for (const value of [[], null, "x"]) {
      assert.throws(
        () => parseBlockscoutRegistry(value),
        /Blockscout registry: the answer must be an object keyed by chain id/,
      );
    }
    assert.throws(
      () => parseBlockscoutRegistry({ abc: {} }),
      /Blockscout registry: abc is not a chain id/,
    );
    assert.throws(
      () => parseBlockscoutRegistry({ "1": { explorers: [{ hostedBy: "blockscout" }] } }),
      /Blockscout registry: url must be text/,
    );
  });

  it("fetches the registry, and fails on an answer other than HTTP 200", async () => {
    const asked: string[] = [];
    const fake =
      (body: unknown, status: number): typeof fetch =>
      async (request) => {
        asked.push(request instanceof Request ? request.url : String(request));
        return await Promise.resolve(Response.json(body, { status }));
      };
    assert.deepEqual(
      await fetchBlockscoutRegistry(
        fake(
          {
            "1": {
              name: "Ethereum",
              explorers: [{ url: "https://eth.blockscout.com/", hostedBy: "blockscout" }],
            },
          },
          200,
        ),
      ),
      [{ chainId: 1, name: "Ethereum", host: "eth.blockscout.com" }],
    );
    assert.deepEqual(asked, [BLOCKSCOUT_REGISTRY]);
    await assert.rejects(
      fetchBlockscoutRegistry(fake({}, 403)),
      /https:\/\/chains\.blockscout\.com\/api\/chains answered HTTP 403/,
    );
  });
});

describe("routing blockscout: the entries (R-RT-1, #169, decision 0038)", () => {
  it("places the entry after Sourcify, after a free-tier etherscan-v2 entry, before a paid-plan one", () => {
    const rows = [
      { chainId: 1, backends: [{ backend: "etherscan-v2", explorer: "etherscan.io" }] },
      { chainId: 31, backends: [{ backend: "sourcify" }] },
      {
        chainId: 8453,
        backends: [{ backend: "sourcify" }, { backend: "etherscan-v2", explorer: "basescan.org" }],
      },
      { chainId: 43113, backends: [{ backend: "etherscan-v2", explorer: "testnet.snowscan.xyz" }] },
      {
        chainId: 11155111,
        backends: [
          { backend: "etherscan-v2", explorer: "sepolia.etherscan.io" },
          { backend: "sourcify" },
        ],
      },
    ];
    const instances = new Map([
      [999, "explorer.example"],
      [1, "eth.blockscout.com"],
      [31, "rootstock-testnet.blockscout.com"],
      [8453, "base.blockscout.com"],
      [43113, "fuji.example"],
      [11155111, "eth-sepolia.blockscout.com"],
    ]);
    const names = withBlockscout(rows, instances, new Set([8453, 43113])).map((row) => [
      row.chainId,
      row.backends.map((entry) => entry.backend).join(">"),
    ]);
    assert.deepEqual(names, [
      [1, "etherscan-v2>blockscout"],
      [31, "sourcify>blockscout"],
      [999, "blockscout"],
      [8453, "sourcify>blockscout>etherscan-v2"],
      [43113, "blockscout>etherscan-v2"],
      [11155111, "etherscan-v2>sourcify>blockscout"],
    ]);
  });

  it("leaves a row that already has a blockscout entry as it is", () => {
    const rows = [{ chainId: 1, backends: [{ backend: "blockscout", instance: "a.example" }] }];
    assert.deepEqual(withBlockscout(rows, new Map([[1, "b.example"]]), new Set()), rows);
  });

  it("builds the shipped table: without its Blockscout, standalone and Routescan entries, adding them back gives it", () => {
    const shipped = read(TABLE_FILE);
    const chains = listOf(field(shipped, "chains"));
    const base = chains
      .map((row) => ({
        chainId: Number(field(row, "chainId")),
        backends: listOf(field(row, "backends")).flatMap((entry): BaseEntry[] => {
          const explorer = field(entry, "explorer");
          return field(entry, "backend") === "sourcify"
            ? [{ backend: "sourcify" }]
            : field(entry, "backend") === "etherscan-v2" && typeof explorer === "string"
              ? [{ backend: "etherscan-v2", explorer }]
              : [];
        }),
      }))
      .filter((row) => row.backends.length > 0);
    const paid = new Set(
      parseSeed(read(SEED_FILE))
        .etherscan.filter((chain) => chain.paidPlan)
        .map((chain) => chain.chainId),
    );
    const rebuilt = withRoutescan(
      withEtherscanCompatible(
        withBlockscout(
          base,
          blockscoutInstances(parseBlockscoutProbe(read(BLOCKSCOUT_FILE))),
          paid,
        ),
        parseStandaloneProbe(read(STANDALONE_FILE)),
      ),
      parseRoutescanProbe(read(ROUTESCAN_FILE)),
    );
    assert.deepEqual(rebuilt, chains);
  });
});

describe("routing blockscout: the comparison (R-RT-1, #169, decision 0038)", () => {
  const rows = [
    {
      chainId: 1,
      backends: ["etherscan-v2", "sourcify", "blockscout"],
      instance: "eth.blockscout.com",
    },
    {
      chainId: 10,
      backends: ["sourcify", "blockscout", "etherscan-v2"],
      instance: "explorer.optimism.io",
    },
    { chainId: 1313161554, backends: ["blockscout"], instance: "explorer.mainnet.aurora.dev" },
  ];

  it("finds no difference when the table, the probe and the registry agree", () => {
    assert.deepEqual(blockscoutDifferences(rows, PROBE, REGISTRY), []);
  });

  it("finds no difference in the shipped table against its probe and the probe's registry hosts", () => {
    const probe = parseBlockscoutProbe(read(BLOCKSCOUT_FILE));
    const registry = probe.candidates
      .filter((each) => each.source === "registry")
      .map((each) => ({ chainId: each.chainId, name: each.name, host: each.listed }));
    assert.deepEqual(blockscoutDifferences(parseTable(read(TABLE_FILE)).rows, probe, registry), []);
  });

  it("reports each difference with the probe", () => {
    const changed = [
      { chainId: 1, backends: ["etherscan-v2", "sourcify"] },
      { chainId: 10, backends: ["sourcify", "blockscout"], instance: "other.example" },
      { chainId: 137, backends: ["sourcify", "blockscout"], instance: "polygon.blockscout.com" },
      {
        chainId: 1313161554,
        backends: ["blockscout", "sourcify"],
        instance: "explorer.mainnet.aurora.dev",
      },
    ];
    assert.deepEqual(
      blockscoutDifferences(changed, PROBE, REGISTRY).map((each) => each.text),
      [
        "table: chain 1 has no blockscout entry; eth.blockscout.com answered on 2026-11-05",
        "table: chain 10 blockscout instance is other.example; the probe says explorer.optimism.io",
        "table: chain 1313161554 lists blockscout away from sourcify; it comes right after it",
        "table: chain 137 lists blockscout, which no instance answered on 2026-11-05",
      ],
    );
    assert.deepEqual(
      blockscoutDifferences(
        [{ chainId: 10, backends: ["blockscout"] }, ...rows.slice(0, 1), ...rows.slice(2)],
        PROBE,
        REGISTRY,
      ).map((each) => each.text),
      ["table: chain 10 blockscout instance is missing; the probe says explorer.optimism.io"],
    );
    assert.deepEqual(
      blockscoutDifferences(rows.slice(1), PROBE, REGISTRY).map((each) => each.text),
      ["table: chain 1 has no blockscout entry; eth.blockscout.com answered on 2026-11-05"],
    );
  });

  it("reports a registry chain the probe did not check, a moved host and a chain that left", () => {
    const registry: RegistryExplorer[] = [
      { chainId: 1, name: "Ethereum", host: "eth2.blockscout.com" },
      { chainId: 137, name: "Polygon PoS", host: "polygon.blockscout.com" },
      { chainId: 1313161554, name: "Aurora", host: "aurora.blockscout.com" },
      { chainId: 4242, name: "New Chain", host: "new.blockscout.com" },
    ];
    assert.deepEqual(blockscoutDifferences(rows, PROBE, registry), [
      {
        chainId: 1,
        text: "blockscout: chain 1 (Ethereum) moved from eth.blockscout.com to eth2.blockscout.com in the registry; probe it",
      },
      {
        chainId: 4242,
        text: "blockscout: chain 4242 (New Chain) is new in the registry at new.blockscout.com; probe it",
      },
      { chainId: 10, text: "blockscout: chain 10 (Chain 10) left the registry; probe it" },
    ]);
  });
});
