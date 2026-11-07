// Blockscout's zksolc form and recorded ZKsync lookups (R-BE-3, R-EXT-1, #207).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blockscout } from "../../src/backends/blockscout.ts";
import { blockscout as blockscoutClient } from "../../src/clients/blockscout.ts";
import { verify as coreVerify } from "../../src/core/index.ts";
import { routingTable } from "../../src/core/table.ts";
import { checkRouteOf, routeWith, settingsOf } from "../../src/flow/verify.ts";
import { verify } from "../../src/index.ts";
import { validateInput } from "../../src/input/validate.ts";
import type { Hex, SolidityStandardJsonInput, VerifyInput } from "../../src/types.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import { resolveRoute } from "../helpers/route.ts";

const ADDRESS: Hex = `0x${"ab".repeat(20)}`;
const SOURCE: SolidityStandardJsonInput = {
  language: "Solidity",
  sources: { "A.sol": { content: "contract A {}" } },
  settings: {},
};
const SOLC = "0.8.24+commit.e11b9ed9";

function input(chainId: number): VerifyInput {
  return validateInput({
    chainId,
    address: ADDRESS,
    contractName: "A.sol:A",
    constructorArgs: "0x2a",
    compiler: {
      kind: "zksolc",
      version: "1.5.15",
      solcVersion: SOLC,
      solcFork: "1.0.2",
      input: SOURCE,
    },
  });
}

describe("zksolc on Blockscout (R-BE-3, R-EXT-1)", () => {
  for (const chainId of [324, 300]) {
    it(`sends both compiler versions on chain ${String(chainId)}`, async () => {
      const fake = replay(
        new Response(JSON.stringify({ status: "1", message: "OK", result: "abc123" })),
      );
      const route = resolveRoute(chainId, { backend: "blockscout" });
      const value = input(chainId);
      const result = await blockscout.submit(value, {
        route,
        http: { backend: "blockscout", fetch: fake.fetch, secrets: [] },
      });
      assert.equal(result.state, "submitted");
      assert.equal(fake.calls.length, 1);
      const fields = new URLSearchParams(fake.calls[0]?.body);
      assert.equal(fields.get("action"), "verifysourcecode");
      assert.equal(fields.get("codeformat"), "solidity-standard-json-input");
      assert.equal(fields.get("compilerversion"), `v${SOLC}`);
      assert.equal(fields.get("zksolcVersion"), "v1.5.15");
      assert.equal(fields.get("constructorArguments"), "0x2a");
      assert.deepEqual(JSON.parse(fields.get("sourceCode") ?? "null"), SOURCE);
      assert.equal(fields.has("solcFork"), false);
      assert.equal(
        new URL(fake.calls[0]?.url ?? "").host,
        chainId === 324 ? "zksync.blockscout.com" : "zksync-sepolia.blockscout.com",
      );
    });
  }

  it("allows shared routing callers without a compiler-kind check", () => {
    const settings = settingsOf({
      route: { backend: "blockscout", apiUrl: "https://zksync.blockscout.com/api" },
    });
    const dependencies = { backends: { blockscout } };
    const checked = checkRouteOf(324, settings, dependencies);
    assert.equal(routeWith(324, checked, settings, dependencies, undefined).backend, "blockscout");
  });

  it("normalizes a leading v in the backend's solc form", async () => {
    const fake = replay(new Response(JSON.stringify({ status: "1", result: "abc123" })));
    await blockscout.submit(
      { ...input(324), compiler: { kind: "solc", version: `v${SOLC}`, input: SOURCE } },
      {
        route: resolveRoute(324, { backend: "blockscout" }),
        http: { backend: "blockscout", fetch: fake.fetch, secrets: [] },
      },
    );
    assert.equal(new URLSearchParams(fake.calls[0]?.body).get("compilerversion"), `v${SOLC}`);
  });

  it("keeps the solc form unchanged and omits the zksolc field", async () => {
    const fake = replay(new Response(JSON.stringify({ status: "1", result: "abc123" })));
    const value = {
      ...input(324),
      compiler: { kind: "solc" as const, version: SOLC, input: SOURCE },
    };
    await blockscout.submit(value, {
      route: resolveRoute(324, { backend: "blockscout" }),
      http: { backend: "blockscout", fetch: fake.fetch, secrets: [] },
    });
    const fields = new URLSearchParams(fake.calls[0]?.body);
    assert.equal(fields.get("compilerversion"), `v${SOLC}`);
    assert.equal(fields.has("zksolcVersion"), false);
  });

  it("does not infer verification from the zksolc version alone", async () => {
    const fake = replay(
      new Response(JSON.stringify({ is_verified: false, zk_compiler_version: "v1.5.15" })),
    );
    assert.equal(
      await blockscout.lookup(input(324), {
        route: resolveRoute(324, { backend: "blockscout" }),
        http: { backend: "blockscout", fetch: fake.fetch, secrets: [] },
      }),
      undefined,
    );
  });

  for (const [chainId, name] of [
    [324, "zksync"],
    [300, "zksync-sepolia"],
  ] as const) {
    it(`recognizes a recorded zksolc lookup on ${name} in both entries`, async () => {
      const fixture = loadFixture("blockscout", `2026-11-07-${name}-lookup`);
      for (const core of [false, true]) {
        const fake = replay(fixture);
        const value = {
          ...input(chainId),
          address: new URL(fixture.request.url).pathname.split("/").at(-1),
        };
        const checked = validateInput(value);
        const result = core
          ? await coreVerify(checked, {
              fetch: fake.fetch,
              clients: [blockscoutClient()],
              table: routingTable,
            })
          : await verify(checked, { fetch: fake.fetch });
        assert.equal(result.status, "already-verified");
        assert.equal(result.backend, "blockscout");
        assert.equal(result.match, "exact");
        assert.equal(fake.calls.length, 1);
        assert.equal(fake.calls[0]?.method, "GET");
      }
    });
  }
});
