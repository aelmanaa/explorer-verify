// Tests added when dryRun() joined mutation testing (#202; R-AX-8, R-DX-5): each one fails on a
// code change in src/flow/dry-run.ts that the other dryRun() tests let pass. The backend is a
// fake passed in; a submit or a poll fails the test.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Backend } from "../../src/backends/backend.ts";
import { sourcify } from "../../src/backends/sourcify.ts";
import { runDryRun } from "../../src/flow/dry-run.ts";
import type { LogFields, VerifyInput, VerifyOptions } from "../../src/types.ts";

const SEPOLIA = 11155111;
const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const ETHERSCAN_API = "https://api.etherscan.io/v2/api";
// A made-up key. Never a real one (R-SEC-1).
const KEYED: VerifyOptions = {
  route: { backend: "etherscan-v2", apiUrl: ETHERSCAN_API, apiKey: "dummy-key-0001" },
};

function input(): VerifyInput {
  return {
    chainId: SEPOLIA,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "src/Greeter.sol": { content: "contract Greeter {}" } },
        settings: {},
      },
    },
    contractName: "src/Greeter.sol:Greeter",
  };
}

function fail(): Promise<never> {
  return Promise.reject(new Error("no submit or poll expected"));
}

/** A keyed backend whose lookup gives `found`. */
function keyed(found: "exact" | "partial" | undefined): Backend {
  return {
    name: "etherscan-v2",
    lookup: async () => await Promise.resolve(found),
    submit: fail,
    poll: fail,
    explorerUrl: () => undefined,
  };
}

/** The info lines a dry run logs, each with its fields. */
async function infoLines(
  backend: Backend,
  options: VerifyOptions,
): Promise<{ message: string; fields: LogFields | undefined }[]> {
  const lines: { message: string; fields: LogFields | undefined }[] = [];
  await runDryRun(
    input(),
    {
      route: { backend: "etherscan-v2", apiUrl: ETHERSCAN_API },
      ...options,
      logger: {
        debug: () => undefined,
        info: (message, fields) => {
          lines.push({ message, fields });
        },
        warn: () => undefined,
        error: () => undefined,
      },
    },
    { backends: { sourcify, "etherscan-v2": backend } },
  );
  return lines;
}

describe("dryRun logs what verify() would do (R-AX-8, R-DX-5)", () => {
  it("says the lookup was skipped when a keyed backend has no key", async () => {
    const lines = await infoLines(keyed("exact"), {});
    assert.deepEqual(lines.at(-1), {
      message:
        "etherscan-v2 needs an API key and none is set, so the dry run skipped the lookup. Nothing was submitted.",
      fields: { backend: "etherscan-v2", routedBy: "api-url" },
    });
  });

  it("says verify() would submit when the backend holds no match", async () => {
    const lines = await infoLines(keyed(undefined), KEYED);
    assert.deepEqual(lines.at(-1), {
      message:
        "Dry run: etherscan-v2 holds no match, so verify() would submit. Nothing was submitted.",
      fields: { backend: "etherscan-v2", routedBy: "api-url" },
    });
  });

  it("says verify() would not submit when the backend holds a partial match", async () => {
    const lines = await infoLines(keyed("partial"), KEYED);
    assert.deepEqual(lines.at(-1), {
      message:
        "Dry run: etherscan-v2 already holds the contract (partial match), so verify() would not submit.",
      fields: { backend: "etherscan-v2", routedBy: "api-url" },
    });
  });

  it("names the contract and the chain in the debug line of the route", async () => {
    const lines: string[] = [];
    await runDryRun(
      input(),
      {
        ...KEYED,
        logger: {
          debug: (message) => {
            lines.push(message);
          },
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      },
      { backends: { sourcify, "etherscan-v2": keyed(undefined) } },
    );
    assert.ok(
      lines.includes(`Dry run for ${ADDRESS} on chain ${String(SEPOLIA)}`),
      lines.join("\n"),
    );
  });
});
