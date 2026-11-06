// Tests added after a mutation review of #59 (R-RT-1, R-RT-3, R-SEC-2): each one fails on a code
// change that the other routing tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BackendName } from "../../src/backend-names.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { DEFAULT_DEPENDENCIES } from "../../src/flow/defaults.ts";
import { keyFor } from "../../src/http/api-keys.ts";
import type { CheckedKeys } from "../../src/http/api-keys.ts";
import { SOURCIFY_API_URL } from "../../src/routing/resolve.ts";
import type { RoutingTable, TableEntry } from "../../src/routing/resolve.ts";
import type { VerifyInput } from "../../src/types.ts";
import { runCheckStatus, runVerify } from "../helpers/defaults.ts";
import { resolveRoute } from "../helpers/route.ts";
import { apiUrlProblems, tableProblems } from "../helpers/routing-table.ts";

const ETHERSCAN_KEY = "etherscan-dummy-key-59a1";
const SEPOLIA = 11155111;
const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const ETHERSCAN: TableEntry = { backend: "etherscan-v2", explorer: "sepolia.etherscan.io" };
const SOURCIFY: TableEntry = { backend: "sourcify" };
function tableOf(...backends: TableEntry[]): RoutingTable {
  return { schemaVersion: 2, checked: "2026-11-03", chains: [{ chainId: SEPOLIA, backends }] };
}
function input(chainId: number): VerifyInput {
  return {
    chainId,
    address: ADDRESS,
    contractName: "src/A.sol:A",
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "src/A.sol": { content: "contract A {}" } },
        settings: {},
      },
    },
  };
}
function recordingFetch(sent: string[]): typeof globalThis.fetch {
  return async (request) => {
    sent.push(request instanceof Request ? request.url : String(request));
    return new Response("{}", { status: 404 });
  };
}
async function withPrototypeField(
  name: string,
  value: unknown,
  run: () => Promise<void> | void,
): Promise<void> {
  Reflect.set(Object.prototype, name, value);
  try {
    await run();
  } finally {
    Reflect.deleteProperty(Object.prototype, name);
  }
}

describe("routing: cases from the mutation review of #59", () => {
  it("R25: drops a row entry with an unknown backend, not only its name", () => {
    const table = tableOf({ ...ETHERSCAN, backend: "etherscan" }, SOURCIFY);
    const route = resolveRoute(SEPOLIA, undefined, { table });
    assert.equal(route.backend, "sourcify");
    assert.equal(route.apiBase, SOURCIFY_API_URL);
    assert.equal(route.tableHost, "sourcify.dev");
  });

  it("R5: does not treat an inherited apiKeys field as a key when choosing the backend", async () => {
    await withPrototypeField("etherscan-v2", ETHERSCAN_KEY, () => {
      const apiKeys: CheckedKeys = {};
      const route = resolveRoute(SEPOLIA, undefined, {
        table: tableOf(ETHERSCAN, SOURCIFY),
        apiKeys,
      });
      assert.equal(route.backend, "sourcify");
    });
  });

  it("K2/K3: keyFor needs https on the exact table host even for a non-overridden route", () => {
    const apiKeys: CheckedKeys = { "etherscan-v2": ETHERSCAN_KEY };
    const base = resolveRoute(SEPOLIA, undefined, { table: tableOf(ETHERSCAN, SOURCIFY), apiKeys });
    assert.equal(base.overridden, false);
    for (const apiBase of ["http://api.etherscan.io/v2/api", "https://xapi.etherscan.io/v2/api"]) {
      const route = { ...base, apiBase };
      assert.equal(
        keyFor({ route, apiKeys: () => apiKeys }, "etherscan-v2", `${apiBase}?chainid=1`),
        undefined,
      );
    }
  });

  it("V2: verify() with allowSourcifyFallback: true sends an unlisted chain to Sourcify (R-RT-3)", async () => {
    const sent: string[] = [];
    await runVerify(
      input(999_999),
      { fetch: recordingFetch(sent), allowSourcifyFallback: true },
      DEFAULT_DEPENDENCIES,
    ).catch(() => undefined);
    assert.ok(sent.length > 0, "no request sent");
    assert.ok(sent[0]?.startsWith(`${SOURCIFY_API_URL}/`), sent[0]);
  });

  it("V6: an inherited allowSourcifyFallback is ignored", async () => {
    await withPrototypeField("allowSourcifyFallback", true, async () => {
      const sent: string[] = [];
      await assert.rejects(
        runVerify(input(999_999), { fetch: recordingFetch(sent) }, DEFAULT_DEPENDENCIES),
        (error) => {
          assert.ok(error instanceof ExplorerVerifyError);
          assert.equal(error.code, "unsupported-chain");
          return true;
        },
      );
      assert.equal(sent.length, 0);
    });
  });

  it("S1: checkStatus() with allowSourcifyFallback: true polls Sourcify for an unlisted chain (R-RT-3)", async () => {
    const sent: string[] = [];
    const handle = `ev1:sourcify:999999:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718`;
    await runCheckStatus(
      handle,
      { fetch: recordingFetch(sent), allowSourcifyFallback: true },
      DEFAULT_DEPENDENCIES,
    ).catch(() => undefined);
    assert.ok(sent.length > 0, "no request sent");
    assert.ok(sent[0]?.startsWith(`${SOURCIFY_API_URL}/`), sent[0]);
  });

  const broken: [string, unknown][] = [
    ["T11 a fractional chain id", 1.5],
    ["T11 an unsafe chain id", 2 ** 53],
  ];
  for (const [label, chainId] of broken) {
    it(`${label} fails the table check`, () => {
      const table = {
        schemaVersion: 2,
        checked: "2026-11-03",
        chains: [{ chainId, backends: [SOURCIFY] }],
      };
      assert.ok(
        tableProblems(table).some((p) => /chainId must be a positive safe integer/.test(p)),
      );
    });
  }
  const urls: [string, BackendName, string][] = [
    ["T15 etherscan path with a suffix", "etherscan-v2", "https://api.etherscan.io/v2/apix"],
    ["T16 sourcify path with a suffix", "sourcify", "https://sourcify.dev/server/x"],
    ["T17 sourcify on another path", "sourcify", "https://sourcify.dev/other"],
    ["T19 etherscan host with a prefix", "etherscan-v2", "https://xapi.etherscan.io/v2/api"],
    ["T19 sourcify subdomain", "sourcify", "https://evil.sourcify.dev/server"],
  ];
  for (const [label, backend, apiUrl] of urls) {
    it(`${label} fails the URL check`, () => {
      const problems = apiUrlProblems(apiUrl, backend, 1, "entry");
      assert.ok(
        problems.some((p) => /apiUrl (host|path) must/.test(p)),
        JSON.stringify(problems),
      );
    });
  }
});
