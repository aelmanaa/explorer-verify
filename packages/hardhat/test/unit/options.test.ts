// R-DX-2, R-IN-7 (#223): the Hardhat helpers take the same option names and return the same
// result shape as the Foundry helpers: `outDir`, `artifact`, a `contract` in the result, an empty
// `sources`, and `compilerVersion` and `sources` forwarded to buildVerifyInput.
import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "explorer-verify";

import { buildVerifyInputFromHardhat, findHardhatBuild } from "../../src/index.ts";
import type { BuildFromProjectOptions } from "../../src/index.ts";
import { HARDHAT_2, HARDHAT_3, withCopy } from "../helpers/project.ts";

const GREETER = "artifacts/contracts/Greeter.sol/Greeter.json";
const VERSION = "0.8.24+commit.e11b9ed9";

/** The error `promise` rejects with, checked to be an ExplorerVerifyError. */
async function rejection(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const error = await promise.then(
    () => new Error("expected a rejection"),
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof ExplorerVerifyError, String(error));
  return error;
}

/** The issues of an `invalid-input` error. */
function issues(error: ExplorerVerifyError): { field: string; message: string }[] {
  assert.equal(error.details.code, "invalid-input");
  return error.details.code === "invalid-input"
    ? error.details.issues.map(({ field, message }) => ({ field, message }))
    : [];
}

/** `buildVerifyInputFromHardhat` called as untyped JavaScript calls it. */
async function buildUntyped(options: Record<string, unknown>): Promise<unknown> {
  const pending: unknown = Reflect.apply(buildVerifyInputFromHardhat, undefined, [options]);
  return await pending;
}

describe("R-DX-2: the contract in the result of findHardhatBuild", () => {
  for (const [version, root] of [
    ["Hardhat 3", HARDHAT_3],
    ["Hardhat 2", HARDHAT_2],
  ] as const) {
    it(`is path:Name from where the artifact is, for a bare name on ${version}`, async () => {
      const build = await findHardhatBuild({ root, contract: "Greeter" });
      assert.equal(build.contract, "contracts/Greeter.sol:Greeter");
      assert.deepEqual(build.sources, {});
    });
  }

  it("drops the project/ prefix of a Hardhat 3 input source name", async () => {
    const build = await findHardhatBuild({
      root: HARDHAT_3,
      contract: "project/contracts/Pair.sol:Second",
    });
    assert.equal(build.contract, "contracts/Pair.sol:Second");
  });

  it("is the bare name for an artifact at the top of the output folder", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      await rename(path.join(root, GREETER), path.join(root, "artifacts/Greeter.json"));
      const build = await findHardhatBuild({ root, contract: "Greeter" });
      assert.equal(build.contract, "Greeter");
    });
  });
});

describe("R-DX-2: the artifact option of findHardhatBuild", () => {
  it("reads the named artifact, relative to the root or absolute", async () => {
    for (const artifact of [GREETER, path.join(HARDHAT_3, GREETER)]) {
      for (const contract of ["Greeter", "contracts/Greeter.sol:Greeter"]) {
        const build = await findHardhatBuild({ root: HARDHAT_3, contract, artifact });
        assert.equal(build.files[0], GREETER);
        assert.equal(build.contract, "contracts/Greeter.sol:Greeter");
        assert.equal(build.documents.length, 3);
      }
    }
  });

  it("accepts the artifact of a Hardhat 3 input source name", async () => {
    const build = await findHardhatBuild({
      root: HARDHAT_3,
      contract: "project/contracts/Greeter.sol:Greeter",
      artifact: GREETER,
    });
    assert.equal(build.files[0], GREETER);
  });

  it("refuses an artifact of another contract or outside the output folder", async () => {
    const cases: [string, string][] = [
      ["Base", GREETER],
      ["contracts/Pair.sol:Greeter", GREETER],
      ["Greeter", "Greeter.json"],
      ["Greeter", "../Greeter.json"],
    ];
    for (const [contract, artifact] of cases) {
      const error = await rejection(findHardhatBuild({ root: HARDHAT_3, contract, artifact }));
      // A file outside the project is named by its absolute path, not one that starts with "..".
      const file = path.resolve(HARDHAT_3, artifact);
      const relative = path.relative(HARDHAT_3, file);
      const shown = relative.startsWith("..") ? file : relative;
      assert.deepEqual(issues(error), [
        {
          field: "artifact",
          message: `is not the artifact of the contract in the artifacts folder: ${shown}`,
        },
      ]);
    }
  });

  it("names the artifact file that does not exist", async () => {
    const error = await rejection(
      findHardhatBuild({
        root: HARDHAT_3,
        contract: "Missing",
        artifact: "artifacts/contracts/Missing.sol/Missing.json",
      }),
    );
    assert.deepEqual(issues(error), [
      {
        field: "contract",
        message: "matches no artifact: artifacts/contracts/Missing.sol/Missing.json does not exist",
      },
    ]);
  });

  it("refuses an artifact option that is not a non-empty string", async () => {
    for (const artifact of ["", 1]) {
      const pending: unknown = Reflect.apply(findHardhatBuild, undefined, [
        { root: HARDHAT_3, contract: "Greeter", artifact },
      ]);
      const error = await rejection(Promise.resolve(pending));
      assert.deepEqual(issues(error), [
        { field: "artifact", message: "must be a non-empty string when set" },
      ]);
    }
  });

  it("refuses a contract name that is not an identifier with the artifact option", async () => {
    const error = await rejection(
      findHardhatBuild({ root: HARDHAT_3, contract: "1x", artifact: GREETER }),
    );
    assert.equal(issues(error)[0]?.field, "contract");
  });
});

describe("R-IN-7: buildVerifyInputFromHardhat forwards compilerVersion and sources", () => {
  it("passes compilerVersion to buildVerifyInput: the same version builds", async () => {
    const options: BuildFromProjectOptions = {
      root: HARDHAT_3,
      contract: "Greeter",
      compilerVersion: VERSION,
    };
    const built = await buildVerifyInputFromHardhat(options);
    assert.equal(built.compiler.version, VERSION);
  });

  it("passes compilerVersion to buildVerifyInput: another version is refused", async () => {
    const error = await rejection(
      buildVerifyInputFromHardhat({
        root: HARDHAT_3,
        contract: "Greeter",
        compilerVersion: "0.8.20+commit.a1b79de6",
      }),
    );
    assert.deepEqual(issues(error), [
      { field: "compilerVersion", message: "differs from the compiler version in the documents" },
    ]);
  });

  it("passes sources to buildVerifyInput, which checks them", async () => {
    const error = await rejection(
      buildUntyped({ root: HARDHAT_3, contract: "Greeter", sources: 42 }),
    );
    assert.equal(issues(error)[0]?.field, "sources");
  });

  it("does not pass the contract option to buildVerifyInput", async () => {
    const built = await buildVerifyInputFromHardhat({
      root: HARDHAT_3,
      contract: "project/contracts/Greeter.sol:Greeter",
    });
    assert.equal(built.contractName, "project/contracts/Greeter.sol:Greeter");
  });
});
