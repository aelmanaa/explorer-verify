// The grade each explorer gives a build without a metadata hash (#287, R-FLOW-3). A contract
// built with `bytecodeHash: "none"` was deployed on Ethereum Sepolia once per explorer and
// verified there with explorer-verify 0.1.0 on 2026-11-10. Each test replays one explorer's
// recorded answers through `verify()` or `dryRun()` with the shipped clients and routing table,
// and checks the `match` that docs/user/explanation/match-types.md states for that explorer.
// The probe is in docs/contributor/research/2026-11-10-no-metadata-hash-grades.md.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { DEFAULT_DEPENDENCIES } from "../../src/flow/defaults.ts";
import { validateInput } from "../../src/input/validate.ts";
import type { ApiKeys, DryRunResult, RouteOverride, VerifyInput } from "../../src/types.ts";
import { runDryRun, runVerify } from "../helpers/defaults.ts";
import { loadFixture, replay } from "../helpers/fake-fetch.ts";
import type { Call, Step } from "../helpers/fake-fetch.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";

const SEPOLIA = 11155111;
// The probe's deployments, one per explorer, so each submit was the first for its address.
const ETHERSCAN = "0x4516568fe694b225ddb62ea1f0b0a956e4149032";
const BLOCKSCOUT = "0xea02aff76e67b89aea47c4fa0e6639e4eece1d32";
const HOSTED = "0x21daa94317e22dc667f5b3088fc7905187ac6813";
const ROUTESCAN = "0x83f6c8a7ae518eb4a0a460d6119184f3639f568b";
const SOURCIFY = "0xd6f4ed540d68798effeb7937f3894f8e51dc0444";
// Fake keys. Never real ones (R-SEC-1).
const API_KEYS: ApiKeys = {
  "etherscan-v2": "DUMMYETHERSCANKEY287noHash01",
  "blockscout-hosted": "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  routescan: "DUMMYROUTESCANKEY287noHash01",
};

const SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MatchGrade287 {
    uint256 public constant TAG = 5327880783795880847;
    uint256 public count;

    function bump() external returns (uint256) {
        count += 1;
        return count + TAG;
    }
}
`;

/**
 * The input of a build without a metadata hash at `address`. The replayed answers do not depend on
 * the source, so every address gets the same one.
 */
function input(address: string): VerifyInput {
  return validateInput({
    chainId: SEPOLIA,
    address,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "src/MatchGrade287.sol": { content: SOURCE } },
        settings: {
          evmVersion: "cancun",
          optimizer: { enabled: true, runs: 200 },
          metadata: { bytecodeHash: "none", appendCBOR: true, useLiteralContent: false },
          outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } },
        },
      },
    },
    contractName: "src/MatchGrade287.sol:MatchGrade287",
  });
}

/** The recording `test/fixtures/<folder>/2026-11-10-<name>.json`. */
function recorded(folder: string, name: string): Step {
  return loadFixture(folder, `2026-11-10-${name}`);
}

/** Settles `promise` with the timers mocked, so the polls wait no real time. */
async function drive<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  promise.catch(() => {});
  await driveMockClock(promise, () => {
    t.mock.timers.runAll();
  });
  return await promise;
}

const DEPENDENCIES = { backends: DEFAULT_DEPENDENCIES.backends, random: () => 0 };

/** Runs `verify()` on `route` for `address`, answered by `steps` in order. */
async function verifyWith(
  t: TestContext,
  address: string,
  route: RouteOverride,
  steps: Step[],
): Promise<{ result: unknown; calls: Call[] }> {
  const fake = replay(...steps);
  const result = await drive(
    t,
    runVerify(
      input(address),
      { fetch: fake.fetch, route, apiKeys: API_KEYS, pollIntervalMs: 1_000 },
      DEPENDENCIES,
    ),
  );
  return { result, calls: fake.calls };
}

/** Runs `dryRun()` on `route` for `address`, answered by `step`. */
async function lookupWith(
  t: TestContext,
  address: string,
  route: RouteOverride,
  step: Step,
): Promise<DryRunResult> {
  const fake = replay(step);
  return await drive(
    t,
    runDryRun(input(address), { fetch: fake.fetch, route, apiKeys: API_KEYS }, DEPENDENCIES),
  );
}

describe("the grade of a build without a metadata hash, per explorer (#287, R-FLOW-3, recorded 2026-11-10)", () => {
  it("Etherscan v2: a fresh submit that passes is verified exact", async (t) => {
    const r = await verifyWith(t, ETHERSCAN, { backend: "etherscan-v2" }, [
      recorded("etherscan", "getsourcecode-no-metadata-hash-not-verified"),
      recorded("etherscan", "verifysourcecode-no-metadata-hash"),
      recorded("etherscan", "checkverifystatus-no-metadata-hash-pass"),
    ]);
    assert.deepEqual(r.result, {
      status: "verified",
      backend: "etherscan-v2",
      match: "exact",
      explorerUrl: `https://sepolia.etherscan.io/address/${ETHERSCAN}#code`,
    });
    assert.equal(r.calls.length, 3);
  });

  it("Etherscan v2: the lookup after that submit, with an empty SimilarMatch, reads exact", async (t) => {
    const r = await lookupWith(
      t,
      ETHERSCAN,
      { backend: "etherscan-v2" },
      recorded("etherscan", "getsourcecode-no-metadata-hash"),
    );
    assert.equal(r.lookup, "exact");
  });

  it("Sourcify: a fresh submit whose job ends with match is verified partial", async (t) => {
    const r = await verifyWith(t, SOURCIFY, { backend: "sourcify" }, [
      recorded("sourcify", "lookup-no-metadata-hash-not-verified"),
      recorded("sourcify", "submit-no-metadata-hash"),
      recorded("sourcify", "job-no-metadata-hash-match"),
    ]);
    assert.deepEqual(r.result, {
      status: "verified",
      backend: "sourcify",
      match: "partial",
      explorerUrl: `https://repo.sourcify.dev/${String(SEPOLIA)}/${SOURCIFY}`,
    });
    assert.equal(r.calls.length, 3);
  });

  it("Sourcify: the lookup after that job, with match, reads partial", async (t) => {
    const r = await lookupWith(
      t,
      SOURCIFY,
      { backend: "sourcify" },
      recorded("sourcify", "lookup-no-metadata-hash-match"),
    );
    assert.equal(r.lookup, "partial");
  });

  it("Blockscout instance: a fresh submit that passes is verified partial, as the lookup reads it", async (t) => {
    const r = await verifyWith(t, BLOCKSCOUT, { backend: "blockscout" }, [
      recorded("blockscout", "lookup-no-metadata-hash-unverified"),
      recorded("blockscout", "verifysourcecode-no-metadata-hash"),
      recorded("blockscout", "checkverifystatus-no-metadata-hash-pending"),
      recorded("blockscout", "checkverifystatus-no-metadata-hash-pass"),
      recorded("blockscout", "lookup-partial-no-metadata-hash-sepolia"),
    ]);
    assert.deepEqual(r.result, {
      status: "verified",
      backend: "blockscout",
      match: "partial",
      explorerUrl: `https://eth-sepolia.blockscout.com/address/${BLOCKSCOUT}?tab=contract`,
    });
    assert.equal(r.calls.length, 5);
  });

  it("Blockscout hosted API: a fresh submit that passes is verified partial, as the lookup reads it", async (t) => {
    const r = await verifyWith(t, HOSTED, { backend: "blockscout-hosted" }, [
      recorded("blockscout", "hosted-lookup-no-metadata-hash-unverified"),
      recorded("blockscout", "hosted-verifysourcecode-no-metadata-hash"),
      recorded("blockscout", "hosted-checkverifystatus-no-metadata-hash-pass"),
      recorded("blockscout", "hosted-lookup-partial-no-metadata-hash"),
    ]);
    assert.deepEqual(r.result, {
      status: "verified",
      backend: "blockscout-hosted",
      match: "partial",
      explorerUrl: `https://eth-sepolia.blockscout.com/address/${HOSTED}?tab=contract`,
    });
    assert.equal(r.calls.length, 4);
  });

  it("Routescan: a fresh submit that passes is verified exact", async (t) => {
    const r = await verifyWith(t, ROUTESCAN, { backend: "routescan" }, [
      recorded("routescan", "getsourcecode-no-metadata-hash-not-verified"),
      recorded("routescan", "verifysourcecode-no-metadata-hash"),
      recorded("routescan", "checkverifystatus-no-metadata-hash-pass"),
    ]);
    assert.deepEqual(r.result, { status: "verified", backend: "routescan", match: "exact" });
    assert.equal(r.calls.length, 3);
  });

  it("Routescan: the lookup after that submit, which has no grade field, reads exact", async (t) => {
    const r = await lookupWith(
      t,
      ROUTESCAN,
      { backend: "routescan" },
      recorded("routescan", "getsourcecode-no-metadata-hash"),
    );
    assert.equal(r.lookup, "exact");
  });
});
