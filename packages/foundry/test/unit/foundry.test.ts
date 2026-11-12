// Tests for findFoundryBuild and buildVerifyInputFromFoundry (R-DX-2), run on the Foundry 1.8.1 output
// in test/fixtures/project/ (see test/fixtures/README.md). `out-build-info/` comes from
// `forge build --build-info`, `out/` from a default `forge build`, which writes a stub build-info.
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildVerifyInput, ExplorerVerifyError } from "explorer-verify";
import type { ErrorCode } from "explorer-verify";

import { findFoundryBuild, buildVerifyInputFromFoundry } from "../../src/index.ts";
import type { FindBuildOptions } from "../../src/index.ts";

const ROOT = fileURLToPath(new URL("../fixtures/project/", import.meta.url));
// Foundry 1.8.1 output of one library file built with solc 0.8.20 and 0.8.24, with
// extra_output_files = ["metadata"] (see test/fixtures/README.md).
const MULTI = fileURLToPath(new URL("../fixtures/multi/", import.meta.url));
const MULTI_BUILD_INFO: Record<string, string> = {
  "0.8.20": "out/build-info/9dfba6f9116d6433.json",
  "0.8.24": "out/build-info/76721a2d5c7f80f3.json",
};
// Permission tests need a user that file modes apply to.
const ROOT_USER = process.getuid?.() === 0;
const FULL = "out-build-info";
const BUILD_INFO = "out-build-info/build-info/cc03796b40982b2b.json";
const STUB = "out/build-info/c7409fb9bbf470dc.json";
const LIBRARY = "0x5A0b54D5dc17e0AadC383d2db43B0a0D3E029c4c";

function readJson(root: string, file: string): unknown {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"));
}

function readText(root: string, file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

/** A record read from a parsed JSON value, for tests that edit a fixture. */
function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

const temporary: string[] = [];
after(() => {
  for (const dir of temporary) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function temporaryDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "explorer-verify-foundry-"));
  temporary.push(dir);
  return dir;
}

/** A new project directory holding a copy of the listed fixture paths. */
function copyProject(...entries: string[]): string {
  const dir = temporaryDir();
  for (const entry of entries) {
    cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  return dir;
}

function write(root: string, file: string, value: unknown): void {
  writeFileSync(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value));
}

/** Calls `run`, which must reject with an ExplorerVerifyError of `code`, and returns the error. */
async function rejection(
  run: () => Promise<unknown>,
  code: ErrorCode,
): Promise<ExplorerVerifyError> {
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
  assert.equal(caught.code, code, caught.message);
  return caught;
}

/** `value` typed as the options without a cast, as a JavaScript caller passes it. */
function optionsOf(value: unknown): FindBuildOptions {
  const box: { options: FindBuildOptions } = { options: { root: "", contract: "" } };
  Reflect.set(box, "options", value);
  return box.options;
}

function issuesOf(error: ExplorerVerifyError): readonly { field: string; message: string }[] {
  return error.details.code === "invalid-input" ? error.details.issues : [];
}

/** Every string in a JSON value, keys included. */
function strings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown) => strings(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
  }
  return [];
}

const CASES = [
  {
    contract: "src/Greeter.sol:Greeter",
    artifact: "Greeter.sol/Greeter.json",
    what: "one contract",
  },
  { contract: "src/Pair.sol:Ping", artifact: "Pair.sol/Ping.json", what: "first of two in a file" },
  {
    contract: "src/Pair.sol:Pong",
    artifact: "Pair.sol/Pong.json",
    what: "second of two in a file",
  },
  {
    contract: "src/Counter.sol:Counter",
    artifact: "Counter.sol/Counter.json",
    what: "library-linked",
  },
] as const;

describe("buildVerifyInputFromFoundry after forge build --build-info (R-DX-2)", () => {
  for (const { contract, artifact, what } of CASES) {
    it(`gives the same compiler part as the files passed by hand: ${what}`, async () => {
      const byHand = buildVerifyInput([
        readJson(ROOT, BUILD_INFO),
        readJson(ROOT, `${FULL}/${artifact}`),
      ]);
      for (const name of [contract, contract.slice(contract.indexOf(":") + 1)]) {
        const built = await buildVerifyInputFromFoundry({
          root: ROOT,
          contract: name,
          outDir: FULL,
        });
        assert.deepEqual(built, byHand);
        assert.equal(built.contractName, contract);
      }
    });
  }

  it("keeps the linked library address of the build (R-DX-2)", async () => {
    const built = await buildVerifyInputFromFoundry({
      root: ROOT,
      contract: "Counter",
      outDir: FULL,
    });
    assert.deepEqual(built.compiler.input.settings["libraries"], {
      "src/Tally.sol": { Tally: LIBRARY },
    });
  });

  it("returns the artifact and the build-info, relative to the root, with no sources", async () => {
    const build = await findFoundryBuild({ root: ROOT, contract: "Greeter", outDir: FULL });
    assert.equal(build.contract, "src/Greeter.sol:Greeter");
    assert.deepEqual(build.files, [`${FULL}/Greeter.sol/Greeter.json`, BUILD_INFO]);
    assert.deepEqual(build.documents, [
      readJson(ROOT, `${FULL}/Greeter.sol/Greeter.json`),
      readJson(ROOT, BUILD_INFO),
    ]);
    assert.deepEqual(build.sources, {});
  });
});

describe("buildVerifyInputFromFoundry after a default forge build (R-DX-2)", () => {
  for (const { contract, artifact, what } of CASES) {
    it(`gives the same compiler part as the artifact and sources passed by hand: ${what}`, async () => {
      const build = await findFoundryBuild({ root: ROOT, contract });
      assert.equal(build.documents.length, 1);
      const sources = Object.fromEntries(
        build.files.slice(1).map((file) => [file, readText(ROOT, file)]),
      );
      assert.ok(Object.keys(sources).length > 0);
      const byHand = buildVerifyInput([readJson(ROOT, `out/${artifact}`)], { sources });
      assert.deepEqual(await buildVerifyInputFromFoundry({ root: ROOT, contract }), byHand);
      assert.deepEqual(build.sources, sources);
    });
  }

  it("rebuilds the same compiler input as the full build-info, apart from the extra sources", async () => {
    const full = await buildVerifyInputFromFoundry({
      root: ROOT,
      contract: "Counter",
      outDir: FULL,
    });
    const stub = await buildVerifyInputFromFoundry({ root: ROOT, contract: "Counter" });
    assert.equal(stub.compiler.version, full.compiler.version);
    // Solidity metadata records the library address in lower case; the bytes are the same.
    assert.deepEqual(stub.compiler.input.settings["libraries"], {
      "src/Tally.sol": { Tally: LIBRARY.toLowerCase() },
    });
    for (const [file, source] of Object.entries(stub.compiler.input.sources)) {
      assert.equal(source.content, full.compiler.input.sources[file]?.content);
    }
  });

  it("reads the full build-info from buildInfoDir when the artifacts come from another build", async () => {
    const build = await findFoundryBuild({
      root: ROOT,
      contract: "Greeter",
      buildInfoDir: path.join(ROOT, FULL, "build-info"),
    });
    assert.equal(build.files[0], "out/Greeter.sol/Greeter.json");
    assert.equal(build.files[1], BUILD_INFO);
  });

  it("does not take the stub as a build-info: the stub never lists a contract", async () => {
    const stub = record(readJson(ROOT, STUB));
    assert.deepEqual(Object.keys(stub).toSorted(), ["id", "language", "source_id_to_path"]);
    const build = await findFoundryBuild({ root: ROOT, contract: "Greeter" });
    assert.equal(build.documents.length, 1);
  });

  it("fails with the builder's incomplete-input and a forge build --build-info hint without the sources", async () => {
    const root = copyProject("out");
    const error = await rejection(
      async () => await buildVerifyInputFromFoundry({ root, contract: "Greeter" }),
      "incomplete-input",
    );
    assert.deepEqual(error.details, {
      code: "incomplete-input",
      field: "sources",
      candidates: ["src/Base.sol", "src/Greeter.sol"],
    });
    assert.match(error.hint, /forge build --build-info/);
    assert.ok(error.cause instanceof Error);
  });

  it("keeps source-mismatch from the builder, with the forge build --build-info hint", async () => {
    const root = copyProject("out", "src");
    write(root, "src/Base.sol", `${readText(ROOT, "src/Base.sol")}\n`);
    const error = await rejection(
      async () => await buildVerifyInputFromFoundry({ root, contract: "Greeter" }),
      "source-mismatch",
    );
    assert.equal(
      error.details.code === "source-mismatch" ? error.details.path : "",
      "src/Base.sol",
    );
    assert.match(error.hint, /forge build --build-info/);
  });
});

describe("buildVerifyInputFromFoundry forwards compilerVersion and sources (R-IN-7, #223)", () => {
  it("passes compilerVersion to buildVerifyInput, which refuses another version", async () => {
    const same = await buildVerifyInputFromFoundry({
      root: ROOT,
      contract: "Greeter",
      outDir: FULL,
      compilerVersion: "0.8.24+commit.e11b9ed9",
    });
    assert.equal(same.compiler.version, "0.8.24+commit.e11b9ed9");
    const error = await rejection(
      async () =>
        await buildVerifyInputFromFoundry({
          root: ROOT,
          contract: "Greeter",
          outDir: FULL,
          compilerVersion: "0.8.20+commit.a1b79de6",
        }),
      "invalid-input",
    );
    assert.deepEqual(issuesOf(error), [
      { field: "compilerVersion", message: "differs from the compiler version in the documents" },
    ]);
  });

  it("uses the caller's sources when the root has none", async () => {
    const root = copyProject("out");
    const sources = {
      "src/Base.sol": readText(ROOT, "src/Base.sol"),
      "src/Greeter.sol": readText(ROOT, "src/Greeter.sol"),
    };
    const built = await buildVerifyInputFromFoundry({ root, contract: "Greeter", sources });
    const byHand = await buildVerifyInputFromFoundry({ root: ROOT, contract: "Greeter" });
    assert.deepEqual(built, byHand);
  });

  it("lets a caller's source replace the file read for the same path", async () => {
    const changed = `${readText(ROOT, "src/Base.sol")}\n`;
    const error = await rejection(
      async () =>
        await buildVerifyInputFromFoundry({
          root: ROOT,
          contract: "Greeter",
          sources: { "src/Base.sol": changed },
        }),
      "source-mismatch",
    );
    assert.equal(
      error.details.code === "source-mismatch" ? error.details.path : "",
      "src/Base.sol",
    );
  });
});

describe("findFoundryBuild picks the contract's artifact (R-DX-2)", () => {
  it("rejects a bare name that matches two contracts with invalid-input listing both", async () => {
    for (const outDir of ["out", FULL]) {
      const error = await rejection(
        async () => await findFoundryBuild({ root: ROOT, contract: "Token", outDir }),
        "invalid-input",
      );
      const [issue, ...others] = issuesOf(error);
      assert.equal(others.length, 0);
      assert.equal(issue?.field, "contract");
      assert.equal(
        issue?.message,
        `matches 2 artifacts: src/a/Token.sol:Token (${outDir}/Token.sol/Token.json), src/b/Token.sol:Token (${outDir}/b/Token.sol/Token.json)`,
      );
      assert.match(error.hint, /path:Name/);
    }
  });

  it("tells the two apart by path, as Foundry names the conflicting artifacts", async () => {
    const a = await buildVerifyInputFromFoundry({ root: ROOT, contract: "src/a/Token.sol:Token" });
    const b = await buildVerifyInputFromFoundry({ root: ROOT, contract: "src/b/Token.sol:Token" });
    assert.equal(a.contractName, "src/a/Token.sol:Token");
    assert.equal(b.contractName, "src/b/Token.sol:Token");
    const files = await findFoundryBuild({ root: ROOT, contract: "src/b/Token.sol:Token" });
    assert.equal(files.files[0], "out/b/Token.sol/Token.json");
  });

  it("accepts a path with ./ or backslashes", async () => {
    for (const contract of ["./src/Pair.sol:Pong", ".\\src\\Pair.sol:Pong"]) {
      const build = await findFoundryBuild({ root: ROOT, contract });
      assert.equal(build.contract, "src/Pair.sol:Pong");
    }
  });

  it("accepts a relative root and an absolute out", async () => {
    const build = await findFoundryBuild({
      root: path.relative(process.cwd(), ROOT),
      contract: "Ping",
      outDir: path.join(ROOT, FULL),
    });
    assert.equal(build.files[1], BUILD_INFO);
  });

  it("rejects a contract with no artifact", async () => {
    const error = await rejection(
      async () => await findFoundryBuild({ root: ROOT, contract: "Missing" }),
      "invalid-input",
    );
    assert.deepEqual(issuesOf(error), [
      { field: "contract", message: "matches no artifact in the output directory" },
    ]);
    assert.match(error.hint, /forge build/);
  });

  it("rejects a wrong path and lists the contracts of that name", async () => {
    for (const contract of ["src/Other.sol:Greeter", "src/Base.sol:Greeter", "lib/X.sol:Token"]) {
      const error = await rejection(
        async () => await findFoundryBuild({ root: ROOT, contract }),
        "invalid-input",
      );
      const found = contract.endsWith("Token")
        ? "src/a/Token.sol:Token, src/b/Token.sol:Token"
        : "src/Greeter.sol:Greeter";
      assert.deepEqual(issuesOf(error), [
        {
          field: "contract",
          message: `matches no artifact in the output directory; artifacts of that name: ${found}`,
        },
      ]);
    }
    const error = await rejection(
      async () => await findFoundryBuild({ root: ROOT, contract: "src/Missing.sol:Missing" }),
      "invalid-input",
    );
    assert.equal(issuesOf(error)[0]?.message, "matches no artifact in the output directory");
  });

  it("lists one source built twice, as Foundry names each compiler version's artifact", async () => {
    const root = copyProject("out");
    cpSync(
      path.join(root, "out/Greeter.sol/Greeter.json"),
      path.join(root, "out/Greeter.sol/Greeter.0.8.24.json"),
    );
    const error = await rejection(
      async () => await findFoundryBuild({ root, contract: "src/Greeter.sol:Greeter" }),
      "invalid-input",
    );
    assert.equal(
      issuesOf(error)[0]?.message,
      "matches 2 artifacts: src/Greeter.sol:Greeter (out/Greeter.sol/Greeter.0.8.24.json), src/Greeter.sol:Greeter (out/Greeter.sol/Greeter.json)",
    );
    assert.match(error.hint, /several compiler versions or profiles/);
    assert.match(error.hint, /Pass artifact/);
  });

  it("lists at most 20 matching artifacts", async () => {
    const root = copyProject("out");
    for (let index = 0; index < 21; index++) {
      cpSync(
        path.join(root, "out/Pair.sol/Ping.json"),
        path.join(root, `out/Pair.sol/Ping.${String(index).padStart(2, "0")}.json`),
      );
    }
    const error = await rejection(
      async () => await findFoundryBuild({ root, contract: "Ping" }),
      "invalid-input",
    );
    const message = issuesOf(error)[0]?.message ?? "";
    assert.match(message, /^matches 22 artifacts: /);
    assert.match(message, /, and more$/);
    assert.equal(message.split("(out/").length - 1, 20);
  });

  it("finds an artifact without metadata by its file name, and lets the builder judge it", async () => {
    const root = copyProject("out");
    const artifact = record(readJson(root, "out/Greeter.sol/Greeter.json"));
    write(root, "out/Greeter.sol/Greeter.json", {
      abi: artifact["abi"],
      bytecode: artifact["bytecode"],
    });
    const build = await findFoundryBuild({ root, contract: "Greeter" });
    assert.equal(build.contract, "Greeter");
    assert.deepEqual(build.sources, {});
    const error = await rejection(
      async () => await buildVerifyInputFromFoundry({ root, contract: "Greeter" }),
      "insufficient-artifact",
    );
    assert.doesNotMatch(error.hint, /forge build --build-info/);
  });

  it("matches the build-info by name alone when the artifact has no metadata string", async () => {
    const root = copyProject(FULL);
    const artifact = record(readJson(root, `${FULL}/Greeter.sol/Greeter.json`));
    write(root, `${FULL}/Greeter.sol/Greeter.json`, {
      abi: artifact["abi"],
      bytecode: artifact["bytecode"],
    });
    const byHand = buildVerifyInput([readJson(root, BUILD_INFO)], {
      contract: "src/Greeter.sol:Greeter",
    });
    const built = await buildVerifyInputFromFoundry({ root, contract: "Greeter", outDir: FULL });
    assert.deepEqual(built, byHand);
  });

  it("reads the metadata object when rawMetadata is not JSON", async () => {
    const root = copyProject("out", "src");
    const artifact = record(readJson(root, "out/Pair.sol/Ping.json"));
    write(root, "out/Pair.sol/Ping.json", { ...artifact, rawMetadata: "not json" });
    const build = await findFoundryBuild({ root, contract: "Ping" });
    assert.equal(build.contract, "src/Pair.sol:Ping");
    assert.deepEqual(build.files.slice(1), ["src/Pair.sol"]);
  });

  it("lists artifacts without metadata by file, and needs no build-info directory", async () => {
    const root = copyProject("out");
    rmSync(path.join(root, "out/build-info"), { recursive: true });
    const artifact = record(readJson(root, "out/Greeter.sol/Greeter.json"));
    const bare = { abi: artifact["abi"], bytecode: artifact["bytecode"] };
    write(root, "out/Greeter.sol/Greeter.json", bare);
    write(root, "out/Greeter.sol/Greeter.0.8.24.json", bare);
    const error = await rejection(
      async () => await findFoundryBuild({ root, contract: "Greeter" }),
      "invalid-input",
    );
    assert.equal(
      issuesOf(error)[0]?.message,
      "matches 2 artifacts: a contract without metadata (out/Greeter.sol/Greeter.0.8.24.json), a contract without metadata (out/Greeter.sol/Greeter.json)",
    );
    const build = await findFoundryBuild({ root, contract: "Ping" });
    assert.equal(build.documents.length, 1);
  });
});

describe("findFoundryBuild picks the build-info (R-DX-2)", () => {
  it("matches a build-info entry without a metadata string by the contract's path and name", async () => {
    const root = copyProject(FULL);
    const buildInfo = record(readJson(root, BUILD_INFO));
    const output = record(buildInfo["output"]);
    const contracts = record(output["contracts"]);
    const pair = record(contracts["src/Pair.sol"]);
    const ping = record(pair["Ping"]);
    write(root, BUILD_INFO, {
      ...buildInfo,
      output: {
        ...output,
        contracts: { ...contracts, "src/Pair.sol": { ...pair, Ping: { abi: ping["abi"] } } },
      },
    });
    const build = await findFoundryBuild({ root, contract: "Ping", outDir: FULL });
    assert.equal(build.files[1], BUILD_INFO);
  });

  it("skips a build-info whose metadata for the contract differs, and takes the first by name that matches", async () => {
    const root = copyProject(FULL);
    const buildInfo = record(readJson(root, BUILD_INFO));
    const output = record(buildInfo["output"]);
    const contracts = record(output["contracts"]);
    const greeter = record(record(contracts["src/Greeter.sol"])["Greeter"]);
    const other = {
      ...buildInfo,
      output: {
        ...output,
        contracts: {
          ...contracts,
          "src/Greeter.sol": { Greeter: { ...greeter, metadata: "{}" } },
        },
      },
    };
    write(root, `${FULL}/build-info/0-other.json`, other);
    write(root, `${FULL}/build-info/z-copy.json`, buildInfo);
    write(root, `${FULL}/build-info/notes.txt`, '"Greeter"');
    const build = await findFoundryBuild({ root, contract: "Greeter", outDir: FULL });
    assert.equal(build.files[1], BUILD_INFO);
  });

  it("falls back to the metadata rebuild when no build-info lists the contract with its metadata", async () => {
    const root = copyProject(FULL, "src");
    const buildInfo = record(readJson(root, BUILD_INFO));
    const output = record(buildInfo["output"]);
    const contracts = record(output["contracts"]);
    // The name stays in the file, under another path, so the quick text check passes.
    const moved: Record<string, unknown> = {
      ...contracts,
      "src/Moved.sol": contracts["src/Pair.sol"],
    };
    delete moved["src/Pair.sol"];
    write(root, BUILD_INFO, { ...buildInfo, output: { ...output, contracts: moved } });
    const build = await findFoundryBuild({ root, contract: "Ping", outDir: FULL });
    assert.equal(build.documents.length, 1);
    assert.deepEqual(build.files.slice(1), ["src/Pair.sol"]);
  });

  it("rejects a build-info that mentions the contract and is not JSON", async () => {
    const root = copyProject(FULL);
    write(root, `${FULL}/build-info/broken.json`, '{"Greeter"');
    const error = await rejection(
      async () => await findFoundryBuild({ root, contract: "Greeter", outDir: FULL }),
      "invalid-input",
    );
    assert.deepEqual(issuesOf(error), [
      {
        field: "buildInfoDir",
        message: `holds a file that is not JSON: ${FULL}/build-info/broken.json`,
      },
    ]);
  });

  it("passes on the builder's error unchanged when a build-info was found", async () => {
    const root = copyProject(FULL);
    const buildInfo = record(readJson(root, BUILD_INFO));
    write(root, BUILD_INFO, { ...buildInfo, solcLongVersion: "0.8.25+commit.00000000" });
    const error = await rejection(
      async () => await buildVerifyInputFromFoundry({ root, contract: "Greeter", outDir: FULL }),
      "invalid-input",
    );
    assert.deepEqual(issuesOf(error), [
      {
        field: "documents",
        message: "hold different compiler versions; pass the documents of one build",
      },
    ]);
    assert.equal(error.cause, undefined);
  });
});

describe("findFoundryBuild reads files only under the root (R-DX-2, R-IN-7)", () => {
  it("never puts an absolute path in its result", async () => {
    for (const outDir of ["out", FULL]) {
      for (const { contract } of CASES) {
        const build = await findFoundryBuild({ root: ROOT, contract, outDir });
        const found = [...strings(build.files), ...Object.keys(build.sources), build.contract];
        for (const value of found) {
          assert.ok(!path.isAbsolute(value), value);
          assert.ok(!value.includes(ROOT), value);
        }
        assert.ok(!JSON.stringify(build).includes(ROOT));
      }
    }
  });

  it("reads a source through a symbolic link that stays under the root, and not one that leaves it", async () => {
    const root = copyProject("out", "src");
    const outside = temporaryDir();
    mkdirSync(path.join(root, "vendor"));
    cpSync(path.join(root, "src/Base.sol"), path.join(root, "vendor/Base.sol"));
    cpSync(path.join(root, "src/Greeter.sol"), path.join(outside, "Greeter.sol"));
    rmSync(path.join(root, "src/Base.sol"));
    rmSync(path.join(root, "src/Greeter.sol"));
    symlinkSync(path.join(root, "vendor/Base.sol"), path.join(root, "src/Base.sol"), "file");
    symlinkSync(path.join(outside, "Greeter.sol"), path.join(root, "src/Greeter.sol"), "file");
    const build = await findFoundryBuild({ root, contract: "Greeter" });
    assert.deepEqual(build.files.slice(1), ["src/Base.sol"]);
    assert.equal(build.sources["src/Base.sol"], readText(ROOT, "src/Base.sol"));
  });

  it("does not read a source larger than 16 MB", async () => {
    const root = copyProject("out", "src");
    truncateSync(path.join(root, "src/Base.sol"), 16 * 1024 * 1024 + 1);
    const build = await findFoundryBuild({ root, contract: "Greeter" });
    assert.deepEqual(build.files.slice(1), ["src/Greeter.sol"]);
  });

  it("does not read a source whose metadata path is absolute or leaves the root", async () => {
    const root = copyProject("out", "src");
    const artifact = record(readJson(root, "out/Greeter.sol/Greeter.json"));
    const metadata = record(artifact["metadata"]);
    const sources = record(metadata["sources"]);
    write(root, "out/Greeter.sol/Greeter.json", {
      ...artifact,
      rawMetadata: undefined,
      metadata: {
        ...metadata,
        settings: {
          ...record(metadata["settings"]),
          compilationTarget: { "src/Greeter.sol": "Greeter", "src/Other.sol": 7 },
        },
        sources: {
          ...sources,
          [path.join(root, "src/Base.sol")]: {},
          "../outside/Base.sol": {},
          "~/Base.sol": {},
          "file:src/Base.sol": {},
          ".": {},
          src: {},
          "src/Absent.sol": {},
        },
      },
    });
    const build = await findFoundryBuild({ root, contract: "src/Greeter.sol:Greeter" });
    assert.deepEqual(build.files.slice(1), ["src/Base.sol", "src/Greeter.sol"]);
    assert.deepEqual(Object.keys(build.sources), ["src/Base.sol", "src/Greeter.sol"]);
  });

  it("rejects an artifact file that is not JSON, naming it relative to the root", async () => {
    const root = copyProject("out");
    write(root, "out/Pair.sol/Pong.json", "not json");
    const error = await rejection(
      async () => await findFoundryBuild({ root, contract: "Pong" }),
      "invalid-input",
    );
    assert.deepEqual(issuesOf(error), [
      {
        field: "outDir",
        message: "holds a file that is not a JSON object: out/Pair.sol/Pong.json",
      },
    ]);
  });

  it("rejects an artifact it cannot read, naming it relative to the root, with the Node error as cause", async (t) => {
    if (ROOT_USER) {
      t.skip("file modes do not apply to root");
      return;
    }
    const root = copyProject("out");
    chmodSync(path.join(root, "out/Pair.sol/Pong.json"), 0o000);
    const error = await rejection(
      async () => await findFoundryBuild({ root, contract: "Pong" }),
      "invalid-input",
    );
    assert.deepEqual(issuesOf(error), [
      { field: "outDir", message: "could not be read: out/Pair.sol/Pong.json" },
    ]);
    assert.ok(error.cause instanceof Error);
    assert.ok(!error.message.includes(root));
    assert.ok(!JSON.stringify(error.toJSON()).includes(root));
  });

  it("says the output directory could not be read when the root cannot be searched (#350)", async (t) => {
    if (ROOT_USER) {
      t.skip("file modes do not apply to root");
      return;
    }
    const root = copyProject("out");
    chmodSync(root, 0o000);
    try {
      const error = await rejection(
        async () => await findFoundryBuild({ root, contract: "Pong" }),
        "invalid-input",
      );
      assert.deepEqual(issuesOf(error), [{ field: "outDir", message: "could not be read" }]);
      assert.equal(error.message, "The input is invalid: outDir could not be read.");
    } finally {
      chmodSync(root, 0o755);
    }
  });

  it("rejects an output directory it cannot list", async (t) => {
    if (ROOT_USER) {
      t.skip("file modes do not apply to root");
      return;
    }
    const root = copyProject("out");
    chmodSync(path.join(root, "out/Pair.sol"), 0o000);
    try {
      const error = await rejection(
        async () => await findFoundryBuild({ root, contract: "Pong" }),
        "invalid-input",
      );
      assert.deepEqual(issuesOf(error), [
        { field: "outDir", message: "could not be read: out/Pair.sol" },
      ]);
    } finally {
      chmodSync(path.join(root, "out/Pair.sol"), 0o755);
    }
  });

  it("never follows a symbolic link in the output directory", async () => {
    const root = copyProject("out");
    const outside = temporaryDir();
    cpSync(path.join(ROOT, "out/Greeter.sol"), path.join(outside, "Greeter.sol"), {
      recursive: true,
    });
    symlinkSync(outside, path.join(root, "out/elsewhere"), "dir");
    symlinkSync(path.join(root, "out"), path.join(root, "out/loop"), "dir");
    symlinkSync(path.join(root, "out/b-link"), path.join(root, "out/a-link"), "dir");
    symlinkSync(path.join(root, "out/a-link"), path.join(root, "out/b-link"), "dir");
    symlinkSync(
      path.join(root, "out/Greeter.sol/Greeter.json"),
      path.join(root, "out/Greeter.sol/Greeter.copy.json"),
      "file",
    );
    const build = await findFoundryBuild({ root, contract: "Greeter" });
    assert.equal(build.files[0], "out/Greeter.sol/Greeter.json");
  });

  it("goes at most 32 directories deep under the output directory", async () => {
    const root = copyProject("out");
    const levels = Array.from({ length: 33 }, (_, index) => `d${String(index)}`);
    const deep = path.join(root, "out", ...levels, "Pair.sol");
    mkdirSync(deep, { recursive: true });
    cpSync(path.join(root, "out/Pair.sol/Ping.json"), path.join(deep, "Ping.json"));
    const build = await findFoundryBuild({ root, contract: "Ping" });
    assert.equal(build.files[0], "out/Pair.sol/Ping.json");
  });

  it("rejects a root that is not a folder, never repeating the path (#350)", async () => {
    const hint =
      "Check that the project folder (options.root) exists and can be read. It should hold foundry.toml.";
    const file = path.join(ROOT, "foundry.toml");
    const cases: [string, string][] = [
      [file, "is not a folder: it is a file"],
      ["no-such-project", "is not a folder: it does not exist"],
      [path.join(ROOT, "missing"), "is not a folder: it does not exist"],
      // A name longer than the file system allows cannot be read: ENAMETOOLONG.
      [path.join(ROOT, "a".repeat(300)), "is not a folder: it cannot be read"],
    ];
    for (const [root, message] of cases) {
      const error = await rejection(
        async () => await findFoundryBuild({ root, contract: "Greeter" }),
        "invalid-input",
      );
      assert.deepEqual(issuesOf(error), [{ field: "root", message }]);
      // The message carries the issue, as the Hardhat helper's does.
      assert.equal(error.message, `The input is invalid: root ${message}.`);
      assert.equal(error.hint, hint);
    }
  });

  it("rejects a missing output directory with a forge build hint", async () => {
    for (const outDir of ["missing", "foundry.toml"]) {
      const error = await rejection(
        async () => await findFoundryBuild({ root: ROOT, contract: "Greeter", outDir }),
        "invalid-input",
      );
      assert.deepEqual(issuesOf(error), [{ field: "outDir", message: "is not a directory" }]);
      assert.match(error.hint, /forge build/);
    }
  });
});

describe("findFoundryBuild checks its options", () => {
  const cases: [string, unknown, string, string][] = [
    ["not an object", null, "options", "must be an object"],
    ["an array", [], "options", "must be an object"],
    ["no root", { contract: "Greeter" }, "root", "must be the project root as a non-empty string"],
    [
      "a blank root",
      { root: " ", contract: "Greeter" },
      "root",
      "must be the project root as a non-empty string",
    ],
    ["no contract", { root: ROOT }, "contract", "must be path:Name or Name as a string"],
    [
      "an artifact that is not a string",
      { root: ROOT, contract: "Greeter", artifact: [] },
      "artifact",
      "must be a non-empty string when set",
    ],
    [
      "a name that is not an identifier",
      { root: ROOT, contract: "src/Greeter.sol:1Greeter" },
      "contract",
      "must be path:Name or Name, with a Solidity identifier as the name",
    ],
    [
      "an empty path",
      { root: ROOT, contract: ":Greeter" },
      "contract",
      "must have a source path before the colon",
    ],
    [
      "an outDir that is not a string",
      { root: ROOT, contract: "Greeter", outDir: 1 },
      "outDir",
      "must be a non-empty string when set",
    ],
    [
      "a blank buildInfoDir",
      { root: ROOT, contract: "Greeter", buildInfoDir: "" },
      "buildInfoDir",
      "must be a non-empty string when set",
    ],
  ];
  for (const [what, options, field, message] of cases) {
    it(`rejects ${what}`, async () => {
      const error = await rejection(
        async () => await findFoundryBuild(optionsOf(options)),
        "invalid-input",
      );
      assert.deepEqual(issuesOf(error), [{ field, message }]);
    });
  }
});

describe("R-IN-6: findFoundryBuild refuses unknown options", () => {
  it("names each unknown key and the closest option, never its value", async () => {
    const error = await rejection(
      async () =>
        await findFoundryBuild(
          optionsOf({ root: ROOT, contract: "Greeter", out: "DUMMYKEY216ABCDEFGH", OutDir: "x" }),
        ),
      "invalid-input",
    );
    assert.deepEqual(issuesOf(error), [
      { field: "out", message: "is not a known option; did you mean outDir?" },
      { field: "OutDir", message: "is not a known option; did you mean outDir?" },
    ]);
    assert.equal(
      error.hint,
      "Pass only root, contract, outDir, buildInfoDir and artifact as options.",
    );
    assert.ok(!JSON.stringify(error).includes("DUMMYKEY216"));
  });

  it("does not repeat a key that is not a short identifier, and suggests nothing for a swap of two letters", async () => {
    const error = await rejection(
      async () =>
        await findFoundryBuild(
          optionsOf({ root: ROOT, contract: "Greeter", "a b": 1, artfiact: 1, ab: 1 }),
        ),
      "invalid-input",
    );
    assert.deepEqual(issuesOf(error), [
      { field: "options", message: "is not a known option" },
      { field: "artfiact", message: "is not a known option" },
      { field: "ab", message: "is not a known option" },
    ]);
  });

  it("never runs a getter on an unknown key (D1)", async () => {
    for (const run of [findFoundryBuild, buildVerifyInputFromFoundry]) {
      let ran = false;
      const options = { root: ROOT, contract: "Greeter" };
      Object.defineProperty(options, "trap", {
        enumerable: true,
        get: () => {
          ran = true;
          throw new Error("secret text");
        },
      });
      const error = await rejection(async () => await run(options), "invalid-input");
      assert.deepEqual(issuesOf(error), [{ field: "trap", message: "is not a known option" }]);
      assert.equal(ran, false);
      assert.ok(!JSON.stringify(error).includes("secret text"));
    }
  });

  it("takes optional fields set to undefined as absent", async () => {
    const build = await findFoundryBuild({
      root: ROOT,
      contract: "Greeter",
      outDir: undefined,
      buildInfoDir: undefined,
      artifact: undefined,
    });
    assert.equal(build.contract.endsWith("Greeter"), true);
  });

  it("buildVerifyInputFromFoundry takes compilerVersion and sources, and names a misspelled one", async () => {
    const error = await rejection(
      async () =>
        await buildVerifyInputFromFoundry(
          optionsOf({ root: ROOT, contract: "Greeter", source: {} }),
        ),
      "invalid-input",
    );
    assert.deepEqual(issuesOf(error), [
      { field: "source", message: "is not a known option; did you mean sources?" },
    ]);
    assert.equal(
      error.hint,
      "Pass only root, contract, outDir, buildInfoDir, artifact, compilerVersion and sources as options.",
    );
    const find = await rejection(
      async () =>
        await findFoundryBuild(
          optionsOf({ root: ROOT, contract: "Greeter", compilerVersion: "x" }),
        ),
      "invalid-input",
    );
    assert.deepEqual(issuesOf(find), [
      { field: "compilerVersion", message: "is not a known option" },
    ]);
  });
});

describe("a contract built with two compiler versions (R-DX-2)", () => {
  const CONTEXT = "lib/utils/Context.sol:Context";

  it("skips the Name.metadata.json files that extra_output_files writes", async () => {
    const build = await findFoundryBuild({ root: MULTI, contract: "Old" });
    assert.equal(build.files[0], "out/Old.sol/Old.json");
    assert.equal(build.files[1], MULTI_BUILD_INFO["0.8.20"]);
    const built = await buildVerifyInputFromFoundry({ root: MULTI, contract: "src/New.sol:New" });
    assert.equal(built.compiler.version, "0.8.24+commit.e11b9ed9");
  });

  it("lists one artifact per version, and says to pass the artifact", async () => {
    for (const contract of ["Context", CONTEXT]) {
      const error = await rejection(
        async () => await findFoundryBuild({ root: MULTI, contract }),
        "invalid-input",
      );
      assert.equal(
        issuesOf(error)[0]?.message,
        `matches 2 artifacts: ${CONTEXT} (out/Context.sol/Context.0.8.20.json), ${CONTEXT} (out/Context.sol/Context.0.8.24.json)`,
      );
      assert.match(error.hint, /Pass artifact/);
      assert.doesNotMatch(error.hint, /forge clean/);
    }
  });

  for (const [version, buildInfo] of Object.entries(MULTI_BUILD_INFO)) {
    it(`takes the artifact option and the build-info of that version: ${version}`, async () => {
      const artifact = `out/Context.sol/Context.${version}.json`;
      for (const option of [artifact, path.join(MULTI, artifact)]) {
        const build = await findFoundryBuild({
          root: MULTI,
          contract: "Context",
          artifact: option,
        });
        assert.deepEqual(build.files, [artifact, buildInfo]);
      }
      const byHand = buildVerifyInput([readJson(MULTI, buildInfo), readJson(MULTI, artifact)]);
      const built = await buildVerifyInputFromFoundry({ root: MULTI, contract: CONTEXT, artifact });
      assert.deepEqual(built, byHand);
      assert.equal(built.compiler.version.slice(0, version.length + 1), `${version}+`);
    });
  }

  it("rejects an artifact option that is not the contract's artifact", async () => {
    const cases: [string, string, string][] = [
      [
        "out/Context.sol/Context.0.8.20.metadata.json",
        "Context",
        "is not a Foundry artifact with abi or bytecode: out/Context.sol/Context.0.8.20.metadata.json",
      ],
      ["out/Old.sol/Old.json", "Context", "holds the artifact of another contract"],
      ["out/Old.sol/Old.json", "src/New.sol:Old", "holds the artifact of another contract"],
      ["out/Missing.json", "Context", "could not be read: out/Missing.json"],
      ["out/Old.sol", "Old", "is not a file: out/Old.sol"],
      // A file outside the project is named by its absolute path, not one that starts with "..".
      [
        "../missing.json",
        "Context",
        `could not be read: ${path.resolve(MULTI, "../missing.json").split(path.sep).join("/")}`,
      ],
    ];
    for (const [artifact, contract, message] of cases) {
      const error = await rejection(
        async () => await findFoundryBuild({ root: MULTI, contract, artifact }),
        "invalid-input",
      );
      assert.deepEqual(issuesOf(error), [{ field: "artifact", message }]);
    }
  });

  it("rejects a buildInfoDir that was set and is not a directory, and ignores a missing default", async () => {
    const error = await rejection(
      async () => await findFoundryBuild({ root: MULTI, contract: "Old", buildInfoDir: "missing" }),
      "invalid-input",
    );
    assert.deepEqual(issuesOf(error), [{ field: "buildInfoDir", message: "is not a directory" }]);
    const root = copyProject("out", "src");
    rmSync(path.join(root, "out/build-info"), { recursive: true });
    const build = await findFoundryBuild({ root, contract: "Ping" });
    assert.equal(build.documents.length, 1);
  });

  it("rejects a build-info file larger than 256 MB without reading it", async () => {
    const root = copyProject(FULL);
    const big = path.join(root, FULL, "build-info/big.json");
    writeFileSync(big, "");
    truncateSync(big, 256 * 1024 * 1024 + 1);
    const error = await rejection(
      async () => await findFoundryBuild({ root, contract: "Ping", outDir: FULL }),
      "invalid-input",
    );
    assert.deepEqual(issuesOf(error), [
      {
        field: "buildInfoDir",
        message: `holds a file larger than 256 MB: ${FULL}/build-info/big.json`,
      },
    ]);
  });
});

describe("the package holds no format logic (R-DX-2)", () => {
  const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

  it("loads no module at run time and names no deep path of the core", () => {
    for (const file of readdirSync(SRC)) {
      const text = readFileSync(path.join(SRC, file), "utf8");
      assert.doesNotMatch(text, /\bimport\s*\(/, `${file} has a dynamic import`);
      assert.doesNotMatch(text, /\brequire\s*\(/, `${file} calls require`);
      assert.doesNotMatch(text, /createRequire/, `${file} uses createRequire`);
      // A quote before the name: the TSDoc examples name the package `@explorer-verify/foundry`.
      assert.doesNotMatch(text, /["'`]explorer-verify\//, `${file} names a deep path of the core`);
    }
  });

  it("imports only the core's public entry point, Node built-ins and its own modules", async () => {
    const core: Record<string, unknown> = { ...(await import("explorer-verify")) };
    const coreTypes = readFileSync(
      fileURLToPath(import.meta.resolve("explorer-verify").replace(/\.js$/, ".d.ts")),
      "utf8",
    );
    for (const file of readdirSync(SRC)) {
      const text = readFileSync(path.join(SRC, file), "utf8");
      for (const match of text.matchAll(/^import (type )?\{?([^}]*?)\}? from "([^"]+)";$/gms)) {
        const [, type, names = "", specifier = ""] = match;
        if (specifier.startsWith("node:")) {
          continue;
        }
        if (specifier.startsWith("./")) {
          assert.ok(!specifier.includes(".."), specifier);
          continue;
        }
        assert.equal(specifier, "explorer-verify", `${file} imports ${specifier}`);
        for (const name of names
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)) {
          if (type === undefined) {
            assert.ok(name in core, `${name} is a public export of explorer-verify`);
          } else {
            assert.match(coreTypes, new RegExp(`\\b${name}\\b`), `${name} is a public type`);
          }
        }
      }
    }
  });

  it("takes explorer-verify as its only peer, so the caller's copy of the core is used", () => {
    const manifest = record(
      JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")),
    );
    assert.equal(manifest["dependencies"], undefined);
    assert.deepEqual(record(manifest["peerDependencies"]), { "explorer-verify": "workspace:^" });
    assert.equal(record(manifest["devDependencies"])["explorer-verify"], "workspace:^");
  });
});

describe("fixtures", () => {
  it("hold no absolute path and no name of the machine or user that built them", () => {
    const user = userInfo().username;
    const forbidden = [homedir(), ...(user.length >= 4 ? [user] : [])];
    const files = [ROOT, MULTI].flatMap((root) =>
      readdirSync(root, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".json"))
        .map((file) => path.join(root, file)),
    );
    assert.ok(files.length >= 28);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /"(?:\/(?:Users|home|private|tmp|var|root|opt)\/|[A-Za-z]:\\\\)/);
      for (const word of forbidden) {
        assert.ok(!text.includes(word), `${file} holds a local name`);
      }
    }
  });

  it("come from one Foundry 1.8.1 project, so both builds hold the same metadata", () => {
    for (const { artifact } of CASES) {
      const full = record(readJson(ROOT, `${FULL}/${artifact}`));
      const stub = record(readJson(ROOT, `out/${artifact}`));
      assert.equal(full["rawMetadata"], stub["rawMetadata"]);
    }
  });
});
