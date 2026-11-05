// R-DX-2 (#223): findHardhatBuild and findFoundryBuild return the same result shape for the same
// project, and the two packages take the same option names. The project holds a Foundry build
// (`out/`, `src/`) and a Hardhat 3 build (`artifacts/`) of the same Greeter contract.
import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildVerifyInputFromFoundry, findFoundryBuild } from "@explorer-verify/foundry";
import type * as Foundry from "@explorer-verify/foundry";

import { buildVerifyInputFromHardhat, findHardhatBuild } from "../../src/index.ts";
import type * as Hardhat from "../../src/index.ts";
import { HARDHAT_3 } from "../helpers/project.ts";

const FOUNDRY_PROJECT = fileURLToPath(
  new URL("../../../foundry/test/fixtures/project", import.meta.url),
);

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// One result type: the same fields with the same types.
const sameBuild: Equal<Foundry.ProjectBuild, Hardhat.ProjectBuild> = true;
// The Hardhat options are the Foundry options without `buildInfoDir`.
const sameOptions: Equal<
  Omit<Foundry.FindBuildOptions, "buildInfoDir">,
  Hardhat.FindBuildOptions
> = true;
const sameBuildOptions: Equal<
  Omit<Foundry.BuildFromProjectOptions, "buildInfoDir">,
  Hardhat.BuildFromProjectOptions
> = true;

/** The kind of each field of `value`, by name, sorted: the shape a caller reads. */
function shape(value: object): [string, string][] {
  return Object.entries(value)
    .map(([key, field]): [string, string] => [
      key,
      Array.isArray(field)
        ? `array of ${[...new Set(field.map((each: unknown) => typeof each))].join("|")}`
        : typeof field,
    ])
    .toSorted(([a], [b]) => a.localeCompare(b));
}

/** Copies both builds to one temporary project, runs `body` on it and removes it. */
async function withBothBuilds(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "explorer-verify-shape-"));
  try {
    await cp(FOUNDRY_PROJECT, root, { recursive: true });
    await cp(path.join(HARDHAT_3, "artifacts"), path.join(root, "artifacts"), { recursive: true });
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("R-DX-2: the find* helpers return one shape", () => {
  it("has the same option and result types in both packages", () => {
    assert.ok(sameBuild && sameOptions && sameBuildOptions);
  });

  it("gives the same result shape for the same project and options", async () => {
    await withBothBuilds(async (root) => {
      const options = { root, contract: "Greeter" };
      const foundry = await findFoundryBuild({ ...options, outDir: "out" });
      const hardhat = await findHardhatBuild({ ...options, outDir: "artifacts" });
      assert.deepEqual(shape(foundry), shape(hardhat));
      assert.deepEqual(shape(foundry), [
        ["contract", "string"],
        ["documents", "array of object"],
        ["files", "array of string"],
        ["sources", "object"],
      ]);
      assert.equal(foundry.contract, "src/Greeter.sol:Greeter");
      assert.equal(hardhat.contract, "contracts/Greeter.sol:Greeter");
      assert.equal(foundry.files[0], "out/Greeter.sol/Greeter.json");
      assert.equal(hardhat.files[0], "artifacts/contracts/Greeter.sol/Greeter.json");
    });
  });

  it("builds an input of the same shape from both helpers with the same options", async () => {
    await withBothBuilds(async (root) => {
      const options = { root, contract: "Greeter", compilerVersion: "0.8.24+commit.e11b9ed9" };
      const foundry = await buildVerifyInputFromFoundry(options);
      const hardhat = await buildVerifyInputFromHardhat(options);
      assert.deepEqual(Object.keys(foundry).toSorted(), Object.keys(hardhat).toSorted());
      assert.equal(foundry.compiler.version, hardhat.compiler.version);
    });
  });
});
