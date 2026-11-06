// Tests for buildVerifyInput (R-IN-7): one test per document shape and per failure, run on the
// fixtures in test/fixtures/build-formats/ (see the README there).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import { buildVerifyInput, ExplorerVerifyError, validateInput } from "../../src/index.ts";
import type { BuildVerifyInputOptions, BuiltVerifyInput, ErrorCode } from "../../src/index.ts";

// A fake key. Never a real one (R-SEC-1).
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const LONG_VERSION = "0.8.24+commit.e11b9ed9";
const PLANTED_LOCAL_PATHS = ["/home/builder/", "/home/u/", "/home/alice/", "C:\\Users\\builder"];
const FIXTURES = new URL("../fixtures/build-formats/", import.meta.url);
const FOUNDRY_EXTRA_KEYS = ["version", "allowPaths", "basePath", "includePaths"];

/** A fresh parse of one fixture file, so a test may change it. */
function fixture(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return { ...parsed };
}

/** A field of a fixture object that must itself be an object. */
function objectAt(value: unknown, ...path: string[]): Record<string, unknown> {
  let current = value;
  for (const key of path) {
    assert.ok(typeof current === "object" && current !== null && !Array.isArray(current));
    current = Object.getOwnPropertyDescriptor(current, key)?.value;
  }
  assert.ok(typeof current === "object" && current !== null && !Array.isArray(current));
  return { ...current };
}

/** The real nested object at `path`, not a copy, so a test can change the document itself. */
function realAt(value: unknown, ...path: string[]): object {
  let current = value;
  for (const key of path) {
    assert.ok(typeof current === "object" && current !== null);
    current = Reflect.get(current, key);
  }
  assert.ok(typeof current === "object" && current !== null);
  return current;
}

const foundry = {
  buildInfo: () => fixture("foundry-1.8.1/build-info.json"),
  stub: () => fixture("foundry-1.8.1/build-info-stub.json"),
  artifact: () => fixture("foundry-1.8.1/Greeter.json"),
};
const hardhat2 = {
  buildInfo: () => fixture("hardhat-2.29.1/build-info.json"),
  artifact: () => fixture("hardhat-2.29.1/Greeter.json"),
};
const hardhat3 = {
  buildInfo: () => fixture("hardhat-3.21.2/build-info.json"),
  output: () => fixture("hardhat-3.21.2/build-info.output.json"),
  artifact: () => fixture("hardhat-3.21.2/Greeter.json"),
};

/** The Standard JSON input inside a build-info fixture, with only the three standard keys. */
function standardJson(buildInfo: Record<string, unknown>): Record<string, unknown> {
  const input = objectAt(buildInfo, "input");
  return { language: input.language, sources: input.sources, settings: input.settings };
}

/** Every ordering of `items`. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

/** Asserts that `text` appears in none of the places an error can be printed from. */
function assertNotShown(error: ExplorerVerifyError, text: string): void {
  const places = [
    error.message,
    error.hint,
    String(error),
    error.stack ?? "",
    JSON.stringify(error),
    JSON.stringify(error.toJSON()),
    JSON.stringify(error.details),
    inspect(error, { depth: Infinity }),
  ];
  for (const place of places) {
    assert.ok(!place.includes(text), `shown in: ${place.slice(0, 120)}`);
  }
}

/** The error `buildVerifyInput` throws. */
function rejection(
  documents: readonly unknown[],
  options?: BuildVerifyInputOptions,
): ExplorerVerifyError {
  try {
    buildVerifyInput(documents, options);
  } catch (error) {
    assert.ok(error instanceof ExplorerVerifyError, "not an ExplorerVerifyError");
    return error;
  }
  return assert.fail("buildVerifyInput did not throw");
}

/** The field an error names: `details.field`, or the one issue of an invalid-input error. */
function fieldOf(error: ExplorerVerifyError): string {
  const details = error.details;
  if (details.code === "invalid-input") {
    assert.equal(details.issues.length, 1);
    return details.issues[0]?.field ?? "";
  }
  if (
    details.code === "incomplete-input" ||
    details.code === "insufficient-artifact" ||
    details.code === "unsupported-compiler"
  ) {
    return details.field;
  }
  return assert.fail(`unexpected code ${details.code}`);
}

/**
 * Asserts the code and the field of the error, and that neither the dummy key nor any local path
 * reaches it. Each document gets a stray `apiKey` field holding the dummy key.
 */
function assertFails(
  documents: Record<string, unknown>[],
  code: ErrorCode,
  field: string,
  options?: BuildVerifyInputOptions,
): ExplorerVerifyError {
  const planted = documents.map((document) => ({ ...document, apiKey: DUMMY_KEY }));
  const error = rejection(planted, options);
  assert.equal(error.code, code);
  assert.equal(fieldOf(error), field);
  assert.equal(error.retryable, false);
  assertNotShown(error, DUMMY_KEY);
  // The planted local paths. Not "/home/" alone: the stack names the runner's own checkout.
  for (const local of PLANTED_LOCAL_PATHS) {
    assertNotShown(error, local);
  }
  return error;
}

function candidatesOf(error: ExplorerVerifyError): readonly string[] {
  assert.ok(error.details.code === "incomplete-input");
  return error.details.candidates;
}

/** Asserts the built input is exactly the build-info's standard part, with the version and name. */
/**
 * The creation bytecode of an artifact as `buildVerifyInput` returns it (R-IN-3): Hardhat's
 * `bytecode` string or Foundry's `bytecode.object`.
 */
function bytecodeOf(artifact: Record<string, unknown>): string {
  const bytecode = artifact["bytecode"];
  const code = typeof bytecode === "string" ? bytecode : objectAt(artifact, "bytecode")["object"];
  assert.ok(typeof code === "string" && code.startsWith("0x"));
  return code;
}

function assertBuilt(
  built: BuiltVerifyInput,
  buildInfo: Record<string, unknown>,
  contractName: string,
  artifact?: Record<string, unknown>,
): void {
  assert.deepEqual(built, {
    compiler: { kind: "solc", version: LONG_VERSION, input: standardJson(buildInfo) },
    contractName,
    ...(artifact === undefined ? {} : { creationBytecode: bytecodeOf(artifact) }),
  });
  assert.deepEqual(Object.keys(built.compiler.input), ["language", "sources", "settings"]);
}

// --- shapes ---------------------------------------------------------------------------------------

describe("buildVerifyInput: shapes (R-IN-7)", () => {
  it("builds from a Foundry build-info and its artifact, version and name from the metadata", () => {
    const buildInfo = foundry.buildInfo();
    const built = buildVerifyInput([buildInfo, foundry.artifact()]);
    assertBuilt(built, buildInfo, "src/Greeter.sol:Greeter", foundry.artifact());
  });

  it("builds from a Foundry build-info alone, with the version from its output metadata", () => {
    const buildInfo = foundry.buildInfo();
    const built = buildVerifyInput([buildInfo], { contract: "Greeter" });
    assertBuilt(built, buildInfo, "src/Greeter.sol:Greeter");
  });

  it("builds from a Hardhat 2 build-info, with a bare name or with the artifact", () => {
    const buildInfo = hardhat2.buildInfo();
    assertBuilt(
      buildVerifyInput([buildInfo], { contract: "Greeter" }),
      buildInfo,
      "contracts/Greeter.sol:Greeter",
    );
    assertBuilt(
      buildVerifyInput([buildInfo, hardhat2.artifact()]),
      buildInfo,
      "contracts/Greeter.sol:Greeter",
      hardhat2.artifact(),
    );
  });

  it("builds from a Hardhat 3 build-info and its artifact", () => {
    const buildInfo = hardhat3.buildInfo();
    const built = buildVerifyInput([buildInfo, hardhat3.artifact()]);
    assertBuilt(built, buildInfo, "project/contracts/Greeter.sol:Greeter", hardhat3.artifact());
  });

  it("builds from a Hardhat 3 build-info and its output file, with a bare name", () => {
    const buildInfo = hardhat3.buildInfo();
    const built = buildVerifyInput([buildInfo, hardhat3.output()], { contract: "Greeter" });
    assertBuilt(built, buildInfo, "project/contracts/Greeter.sol:Greeter");
  });

  it("builds from a bare Standard JSON input with the version and name in options", () => {
    const buildInfo = hardhat2.buildInfo();
    const built = buildVerifyInput([standardJson(buildInfo)], {
      contract: "contracts/Greeter.sol:Greeter",
      compilerVersion: `v${LONG_VERSION}`,
    });
    assertBuilt(built, buildInfo, "contracts/Greeter.sol:Greeter");
  });

  it("drops Foundry's version, allowPaths, basePath and includePaths, so no local path is published", () => {
    const buildInfo = foundry.buildInfo();
    const input = objectAt(buildInfo, "input");
    const local = "/home/builder/project";
    buildInfo.input = { ...input, basePath: local, allowPaths: [local], includePaths: [local] };
    const built = buildVerifyInput([buildInfo, foundry.artifact()]);
    for (const key of FOUNDRY_EXTRA_KEYS) {
      assert.ok(key in input, `the fixture has ${key}`);
      assert.ok(!(key in built.compiler.input), `${key} was kept`);
    }
    assert.ok(!JSON.stringify(built).includes(local));
  });

  it("names a Hardhat 3 contract by the artifact's inputSourceName, not its sourceName", () => {
    const artifact = hardhat3.artifact();
    assert.equal(artifact.sourceName, "contracts/Greeter.sol");
    assert.equal(artifact.inputSourceName, "project/contracts/Greeter.sol");
    // Without the map, sourceName could not be rescued by mapping it to the input name.
    const buildInfo = hardhat3.buildInfo();
    delete buildInfo.userSourceNameMap;
    const built = buildVerifyInput([buildInfo, artifact]);
    assert.equal(built.contractName, "project/contracts/Greeter.sol:Greeter");
  });

  it("maps a Hardhat 3 user source name in options.contract to its input source name", () => {
    const built = buildVerifyInput([hardhat3.buildInfo()], {
      contract: "contracts/Greeter.sol:Greeter",
    });
    assert.equal(built.contractName, "project/contracts/Greeter.sol:Greeter");
  });

  it("gives the same result for every order of the documents", () => {
    const sets: [Record<string, unknown>[], BuildVerifyInputOptions | undefined][] = [
      [[foundry.buildInfo(), foundry.artifact()], undefined],
      [[hardhat2.buildInfo(), hardhat2.artifact()], undefined],
      [[hardhat3.buildInfo(), hardhat3.output(), hardhat3.artifact()], undefined],
      [[hardhat3.buildInfo(), hardhat3.output()], { contract: "Greeter" }],
    ];
    for (const [documents, options] of sets) {
      const results = permutations(documents).map((order) => buildVerifyInput(order, options));
      const [first, ...rest] = results;
      for (const result of rest) {
        assert.deepEqual(result, first);
      }
    }
  });

  it("returns a copy that passes validateInput and shares nothing with the documents (R-IN-6)", () => {
    const buildInfo = hardhat3.buildInfo();
    const built = buildVerifyInput([buildInfo, hardhat3.artifact()]);
    const input = {
      chainId: 11155111,
      address: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      ...built,
    };
    assert.deepEqual(validateInput(input), input);
    const before = JSON.stringify(built);
    const sources = realAt(buildInfo, "input", "sources");
    const settings = realAt(buildInfo, "input", "settings");
    assert.notEqual(built.compiler.input.sources, sources);
    assert.notEqual(built.compiler.input.settings, settings);
    Reflect.set(settings, "evmVersion", "london");
    Reflect.set(realAt(sources, "project/contracts/Greeter.sol"), "content", "changed");
    Reflect.set(sources, "new.sol", { content: "x" });
    assert.equal(JSON.stringify(built), before);
  });

  it("accepts options.compilerVersion equal to the version in the documents", () => {
    const built = buildVerifyInput([hardhat2.buildInfo(), hardhat2.artifact()], {
      compilerVersion: LONG_VERSION,
    });
    assert.equal(built.compiler.version, LONG_VERSION);
  });

  it("accepts options.compilerVersion with a leading v when it equals the documents' version", () => {
    const built = buildVerifyInput([hardhat2.buildInfo(), hardhat2.artifact()], {
      compilerVersion: `v${LONG_VERSION}`,
    });
    assert.equal(built.compiler.version, LONG_VERSION);
  });

  it("skips output entries that are not objects and remappings that are not strings", () => {
    const buildInfo = hardhat3.buildInfo();
    const input = objectAt(buildInfo, "input");
    const settings = objectAt(input, "settings");
    settings.remappings = [5];
    buildInfo.input = { ...input, settings };
    const output = hardhat3.output();
    const contracts = objectAt(output, "output", "contracts");
    contracts["project/contracts/Extra.sol"] = 1;
    output.output = { contracts };
    const built = buildVerifyInput([buildInfo, output, hardhat3.artifact()]);
    assert.equal(built.contractName, "project/contracts/Greeter.sol:Greeter");
  });

  it("takes the contract from an artifact with metadata when it is the only identity", () => {
    const buildInfo = foundry.buildInfo();
    buildInfo.output = { contracts: {} };
    const built = buildVerifyInput([buildInfo, foundry.artifact()]);
    assertBuilt(built, buildInfo, "src/Greeter.sol:Greeter", foundry.artifact());
  });

  it("takes the one contract a build-info output lists when nothing else names one", () => {
    const buildInfo = hardhat3.buildInfo();
    const output = hardhat3.output();
    const contracts = objectAt(output, "output", "contracts");
    delete contracts["project/contracts/Base.sol"];
    output.output = { contracts };
    const built = buildVerifyInput([buildInfo, output]);
    assert.equal(built.contractName, "project/contracts/Greeter.sol:Greeter");
  });

  it("reads the version from rawMetadata when the artifact has no metadata object", () => {
    const buildInfo = foundry.buildInfo();
    buildInfo.output = { contracts: {} };
    const artifact = foundry.artifact();
    delete artifact.metadata;
    const built = buildVerifyInput([buildInfo, artifact], { contract: "src/Greeter.sol:Greeter" });
    assert.equal(built.compiler.version, LONG_VERSION);
  });
});

// --- failures -------------------------------------------------------------------------------------

describe("buildVerifyInput: failures (R-IN-7, R-DX-3)", () => {
  it("fails on a Foundry build-info stub with incomplete-input on input, hinting --build-info", () => {
    const error = assertFails([foundry.stub()], "incomplete-input", "input");
    assert.match(error.hint, /--build-info/);
    assert.deepEqual(candidatesOf(error), []);
    // Next to the artifact, the metadata rebuild runs instead, and asks for the sources (#21).
    const withArtifact = assertFails(
      [foundry.stub(), foundry.artifact()],
      "incomplete-input",
      "sources",
    );
    assert.deepEqual(candidatesOf(withArtifact), ["src/Base.sol", "src/Greeter.sol"]);
    assert.match(withArtifact.hint, /options\.sources/);
    assert.match(withArtifact.hint, /build-info/);
  });

  it("fails on a short version with no long one with incomplete-input on compilerVersion", () => {
    const buildInfo = foundry.buildInfo();
    delete buildInfo.output;
    const error = assertFails([buildInfo], "incomplete-input", "compilerVersion", {
      contract: "src/Greeter.sol:Greeter",
    });
    assert.match(error.message, /short compiler version/);
    assert.match(error.hint, /options\.compilerVersion/);
  });

  it("fails on a bare Standard JSON input with no version with incomplete-input on compilerVersion", () => {
    const error = assertFails(
      [standardJson(hardhat2.buildInfo())],
      "incomplete-input",
      "compilerVersion",
      { contract: "contracts/Greeter.sol:Greeter" },
    );
    assert.match(error.message, /no compiler version/);
  });

  it("fails on an ambiguous contract name with incomplete-input on contract, listing the candidates", () => {
    const buildInfo = foundry.buildInfo();
    const input = objectAt(buildInfo, "input");
    const sources = objectAt(input, "sources");
    sources["src/Other.sol"] = sources["src/Greeter.sol"];
    buildInfo.input = { ...input, sources };
    const contracts = objectAt(buildInfo, "output", "contracts");
    contracts["src/Other.sol"] = contracts["src/Greeter.sol"];
    buildInfo.output = { contracts };
    const error = assertFails([buildInfo], "incomplete-input", "contract", { contract: "Greeter" });
    assert.deepEqual(candidatesOf(error), ["src/Greeter.sol:Greeter", "src/Other.sol:Greeter"]);
  });

  it("fails when the documents hold several contracts and none is chosen", () => {
    const error = assertFails([foundry.buildInfo()], "incomplete-input", "contract");
    assert.deepEqual(candidatesOf(error), ["src/Base.sol:Base", "src/Greeter.sol:Greeter"]);
  });

  it("fails when two artifacts name different contracts", () => {
    const base = hardhat2.artifact();
    base.contractName = "Base";
    base.sourceName = "contracts/Base.sol";
    const error = assertFails(
      [hardhat2.buildInfo(), hardhat2.artifact(), base],
      "incomplete-input",
      "contract",
    );
    assert.deepEqual(candidatesOf(error), [
      "contracts/Base.sol:Base",
      "contracts/Greeter.sol:Greeter",
    ]);
  });

  it("fails when nothing names a contract", () => {
    const error = assertFails(
      [standardJson(hardhat2.buildInfo())],
      "incomplete-input",
      "contract",
      { compilerVersion: LONG_VERSION },
    );
    assert.deepEqual(candidatesOf(error), []);
  });

  it("fails on a bare name when the documents list no contracts", () => {
    assertFails([standardJson(hardhat2.buildInfo())], "incomplete-input", "contract", {
      contract: "Greeter",
      compilerVersion: LONG_VERSION,
    });
  });

  it("fails on a path that is not a key of the sources with invalid-input on contract", () => {
    const error = assertFails([hardhat2.buildInfo()], "invalid-input", "contract", {
      contract: `src/${DUMMY_KEY}.sol:Greeter`,
    });
    assert.match(JSON.stringify(error.details), /not a key of the compiler input's sources/);
  });

  it("fails on an artifact whose source is not in the compiler input", () => {
    assertFails([foundry.buildInfo(), hardhat2.artifact()], "invalid-input", "contract");
  });

  it("fails on a bare name that matches no contract, or that is not an identifier", () => {
    assertFails([hardhat2.buildInfo()], "invalid-input", "contract", { contract: "Missing" });
    assertFails([hardhat2.buildInfo()], "invalid-input", "contract", { contract: "Gre-eter" });
  });

  it("fails on a compilerType other than solc with unsupported-compiler", () => {
    const buildInfo = hardhat3.buildInfo();
    buildInfo.compilerType = "solx";
    assertFails([buildInfo, hardhat3.artifact()], "unsupported-compiler", "compilerType");
  });

  it("fails on a language other than Solidity with unsupported-compiler", () => {
    const json = standardJson(hardhat2.buildInfo());
    json.language = "Vyper";
    assertFails([json], "unsupported-compiler", "language", {
      contract: "contracts/Greeter.sol:Greeter",
      compilerVersion: LONG_VERSION,
    });
  });

  it("fails on ABI and bytecode only with insufficient-artifact, naming the three routes", () => {
    for (const artifact of [hardhat2.artifact(), hardhat3.artifact()]) {
      const error = assertFails([artifact], "insufficient-artifact", "input");
      assert.match(error.message, /no compiler input or settings/);
      assert.match(error.hint, /build-info or metadata/);
      assert.match(error.hint, /bytecode-metadata resolver/);
      assert.match(error.hint, /Similar Match/);
    }
  });

  it("ignores metadata that does not parse, then fails on the short version", () => {
    const buildInfo = foundry.buildInfo();
    delete buildInfo.output;
    const artifact = foundry.artifact();
    delete artifact.metadata;
    artifact.rawMetadata = `{not json ${DUMMY_KEY}`;
    assertFails([buildInfo, artifact], "incomplete-input", "compilerVersion");
  });

  it("fails on an artifact with metadata and no sources with incomplete-input on sources (#21)", () => {
    const error = assertFails([foundry.artifact()], "incomplete-input", "sources");
    assert.deepEqual(candidatesOf(error), ["src/Base.sol", "src/Greeter.sol"]);
  });

  it("fails on a build-info output alone with incomplete-input on input", () => {
    assertFails([hardhat3.output()], "incomplete-input", "input");
  });

  it("fails on two compiler inputs", () => {
    assertFails([hardhat2.buildInfo(), hardhat3.buildInfo()], "invalid-input", "documents");
  });

  it("fails on metadata of two different compiler versions", () => {
    const buildInfo = foundry.buildInfo();
    delete buildInfo.output;
    const artifact = foundry.artifact();
    const other = foundry.artifact();
    delete other.rawMetadata;
    other.metadata = { compiler: { version: "0.8.25+commit.b61c2a91" } };
    assertFails([buildInfo, artifact, other], "invalid-input", "documents", {
      contract: "src/Greeter.sol:Greeter",
    });
  });

  it("fails when options.compilerVersion differs from the version in the documents", () => {
    assertFails([hardhat2.buildInfo(), hardhat2.artifact()], "invalid-input", "compilerVersion", {
      compilerVersion: "0.8.25+commit.b61c2a91",
    });
  });

  it("fails on a document of no known shape", () => {
    const error = assertFails(
      [hardhat2.buildInfo(), { _format: "hh-sol-dbg-1", buildInfo: "../build-info/x.json" }],
      "invalid-input",
      "documents",
    );
    assert.match(JSON.stringify(error.details), /at position 2/);
  });

  it("lists at most five positions of documents of no known shape", () => {
    const error = assertFails(
      Array.from({ length: 7 }, (_, index) => ({ unknown: index })),
      "invalid-input",
      "documents",
    );
    assert.match(JSON.stringify(error.details), /positions 1, 2, 3, 4, 5 and more/);
  });

  it("fails on sources that are not an object with invalid-input on compiler.input.sources", () => {
    const buildInfo = hardhat2.buildInfo();
    buildInfo.input = { ...objectAt(buildInfo, "input"), sources: "contracts" };
    assertFails([buildInfo], "invalid-input", "compiler.input.sources", {
      contract: "contracts/Greeter.sol:Greeter",
    });
  });

  it("fails on documents that are not an array, an empty array or values that are not objects", () => {
    for (const documents of [
      undefined,
      "build-info",
      {},
      [],
      [42],
      [null, ["array"]],
      [undefined],
    ]) {
      const error = rejection(documentsOf(documents));
      assert.equal(error.code, "invalid-input");
      assert.equal(fieldOf(error), "documents");
    }
  });

  it("fails on a Proxy that throws, without repeating its message", () => {
    const hostile = new Proxy([], {
      get() {
        throw new Error(`trap ${DUMMY_KEY}`);
      },
    });
    const error = rejection(hostile);
    assert.equal(fieldOf(error), "documents");
    assertNotShown(error, DUMMY_KEY);
  });

  it("fails on options that are not an object, or a field that is not a string", () => {
    const documents = [hardhat2.buildInfo(), hardhat2.artifact()];
    const cases: [unknown, string][] = [
      ["Greeter", "options"],
      [{ contract: 1 }, "contract"],
      [{ compilerVersion: [DUMMY_KEY] }, "compilerVersion"],
    ];
    for (const [options, field] of cases) {
      const error = rejection(documents, optionsOf(options));
      assert.equal(error.code, "invalid-input");
      assert.equal(fieldOf(error), field);
      assertNotShown(error, DUMMY_KEY);
    }
  });

  it("fails on an absolute source path, Unix or Windows, without repeating it", () => {
    for (const path of ["/home/builder/src/Greeter.sol", "C:\\Users\\builder\\Greeter.sol"]) {
      const buildInfo = hardhat2.buildInfo();
      const input = objectAt(buildInfo, "input");
      const sources = objectAt(input, "sources");
      sources[path] = sources["contracts/Greeter.sol"];
      buildInfo.input = { ...input, sources };
      const error = assertFails([buildInfo], "invalid-input", "compiler.input.sources", {
        contract: "Greeter",
      });
      assertNotShown(error, path);
      assert.match(error.hint, /relative/);
    }
  });

  it("fails on an absolute remapping target", () => {
    const buildInfo = hardhat3.buildInfo();
    const input = objectAt(buildInfo, "input");
    const settings = objectAt(input, "settings");
    settings.remappings = ["forge-std/=lib/forge-std/src/", "@oz/=/home/builder/node_modules/@oz/"];
    buildInfo.input = { ...input, settings };
    const error = assertFails(
      [buildInfo, hardhat3.artifact()],
      "invalid-input",
      "compiler.input.settings.remappings",
    );
    assert.match(JSON.stringify(error.details), /at position 2/);
  });

  it("passes on the rejection of validateInput for an input it cannot accept (R-IN-6)", () => {
    const buildInfo = hardhat2.buildInfo();
    const input = objectAt(buildInfo, "input");
    buildInfo.input = { ...input, sources: { "contracts/Greeter.sol": { content: 1 } } };
    assertFails([buildInfo], "invalid-input", "compiler.input.sources", {
      contract: "contracts/Greeter.sol:Greeter",
    });
  });
});

/** `value` typed as the documents without a cast, as a JavaScript caller passes it. */
function documentsOf(value: unknown): readonly unknown[] {
  const box: { documents: readonly unknown[] } = { documents: [] };
  Reflect.set(box, "documents", value);
  return box.documents;
}

/** `value` typed as the options without a cast, as a JavaScript caller passes it. */
function optionsOf(value: unknown): BuildVerifyInputOptions {
  const box: { options: BuildVerifyInputOptions } = { options: {} };
  Reflect.set(box, "options", value);
  return box.options;
}

// --- review fixes ---------------------------------------------------------------------------------

/** A bare Standard JSON input with one source at `path` and the given settings. */
function oneSource(path: string, settings: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    language: "Solidity",
    sources: { [path]: { content: "contract A {}" } },
    settings: { optimizer: { enabled: false }, ...settings },
  };
}

const ONE_SOURCE_OPTIONS = { contract: "src/A.sol:A", compilerVersion: LONG_VERSION };

/** The Foundry artifact's Solidity metadata object, as a separate document. */
function metadataDocument(): Record<string, unknown> {
  return objectAt(foundry.artifact(), "metadata");
}

describe("buildVerifyInput: builds and versions that do not match (R-IN-7)", () => {
  it("fails when a Hardhat 3 artifact's buildInfoId names another build", () => {
    const artifact = hardhat3.artifact();
    artifact.buildInfoId = "solc-0_8_24-ffffffffffffffffffffffffffffffffffffffff";
    const error = assertFails([hardhat3.buildInfo(), artifact], "invalid-input", "documents");
    assert.match(JSON.stringify(error.details), /different builds/);
  });

  it("fails when a Hardhat 3 output file's id names another build", () => {
    const output = hardhat3.output();
    output.id = "solc-0_8_24-ffffffffffffffffffffffffffffffffffffffff";
    assertFails([hardhat3.buildInfo(), output], "invalid-input", "documents", {
      contract: "Greeter",
    });
  });

  it("fails when an artifact and an output file name different builds without a build-info", () => {
    const artifact = hardhat3.artifact();
    artifact.buildInfoId = "solc-0_8_24-ffffffffffffffffffffffffffffffffffffffff";
    assertFails([hardhat3.output(), artifact], "invalid-input", "documents");
  });

  it("ignores a document passed twice", () => {
    const buildInfo = hardhat3.buildInfo();
    const built = buildVerifyInput([buildInfo, hardhat3.artifact(), hardhat3.buildInfo()]);
    assertBuilt(built, buildInfo, "project/contracts/Greeter.sol:Greeter", hardhat3.artifact());
  });

  it("fails when the build-info's long version and an artifact's metadata version differ", () => {
    const artifact = {
      abi: [],
      bytecode: "0x",
      metadata: {
        compiler: { version: "0.8.25+commit.b61c2a91" },
        settings: { compilationTarget: { "contracts/Greeter.sol": "Greeter" } },
      },
    };
    const error = assertFails([hardhat2.buildInfo(), artifact], "invalid-input", "documents");
    assert.match(JSON.stringify(error.details), /different compiler versions/);
  });
});

describe("buildVerifyInput: Solidity metadata is not a compiler input (R-IN-7)", () => {
  it("rebuilds from a metadata object, not as Standard JSON, and asks for its sources", () => {
    const error = assertFails([metadataDocument()], "incomplete-input", "sources", {
      contract: "src/Greeter.sol:Greeter",
      compilerVersion: LONG_VERSION,
    });
    assert.deepEqual(candidatesOf(error), ["src/Base.sol", "src/Greeter.sol"]);
  });

  it("fails on metadata with embedded sources and no compiler or output object", () => {
    const metadata = metadataDocument();
    delete metadata.compiler;
    delete metadata.output;
    const sources = objectAt(metadata, "sources");
    for (const [path, entry] of Object.entries(sources)) {
      sources[path] = { ...objectAt(entry), content: "contract A {}" };
    }
    metadata.sources = sources;
    assertFails([metadata], "incomplete-input", "input", {
      contract: "src/Greeter.sol:Greeter",
      compilerVersion: LONG_VERSION,
    });
  });

  it("uses a metadata document next to a build-info for the version and the name", () => {
    const buildInfo = foundry.buildInfo();
    delete buildInfo.output;
    const built = buildVerifyInput([buildInfo, metadataDocument()]);
    assertBuilt(built, buildInfo, "src/Greeter.sol:Greeter");
  });
});

describe("buildVerifyInput: no local path reaches the output (R-IN-7)", () => {
  const sourcePaths = [
    "C:A.sol",
    "c:/Users/u/A.sol",
    "\\\\?\\C:\\A.sol",
    "~alice/A.sol",
    "~",
    "../../../../home/u/A.sol",
    "src/../../A.sol",
    " /home/u/A.sol",
    "FILE:///home/u/A.sol",
  ];
  for (const path of sourcePaths) {
    it(`fails on the source path ${JSON.stringify(path)} without repeating it`, () => {
      const error = assertFails([oneSource(path)], "invalid-input", "compiler.input.sources", {
        contract: `${path}:A`,
        compilerVersion: LONG_VERSION,
      });
      assertNotShown(error, path.trim());
    });
  }

  it("accepts a path with .. that stays inside the root", () => {
    const built = buildVerifyInput([oneSource("lib/../src/A.sol")], {
      contract: "lib/../src/A.sol:A",
      compilerVersion: LONG_VERSION,
    });
    assert.equal(built.contractName, "lib/../src/A.sol:A");
  });

  const remappings = [
    "/home/u/proj:@oz/=lib/oz/",
    "/home/u/x",
    "@oz/=~/oz/",
    "@oz/=C:\\x\\",
    "@oz/=../../../oz/",
  ];
  for (const remapping of remappings) {
    it(`fails on the remapping ${JSON.stringify(remapping)} on either side of =`, () => {
      const error = assertFails(
        [oneSource("src/A.sol", { remappings: [remapping] })],
        "invalid-input",
        "compiler.input.settings.remappings",
        ONE_SOURCE_OPTIONS,
      );
      assertNotShown(error, remapping);
    });
  }

  it("fails on an absolute key in settings.libraries", () => {
    const libraries = { "/home/u/L.sol": { L: `0x${"1".repeat(40)}` } };
    assertFails(
      [oneSource("src/A.sol", { libraries })],
      "invalid-input",
      "compiler.input.settings.libraries",
      ONE_SOURCE_OPTIONS,
    );
  });

  it("fails on an absolute key in settings.outputSelection", () => {
    const outputSelection = { "/home/u/A.sol": { "*": ["abi"] } };
    assertFails(
      [oneSource("src/A.sol", { outputSelection })],
      "invalid-input",
      "compiler.input.settings.outputSelection",
      ONE_SOURCE_OPTIONS,
    );
  });

  it("keeps only content and keccak256 of each source, so urls with local paths are dropped", () => {
    const json = oneSource("src/A.sol");
    json.sources = {
      "src/A.sol": {
        content: "contract A {}",
        keccak256: `0x${"ab".repeat(32)}`,
        urls: ["/home/alice/proj/src/A.sol"],
        license: "MIT",
      },
    };
    const built = buildVerifyInput([json], ONE_SOURCE_OPTIONS);
    assert.deepEqual(built.compiler.input.sources, {
      "src/A.sol": { content: "contract A {}", keccak256: `0x${"ab".repeat(32)}` },
    });
  });
});

describe("buildVerifyInput: fields named in errors (R-IN-7, R-DX-3)", () => {
  it("fails on two different compiler inputs that carry no build id", () => {
    const first = standardJson(hardhat2.buildInfo());
    const second = standardJson(hardhat3.buildInfo());
    const error = assertFails([first, second], "invalid-input", "documents", {
      compilerVersion: LONG_VERSION,
    });
    assert.match(JSON.stringify(error.details), /more than one compiler input/);
  });

  it("passes a source entry that is not an object on to validateInput", () => {
    const json = oneSource("src/A.sol");
    json.sources = { "src/A.sol": 1 };
    assertFails([json], "invalid-input", "compiler.input.sources", ONE_SOURCE_OPTIONS);
  });

  it("classifies a document that is not JSON data, such as one holding a BigInt", () => {
    const artifact = { ...hardhat2.artifact(), gas: 1n };
    const built = buildVerifyInput([hardhat2.buildInfo(), artifact]);
    assert.equal(built.contractName, "contracts/Greeter.sol:Greeter");
  });

  it("fails on an output file and an artifact without build-info with incomplete-input on input", () => {
    const error = assertFails(
      [hardhat3.output(), hardhat3.artifact()],
      "incomplete-input",
      "input",
    );
    assert.match(error.hint, /build-info/);
  });

  it("reports a malformed options.contract on the field contract, not contractName", () => {
    assertFails([hardhat2.buildInfo()], "invalid-input", "contract", {
      contract: "contracts/Greeter.sol:1Greeter",
    });
  });
});

// --- test strength (mutation review) --------------------------------------------------------------

describe("buildVerifyInput: shapes and precedence pinned (R-IN-7)", () => {
  it("treats a build-info whose input lacks settings as no known shape (K-shape)", () => {
    const buildInfo = hardhat2.buildInfo();
    Reflect.deleteProperty(realAt(buildInfo, "input"), "settings");
    assertFails([buildInfo], "invalid-input", "documents", {
      contract: "contracts/Greeter.sol:Greeter",
    });
    const onlyLanguage = hardhat2.buildInfo();
    onlyLanguage.input = { language: "Solidity" };
    assertFails([onlyLanguage], "invalid-input", "documents", {
      contract: "contracts/Greeter.sol:Greeter",
    });
  });

  it("does not read a partial input with an output as an output file (K-output)", () => {
    const buildInfo = foundry.buildInfo();
    Reflect.deleteProperty(realAt(buildInfo, "input"), "settings");
    assertFails([buildInfo], "invalid-input", "documents");
  });

  it("treats abi without bytecode as no known shape (K-abi)", () => {
    assertFails([{ abi: [] }], "invalid-input", "documents");
  });

  it("passes a language that is not a string on to validateInput (K-lang)", () => {
    const buildInfo = hardhat2.buildInfo();
    Reflect.set(realAt(buildInfo, "input"), "language", 5);
    assertFails([buildInfo], "invalid-input", "compiler.input.language", {
      contract: "contracts/Greeter.sol:Greeter",
    });
  });

  it("uses inputSourceName without userSourceNameMap (K-isn)", () => {
    const buildInfo = hardhat3.buildInfo();
    delete buildInfo.userSourceNameMap;
    const built = buildVerifyInput([buildInfo, hardhat3.artifact()]);
    assert.equal(built.contractName, "project/contracts/Greeter.sol:Greeter");
  });

  it("rejects a solcLongVersion that conflicts with artifact metadata, in both orders (K-ver)", () => {
    const buildInfo = foundry.buildInfo();
    buildInfo.solcLongVersion = LONG_VERSION;
    delete buildInfo.output;
    const same = foundry.artifact();
    const other = foundry.artifact();
    delete other.rawMetadata;
    other.metadata = {
      ...objectAt(other, "metadata"),
      compiler: { version: "0.8.25+commit.b61c2a91" },
    };
    const options = { contract: "src/Greeter.sol:Greeter" };
    assertFails([buildInfo, same, other], "invalid-input", "documents", options);
    assertFails([buildInfo, other, same], "invalid-input", "documents", options);
  });

  it("caps candidates at 20, sorted, and keeps them out of the message (K-cap)", () => {
    const buildInfo = foundry.buildInfo();
    const sources = realAt(buildInfo, "input", "sources");
    const contracts = realAt(buildInfo, "output", "contracts");
    for (let index = 0; index < 25; index++) {
      const path = `src/C${String(index).padStart(2, "0")}.sol`;
      Reflect.set(sources, path, Reflect.get(sources, "src/Greeter.sol"));
      Reflect.set(contracts, path, Reflect.get(contracts, "src/Greeter.sol"));
    }
    const error = assertFails([buildInfo], "incomplete-input", "contract", { contract: "Greeter" });
    const candidates = candidatesOf(error);
    assert.equal(candidates.length, 20);
    assert.deepEqual(candidates, candidates.toSorted());
    assert.equal(candidates[0], "src/C00.sol:Greeter");
    assert.ok(!error.message.includes("src/C00.sol"));
    assert.ok(!error.message.includes("src/Greeter.sol"));
  });

  it("rejects each absolute form as a source key and as a remapping target (K-abs)", () => {
    for (const path of [
      "\\\\server\\share\\A.sol",
      "~/src/A.sol",
      "file:///src/A.sol",
      "C:/Users/b/A.sol",
      "/x/A.sol",
    ]) {
      const buildInfo = hardhat2.buildInfo();
      const sources = realAt(buildInfo, "input", "sources");
      Reflect.set(sources, path, Reflect.get(sources, "contracts/Greeter.sol"));
      assertFails([buildInfo], "invalid-input", "compiler.input.sources", { contract: "Greeter" });
      const remapped = hardhat2.buildInfo();
      Reflect.set(realAt(remapped, "input", "settings"), "remappings", [`x/=${path}`]);
      assertFails([remapped], "invalid-input", "compiler.input.settings.remappings", {
        contract: "Greeter",
      });
    }
  });

  it("gives a metadata artifact next to a plain artifact incomplete-input, not insufficient-artifact (K-prec1)", () => {
    const error = assertFails(
      [foundry.artifact(), hardhat2.artifact()],
      "incomplete-input",
      "sources",
    );
    assert.match(error.hint, /options\.sources/);
  });

  it("rebuilds from an artifact next to a stub, and keeps the --build-info hint for a stub alone (K-prec2)", () => {
    const stub = assertFails([foundry.stub()], "incomplete-input", "input");
    assert.match(stub.hint, /--build-info/);
    const withArtifact = assertFails(
      [foundry.stub(), foundry.artifact()],
      "incomplete-input",
      "sources",
    );
    assert.doesNotMatch(withArtifact.hint, /--build-info/);
  });

  it("never repeats a bare name that matches nothing (K-echo)", () => {
    const error = assertFails([hardhat2.buildInfo()], "invalid-input", "contract", {
      contract: DUMMY_KEY,
    });
    assertNotShown(error, DUMMY_KEY);
  });

  it("gives a bare name that is not an identifier the identifier message (K-ident)", () => {
    const error = assertFails([hardhat2.buildInfo()], "invalid-input", "contract", {
      contract: "Gre-eter",
    });
    assert.match(JSON.stringify(error.details), /Solidity identifier/);
  });

  it("matches a bare name against whole contract names only (K-suffix)", () => {
    assertFails([hardhat2.buildInfo()], "invalid-input", "contract", { contract: "Greet" });
    assertFails([hardhat2.buildInfo()], "invalid-input", "contract", { contract: "reeter" });
  });

  it("falls back to an artifact's metadata object when its rawMetadata string does not parse", () => {
    const buildInfo = foundry.buildInfo();
    delete buildInfo.output;
    const artifact = foundry.artifact();
    artifact.rawMetadata = "{not json";
    const built = buildVerifyInput([buildInfo, artifact]);
    assert.equal(built.compiler.version, LONG_VERSION);
  });

  it("reports a document of no known shape before an unsupported compiler (K-prec3)", () => {
    const buildInfo = hardhat3.buildInfo();
    buildInfo.compilerType = "solx";
    assertFails([buildInfo, { unknown: true }], "invalid-input", "documents");
  });
});

// --- fixtures -------------------------------------------------------------------------------------

/** Every file under `directory`, recursively. */
function files(directory: URL): URL[] {
  return readdirSync(directory).flatMap((name) => {
    const entry = new URL(name, directory);
    return statSync(entry).isDirectory() ? files(new URL(`${name}/`, directory)) : [entry];
  });
}
describe("build-format fixtures", () => {
  it("hold no absolute path and no name of the machine or user that built them", () => {
    const all = files(FIXTURES);
    assert.ok(all.length >= 9);
    const user = userInfo().username;
    const forbidden = [homedir(), ...(user.length >= 4 ? [user] : [])];
    for (const file of all) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /"(?:\/(?:Users|home|private|tmp|var|root|opt)\/|[A-Za-z]:\\\\)/);
      for (const word of forbidden) {
        assert.ok(!text.includes(word), `${file.pathname} holds a local name`);
      }
    }
  });

  it("keep Foundry's extra input keys, with a placeholder for the build machine's path", () => {
    const input = objectAt(foundry.buildInfo(), "input");
    assert.equal(input.basePath, "<project-root>");
    assert.deepEqual(input.allowPaths, ["<project-root>"]);
    assert.deepEqual(input.includePaths, ["<project-root>"]);
    assert.equal(input.version, "0.8.24");
  });
});
