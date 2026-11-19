// Tests for buildVerifyInput on Vyper documents (R-IN-7, R-SEC-1, decisions 0075 and 0076): a bare Vyper
// Standard JSON, the output of `vyper -f solc_json` and a Foundry Vyper build-info. The fixtures
// are in test/fixtures/build-formats/ (see the README there). Each `compiled.json` holds the
// creation bytecode of the original build and of the input this builder returns, both compiled
// once with the Vyper compiler when the fixture was made; the tests never run the compiler.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import { buildVerifyInput, ExplorerVerifyError, validateInput, verify } from "../../src/index.ts";
import type {
  BuildVerifyInputOptions,
  BuiltVerifyInput,
  ErrorCode,
  VerifyInput,
} from "../../src/index.ts";
import { isIndexedPath } from "../../src/input/paths.ts";
import {
  VYPER_RELEASES,
  rewriteVyperKey,
  rewriteVyperSearchPath,
  vyperLongVersion,
} from "../../src/input/vyper.ts";

type Json = Record<string, unknown>;

const FIXTURES = new URL("../fixtures/build-formats/", import.meta.url);
const V043 = "0.4.3+commit.bff19ea2";
const V0310 = "0.3.10+commit.91361694";
// The fake environment path in the site-packages fixture; it must never reach an output or error.
const FAKE_PREFIX = "0/1/2/3/home/user/.venv/lib/python3.12/site-packages";
const PLACEHOLDER = { chainId: 1, address: `0x${"0".repeat(40)}` } as const;

/** A fresh parse of one fixture file, so a test may change it. */
function fixture(path: string): Json {
  const parsed: unknown = JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return { ...parsed };
}

/** The object at `key` of `value`, copied. */
function child(value: unknown, key: string): Json {
  assert.ok(typeof value === "object" && value !== null);
  const found: unknown = Reflect.get(value, key);
  assert.ok(typeof found === "object" && found !== null && !Array.isArray(found));
  return { ...found };
}

/** The string at `key` of `value`. */
function text(value: Json, key: string): string {
  const found = value[key];
  assert.equal(typeof found, "string");
  return String(found);
}

const solcJson = (): Json => fixture("vyper-0.4.3-solc-json/Counter.solc_json.json");
const sitePackages = (): Json => fixture("vyper-0.4.3-site-packages/Vault.solc_json.json");
const foundry = (): Json => fixture("foundry-1.8.1-vyper/build-info.json");
const bare0310 = (): Json => fixture("vyper-0.3.10/input.json");
const hardhatArtifact = (): Json => fixture("hardhat-vyper-3.1.2/Greeter.json");
const solcJson040 = (): Json => fixture("vyper-0.4.0-solc-json/Counter.solc_json.json");

/** The input part of a built Vyper compiler. */
function inputOf(built: BuiltVerifyInput): Json {
  assert.equal(built.compiler.kind, "vyper");
  return child(built.compiler, "input");
}

/** Asserts that the built parts pass validateInput unchanged. */
function assertValid(built: BuiltVerifyInput): void {
  const checked = validateInput({ ...PLACEHOLDER, ...built });
  assert.deepEqual(checked.compiler, built.compiler);
  assert.equal(checked.contractName, built.contractName);
}

/** The error buildVerifyInput throws. */
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

/** Asserts that `text` appears in none of the places an error can be printed from. */
function assertNotShown(error: ExplorerVerifyError, shown: string): void {
  for (const place of [
    error.message,
    error.hint,
    String(error),
    error.stack ?? "",
    JSON.stringify(error),
    inspect(error, { depth: Infinity }),
  ]) {
    assert.ok(!place.includes(shown), `shown in: ${place.slice(0, 120)}`);
  }
}

/** Asserts an invalid-input error with one issue on `field`, whose message names no path. */
function assertInvalid(
  documents: readonly unknown[],
  field: string,
  message: string,
  options?: BuildVerifyInputOptions,
): ExplorerVerifyError {
  const error = rejection(documents, options);
  const details = error.details;
  assert.equal(details.code, "invalid-input");
  assert.deepEqual(details.issues, [{ field, message }]);
  return error;
}

/** Asserts the code and `details.field` of an error. */
function assertCode(error: ExplorerVerifyError, code: ErrorCode, field: string): void {
  assert.equal(error.details.code, code);
  assert.equal(Reflect.get(error.details, "field"), field);
}

describe("buildVerifyInput: vyper -f solc_json (R-IN-7)", () => {
  it("returns kind vyper, the version without its v and the one target, and passes validateInput", () => {
    const built = buildVerifyInput([solcJson()]);
    assert.deepEqual(built.compiler.version, V043);
    assert.equal(built.contractName, "src/Counter.vy:Counter");
    assert.equal(built.creationBytecode, undefined);
    assert.ok(!("creationBytecode" in built));
    assertValid(built);
  });

  it("keeps only language, sources and settings, and only content of each source", () => {
    const original = solcJson();
    const input = inputOf(buildVerifyInput([original]));
    assert.deepEqual(Object.keys(input), ["language", "sources", "settings"]);
    assert.equal(input.language, "Vyper");
    const sources = child(input, "sources");
    const originalSources = child(original, "sources");
    assert.deepEqual(Object.keys(sources), Object.keys(originalSources));
    for (const [path, entry] of Object.entries(sources)) {
      assert.deepEqual(entry, { content: child(originalSources, path).content });
    }
    assert.deepEqual(input.settings, original.settings);
  });

  it("returns the input that compiled to the original bytecode (Counter.input.json, compiled.json)", () => {
    const built = buildVerifyInput([solcJson()]);
    assert.deepEqual(built.compiler.input, fixture("vyper-0.4.3-solc-json/Counter.input.json"));
    const compiled = fixture("vyper-0.4.3-solc-json/compiled.json");
    assert.match(text(compiled, "original"), /^0x[0-9a-f]+$/);
    assert.equal(compiled.built, compiled.original);
  });

  it("takes a matching compilerVersion, with or without its v, and refuses another", () => {
    assert.equal(buildVerifyInput([solcJson()], { compilerVersion: V043 }).compiler.version, V043);
    assert.equal(
      buildVerifyInput([solcJson()], { compilerVersion: `v${V043}` }).compiler.version,
      V043,
    );
    assertInvalid(
      [solcJson()],
      "compilerVersion",
      "differs from the compiler version in the documents",
      { compilerVersion: "0.4.2+commit.c216787f" },
    );
  });

  it("names the contract from a bare name or path:Name", () => {
    assert.equal(
      buildVerifyInput([solcJson()], { contract: "Counter" }).contractName,
      "src/Counter.vy:Counter",
    );
    assert.equal(
      buildVerifyInput([solcJson()], { contract: "src/lib/owned.vy:owned" }).contractName,
      "src/lib/owned.vy:owned",
    );
  });

  it("lists only the .vy targets of outputSelection that are source keys", () => {
    const document = solcJson();
    document.settings = {
      outputSelection: {
        "src/Counter.vy": ["*"],
        "src/interfaces/ICounter.vyi": ["*"],
        "src/Missing.vy": ["*"],
        "*": ["*"],
      },
    };
    assert.equal(buildVerifyInput([document]).contractName, "src/Counter.vy:Counter");
    document.settings = {
      outputSelection: { "src/Counter.vy": ["*"], "src/lib/owned.vy": ["*"] },
    };
    const error = rejection([document]);
    assertCode(error, "incomplete-input", "contract");
    assert.deepEqual(Reflect.get(error.details, "candidates"), [
      "src/Counter.vy:Counter",
      "src/lib/owned.vy:owned",
    ]);
  });

  it("finds a target in a nested folder named after the file, with either separator", () => {
    const document = solcJson();
    const sources = child(document, "sources");
    sources["src\\win\\Counter.vy"] = sources["src/Counter.vy"];
    delete sources["src/Counter.vy"];
    document.sources = sources;
    document.settings = { outputSelection: { "src\\win\\Counter.vy": ["*"] } };
    assert.equal(buildVerifyInput([document]).contractName, "src\\win\\Counter.vy:Counter");
  });
});

describe("buildVerifyInput: a module from a Python environment (R-IN-7, R-SEC-1)", () => {
  it("rewrites the key to the package path and the search path to .", () => {
    const built = buildVerifyInput([sitePackages()]);
    const input = inputOf(built);
    assert.deepEqual(Object.keys(child(input, "sources")), ["vylib/auth/owned.vy", "src/Vault.vy"]);
    assert.deepEqual(child(input, "settings").search_paths, ["."]);
    assert.equal(built.contractName, "src/Vault.vy:Vault");
    assert.equal(built.compiler.version, V043);
    assert.ok(!JSON.stringify(built).includes("home/user"));
    assertValid(built);
  });

  it("returns the input that compiled to the original bytecode (Vault.input.json, compiled.json)", () => {
    const built = buildVerifyInput([sitePackages()]);
    assert.deepEqual(built.compiler.input, fixture("vyper-0.4.3-site-packages/Vault.input.json"));
    const compiled = fixture("vyper-0.4.3-site-packages/compiled.json");
    assert.match(text(compiled, "original"), /^0x[0-9a-f]+$/);
    assert.equal(compiled.fakePrefix, compiled.original);
    assert.equal(compiled.rewritten, compiled.original);
  });

  it("holds the fake environment path in the fixture, keyed after an index run", () => {
    const document = sitePackages();
    assert.ok(
      Object.keys(child(document, "sources")).includes(`${FAKE_PREFIX}/vylib/auth/owned.vy`),
    );
    assert.deepEqual(child(document, "settings").search_paths, [FAKE_PREFIX, "."]);
  });

  it("rewrites outputSelection keys and an interface key, and maps a contract given by its old key", () => {
    const document = sitePackages();
    const source = child(child(document, "sources"), `${FAKE_PREFIX}/vylib/auth/owned.vy`);
    document.interfaces = {
      [`${FAKE_PREFIX}\\vylib\\IOwned.vyi`]: { content: "", sha256sum: "x" },
    };
    document.settings = {
      outputSelection: { [`${FAKE_PREFIX}/vylib/auth/owned.vy`]: ["*"] },
      search_paths: [`${FAKE_PREFIX}/`, ".", "lib"],
    };
    const built = buildVerifyInput([document]);
    const input = inputOf(built);
    assert.deepEqual(input.interfaces, { "vylib\\IOwned.vyi": { content: "" } });
    assert.deepEqual(input.settings, {
      outputSelection: { "vylib/auth/owned.vy": ["*"] },
      search_paths: [".", "lib"],
    });
    assert.equal(built.contractName, "vylib/auth/owned.vy:owned");
    assert.deepEqual(child(input, "sources")["vylib/auth/owned.vy"], { content: source.content });
    const byOldKey = buildVerifyInput([document], {
      contract: `${FAKE_PREFIX}/vylib/auth/owned.vy:owned`,
    });
    assert.equal(byOldKey.contractName, "vylib/auth/owned.vy:owned");
  });

  it("takes creation bytecode from an artifact that names the old key", () => {
    const compiled = fixture("vyper-0.4.3-site-packages/compiled.json");
    const artifact = {
      _format: "hh-vyper-artifact-1",
      contractName: "owned",
      sourceName: `${FAKE_PREFIX}/vylib/auth/owned.vy`,
      abi: [],
      bytecode: compiled.original,
    };
    const built = buildVerifyInput([sitePackages(), artifact]);
    assert.equal(built.contractName, "vylib/auth/owned.vy:owned");
    assert.equal(built.creationBytecode, compiled.original);
  });
});

describe("buildVerifyInput: refuses local Vyper paths (R-IN-7, R-SEC-1)", () => {
  const localKeys = [
    ["an index run without site-packages", "0/1/2/home/user/project/lib/owned.vy"],
    ["an index run after ./", "./0/1/home/user/.venv/lib/owned.vy"],
    ["an absolute key", "/home/user/project/src/lib/owned.vy"],
    ["a Windows absolute key", "C:\\Users\\builder\\src\\owned.vy"],
    ["a climbing key", "../../outside/owned.vy"],
    ["a site-packages key that climbs", "0/1/home/user/site-packages/../../../etc/owned.vy"],
    ["a site-packages key that is indexed again", "0/1/home/user/site-packages/0/x/owned.vy"],
  ] as const;

  for (const [name, key] of localKeys) {
    it(`throws invalid-input on ${name} in sources, naming no path`, () => {
      const document = solcJson();
      const sources = child(document, "sources");
      sources[key] = sources["src/lib/owned.vy"];
      delete sources["src/lib/owned.vy"];
      document.sources = sources;
      const error = assertInvalid(
        [document],
        "compiler.input.sources",
        "has a local path at position 3",
      );
      assert.match(error.hint, /Python environment, under site-packages/);
      assertNotShown(error, key);
      assertNotShown(error, "home");
      assertNotShown(error, "builder");
    });
  }

  it("throws on a local key in interfaces and in outputSelection", () => {
    const document = solcJson();
    document.interfaces = { "ok.vyi": { content: "" }, "/home/user/I.vyi": { content: "" } };
    assertInvalid([document], "compiler.input.interfaces", "has a local path at position 2");
    const selection = solcJson();
    selection.settings = { outputSelection: { "0/1/home/user/x.vy": ["*"] } };
    assertInvalid(
      [selection],
      "compiler.input.settings.outputSelection",
      "has a local path at position 1",
    );
  });

  it("throws on an indexed search path that is not site-packages, and on an absolute one", () => {
    for (const [paths, at] of [
      [[".", "0/1/home/user/lib"], "position 2"],
      [["/home/user/lib", "../up", "."], "positions 1, 2"],
      [["0/1/x/site-packages/more"], "position 1"],
    ] as const) {
      const document = solcJson();
      document.settings = { outputSelection: { "src/Counter.vy": ["*"] }, search_paths: paths };
      const error = assertInvalid(
        [document],
        "compiler.input.settings.search_paths",
        `has a local path at ${at}`,
      );
      assertNotShown(error, "home");
    }
  });

  it("throws when two keys name one file after the rewrite", () => {
    const document = sitePackages();
    const sources = child(document, "sources");
    sources["vylib/auth/owned.vy"] = sources[`${FAKE_PREFIX}/vylib/auth/owned.vy`];
    document.sources = sources;
    const error = assertInvalid(
      [document],
      "compiler.input.sources",
      "names one file twice at position 3",
    );
    assertNotShown(error, "home");
  });

  it("leaves a search path that is not a string for validateInput to report", () => {
    const document = solcJson();
    document.settings = { outputSelection: { "src/Counter.vy": ["*"] }, search_paths: [".", 7, 7] };
    assertInvalid(
      [document],
      "compiler.input.settings.search_paths",
      "must be an array of strings",
    );
    document.settings = { outputSelection: { "src/Counter.vy": ["*"] }, search_paths: [undefined] };
    assertInvalid(
      [document],
      "compiler.input.settings.search_paths",
      "must be an array of strings",
    );
  });

  it("drops a repeated search path", () => {
    const document = solcJson();
    document.settings = { search_paths: [".", "lib", ".", "lib"] };
    const input = inputOf(buildVerifyInput([document], { contract: "src/Counter.vy:Counter" }));
    assert.deepEqual(child(input, "settings").search_paths, [".", "lib"]);
  });

  it("refuses a search_paths array whose Proxy traps throw, without its text", () => {
    const document = solcJson();
    const hostile = new Proxy([], {
      get(): never {
        throw new Error("/home/user/secret");
      },
    });
    document.settings = { search_paths: hostile };
    const error = assertInvalid(
      [document],
      "compiler.input.settings.search_paths",
      "could not be read as an array",
      { contract: "src/Counter.vy:Counter" },
    );
    assertNotShown(error, "secret");
  });
});

describe("buildVerifyInput: a Foundry Vyper build-info (R-IN-7, D1)", () => {
  it("returns the long version from the release table, the contract and its creation bytecode", () => {
    const document = foundry();
    const built = buildVerifyInput([document], { contract: "Counter" });
    assert.equal(document.solcLongVersion, "0.4.3");
    assert.equal(built.compiler.version, V043);
    assert.equal(built.contractName, "src/Counter.vy:Counter");
    const contracts = child(child(document, "output"), "contracts");
    const bytecode = child(
      child(child(child(contracts, "src/Counter.vy"), "Counter"), "evm"),
      "bytecode",
    );
    assert.equal(built.creationBytecode, `0x${text(bytecode, "object")}`);
    assert.deepEqual(built.compiler.input, fixture("foundry-1.8.1-vyper/Counter.input.json"));
    const compiled = fixture("foundry-1.8.1-vyper/compiled.json");
    assert.equal(built.creationBytecode, compiled.original);
    assert.equal(compiled.built, compiled.original);
    assertValid(built);
  });

  it("keeps the interfaces and the settings, and drops the build-info's other keys", () => {
    const document = foundry();
    const input = inputOf(buildVerifyInput([document], { contract: "src/Counter.vy:Counter" }));
    assert.deepEqual(Object.keys(input), ["language", "sources", "settings", "interfaces"]);
    const original = child(document, "input");
    assert.deepEqual(input.interfaces, original.interfaces);
    assert.deepEqual(input.settings, original.settings);
  });

  it("asks for the contract when the build-info lists two", () => {
    const error = rejection([foundry()]);
    assertCode(error, "incomplete-input", "contract");
    assert.deepEqual(Reflect.get(error.details, "candidates"), [
      "src/Counter.vy:Counter",
      "src/lib/owned.vy:owned",
    ]);
  });

  it("throws incomplete-input naming compilerVersion for a version the table does not list", () => {
    const document = foundry();
    document.solcLongVersion = "0.4.4";
    const error = rejection([document], { contract: "Counter" });
    assertCode(error, "incomplete-input", "compilerVersion");
    assert.equal(
      error.message,
      "The documents hold only the short Vyper version, and this version of explorer-verify lists no commit for that Vyper version.",
    );
    assert.match(error.hint, /options\.compilerVersion/);
    assert.match(error.hint, /0\.4\.3\+commit\.bff19ea2/);
  });

  it("takes compilerVersion for a version the table does not list, when it has the same base", () => {
    const document = foundry();
    document.solcLongVersion = "0.4.4";
    const version = "0.4.4+commit.0123abcd";
    const built = buildVerifyInput([document], { contract: "Counter", compilerVersion: version });
    assert.equal(built.compiler.version, version);
    assertInvalid(
      [document],
      "compilerVersion",
      "differs from the compiler version in the documents",
      {
        contract: "Counter",
        compilerVersion: V043,
      },
    );
  });

  it("takes a compilerVersion equal to the table's, and refuses another commit", () => {
    const options = { contract: "Counter", compilerVersion: V043 };
    assert.equal(buildVerifyInput([foundry()], options).compiler.version, V043);
    assertInvalid(
      [foundry()],
      "compilerVersion",
      "differs from the compiler version in the documents",
      {
        contract: "Counter",
        compilerVersion: "0.4.3+commit.0123abcd",
      },
    );
  });

  it("reads a long solcLongVersion as it is", () => {
    const document = foundry();
    document.solcLongVersion = "0.4.2+commit.c216787f";
    assert.equal(
      buildVerifyInput([document], { contract: "Counter" }).compiler.version,
      "0.4.2+commit.c216787f",
    );
  });
});

describe("buildVerifyInput: a bare Vyper Standard JSON (R-IN-7)", () => {
  it("returns the compilerVersion and the one target, and passes validateInput", () => {
    const built = buildVerifyInput([bare0310()], { compilerVersion: V0310 });
    assert.equal(built.compiler.version, V0310);
    assert.equal(built.contractName, "contracts/Greeter.vy:Greeter");
    assert.ok(!("creationBytecode" in built));
    assert.deepEqual(built.compiler.input, bare0310());
    assert.deepEqual(built.compiler.input, fixture("vyper-0.3.10/Greeter.input.json"));
    assertValid(built);
    const compiled = fixture("vyper-0.3.10/compiled.json");
    assert.equal(compiled.built, compiled.original);
  });

  it("ignores a compiler_version that is not a string", () => {
    const document = { ...bare0310(), compiler_version: 7 };
    const built = buildVerifyInput([document], { compilerVersion: V0310 });
    assert.equal(built.compiler.version, V0310);
    assert.ok(!("compiler_version" in inputOf(built)));
  });

  it("throws incomplete-input naming compilerVersion without one", () => {
    const error = rejection([bare0310()]);
    assertCode(error, "incomplete-input", "compilerVersion");
    assert.equal(error.message, "The documents hold no compiler version.");
  });

  it("takes the name and the creation bytecode from a Hardhat 2 Vyper artifact", () => {
    const artifact = hardhatArtifact();
    const built = buildVerifyInput([artifact, bare0310()], { compilerVersion: V0310 });
    assert.equal(built.contractName, "contracts/Greeter.vy:Greeter");
    assert.equal(built.creationBytecode, artifact.bytecode);
    assert.equal(artifact.bytecode, fixture("vyper-0.3.10/compiled.json").original);
  });

  it("keeps an interface given as an ABI, and one that is not an object for validateInput", () => {
    const document = bare0310();
    document.interfaces = { "I.json": { abi: [], extra: 1 } };
    const input = inputOf(buildVerifyInput([document], { compilerVersion: V0310 }));
    assert.deepEqual(input.interfaces, { "I.json": { abi: [] } });
    document.interfaces = { "I.vyi": { content: "x", abi: [], sha256sum: "y" } };
    const both = inputOf(buildVerifyInput([document], { compilerVersion: V0310 }));
    assert.deepEqual(both.interfaces, { "I.vyi": { content: "x" } });
    document.interfaces = { "I.vyi": "text" };
    const error = rejection([document], { compilerVersion: V0310 });
    assert.equal(error.details.code, "invalid-input");
    assert.deepEqual(
      error.details.code === "invalid-input" ? error.details.issues.map((one) => one.field) : [],
      ["compiler.input.interfaces"],
    );
    document.interfaces = "not an object";
    assert.equal(rejection([document], { compilerVersion: V0310 }).details.code, "invalid-input");
  });

  it("keeps settings that are not an object for validateInput to report", () => {
    const document = bare0310();
    document.settings = 7;
    const error = rejection([document], {
      compilerVersion: V0310,
      contract: "contracts/Greeter.vy:Greeter",
    });
    assert.equal(error.details.code, "invalid-input");
  });

  it("throws invalid-input when sources is not an object", () => {
    const document = bare0310();
    document.sources = [];
    assertInvalid(
      [document],
      "compiler.input.sources",
      "must be an object of source files by path",
      {
        compilerVersion: V0310,
      },
    );
  });

  it("refuses a Vyper version below 0.3.10 through validateInput", () => {
    const error = rejection([bare0310()], { compilerVersion: "0.3.9+commit.66b96705" });
    assert.equal(error.details.code, "unsupported-compiler");
  });
});

describe("buildVerifyInput: a Hardhat 2 Vyper artifact on its own (R-IN-7)", () => {
  it("throws insufficient-artifact, naming the Vyper routes", () => {
    const error = rejection([hardhatArtifact()]);
    assertCode(error, "insufficient-artifact", "input");
    assert.equal(
      error.message,
      "The documents hold no compiler input or settings: a Hardhat 2 Vyper artifact holds only ABI and bytecode.",
    );
    assert.equal(
      error.hint,
      "Pass the output of vyper -f solc_json for the contract, a Foundry build-info (build_info = true), or the Vyper Standard JSON input with the full compiler version (options.compilerVersion) and the contract (options.contract).",
    );
  });
});

describe("buildVerifyInput: Vyper metadata is not rebuilt (R-IN-7)", () => {
  it("refuses metadata with language Vyper as unsupported-compiler", () => {
    const metadata = {
      language: "Vyper",
      compiler: { version: V043 },
      settings: { compilationTarget: { "src/A.vy": "A" } },
      sources: { "src/A.vy": { keccak256: `0x${"0".repeat(64)}`, content: "" } },
    };
    const error = rejection([metadata]);
    assertCode(error, "unsupported-compiler", "language");
  });
});

describe("the Vyper release table (D1)", () => {
  it("lists the stable releases from 0.3.10 with their 8-character commits", () => {
    assert.deepEqual(
      [...VYPER_RELEASES],
      [
        ["0.3.10", "91361694"],
        ["0.4.0", "e9db8d9f"],
        ["0.4.1", "8a93dd27"],
        ["0.4.2", "c216787f"],
        ["0.4.3", "bff19ea2"],
      ],
    );
  });

  it("completes a listed version without a commit or with a 7-character commit", () => {
    assert.equal(vyperLongVersion("0.4.3"), V043);
    assert.equal(vyperLongVersion("v0.3.10"), V0310);
    assert.equal(vyperLongVersion("v0.4.0+commit.e9db8d9"), "0.4.0+commit.e9db8d9f");
    assert.equal(vyperLongVersion("0.3.10+commit.9136169"), V0310);
    assert.equal(vyperLongVersion("0.4.0+commit.1234567"), null);
    assert.equal(vyperLongVersion("0.4.4"), undefined);
    assert.equal(vyperLongVersion("0.4.4+commit.abcdef1"), undefined);
    assert.equal(vyperLongVersion("10.4.3"), undefined);
    assert.equal(vyperLongVersion("0.10.0"), undefined);
  });

  it("rewrites a top-level site-packages key and search path", () => {
    assert.equal(rewriteVyperKey("site-packages/snek/a.vy"), "snek/a.vy");
    assert.equal(rewriteVyperSearchPath("site-packages"), ".");
    assert.equal(rewriteVyperSearchPath("site-packages/"), ".");
  });

  it("compares a short compilerVersion with the whole base of the documents' version", () => {
    const document = { ...bare0310(), compiler_version: "v0.4.30+commit.12345678" };
    assertInvalid(
      [document],
      "compilerVersion",
      "differs from the compiler version in the documents",
      {
        compilerVersion: "0.4.3",
      },
    );
  });

  it("returns any other form as it is, for validateInput to check", () => {
    for (const version of [
      V043,
      `v${V043}`,
      "0.4.3rc1",
      "vv0.4.3",
      "0.4.3+commit.bff19e",
      "0.4.3+commit.BFF19EA",
      "x0.4.3",
      "0.4.3 ",
    ]) {
      assert.equal(vyperLongVersion(version), version);
    }
  });

  it("rewrites keys and search paths", () => {
    assert.equal(rewriteVyperKey("src/A.vy"), "src/A.vy");
    assert.equal(rewriteVyperKey(" 0/x/site-packages/p/a.vy"), "p/a.vy");
    assert.equal(rewriteVyperKey("./0/x/site-packages/p/a.vy"), "p/a.vy");
    assert.equal(rewriteVyperKey("0\\x\\site-packages\\p\\a.vy"), "p\\a.vy");
    assert.equal(rewriteVyperKey("0/x/site-packages/"), undefined);
    assert.equal(rewriteVyperKey("0/x/my-site-packages/p/a.vy"), undefined);
    assert.equal(rewriteVyperKey("10/x/site-packages/p/a.vy"), "p/a.vy");
    assert.equal(rewriteVyperKey("0/x/site-packages/~/a.vy"), undefined);
    assert.equal(rewriteVyperKey("0/x/site-packages/p/a.vy\nb.vy"), undefined);
    assert.equal(rewriteVyperSearchPath("lib"), "lib");
    assert.equal(rewriteVyperSearchPath(""), "");
    assert.equal(rewriteVyperSearchPath("0/x/site-packages"), ".");
    assert.equal(rewriteVyperSearchPath("0\\x\\site-packages\\"), ".");
    assert.equal(rewriteVyperSearchPath("0/x/site-packages-old"), undefined);
    assert.equal(rewriteVyperSearchPath("/abs/site-packages"), ".");
  });
});

describe("buildVerifyInput: a 7-character commit, as the PyPI wheels print it (R-IN-7, #425)", () => {
  const V040 = "0.4.0+commit.e9db8d9f";

  it("completes the real 0.4.0 compiler_version from the table, and compiles to the original", () => {
    const document = solcJson040();
    assert.equal(document.compiler_version, "v0.4.0+commit.e9db8d9");
    const built = buildVerifyInput([document]);
    assert.equal(built.compiler.version, V040);
    assert.equal(built.contractName, "src/Counter.vy:Counter");
    assert.deepEqual(built.compiler.input, fixture("vyper-0.4.0-solc-json/Counter.input.json"));
    const compiled = fixture("vyper-0.4.0-solc-json/compiled.json");
    assert.match(text(compiled, "original"), /^0x[0-9a-f]+$/);
    assert.equal(compiled.built, compiled.original);
    assertValid(built);
  });

  it("takes compilerVersion with the 8- or the 7-character commit next to it", () => {
    for (const compilerVersion of [V040, `v${V040}`, "0.4.0+commit.e9db8d9", "0.4.0"]) {
      assert.equal(buildVerifyInput([solcJson040()], { compilerVersion }).compiler.version, V040);
    }
    assertInvalid(
      [solcJson040()],
      "compilerVersion",
      "differs from the compiler version in the documents",
      { compilerVersion: "0.4.1" },
    );
  });

  it("completes a 7-character solcLongVersion of a build-info", () => {
    const document = foundry();
    document.solcLongVersion = "0.4.3+commit.bff19ea";
    assert.equal(buildVerifyInput([document], { contract: "Counter" }).compiler.version, V043);
  });

  it("throws invalid-input for a 7-character commit that is not the release's", () => {
    const document = { ...solcJson040(), compiler_version: "v0.4.0+commit.1234567" };
    const error = assertInvalid(
      [document],
      "documents",
      "hold a Vyper version whose 7-character commit is not the commit of that release",
    );
    assert.match(error.hint, /8-character commit/);
    const option = assertInvalid(
      [bare0310()],
      "compilerVersion",
      "has a 7-character commit that is not the commit of that Vyper release",
      { compilerVersion: "0.3.10+commit.1234567" },
    );
    assert.match(option.hint, /0\.4\.0\+commit\.e9db8d9f/);
  });

  it("throws incomplete-input on compilerVersion for a 7-character commit of an unlisted version", () => {
    const document = { ...solcJson040(), compiler_version: "v0.4.4+commit.abcdef1" };
    const error = rejection([document]);
    assertCode(error, "incomplete-input", "compilerVersion");
    assert.equal(
      error.message,
      "The documents hold a Vyper version with a 7-character commit, and this version of explorer-verify lists no commit for that Vyper version.",
    );
    assert.match(error.hint, /8-character commit/);
    const given = "0.4.4+commit.abcdef12";
    assert.equal(buildVerifyInput([document], { compilerVersion: given }).compiler.version, given);
    assertInvalid(
      [document],
      "compilerVersion",
      "differs from the compiler version in the documents",
      {
        compilerVersion: "0.4.4+commit.12345678",
      },
    );
  });

  it("completes a compiler_version without a commit, as solcLongVersion", () => {
    const document = { ...solcJson(), compiler_version: "v0.4.3" };
    assert.equal(buildVerifyInput([document]).compiler.version, V043);
  });

  it("gives the short-version message for a short compilerVersion the table does not list", () => {
    const error = rejection([bare0310()], { compilerVersion: "0.4.4" });
    assertCode(error, "incomplete-input", "compilerVersion");
    assert.equal(
      error.message,
      "The compiler version passed is only the short Vyper version, and this version of explorer-verify lists no commit for that Vyper version.",
    );
    const sevenChars = rejection([bare0310()], { compilerVersion: "v0.4.4+commit.abcdef1" });
    assert.equal(
      sevenChars.message,
      "The compiler version passed is a Vyper version with a 7-character commit, and this version of explorer-verify lists no commit for that Vyper version.",
    );
    assert.equal(
      buildVerifyInput([bare0310()], { compilerVersion: "0.3.10" }).compiler.version,
      V0310,
    );
    const document = foundry();
    document.solcLongVersion = "0.4.4";
    const both = rejection([document], { contract: "Counter", compilerVersion: "0.4.4" });
    assertCode(both, "incomplete-input", "compilerVersion");
  });
});

/** A built Vyper input with a storage layout override that names an absolute path. */
function withOverrides(): VerifyInput {
  const input: VerifyInput = { ...PLACEHOLDER, ...buildVerifyInput([solcJson()]) };
  Reflect.set(input.compiler.input, "storage_layout_overrides", {
    "/home/alice/layout.json": { count: { slot: 3 } },
  });
  return input;
}

/** Asserts the storage layout refusal: one issue on the field, the builder's hint, no path. */
function assertStorageRefusal(error: unknown): true {
  assert.ok(error instanceof ExplorerVerifyError);
  const details = error.details;
  assert.equal(details.code, "invalid-input");
  assert.deepEqual(details.code === "invalid-input" ? details.issues : [], [
    { field: "compiler.input.storage_layout_overrides", message: "is not supported" },
  ]);
  assert.equal(error.hint, rejection([{ ...solcJson(), storage_layout_overrides: {} }]).hint);
  assertNotShown(error, "alice");
  return true;
}

describe("buildVerifyInput: Vyper storage layout overrides (R-IN-7)", () => {
  it("throws invalid-input on compiler.input.storage_layout_overrides, naming no path", () => {
    const document = {
      ...solcJson(),
      storage_layout_overrides: { "/home/alice/src/Counter.vy": { count: { slot: 3 } } },
    };
    const error = assertInvalid(
      [document],
      "compiler.input.storage_layout_overrides",
      "is not supported",
    );
    assert.match(error.hint, /^Storage layout overrides are not supported/);
    assertNotShown(error, "alice");
  });

  it("is refused by validateInput too, with the same message and hint", () => {
    assert.throws(() => validateInput(withOverrides()), assertStorageRefusal);
    const plain = withOverrides();
    Reflect.deleteProperty(plain.compiler.input, "storage_layout_overrides");
    assert.equal(validateInput(plain).chainId, 1);
  });

  it("is refused by verify() before any request", async () => {
    let calls = 0;
    await assert.rejects(
      verify(withOverrides(), {
        fetch: async () => {
          calls++;
          return await Promise.reject(new Error("no request expected"));
        },
      }),
      assertStorageRefusal,
    );
    assert.equal(calls, 0);
  });
});

describe("buildVerifyInput: index runs in any spelling (R-IN-7, R-SEC-1)", () => {
  const spellings = [
    ".//0/1/home/alice/a.vy",
    "a/../0/1/home/alice/a.vy",
    "./ ./0/1/home/alice/a.vy",
    "src\\..\\0\\1\\home\\alice\\a.vy",
    " 0/1/home/alice/a.vy",
  ];

  it("reads each spelling as an index run", () => {
    for (const path of spellings) {
      assert.equal(isIndexedPath(path), true, path);
      assert.equal(rewriteVyperKey(path), undefined, path);
      assert.equal(rewriteVyperSearchPath(path), undefined, path);
    }
    for (const path of ["src/0/a.vy", "0/../src/a.vy", "00/a.vy", "", "../0/a.vy", ".. /0"]) {
      assert.equal(isIndexedPath(path), false, path);
    }
    assert.equal(isIndexedPath("x/../../0/a"), false);
  });

  it("rewrites a site-packages key after a spelling that folds to an index run", () => {
    assert.equal(rewriteVyperKey("src/../0/1/home/alice/site-packages/snek/a.vy"), "snek/a.vy");
  });

  for (const path of spellings) {
    it(`refuses ${JSON.stringify(path)} in sources, interfaces, outputSelection and search_paths`, () => {
      const inSources = solcJson();
      const sources = child(inSources, "sources");
      sources[path] = sources["src/lib/owned.vy"];
      delete sources["src/lib/owned.vy"];
      inSources.sources = sources;
      assertInvalid([inSources], "compiler.input.sources", "has a local path at position 3");
      const inInterfaces = solcJson();
      inInterfaces.interfaces = { [path]: { content: "" } };
      assertInvalid([inInterfaces], "compiler.input.interfaces", "has a local path at position 1");
      const inSelection = solcJson();
      inSelection.settings = { outputSelection: { [path]: ["*"] } };
      assertInvalid(
        [inSelection],
        "compiler.input.settings.outputSelection",
        "has a local path at position 1",
      );
      const inSearch = solcJson();
      inSearch.settings = { search_paths: [".", path] };
      const error = assertInvalid(
        [inSearch],
        "compiler.input.settings.search_paths",
        "has a local path at position 2",
        { contract: "src/Counter.vy:Counter" },
      );
      assertNotShown(error, "alice");
    });
  }

  it("refuses each spelling in validateInput too", () => {
    const built = buildVerifyInput([solcJson()]);
    for (const path of spellings) {
      const input = inputOf(built);
      const sources = child(input, "sources");
      sources[path] = sources["src/lib/owned.vy"];
      const settings = { ...child(input, "settings"), search_paths: [path] };
      const error = (() => {
        try {
          validateInput({
            ...PLACEHOLDER,
            contractName: built.contractName,
            compiler: { ...built.compiler, input: { ...input, sources, settings } },
          });
        } catch (caught) {
          assert.ok(caught instanceof ExplorerVerifyError);
          return caught;
        }
        return assert.fail(`validateInput took ${path}`);
      })();
      const details = error.details;
      assert.equal(details.code, "invalid-input");
      assert.deepEqual(
        details.code === "invalid-input" ? details.issues.map((issue) => issue.field) : [],
        ["compiler.input.sources", "compiler.input.settings.search_paths"],
      );
      assertNotShown(error, "alice");
    }
  });
});

describe("buildVerifyInput: site-packages keys (R-IN-7, #425)", () => {
  it("cuts a key at its last site-packages segment", () => {
    assert.equal(
      rewriteVyperKey("0/1/home/alice/site-packages/proj/.venv/lib/site-packages/snek/a.vy"),
      "snek/a.vy",
    );
    assert.equal(rewriteVyperSearchPath("0/1/home/alice/site-packages/x/site-packages"), ".");
  });

  it("rewrites a project-local .venv key and its search path (real fixture)", () => {
    const document = fixture("vyper-0.4.3-local-venv/Vault.solc_json.json");
    assert.ok(
      Object.keys(child(document, "sources")).includes(
        ".venv/lib/python3.12/site-packages/vylib/auth/owned.vy",
      ),
    );
    assert.deepEqual(child(document, "settings").search_paths, [
      ".venv/lib/python3.12/site-packages",
      ".",
    ]);
    const built = buildVerifyInput([document]);
    assert.deepEqual(built.compiler.input, fixture("vyper-0.4.3-local-venv/Vault.input.json"));
    assert.deepEqual(Object.keys(child(inputOf(built), "sources")), [
      "vylib/auth/owned.vy",
      "src/Vault.vy",
    ]);
    assert.deepEqual(child(inputOf(built), "settings").search_paths, ["."]);
    const compiled = fixture("vyper-0.4.3-local-venv/compiled.json");
    assert.match(text(compiled, "original"), /^0x[0-9a-f]+$/);
    assert.equal(compiled.asWritten, compiled.original);
    assert.equal(compiled.rewritten, compiled.original);
    assertValid(built);
  });

  it("rewrites the uv default .venv layout of Python 3.14 too, and keeps the collision check", () => {
    assert.equal(
      rewriteVyperKey(".venv/lib/python3.14/site-packages/bbmath/auth/owned.vy"),
      "bbmath/auth/owned.vy",
    );
    assert.equal(rewriteVyperSearchPath(".venv/lib/python3.14/site-packages"), ".");
    const document = fixture("vyper-0.4.3-local-venv/Vault.solc_json.json");
    const sources = child(document, "sources");
    sources["vylib/auth/owned.vy"] = { content: "" };
    document.sources = sources;
    assertInvalid([document], "compiler.input.sources", "names one file twice at position 3");
  });
});

describe("buildVerifyInput: contract candidates name no local path (R-SEC-1)", () => {
  it("leaves out an artifact source name that is a local or indexed path", () => {
    const artifact = (sourceName: string, contractName: string): Json => ({
      ...hardhatArtifact(),
      sourceName,
      contractName,
    });
    const error = rejection(
      [
        bare0310(),
        artifact("/home/alice/V.vy", "V"),
        artifact("0/1/home/alice/W.vy", "W"),
        hardhatArtifact(),
      ],
      { compilerVersion: V0310 },
    );
    assertCode(error, "incomplete-input", "contract");
    assert.deepEqual(Reflect.get(error.details, "candidates"), ["contracts/Greeter.vy:Greeter"]);
    assert.equal(error.message, "The documents hold 3 contracts and none was chosen.");
    assertNotShown(error, "alice");
  });
});
