// R-DX-2: for real Hardhat 3 and Hardhat 2 builds, the helper gives the same result as passing the
// build files to buildVerifyInput by hand.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { buildVerifyInput } from "explorer-verify";

import { findHardhatBuild, verifyInputFromHardhat } from "../../src/index.ts";
import {
  HARDHAT_2,
  HARDHAT_2_BUILD_ID,
  HARDHAT_3,
  HARDHAT_3_BUILD_ID,
} from "../helpers/project.ts";

async function readJson(root: string, file: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(path.join(root, file), "utf8"));
  return parsed;
}

// One contract that inherits from another file, two contracts in one file, and a contract that
// links an external library.
const CONTRACTS = [
  { source: "contracts/Greeter.sol", name: "Greeter" },
  { source: "contracts/Pair.sol", name: "First" },
  { source: "contracts/Pair.sol", name: "Second" },
  { source: "contracts/Counter.sol", name: "Counter" },
] as const;

describe("R-DX-2: Hardhat 3.21.2 build", () => {
  for (const { source, name } of CONTRACTS) {
    it(`${source}:${name} gives the same result as buildVerifyInput on the files by hand`, async () => {
      const artifact = `artifacts/${source}/${name}.json`;
      const input = `artifacts/build-info/${HARDHAT_3_BUILD_ID}.json`;
      const output = `artifacts/build-info/${HARDHAT_3_BUILD_ID}.output.json`;
      const byHand = buildVerifyInput([
        await readJson(HARDHAT_3, artifact),
        await readJson(HARDHAT_3, input),
        await readJson(HARDHAT_3, output),
      ]);
      for (const contract of [`${source}:${name}`, name]) {
        const built = await verifyInputFromHardhat({ root: HARDHAT_3, contract });
        assert.deepEqual(built, byHand);
        assert.deepEqual(built.compiler, byHand.compiler);
      }
      assert.equal(byHand.contractName, `project/${source}:${name}`);
      assert.equal(byHand.compiler.version, "0.8.24+commit.e11b9ed9");
      const build = await findHardhatBuild({ root: HARDHAT_3, contract: name });
      assert.deepEqual(build.files, [artifact, input, output]);
    });
  }
});

describe("R-DX-2: Hardhat 2.29.1 build", () => {
  for (const { source, name } of CONTRACTS) {
    it(`${source}:${name} gives the same result as buildVerifyInput on the files by hand`, async () => {
      const artifact = `artifacts/${source}/${name}.json`;
      const input = `artifacts/build-info/${HARDHAT_2_BUILD_ID}.json`;
      const byHand = buildVerifyInput([
        await readJson(HARDHAT_2, artifact),
        await readJson(HARDHAT_2, input),
      ]);
      for (const contract of [`${source}:${name}`, name]) {
        const built = await verifyInputFromHardhat({ root: HARDHAT_2, contract });
        assert.deepEqual(built, byHand);
      }
      assert.equal(byHand.contractName, `${source}:${name}`);
      assert.equal(byHand.compiler.version, "0.8.24+commit.e11b9ed9");
      const build = await findHardhatBuild({ root: HARDHAT_2, contract: name });
      assert.deepEqual(build.files, [artifact, input]);
    });
  }
});

describe("R-DX-2: the library-linked contract", () => {
  it("keeps the library out of the compiler settings: Hardhat links at deploy time", async () => {
    for (const root of [HARDHAT_2, HARDHAT_3]) {
      const built = await verifyInputFromHardhat({ root, contract: "Counter" });
      assert.equal(built.compiler.input.settings.libraries, undefined);
    }
  });
});
