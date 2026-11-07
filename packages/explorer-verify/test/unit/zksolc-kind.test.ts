// The zksolc compiler kind (R-EXT-1, R-IN-6, R-IN-3, decision 0057): routing by kind, refusals
// before any request in the default entry and in explorer-verify/core, and no constructor argument
// derivation for EraVM. No backend of this release maps zksolc, so the tests that reach a backend
// that does pass `zksolc` in the flow dependencies, as the next mapping will set it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Backend } from "../../src/backends/backend.ts";
import { blockscout } from "../../src/clients/blockscout.ts";
import { sourcify } from "../../src/clients/sourcify.ts";
import { kindCheck, ZKSOLC_ROUTES } from "../../src/compiler-kinds.ts";
import { dryRun as coreDryRun, verify as coreVerify } from "../../src/core/index.ts";
import { routingTable } from "../../src/core/table.ts";
import type { FlowDependencies } from "../../src/flow/verify.ts";
import { ERROR_HINTS, ExplorerVerifyError, dryRun, verify, verifyEach } from "../../src/index.ts";
import type { BackendName, Hex, RouteOverride, VerifyInput } from "../../src/index.ts";
import { ROUTING_TABLE } from "../../src/routing/table.ts";
import { runDryRun, runVerify, runVerifyEach } from "../helpers/defaults.ts";
import { replay } from "../helpers/fake-fetch.ts";
import { resolveRoute } from "../helpers/route.ts";

const ZKSYNC = 324;
const ADDRESS: Hex = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const TX_HASH: Hex = `0x${"ab".repeat(32)}`;
const RPC = "https://rpc.example.org/zksync";
const SOURCES = { "src/A.sol": { content: "contract A {}" } };

/** A kind check under which only Blockscout maps the input, as the next mapping sets it. */
const blockscoutOnly = (backend: BackendName): boolean => backend === "blockscout";

function zksolcInput(): VerifyInput {
  return {
    chainId: ZKSYNC,
    address: ADDRESS,
    compiler: {
      kind: "zksolc",
      version: "1.5.15",
      solcVersion: "0.8.24+commit.e11b9ed9",
      solcFork: "1.0.2",
      input: { language: "Solidity", sources: SOURCES, settings: { optimizer: { mode: "3" } } },
    },
    contractName: "src/A.sol:A",
  };
}

function solcInput(): VerifyInput {
  return {
    ...zksolcInput(),
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: { language: "Solidity", sources: SOURCES, settings: {} },
    },
  };
}

/** A client that records each call; its lookup finds nothing and its submit is answered verified. */
function fakeClient(name: BackendName, seen: string[], submitted: VerifyInput[] = []): Backend {
  return {
    name,
    takesConstructorArgs: true,
    lookup: async () => {
      seen.push(`lookup ${name}`);
      return await Promise.resolve(undefined);
    },
    submit: async (input) => {
      seen.push(`submit ${name}`);
      submitted.push(input);
      return await Promise.resolve({ state: "already-verified", match: "exact" });
    },
    poll: async () => await Promise.reject(new Error("no poll expected")),
    explorerUrl: () => undefined,
  };
}

/** Flow dependencies with fake Sourcify and Blockscout clients, Blockscout mapping zksolc. */
function mapping(seen: string[], submitted: VerifyInput[] = []): FlowDependencies {
  return {
    backends: {
      sourcify: fakeClient("sourcify", seen),
      blockscout: fakeClient("blockscout", seen, submitted),
    },
    zksolc: [["blockscout", [324, 300]]],
  };
}

/** Asserts the refusal of zksolc input by `backend`. */
function isRefusal(error: unknown, backend?: BackendName): true {
  assert.ok(error instanceof ExplorerVerifyError, `threw ${String(error)}`);
  assert.deepEqual(error.details, { code: "unsupported-compiler", field: "compiler.kind" });
  assert.equal(
    error.message,
    backend === undefined
      ? `No backend of this release verifies zksolc input on chain ${String(ZKSYNC)}.`
      : `The ${backend} backend does not verify zksolc input on chain ${String(ZKSYNC)}.`,
  );
  assert.equal(error.hint, ERROR_HINTS["unsupported-compiler"]);
  assert.equal(error.retryable, false);
  assert.deepEqual(error.toJSON().details, error.details);
  return true;
}

describe("compiler kinds (R-EXT-1, decision 0057)", () => {
  it("maps solc on every backend and zksolc on none in this release", () => {
    assert.deepEqual(ZKSOLC_ROUTES, []);
    assert.equal(kindCheck("solc", ZKSYNC).verifies("sourcify"), true);
    assert.equal(kindCheck("solc", ZKSYNC, []).verifies("routescan"), true);
    assert.throws(
      () => kindCheck("zksolc", ZKSYNC),
      (error) => isRefusal(error),
    );
    assert.equal(
      kindCheck("zksolc", ZKSYNC, [["blockscout", [324, 300]]]).verifies("blockscout"),
      true,
    );
    assert.equal(
      kindCheck("zksolc", ZKSYNC, [["blockscout", [324, 300]]]).verifies("sourcify"),
      false,
    );
  });

  it("names the backend, the kind and the chain in the refusal", () => {
    isRefusal(
      kindCheck("zksolc", ZKSYNC, [["blockscout", [324]]]).refused("routescan"),
      "routescan",
    );
  });
  it("limits each compiler mapping to its backend and chains", () => {
    const routes = [
      ["blockscout", [324, 300]],
      ["sourcify", [300]],
    ] as const;
    assert.equal(kindCheck("zksolc", 300, routes).verifies("blockscout"), true);
    assert.equal(kindCheck("zksolc", 324, routes).verifies("sourcify"), false);
    assert.equal(kindCheck("zksolc", 324, routes).verifies("blockscout"), true);
    for (const chainId of [1, 11155111, 999999]) {
      assert.throws(
        () => kindCheck("zksolc", chainId, routes),
        (error: unknown) => {
          assert.ok(error instanceof ExplorerVerifyError);
          assert.equal(error.code, "unsupported-compiler");
          assert.match(error.message, new RegExp(String(chainId)));
          return true;
        },
      );
    }
  });
});

describe("zksolc input is refused before any request (R-IN-6, decision 0057)", () => {
  it("by verify() and dryRun() of the default entry, on the routing table's pick", async () => {
    for (const run of [verify, dryRun]) {
      const fake = replay();
      await assert.rejects(run(zksolcInput(), { fetch: fake.fetch }), (error) => isRefusal(error));
      assert.deepEqual(fake.calls, []);
    }
  });

  it("on every backend the caller names, before a missing key is reported", async () => {
    const routes: [BackendName, RouteOverride][] = [
      ["sourcify", { backend: "sourcify" }],
      ["blockscout", { backend: "blockscout" }],
      ["blockscout-hosted", { backend: "blockscout-hosted" }],
      ["etherscan-v2", { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" }],
      [
        "routescan",
        {
          backend: "routescan",
          apiUrl: "https://api.routescan.io/v2/network/mainnet/evm/324/etherscan/api",
        },
      ],
      [
        "etherscan-compatible",
        { backend: "etherscan-compatible", apiUrl: "https://x.example/api" },
      ],
      ["sourcify", { apiUrl: "http://127.0.0.1:5555" }],
    ];
    for (const [, route] of routes) {
      const fake = replay();
      await assert.rejects(verify(zksolcInput(), { fetch: fake.fetch, route }), (error) =>
        isRefusal(error),
      );
      assert.deepEqual(fake.calls, []);
    }
  });

  it("refuses verifyEach() when no backend maps the kind", async () => {
    for (const backends of ["all", ["sourcify", "blockscout"]] as const) {
      const fake = replay();
      await assert.rejects(verifyEach(zksolcInput(), { fetch: fake.fetch, backends }), (error) =>
        isRefusal(error),
      );
      assert.deepEqual(fake.calls, []);
    }
  });

  it("by verify() and dryRun() of explorer-verify/core", async () => {
    const clients = [sourcify(), blockscout()] as const;
    const fake = replay();
    await assert.rejects(
      coreVerify(zksolcInput(), { fetch: fake.fetch, clients, table: routingTable }),
      (error) => isRefusal(error),
    );
    await assert.rejects(
      coreDryRun(zksolcInput(), {
        fetch: fake.fetch,
        clients,
        table: routingTable,
        route: { backend: "blockscout" },
      }),
      (error) => isRefusal(error),
    );
    assert.deepEqual(fake.calls, []);
  });
  it("refuses before handler setup, missing keys, and fallback advice", async () => {
    const fake = replay();
    await assert.rejects(
      verify(zksolcInput(), {
        fetch: fake.fetch,
        handlerUrl: "https://handler.example/verify",
        route: { backend: "etherscan-v2" },
      }),
      (error) => isRefusal(error),
    );
    for (const run of [verify, dryRun]) {
      await assert.rejects(
        run(
          { ...zksolcInput(), chainId: 999999 },
          {
            fetch: fake.fetch,
            allowSourcifyFallback: true,
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof ExplorerVerifyError);
          assert.equal(error.code, "unsupported-compiler");
          assert.doesNotMatch(error.hint, /allowSourcifyFallback|handlerUrl|auto/);
          return true;
        },
      );
    }
    assert.deepEqual(fake.calls, []);
  });
});

describe("the routing table chooses by compiler kind (R-RT-1, decision 0057)", () => {
  it("passes over a backend that does not map the kind", () => {
    const choice = { table: ROUTING_TABLE, verifies: blockscoutOnly };
    assert.equal(resolveRoute(ZKSYNC, undefined, choice).backend, "blockscout");
    assert.deepEqual(resolveRoute(ZKSYNC, undefined, choice).skipped, []);
    // A capable backend without a client stays the pick: the flow then names the missing client.
    const unserved = { ...choice, clients: ["sourcify"] as const };
    assert.equal(resolveRoute(ZKSYNC, undefined, unserved).backend, "blockscout");
    // When no listed backend maps the kind, the table's pick stays, for the flow to refuse.
    const none = { table: ROUTING_TABLE, verifies: () => false };
    assert.equal(resolveRoute(ZKSYNC, undefined, none).backend, "sourcify");
    // A named backend is never replaced.
    assert.equal(resolveRoute(ZKSYNC, { backend: "sourcify" }, choice).backend, "sourcify");
  });

  it("shows the route in a dry run: Blockscout for zksolc, the table's first for solc", async () => {
    const seen: string[] = [];
    const fake = replay();
    const zksolc = await runDryRun(zksolcInput(), { fetch: fake.fetch }, mapping(seen));
    assert.deepEqual(zksolc, {
      status: "dry-run",
      backend: "blockscout",
      apiHost: "zksync.blockscout.com",
      lookup: "none",
      routedBy: "table",
    });
    const solc = await runDryRun(solcInput(), { fetch: fake.fetch }, mapping(seen));
    assert.equal(solc.backend, "sourcify");
    assert.deepEqual(seen, ["lookup blockscout", "lookup sourcify"]);
    assert.deepEqual(fake.calls, []);
  });

  it("refuses a named backend that does not map the kind, before its lookup", async () => {
    const seen: string[] = [];
    await assert.rejects(
      runVerify(zksolcInput(), { route: { backend: "sourcify" } }, mapping(seen)),
      (error) => isRefusal(error, "sourcify"),
    );
    assert.deepEqual(seen, []);
  });

  it("runs verifyEach() only on the backends that map the kind", async () => {
    const seen: string[] = [];
    const all = await runVerifyEach(zksolcInput(), { backends: "all" }, mapping(seen));
    assert.deepEqual(
      all.outcomes.map((outcome) => [outcome.backend, outcome.ok]),
      [["blockscout", true]],
    );
    const listed = await runVerifyEach(
      zksolcInput(),
      { backends: ["sourcify", "blockscout"] },
      mapping(seen),
    );
    const [first, second] = listed.outcomes;
    assert.ok(first !== undefined && "error" in first && isRefusal(first.error, "sourcify"));
    assert.equal(second?.ok, true);
    assert.deepEqual(seen, [
      "lookup blockscout",
      "submit blockscout",
      "lookup blockscout",
      "submit blockscout",
    ]);
  });

  it("leaves keyed backends out of all when they do not map the compiler", async () => {
    const seen: string[] = [];
    const dependencies = mapping(seen);
    const result = await runVerifyEach(
      zksolcInput(),
      { backends: "all" },
      {
        ...dependencies,
        backends: {
          ...dependencies.backends,
          "etherscan-v2": fakeClient("etherscan-v2", seen),
        },
        table: {
          schemaVersion: 3,
          checked: "2026-11-07",
          chains: [
            {
              chainId: ZKSYNC,
              backends: [
                { backend: "etherscan-v2" },
                { backend: "sourcify" },
                { backend: "blockscout", instance: "zksync.blockscout.com" },
              ],
            },
          ],
        },
      },
    );
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.backend),
      ["blockscout"],
    );
    assert.deepEqual(seen, ["lookup blockscout", "submit blockscout"]);
  });
});

describe("no constructor arguments are derived for zksolc (R-IN-3, decision 0057)", () => {
  it("submits without them, logs why at info and sends no request", async () => {
    const seen: string[] = [];
    const submitted: VerifyInput[] = [];
    const lines: string[] = [];
    const fake = replay();
    const result = await runVerify(
      { ...zksolcInput(), creationBytecode: "0x6080", creationTxHash: TX_HASH },
      {
        fetch: fake.fetch,
        rpcUrl: RPC,
        logger: {
          debug: () => undefined,
          info: (message, fields) => {
            lines.push(`info ${message} ${JSON.stringify(fields)}`);
          },
          warn: (message) => {
            lines.push(`warn ${message}`);
          },
          error: (message) => {
            lines.push(`error ${message}`);
          },
        },
      },
      mapping(seen, submitted),
    );
    assert.equal(result.status, "already-verified");
    assert.equal(submitted[0]?.constructorArgs, undefined);
    assert.deepEqual(fake.calls, []);
    assert.ok(
      lines.includes(
        'info zksolc input: EraVM creation code holds no constructor arguments; submitting without them. Pass constructorArgs if the constructor takes any (zksolc) {"backend":"blockscout","reason":"zksolc"}',
      ),
      lines.join("\n"),
    );
    assert.ok(!lines.some((line) => line.startsWith("warn") || line.startsWith("error")));
  });

  it("submits the arguments the caller passed, unchanged", async () => {
    const submitted: VerifyInput[] = [];
    await runVerify(
      { ...zksolcInput(), creationBytecode: "0x6080", constructorArgs: "0x2a" },
      { fetch: replay().fetch },
      mapping([], submitted),
    );
    assert.equal(submitted[0]?.constructorArgs, "0x2a");
  });
});
