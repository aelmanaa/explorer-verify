// Regression cases found while reviewing the full mutation report (#202).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blockscout, refusal } from "../../src/backends/blockscout.ts";
import { blockscoutProxyLinker } from "../../src/backends/proxy-blockscout.ts";
import { ExplorerVerifyError } from "../../src/errors.ts";
import { validateInput } from "../../src/input/validate.ts";
import { routesWith } from "../../src/routing/resolve.ts";
import type { RoutingTable } from "../../src/routing/resolve.ts";
import { BOX, PROXY, SEPOLIA, json, setup } from "../helpers/proxy-link.ts";

describe("mutation baseline regressions (R-FLOW-4, R-SEC-1, R-RT-2)", () => {
  it("requires an instance submit to use the instance's answer mapping", async () => {
    const { ctx } = setup({ backend: "blockscout", apiUrl: "https://instance.example/api" }, [
      json({ error: "Unauthorized" }, 401),
    ]);
    const input = validateInput({
      chainId: SEPOLIA,
      address: PROXY,
      contractName: "A.sol:A",
      compiler: {
        kind: "solc",
        version: "0.8.24+commit.e11b9ed9",
        input: {
          language: "Solidity",
          sources: { "A.sol": { content: "contract A {}" } },
          settings: {},
        },
      },
    });
    await assert.rejects(blockscout.submit(input, ctx), (error: unknown) => {
      assert.ok(error instanceof ExplorerVerifyError);
      assert.equal(error.code, "unexpected-response");
      return true;
    });
  });

  it("does not accept a missing proxy job id", async () => {
    const { ctx } = setup({ backend: "blockscout", apiUrl: "https://instance.example/api" }, [
      json({ status: "1", message: "OK" }),
    ]);
    await assert.rejects(
      blockscoutProxyLinker.request({ chainId: SEPOLIA, address: PROXY }, ctx),
      (error: unknown) => {
        assert.ok(error instanceof ExplorerVerifyError);
        assert.equal(error.code, "unexpected-response");
        return true;
      },
    );
  });

  for (const backend of ["blockscout", "blockscout-hosted"] as const) {
    it(`uses ${backend}'s refusal mapping when checking the implementation source`, async () => {
      const { ctx, calls } = setup({ backend, apiUrl: "https://instance.example/api" }, [
        json({ error: "Unauthorized" }, 401),
      ]);
      const verified = blockscoutProxyLinker.verified;
      assert.ok(verified !== undefined);
      await assert.rejects(verified(BOX, SEPOLIA, ctx), (error: unknown) => {
        assert.ok(error instanceof ExplorerVerifyError);
        assert.equal(
          error.code,
          backend === "blockscout" ? "unexpected-response" : "api-key-rejected",
        );
        return true;
      });
      assert.equal(calls.length, 1);
      assert.match(calls[0]?.url ?? "", new RegExp(BOX));
    });
  }

  it("sends the proxy status action and guid", async () => {
    const { ctx, calls } = setup(
      { backend: "blockscout", apiUrl: "https://instance.example/api" },
      [json({ status: "1", result: "Verification in progress" })],
    );
    assert.deepEqual(
      await blockscoutProxyLinker.check("abc123", { chainId: SEPOLIA, address: PROXY }, ctx),
      { state: "pending" },
    );
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0]?.body)), {
      module: "contract",
      action: "checkproxyverification",
      guid: "abc123",
    });
  });

  it("names a hosted unsupported chain and requires HTTP 404", () => {
    const { ctx } = setup({ backend: "blockscout-hosted" }, []);
    const fields = new Map([["error", "Network not supported"]]);
    const error = refusal(ctx, { status: 404, text: "", fields }, SEPOLIA);
    assert.equal(
      error?.message,
      `Blockscout's hosted API does not serve chain ${String(SEPOLIA)}.`,
    );
    assert.equal(refusal(ctx, { status: 200, text: "", fields }, SEPOLIA), undefined);
    assert.equal(refusal(ctx, { status: 200, text: "", fields: undefined }, SEPOLIA), undefined);
    assert.equal(refusal(ctx, { status: 200, text: "", fields: new Map() }, SEPOLIA), undefined);
  });

  it("names rejected and missing hosted keys without echoing the response", () => {
    const { ctx } = setup({ backend: "blockscout-hosted" }, []);
    for (const [status, message] of [
      [
        401,
        "Blockscout's hosted API refused the API key, or its plan or credits for this request.",
      ],
      [402, "Blockscout's hosted API answered that the API key is missing."],
    ] as const) {
      assert.equal(
        refusal(ctx, { status, text: "untrusted response", fields: undefined }, SEPOLIA)?.message,
        message,
      );
    }
  });

  for (const backend of ["etherscan-v2", "etherscan-compatible"] as const) {
    it(`reports a missing ${backend} key even when it is the only route`, async () => {
      const table: RoutingTable = {
        schemaVersion: 3,
        checked: "2026-11-07",
        chains: [
          {
            chainId: SEPOLIA,
            backends: [{ backend, api: "scan.example/api", needsKey: true }],
          },
        ],
      };
      const { pick } = await routesWith(SEPOLIA, {}, async () => table);
      assert.ok(!(pick instanceof ExplorerVerifyError));
      assert.equal(pick.backend, backend);
      assert.equal(pick.keyMissing, true);
    });
  }
});
