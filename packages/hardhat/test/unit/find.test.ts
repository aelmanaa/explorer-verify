// R-DX-2: findHardhatBuild finds and reads a contract's build files, and fails with an error from
// the core's catalogue that names what it looked for.
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "explorer-verify";

import { findHardhatBuild, verifyInputFromHardhat } from "../../src/index.ts";
import type { FindHardhatBuildOptions } from "../../src/index.ts";
import {
  HARDHAT_2,
  HARDHAT_2_BUILD_ID,
  HARDHAT_3,
  HARDHAT_3_BUILD_ID,
  withCopy,
} from "../helpers/project.ts";

const H3_INPUT = `artifacts/build-info/${HARDHAT_3_BUILD_ID}.json`;
const H3_OUTPUT = `artifacts/build-info/${HARDHAT_3_BUILD_ID}.output.json`;
const H2_INPUT = `artifacts/build-info/${HARDHAT_2_BUILD_ID}.json`;
// Permissions do not stop root from reading, so the unreadable-file tests skip under root.
const RUNS_AS_ROOT = process.getuid?.() === 0;

/** The error `promise` rejects with, checked to be an ExplorerVerifyError. */
async function rejection(promise: Promise<unknown>): Promise<ExplorerVerifyError> {
  const error = await promise.then(
    () => new Error("expected a rejection"),
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof ExplorerVerifyError, String(error));
  return error;
}

/** The single invalid-input issue of `error`. */
function issue(error: ExplorerVerifyError): { field: string; message: string } {
  assert.equal(error.details.code, "invalid-input");
  if (error.details.code !== "invalid-input") {
    throw new Error("unreachable");
  }
  const [only, ...rest] = error.details.issues;
  assert.ok(only !== undefined);
  assert.equal(rest.length, 0);
  return only;
}

async function writeJson(root: string, file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), JSON.stringify(value));
}

describe("R-DX-2: findHardhatBuild on Hardhat 3", () => {
  it("returns the artifact, the build-info and its output file, parsed", async () => {
    const build = await findHardhatBuild({ root: HARDHAT_3, contract: "Greeter" });
    assert.equal(build.documents.length, 3);
    const [artifact, input, output] = build.documents;
    assert.deepEqual(
      artifact,
      JSON.parse(
        await readFile(
          path.join(HARDHAT_3, "artifacts/contracts/Greeter.sol/Greeter.json"),
          "utf8",
        ),
      ),
    );
    assert.deepEqual(input, JSON.parse(await readFile(path.join(HARDHAT_3, H3_INPUT), "utf8")));
    assert.deepEqual(output, JSON.parse(await readFile(path.join(HARDHAT_3, H3_OUTPUT), "utf8")));
  });

  it("accepts a relative root", async () => {
    const root = path.relative(process.cwd(), HARDHAT_3);
    const build = await findHardhatBuild({ root, contract: "Greeter" });
    assert.equal(build.files[0], "artifacts/contracts/Greeter.sol/Greeter.json");
  });

  it("names the missing build-info file, relative to the root", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      await rm(path.join(root, H3_INPUT));
      const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.equal(error.code, "incomplete-input");
      assert.deepEqual(error.details, { code: "incomplete-input", field: "input", candidates: [] });
      assert.equal(error.message, `The build-info file ${H3_INPUT} was not found.`);
      assert.match(error.hint, /npx hardhat build/);
      assert.ok(!error.message.includes(root));
    });
  });

  it("names the missing output file, relative to the root", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      await rm(path.join(root, H3_OUTPUT));
      const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.equal(error.code, "incomplete-input");
      assert.equal(error.message, `The build-info output file ${H3_OUTPUT} was not found.`);
    });
  });

  it("refuses a buildInfoId that is not a file name", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      const file = "artifacts/contracts/Greeter.sol/Greeter.json";
      for (const buildInfoId of ["../../secret", 42, ""]) {
        await writeJson(root, file, { abi: [], bytecode: "0x", buildInfoId });
        const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
        assert.deepEqual(issue(error), {
          field: file,
          message: "has a buildInfoId that is not a file name",
        });
      }
    });
  });

  it("passes on what buildVerifyInput throws for documents of different builds", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      const output = JSON.parse(await readFile(path.join(root, H3_OUTPUT), "utf8"));
      await writeJson(root, H3_OUTPUT, { ...output, id: "another-build" });
      const error = await rejection(verifyInputFromHardhat({ root, contract: "Greeter" }));
      assert.equal(issue(error).field, "documents");
    });
  });
});

describe("R-DX-2: findHardhatBuild on Hardhat 2", () => {
  it("follows the .dbg.json file to the build-info", async () => {
    const build = await findHardhatBuild({
      root: HARDHAT_2,
      contract: "contracts/Pair.sol:Second",
    });
    assert.deepEqual(build.files, ["artifacts/contracts/Pair.sol/Second.json", H2_INPUT]);
    assert.equal(build.documents.length, 2);
  });

  it("names the missing build-info file, relative to the root", async () => {
    await withCopy(HARDHAT_2, async (root) => {
      await rm(path.join(root, H2_INPUT));
      const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.equal(error.code, "incomplete-input");
      assert.equal(error.message, `The build-info file ${H2_INPUT} was not found.`);
    });
  });

  it("names the artifact and the .dbg.json file when neither names a build-info", async () => {
    await withCopy(HARDHAT_2, async (root) => {
      await rm(path.join(root, "artifacts/contracts/Greeter.sol/Greeter.dbg.json"));
      const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.equal(error.code, "incomplete-input");
      assert.equal(
        error.message,
        "The artifact artifacts/contracts/Greeter.sol/Greeter.json names no build-info: it has no buildInfoId, and artifacts/contracts/Greeter.sol/Greeter.dbg.json was not found.",
      );
    });
  });

  it("passes on invalid-input on contract for an artifact the build-info does not hold", async () => {
    await withCopy(HARDHAT_2, async (root) => {
      const buildInfo = JSON.parse(await readFile(path.join(root, H2_INPUT), "utf8"));
      delete buildInfo.input.sources["contracts/Greeter.sol"];
      await writeJson(root, H2_INPUT, buildInfo);
      const error = await rejection(verifyInputFromHardhat({ root, contract: "Greeter" }));
      assert.equal(issue(error).field, "contract");
    });
  });

  it("refuses a .dbg.json file without a buildInfo path", async () => {
    await withCopy(HARDHAT_2, async (root) => {
      const file = "artifacts/contracts/Greeter.sol/Greeter.dbg.json";
      for (const value of [{ _format: "hh-sol-dbg-1" }, { buildInfo: 1 }, ["../x.json"]]) {
        await writeJson(root, file, value);
        const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
        assert.deepEqual(issue(error), { field: file, message: "has no buildInfo path" });
      }
    });
  });

  it("refuses a buildInfo path outside the build-info folder", async () => {
    await withCopy(HARDHAT_2, async (root) => {
      const file = "artifacts/contracts/Greeter.sol/Greeter.dbg.json";
      for (const buildInfo of ["../../../package.json", "/etc/hosts", "../Greeter.json"]) {
        await writeJson(root, file, { buildInfo });
        const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
        assert.deepEqual(issue(error), {
          field: file,
          message: "has a buildInfo path outside the build-info folder",
        });
      }
    });
  });

  it("reads a field only when the document holds it as its own", async () => {
    await withCopy(HARDHAT_2, async (root) => {
      const file = "artifacts/contracts/Greeter.sol/Greeter.dbg.json";
      await writeFile(path.join(root, file), '{"__proto__": {"buildInfo": "x.json"}}');
      const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.deepEqual(issue(error), { field: file, message: "has no buildInfo path" });
    });
  });
});

describe("R-DX-2: choosing the contract", () => {
  it("lists every match, sorted, when a bare name matches several artifacts", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      await writeJson(root, "artifacts/contracts/other/Greeter.sol/Greeter.json", { abi: [] });
      await writeJson(root, "artifacts/@scope/lib/Greeter.sol/Greeter.json", { abi: [] });
      const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.equal(error.message, "The contract name matches 3 artifacts.");
      assert.deepEqual(error.details, {
        code: "incomplete-input",
        field: "contract",
        candidates: [
          "@scope/lib/Greeter.sol:Greeter",
          "contracts/Greeter.sol:Greeter",
          "contracts/other/Greeter.sol:Greeter",
        ],
      });
      // path:Name picks one of them.
      const build = await findHardhatBuild({ root, contract: "contracts/Greeter.sol:Greeter" });
      assert.equal(build.files[0], "artifacts/contracts/Greeter.sol/Greeter.json");
    });
  });

  it("lists at most 20 matches", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      for (let index = 0; index < 25; index++) {
        await writeJson(root, `artifacts/many/F${String(index)}.sol/Greeter.json`, { abi: [] });
      }
      const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.equal(error.message, "The contract name matches 26 artifacts.");
      assert.ok(error.details.code === "incomplete-input");
      assert.equal(error.details.candidates.length, 20);
    });
  });

  it("ignores build-info files and .dbg.json files when it searches a bare name", async () => {
    await withCopy(HARDHAT_2, async (root) => {
      await writeJson(root, "artifacts/build-info/Greeter.json", { abi: [] });
      const build = await findHardhatBuild({ root, contract: "Greeter" });
      assert.equal(build.files[0], "artifacts/contracts/Greeter.sol/Greeter.json");
    });
  });

  it("refuses a bare name that matches no artifact", async () => {
    const error = await rejection(findHardhatBuild({ root: HARDHAT_3, contract: "Missing" }));
    assert.deepEqual(issue(error), {
      field: "contract",
      message: "matches no artifact under artifacts",
    });
    assert.match(error.hint, /npx hardhat compile/);
  });

  it("refuses path:Name with no artifact, naming the file it looked for", async () => {
    for (const contract of [
      "contracts/Greeter.sol:Missing",
      "contracts/Missing.sol:Greeter",
      "contracts/Greeter.sol/Greeter.json:Greeter",
    ]) {
      const error = await rejection(findHardhatBuild({ root: HARDHAT_3, contract }));
      const [source, name] = contract.split(":");
      const message = `matches no artifact: artifacts/${String(source)}/${String(name)}.json does not exist`;
      assert.deepEqual(issue(error), { field: "contract", message });
      // The message names the file too, not only details.issues.
      assert.equal(error.message, `The input is invalid: contract ${message}.`);
    }
  });

  it("accepts a Hardhat 3 input source name, dropping the leading project/", async () => {
    const build = await findHardhatBuild({
      root: HARDHAT_3,
      contract: "project/contracts/Greeter.sol:Greeter",
    });
    assert.equal(build.files[0], "artifacts/contracts/Greeter.sol/Greeter.json");
    const built = await verifyInputFromHardhat({
      root: HARDHAT_3,
      contract: "project/contracts/Pair.sol:Second",
    });
    assert.equal(built.contractName, "project/contracts/Pair.sol:Second");
  });

  it("prefers an artifact under a real project/ folder, and names it when neither exists", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      const artifact = await readFile(path.join(root, "artifacts/contracts/Pair.sol/First.json"));
      await mkdir(path.join(root, "artifacts/project/contracts/Greeter.sol"), { recursive: true });
      await writeFile(
        path.join(root, "artifacts/project/contracts/Greeter.sol/Greeter.json"),
        artifact,
      );
      const build = await findHardhatBuild({
        root,
        contract: "project/contracts/Greeter.sol:Greeter",
      });
      assert.equal(build.files[0], "artifacts/project/contracts/Greeter.sol/Greeter.json");
    });
    const error = await rejection(
      findHardhatBuild({ root: HARDHAT_3, contract: "project/contracts/Missing.sol:Greeter" }),
    );
    assert.deepEqual(issue(error), {
      field: "contract",
      message:
        "matches no artifact: artifacts/project/contracts/Missing.sol/Greeter.json does not exist",
    });
    const escape = await rejection(
      findHardhatBuild({ root: HARDHAT_3, contract: "project/../../x:Greeter" }),
    );
    assert.equal(issue(escape).message, "must have a source path relative to the artifacts folder");
  });

  it("refuses a name that is not a Solidity identifier", async () => {
    for (const contract of ["", "contracts/Greeter.sol:", "Greeter.dbg", "1Greeter", "a/b"]) {
      const error = await rejection(findHardhatBuild({ root: HARDHAT_3, contract }));
      assert.equal(issue(error).field, "contract");
    }
  });

  it("refuses a source path outside the artifacts folder", async () => {
    for (const contract of [
      ":Greeter",
      "/etc:Greeter",
      "../contracts/Greeter.sol:Greeter",
      "contracts/../../x:Greeter",
    ]) {
      const error = await rejection(findHardhatBuild({ root: HARDHAT_3, contract }));
      assert.deepEqual(issue(error), {
        field: "contract",
        message: "must have a source path relative to the artifacts folder",
      });
    }
  });
});

describe("R-DX-2: the artifacts folder", () => {
  it("reads the folder that options.artifacts names, relative to the root", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      await rename(path.join(root, "artifacts"), path.join(root, "out"));
      const build = await findHardhatBuild({ root, contract: "First", artifacts: "out" });
      assert.deepEqual(build.files, [
        "out/contracts/Pair.sol/First.json",
        `out/build-info/${HARDHAT_3_BUILD_ID}.json`,
        `out/build-info/${HARDHAT_3_BUILD_ID}.output.json`,
      ]);
      const absolute = await findHardhatBuild({
        root,
        contract: "First",
        artifacts: path.join(root, "out"),
      });
      assert.deepEqual(absolute.files, build.files);
    });
  });

  it("refuses a missing artifacts folder", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      await rm(path.join(root, "artifacts"), { recursive: true });
      const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.deepEqual(issue(error), {
        field: "artifacts",
        message: "names no folder: artifacts does not exist",
      });
      assert.match(error.hint, /paths\.artifacts/);
      // A path:Name contract gets the same error.
      const named = await rejection(
        findHardhatBuild({ root, contract: "contracts/Greeter.sol:Greeter" }),
      );
      assert.equal(
        named.message,
        "The input is invalid: artifacts names no folder: artifacts does not exist.",
      );
      // An artifacts path that is a file is no folder either.
      await writeFile(path.join(root, "artifacts"), "");
      const file = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.deepEqual(issue(file), {
        field: "artifacts",
        message: "names no folder: artifacts is a file",
      });
    });
  });

  it("refuses an artifacts folder that cannot be read, keeping the cause", async () => {
    const error = await rejection(
      findHardhatBuild({ root: HARDHAT_3, contract: "Greeter", artifacts: "a".repeat(300) }),
    );
    assert.equal(issue(error).message, "cannot be read");
    assert.ok(error.cause instanceof Error);
  });
});

describe("R-DX-2: files that are not JSON or cannot be read", () => {
  it("names a file that is not valid JSON", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      await writeFile(path.join(root, H3_INPUT), "{ not json");
      const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.deepEqual(issue(error), { field: H3_INPUT, message: "is not valid JSON" });
    });
  });

  it("refuses a path that is a folder, not a file", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      await rm(path.join(root, H3_OUTPUT));
      await mkdir(path.join(root, H3_OUTPUT));
      const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.deepEqual(issue(error), { field: H3_OUTPUT, message: "is not a file" });
      assert.equal(error.message, `The input is invalid: ${H3_OUTPUT} is not a file.`);
    });
  });

  it("refuses a file larger than 256 MiB without reading it", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      // A sparse file: the size is set, no data is written.
      await truncate(path.join(root, H3_INPUT), 256 * 1024 * 1024 + 1);
      const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.deepEqual(issue(error), { field: H3_INPUT, message: "is larger than 256 MiB" });
    });
  });

  it("names a file that cannot be read, keeping the cause", { skip: RUNS_AS_ROOT }, async () => {
    await withCopy(HARDHAT_3, async (root) => {
      await chmod(path.join(root, H3_OUTPUT), 0o000);
      const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.deepEqual(issue(error), { field: H3_OUTPUT, message: "cannot be read" });
      assert.equal(error.message, `The input is invalid: ${H3_OUTPUT} cannot be read.`);
      assert.ok(error.cause instanceof Error);
    });
  });

  it("names a folder the search cannot read", { skip: RUNS_AS_ROOT }, async () => {
    await withCopy(HARDHAT_3, async (root) => {
      const locked = path.join(root, "artifacts/contracts/Pair.sol");
      await chmod(locked, 0o000);
      try {
        const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
        assert.deepEqual(issue(error), {
          field: "artifacts/contracts/Pair.sol",
          message: "cannot be read",
        });
      } finally {
        await chmod(locked, 0o755);
      }
    });
  });
});

describe("R-DX-2: symlinks and paths that leave the artifacts folder", () => {
  it("finishes the bare-name search when symlinks loop back to the root", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      const artifacts = path.join(root, "artifacts");
      await symlink(artifacts, path.join(artifacts, "contracts/loop-a"), "dir");
      await symlink(artifacts, path.join(artifacts, "contracts/Pair.sol/loop-b"), "dir");
      const build = await findHardhatBuild({ root, contract: "Greeter" });
      assert.equal(build.files[0], "artifacts/contracts/Greeter.sol/Greeter.json");
    });
  });

  it("does not follow a symlinked folder or file in the search", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      const artifacts = path.join(root, "artifacts");
      await symlink(path.join(artifacts, "contracts/Greeter.sol"), path.join(artifacts, "linked"));
      await symlink(
        path.join(artifacts, "contracts/Greeter.sol/Greeter.json"),
        path.join(artifacts, "contracts/Greeter.json"),
      );
      const build = await findHardhatBuild({ root, contract: "Greeter" });
      assert.equal(build.files[0], "artifacts/contracts/Greeter.sol/Greeter.json");
    });
  });

  it("refuses a file that resolves outside the artifacts folder", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      const outside = path.join(root, "outside.json");
      await writeFile(outside, "{}");
      await rm(path.join(root, H3_INPUT));
      await symlink(outside, path.join(root, H3_INPUT));
      const error = await rejection(findHardhatBuild({ root, contract: "Greeter" }));
      assert.deepEqual(issue(error), {
        field: H3_INPUT,
        message: "resolves to a path outside the artifacts folder",
      });
    });
  });

  it("reads an artifacts folder that is itself a symlink", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      await rename(path.join(root, "artifacts"), path.join(root, "real"));
      await symlink(path.join(root, "real"), path.join(root, "artifacts"), "dir");
      const build = await findHardhatBuild({ root, contract: "Greeter" });
      assert.equal(build.files[0], "artifacts/contracts/Greeter.sol/Greeter.json");
    });
  });

  it("treats a folder named ..x as inside the artifacts folder", async () => {
    await withCopy(HARDHAT_3, async (root) => {
      const artifact = await readFile(
        path.join(root, "artifacts/contracts/Greeter.sol/Greeter.json"),
      );
      await mkdir(path.join(root, "artifacts/..x/Greeter.sol"), { recursive: true });
      await writeFile(path.join(root, "artifacts/..x/Greeter.sol/Greeter.json"), artifact);
      const build = await findHardhatBuild({ root, contract: "..x/Greeter.sol:Greeter" });
      assert.equal(build.files[0], "artifacts/..x/Greeter.sol/Greeter.json");
    });
  });
});

describe("R-DX-2: options", () => {
  const cases: [string, string, unknown][] = [
    ["root", "no root", { contract: "Greeter" }],
    ["root", "an empty root", { root: "", contract: "Greeter" }],
    ["root", "a number as root", { root: 1, contract: "Greeter" }],
    ["contract", "no contract", { root: HARDHAT_3 }],
    ["contract", "a number as contract", { root: HARDHAT_3, contract: 1 }],
    ["artifacts", "an empty artifacts", { root: HARDHAT_3, contract: "Greeter", artifacts: "" }],
    ["artifacts", "a number as artifacts", { root: HARDHAT_3, contract: "Greeter", artifacts: 1 }],
    ["root", "no options", undefined],
    ["root", "a string as options", "options"],
  ];
  for (const [field, label, options] of cases) {
    it(`names ${field} for ${label}`, async () => {
      const error = await rejection(findHardhatBuild(optionsOf(options)));
      assert.equal(issue(error).field, field);
    });
  }
});

/** `value` typed as the options without a cast, as a JavaScript caller passes it. */
function optionsOf(value: unknown): FindHardhatBuildOptions {
  const box: { options: FindHardhatBuildOptions } = { options: { root: "", contract: "" } };
  Reflect.set(box, "options", value);
  return box.options;
}
