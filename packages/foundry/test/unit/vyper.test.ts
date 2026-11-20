// Tests for a Vyper contract in a Foundry project (R-DX-2, issue #426), run on the Foundry 1.8.1
// and Vyper 0.4.3 output in test/fixtures/vyper/ (see test/fixtures/README.md). `Counter` imports
// the module `ownable` and implements the interface `ICounter.vyi`.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import { buildVerifyInput, ExplorerVerifyError } from "explorer-verify";

import { buildVerifyInputFromFoundry, findFoundryBuild } from "../../src/index.ts";

const ROOT = fileURLToPath(new URL("../fixtures/vyper/", import.meta.url));
// The input buildVerifyInputFromFoundry returns for src/Counter.vy:Counter, compiled once with
// vyper-json 0.4.3 in an empty folder, and the bytecode that compile gave.
const RECOMPILE = fileURLToPath(new URL("../fixtures/vyper-recompile.json", import.meta.url));
const BUILD_INFO = "out/build-info/cb47506b7508bb34.json";
const ARTIFACT = "out/Counter.vy/Counter.json";
const VERSION = "0.4.3+commit.bff19ea2";
const FORGE_HINT = /^Run forge build --build-info\b/;

function readJson(root: string, file: string): unknown {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"));
}

/** A record read from a parsed JSON value, for tests that edit a fixture. */
function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

/** The string at `keys` in a parsed JSON value. */
function stringAt(value: unknown, ...keys: string[]): string {
  const found = keys.reduce<unknown>((current, key) => record(current)[key], value);
  assert.equal(typeof found, "string");
  return String(found);
}

const temporary: string[] = [];
after(() => {
  for (const dir of temporary) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A copy of the fixture project in a new folder. */
function copyProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "explorer-verify-foundry-vyper-"));
  temporary.push(dir);
  cpSync(ROOT, dir, { recursive: true });
  return dir;
}

function write(root: string, file: string, value: unknown): void {
  writeFileSync(path.join(root, file), JSON.stringify(value));
}

/** The build-info with the `Counter` entry's creation bytecode replaced by `object`. */
function withCounterBytecode(root: string, object: unknown): Record<string, unknown> {
  const buildInfo = record(readJson(root, BUILD_INFO));
  const output = record(buildInfo["output"]);
  const contracts = record(output["contracts"]);
  const file = record(contracts["src/Counter.vy"]);
  const counter = record(file["Counter"]);
  const evm = record(counter["evm"]);
  return {
    ...buildInfo,
    output: {
      ...output,
      contracts: {
        ...contracts,
        "src/Counter.vy": {
          ...file,
          Counter: {
            ...counter,
            evm: { ...evm, bytecode: { ...record(evm["bytecode"]), object } },
          },
        },
      },
    },
  };
}

/** The build-info's `output.contracts`. */
function contractsOf(root: string): Record<string, unknown> {
  return record(record(record(readJson(root, BUILD_INFO))["output"])["contracts"]);
}

/** Rewrites the build-info with `contracts` as its `output.contracts`. */
function writeContracts(root: string, contracts: Record<string, unknown>): void {
  const buildInfo = record(readJson(root, BUILD_INFO));
  write(root, BUILD_INFO, {
    ...buildInfo,
    output: { ...record(buildInfo["output"]), contracts },
  });
}

/** Calls `run`, which must reject with an ExplorerVerifyError, and returns the error. */
async function rejection(run: () => Promise<unknown>): Promise<ExplorerVerifyError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof ExplorerVerifyError,
    `expected an ExplorerVerifyError: ${String(caught)}`,
  );
  return caught;
}

/** A printed error without its stack frames, which name the folder the tests run from. */
function withoutFrames(printed: string): string {
  return printed
    .split("\n")
    .filter((line) => !/^\s+at /.test(line))
    .join("\n");
}

/** Checks the refusal of a Vyper contract that no build-info lists. */
function assertNoBuildInfo(error: ExplorerVerifyError, root: string): void {
  assert.equal(error.code, "insufficient-artifact");
  assert.deepEqual(error.details, { code: "insufficient-artifact", field: "input" });
  assert.equal(
    error.message,
    "No build-info file lists the Vyper contract with the artifact's creation bytecode, and the artifact holds only ABI and bytecode.",
  );
  assert.match(error.hint, FORGE_HINT);
  assert.match(error.hint, /build_info = true/);
  assert.ok(!withoutFrames(inspect(error)).includes(root));
}

describe("findFoundryBuild finds a Vyper contract's build-info (R-DX-2)", () => {
  for (const contract of ["src/Counter.vy:Counter", "./src/Counter.vy:Counter", "Counter"]) {
    it(`finds ${contract} by its source path and name`, async () => {
      const build = await findFoundryBuild({ root: ROOT, contract });
      assert.equal(build.contract, "src/Counter.vy:Counter");
      assert.deepEqual(build.files, [ARTIFACT, BUILD_INFO]);
      assert.deepEqual(build.documents, [readJson(ROOT, ARTIFACT), readJson(ROOT, BUILD_INFO)]);
      assert.deepEqual(build.sources, {});
    });
  }

  it("finds the imported module, which forge also lists as a contract", async () => {
    const build = await findFoundryBuild({ root: ROOT, contract: "src/ownable.vy:ownable" });
    assert.equal(build.contract, "src/ownable.vy:ownable");
    assert.deepEqual(build.files, ["out/ownable.vy/ownable.json", BUILD_INFO]);
  });

  it("reads the artifact the artifact option names", async () => {
    const build = await findFoundryBuild({ root: ROOT, contract: "Counter", artifact: ARTIFACT });
    assert.equal(build.contract, "src/Counter.vy:Counter");
  });

  it("skips a build-info whose creation bytecode for the contract differs", async () => {
    const root = copyProject();
    write(root, BUILD_INFO, withCounterBytecode(root, "00"));
    assertNoBuildInfo(
      await rejection(
        async () => await findFoundryBuild({ root, contract: "src/Counter.vy:Counter" }),
      ),
      root,
    );
  });

  it("compares the bytecode without 0x and in any case", async () => {
    const root = copyProject();
    const object = stringAt(readJson(root, ARTIFACT), "bytecode", "object");
    write(root, BUILD_INFO, withCounterBytecode(root, object.toUpperCase().replace("0X", "0x")));
    const build = await findFoundryBuild({ root, contract: "Counter" });
    assert.equal(build.files[1], BUILD_INFO);
  });

  it("matches on the path and name alone when either side has no creation bytecode", async () => {
    const root = copyProject();
    write(root, BUILD_INFO, withCounterBytecode(root, 1));
    assert.equal((await findFoundryBuild({ root, contract: "Counter" })).files[1], BUILD_INFO);
    const artifact = record(readJson(root, ARTIFACT));
    write(root, ARTIFACT, { abi: artifact["abi"], deployedBytecode: artifact["deployedBytecode"] });
    write(root, BUILD_INFO, readJson(ROOT, BUILD_INFO));
    assert.equal((await findFoundryBuild({ root, contract: "Counter" })).files[1], BUILD_INFO);
  });

  it("finds a path that ends with the path given, and refuses one that does not", async () => {
    const build = await findFoundryBuild({ root: ROOT, contract: "Counter.vy:Counter" });
    assert.equal(build.contract, "src/Counter.vy:Counter");
    assert.deepEqual(build.files, [ARTIFACT, BUILD_INFO]);
    const error = await rejection(
      async () => await findFoundryBuild({ root: ROOT, contract: "lib/Counter.vy:Counter" }),
    );
    assert.equal(error.code, "invalid-input");
    assert.equal(
      error.message,
      "The input is invalid: contract has a source path that no build-info lists for this contract; the build-info lists it under src/Counter.vy.",
    );
    assert.match(error.hint, /with the source path the build-info lists/);
  });

  it("prefers the path given over one that ends with it, then the first of those", async () => {
    const root = copyProject();
    const contracts = contractsOf(root);
    const counter = contracts["src/Counter.vy"];
    // Listed before the exact path, so a scan that stopped at the first match would take them.
    writeContracts(root, {
      "a/src/Counter.vy": counter,
      "b/src/Counter.vy": counter,
      ...contracts,
    });
    const exact = await findFoundryBuild({ root, contract: "src/Counter.vy:Counter" });
    assert.equal(exact.contract, "src/Counter.vy:Counter");
    const suffix = await findFoundryBuild({ root, contract: "Counter.vy:Counter" });
    assert.equal(suffix.contract, "a/src/Counter.vy:Counter");
  });

  it("lists another path for a path given, and takes any path for a bare name", async () => {
    const root = copyProject();
    const { "src/Counter.vy": counter, ...rest } = contractsOf(root);
    writeContracts(root, { ...rest, "src/Other.vy": counter });
    const error = await rejection(
      async () => await findFoundryBuild({ root, contract: "src/Counter.vy:Counter" }),
    );
    assert.equal(error.code, "invalid-input");
    assert.match(error.message, /the build-info lists it under src\/Other\.vy\.$/);
    const bare = await findFoundryBuild({ root, contract: "Counter" });
    assert.equal(bare.contract, "src/Other.vy:Counter");
  });

  it("never names a local path the build-info lists", async () => {
    const root = copyProject();
    const { "src/Counter.vy": counter, ...rest } = contractsOf(root);
    writeContracts(root, { ...rest, "/build/src/Counter.vy.bak": counter });
    assertNoBuildInfo(
      await rejection(
        async () => await findFoundryBuild({ root, contract: "src/Counter.vy:Counter" }),
      ),
      root,
    );
  });

  it("says to pass artifact when two artifacts without metadata match", async () => {
    const root = copyProject();
    cpSync(path.join(root, "out/Counter.vy"), path.join(root, "out/b/Counter.vy"), {
      recursive: true,
    });
    const error = await rejection(
      async () => await findFoundryBuild({ root, contract: "src/Counter.vy:Counter" }),
    );
    assert.equal(error.code, "invalid-input");
    assert.match(error.message, /matches 2 artifacts: a contract without metadata/);
    assert.equal(
      error.hint,
      "These artifacts hold no metadata, so the source path cannot tell them apart. Pass artifact with one of the files listed.",
    );
  });
});

describe("a Vyper contract without build-info (R-DX-2)", () => {
  for (const contract of ["src/Counter.vy:Counter", "Counter"]) {
    it(`refuses ${contract} with insufficient-artifact, naming forge build --build-info`, async () => {
      const root = copyProject();
      rmSync(path.join(root, "out/build-info"), { recursive: true });
      for (const run of [findFoundryBuild, buildVerifyInputFromFoundry]) {
        assertNoBuildInfo(await rejection(async () => await run({ root, contract })), root);
      }
    });
  }

  it("skips a build-info that names the contract but lists no contracts", async () => {
    const root = copyProject();
    const buildInfo = record(readJson(root, BUILD_INFO));
    write(root, BUILD_INFO, { ...buildInfo, output: { errors: [{ contract: "Counter" }] } });
    assertNoBuildInfo(
      await rejection(async () => await findFoundryBuild({ root, contract: "Counter" })),
      root,
    );
  });

  it("refuses a path that names no artifact, listing no Vyper artifact of that name", async () => {
    const error = await rejection(
      async () => await findFoundryBuild({ root: ROOT, contract: "src/Missing.vy:Counter" }),
    );
    assert.equal(error.code, "invalid-input");
    assert.equal(
      error.message,
      "The input is invalid: contract matches no artifact in the output directory.",
    );
  });

  it("refuses a stub build-info as a default forge build writes it", async () => {
    const root = copyProject();
    const { id, source_id_to_path: sourceIdToPath, language } = record(readJson(root, BUILD_INFO));
    write(root, BUILD_INFO, { id, source_id_to_path: sourceIdToPath, language });
    assertNoBuildInfo(
      await rejection(async () => await findFoundryBuild({ root, contract: "Counter" })),
      root,
    );
  });
});

describe("buildVerifyInputFromFoundry on a Vyper contract (R-DX-2)", () => {
  it("gives the input whose recorded compile gives the artifact bytecode", async () => {
    const built = await buildVerifyInputFromFoundry({
      root: ROOT,
      contract: "src/Counter.vy:Counter",
    });
    const recompile = record(JSON.parse(readFileSync(RECOMPILE, "utf8")));
    const artifact = readJson(ROOT, ARTIFACT);
    assert.equal(built.contractName, "src/Counter.vy:Counter");
    assert.equal(built.compiler.kind, "vyper");
    assert.equal(built.compiler.version, VERSION);
    assert.equal(recompile["compiler"], VERSION);
    // The input compiled is the input built, so its bytecode is the build's.
    assert.deepEqual(built.compiler.input, recompile["input"]);
    const bytecode = stringAt(recompile, "bytecode");
    assert.equal(bytecode, stringAt(artifact, "bytecode", "object"));
    assert.equal(
      stringAt(recompile, "deployedBytecode"),
      stringAt(artifact, "deployedBytecode", "object"),
    );
    assert.equal(built.creationBytecode, bytecode);
    const input = record(built.compiler.input);
    assert.deepEqual(Object.keys(record(input["sources"])), ["src/Counter.vy", "src/ownable.vy"]);
    assert.deepEqual(Object.keys(record(input["interfaces"])), ["src/interfaces/ICounter.vyi"]);
  });

  it("gives what buildVerifyInput gives on the build-info by hand", async () => {
    for (const contract of ["src/Counter.vy:Counter", "src/ownable.vy:ownable"]) {
      const byHand = buildVerifyInput([readJson(ROOT, BUILD_INFO)], { contract });
      assert.deepEqual(await buildVerifyInputFromFoundry({ root: ROOT, contract }), byHand);
    }
  });

  it("takes compilerVersion when it names the same release", async () => {
    const built = await buildVerifyInputFromFoundry({
      root: ROOT,
      contract: "Counter",
      compilerVersion: VERSION,
    });
    assert.equal(built.compiler.version, VERSION);
  });
});

describe("the Vyper fixture", () => {
  it("holds no absolute path and no name of the machine or user that built it", () => {
    const user = userInfo().username;
    const forbidden = [homedir(), ...(user.length >= 4 ? [user] : [])];
    const files = [
      RECOMPILE,
      ...readdirSync(ROOT, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".json"))
        .map((file) => path.join(ROOT, file)),
    ];
    assert.equal(files.length, 4);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /"(?:\/(?:Users|home|private|tmp|var|root|opt)\/|[A-Za-z]:\\\\)/);
      for (const word of forbidden) {
        assert.ok(!text.includes(word), `${file} holds a local name`);
      }
    }
  });
});
