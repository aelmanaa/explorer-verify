// Tests for rebuilding the Standard JSON input from Solidity metadata and sources (R-IN-7, #21),
// on the fixtures in test/fixtures/build-formats/ (see the README there). Each rebuilt input was
// compiled again with solc 0.8.24 and gave the original bytecode; the README records that check.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import { buildVerifyInput, ExplorerVerifyError } from "../../src/index.ts";
import type { BuildVerifyInputOptions, ErrorCode } from "../../src/index.ts";
import { keccak256 } from "../../src/internal/keccak.ts";
import { docsUrlOf } from "../helpers/docs-url.ts";

const LONG_VERSION = "0.8.24+commit.e11b9ed9";
// A fake key. Never a real one (R-SEC-1).
const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const LIBRARY_ADDRESS = "0x5a0b54d5dc17e0aadc383d2db43b0a0d3e029c4c";
const FIXTURES = new URL("../fixtures/build-formats/", import.meta.url);
const OUTPUT_SELECTION = {
  "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] },
};

function text(path: string): string {
  return readFileSync(new URL(path, FIXTURES), "utf8");
}

/** A fresh parse of one fixture file, so a test may change it. */
function fixture(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text(path));
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return { ...parsed };
}

/** A field of a fixture object that must itself be an object, copied. */
function objectAt(value: unknown, ...path: string[]): Record<string, unknown> {
  let current = value;
  for (const key of path) {
    assert.ok(typeof current === "object" && current !== null && !Array.isArray(current));
    current = Object.getOwnPropertyDescriptor(current, key)?.value;
  }
  assert.ok(typeof current === "object" && current !== null && !Array.isArray(current));
  return { ...current };
}

/** A string field of a fixture object. */
function stringAt(value: unknown, ...path: string[]): string {
  const last = path.at(-1) ?? "";
  const holder = objectAt(value, ...path.slice(0, -1));
  const field = holder[last];
  assert.equal(typeof field, "string");
  return String(field);
}

const BASE = text("sources/Base.sol");
const GREETER = text("sources/Greeter.sol");
const COUNTER = text("solc-0.8.24-library/src/Counter.sol");
const TALLY = text("solc-0.8.24-library/src/Tally.sol");
const FOUNDRY_SOURCES = { "src/Base.sol": BASE, "src/Greeter.sol": GREETER };
const HARDHAT_SOURCES = { "contracts/Base.sol": BASE, "contracts/Greeter.sol": GREETER };
const LIBRARY_SOURCES = { "src/Counter.sol": COUNTER, "src/Tally.sol": TALLY };

const foundryArtifact = (): Record<string, unknown> => fixture("foundry-1.8.1/Greeter.json");
const literalArtifact = (): Record<string, unknown> =>
  fixture("foundry-1.8.1-literal-viair/Greeter.json");
const libraryArtifact = (): Record<string, unknown> => fixture("solc-0.8.24-library/Counter.json");
/** The metadata string of Greeter in the Hardhat 2 build-info output. */
const hardhat2Metadata = (): string =>
  stringAt(
    fixture("hardhat-2.29.1/build-info.json"),
    "output",
    "contracts",
    "contracts/Greeter.sol",
    "Greeter",
    "metadata",
  );
/** The parsed metadata of an artifact's rawMetadata or metadata string. */
function parsedMetadata(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  return objectAt(parsed);
}

/** Asserts that `value` appears in none of the places an error can be printed from. */
function assertNotShown(error: ExplorerVerifyError, value: string): void {
  for (const place of [
    error.message,
    error.hint,
    JSON.stringify(error),
    JSON.stringify(error.details),
    inspect(error, { depth: Infinity }),
  ]) {
    assert.ok(!place.includes(value), `shown in: ${place.slice(0, 120)}`);
  }
}

/** The error `buildVerifyInput` throws, with its code checked. */
function rejection(
  documents: readonly unknown[],
  code: ErrorCode,
  options?: BuildVerifyInputOptions,
): ExplorerVerifyError {
  try {
    buildVerifyInput(documents, options);
  } catch (error) {
    assert.ok(error instanceof ExplorerVerifyError, "not an ExplorerVerifyError");
    assert.equal(error.code, code, error.message);
    assert.equal(error.retryable, false);
    return error;
  }
  return assert.fail("buildVerifyInput did not throw");
}

/** The field of an invalid-input error with one issue. */
function invalidField(error: ExplorerVerifyError): string {
  assert.ok(error.details.code === "invalid-input");
  assert.equal(error.details.issues.length, 1);
  return error.details.issues[0]?.field ?? "";
}

/** The rebuilt Standard JSON for the Greeter fixtures, Foundry layout, from plain metadata. */
function foundryInput(): Record<string, unknown> {
  return {
    language: "Solidity",
    sources: { "src/Base.sol": { content: BASE }, "src/Greeter.sol": { content: GREETER } },
    settings: {
      remappings: [],
      optimizer: { enabled: true, runs: 200 },
      metadata: { bytecodeHash: "ipfs" },
      evmVersion: "cancun",
      libraries: {},
      outputSelection: OUTPUT_SELECTION,
    },
  };
}

// --- one test per input form ------------------------------------------------------------------

describe("buildVerifyInput: Solidity metadata plus sources (R-IN-7)", () => {
  it("rebuilds from a metadata object plus sources", () => {
    const metadata = objectAt(foundryArtifact(), "metadata");
    const built = buildVerifyInput([metadata], { sources: FOUNDRY_SOURCES });
    assert.deepEqual(built, {
      compiler: { kind: "solc", version: LONG_VERSION, input: foundryInput() },
      contractName: "src/Greeter.sol:Greeter",
    });
    assert.deepEqual(Object.keys(built.compiler.input), ["language", "sources", "settings"]);
  });

  it("rebuilds from a rawMetadata string plus sources, alone or in its artifact", () => {
    const raw = stringAt(foundryArtifact(), "rawMetadata");
    const expected = {
      compiler: { kind: "solc", version: LONG_VERSION, input: foundryInput() },
      contractName: "src/Greeter.sol:Greeter",
    };
    assert.deepEqual(buildVerifyInput([raw], { sources: FOUNDRY_SOURCES }), expected);
    assert.deepEqual(buildVerifyInput([foundryArtifact()], { sources: FOUNDRY_SOURCES }), expected);
  });

  it("rebuilds from metadata with literal content and viaIR, with no sources passed", () => {
    const built = buildVerifyInput([literalArtifact()]);
    assert.deepEqual(built, {
      compiler: {
        kind: "solc",
        version: LONG_VERSION,
        input: {
          language: "Solidity",
          sources: { "src/Base.sol": { content: BASE }, "src/Greeter.sol": { content: GREETER } },
          settings: {
            evmVersion: "cancun",
            libraries: {},
            metadata: { bytecodeHash: "ipfs", useLiteralContent: true },
            optimizer: { enabled: true, runs: 200 },
            remappings: [],
            viaIR: true,
            outputSelection: OUTPUT_SELECTION,
          },
        },
      },
      contractName: "src/Greeter.sol:Greeter",
    });
  });

  it("rebuilds from a Hardhat 2 build-info output metadata string plus sources", () => {
    const built = buildVerifyInput([hardhat2Metadata()], { sources: HARDHAT_SOURCES });
    assert.deepEqual(built, {
      compiler: {
        kind: "solc",
        version: LONG_VERSION,
        input: {
          language: "Solidity",
          sources: {
            "contracts/Base.sol": { content: BASE },
            "contracts/Greeter.sol": { content: GREETER },
          },
          settings: {
            evmVersion: "paris",
            libraries: {},
            metadata: { bytecodeHash: "ipfs" },
            optimizer: { enabled: true, runs: 200 },
            remappings: [],
            outputSelection: OUTPUT_SELECTION,
          },
        },
      },
      contractName: "contracts/Greeter.sol:Greeter",
    });
  });

  it("rebuilds a contract that links an external library, libraries as { path: { Name } }", () => {
    const built = buildVerifyInput([stringAt(libraryArtifact(), "metadata")], {
      sources: LIBRARY_SOURCES,
    });
    assert.deepEqual(built, {
      compiler: {
        kind: "solc",
        version: LONG_VERSION,
        input: {
          language: "Solidity",
          sources: { "src/Counter.sol": { content: COUNTER }, "src/Tally.sol": { content: TALLY } },
          settings: {
            evmVersion: "shanghai",
            libraries: { "src/Tally.sol": { Tally: LIBRARY_ADDRESS } },
            metadata: { bytecodeHash: "ipfs" },
            optimizer: { enabled: false, runs: 200 },
            remappings: [],
            outputSelection: OUTPUT_SELECTION,
          },
        },
      },
      contractName: "src/Counter.sol:Counter",
    });
  });
});

// --- the rebuilt input is the build's input ---------------------------------------------------

/**
 * Settings with solc's defaults filled in for the fields that metadata leaves out or that a tool
 * writes explicitly, `outputSelection` removed, and library addresses in lower case (solc writes
 * them so in the metadata). Defaults: the Standard JSON input description,
 * https://docs.soliditylang.org/en/v0.8.24/using-the-compiler.html#input-description.
 */
function normalise(settings: unknown): Record<string, unknown> {
  const { outputSelection: _selection, ...rest } = objectAt(settings);
  const metadata = rest.metadata === undefined ? {} : objectAt(rest.metadata);
  const libraries = Object.fromEntries(
    Object.entries(rest.libraries === undefined ? {} : objectAt(rest.libraries)).map(
      ([path, byName]) => [
        path,
        Object.fromEntries(
          Object.entries(objectAt(byName)).map(([name, address]) => [
            name,
            String(address).toLowerCase(),
          ]),
        ),
      ],
    ),
  );
  return {
    remappings: [],
    viaIR: false,
    ...rest,
    libraries,
    metadata: { useLiteralContent: false, appendCBOR: true, bytecodeHash: "ipfs", ...metadata },
  };
}

describe("buildVerifyInput: the rebuilt input equals the build's own input (R-IN-7)", () => {
  const cases: [string, () => unknown, BuildVerifyInputOptions, () => Record<string, unknown>][] = [
    [
      "Foundry",
      foundryArtifact,
      { sources: FOUNDRY_SOURCES },
      () => objectAt(fixture("foundry-1.8.1/build-info.json"), "input"),
    ],
    [
      "Foundry with literal content and viaIR",
      literalArtifact,
      {},
      () => objectAt(fixture("foundry-1.8.1-literal-viair/build-info.json"), "input"),
    ],
    [
      "Hardhat 2",
      hardhat2Metadata,
      { sources: HARDHAT_SOURCES },
      () => objectAt(fixture("hardhat-2.29.1/build-info.json"), "input"),
    ],
    [
      "solc with a linked library",
      () => stringAt(libraryArtifact(), "metadata"),
      { sources: LIBRARY_SOURCES },
      () => fixture("solc-0.8.24-library/input.json"),
    ],
  ];
  for (const [name, document, options, original] of cases) {
    it(`gives the same sources and settings as the ${name} build, outputSelection aside`, () => {
      const rebuilt = buildVerifyInput([document()], options).compiler.input;
      const input = original();
      assert.deepEqual(rebuilt.sources, input.sources);
      assert.equal(rebuilt.language, input.language);
      assert.deepEqual(normalise(rebuilt.settings), normalise(input.settings));
    });
  }
});

/** varint encoding, as protobuf uses it. */
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return bytes;
}

/**
 * The SHA-256 digest inside the IPFS hash solc computes for a small file: a dag-pb node holding a
 * UnixFS file (type 2) with the content and its size.
 */
function ipfsDigest(content: string): string {
  const bytes = [...Buffer.from(content, "utf8")];
  const size = varint(bytes.length);
  const unixfs = [0x08, 0x02, 0x12, ...size, ...bytes, 0x18, ...size];
  const node = Buffer.from([0x0a, ...varint(unixfs.length), ...unixfs]);
  return createHash("sha256").update(node).digest("hex");
}

/** The SHA-256 digest of the metadata IPFS hash in the CBOR at the end of runtime bytecode. */
function bytecodeDigest(bytecode: string): string {
  // a2 64 "ipfs" 58 22, then the multihash prefix 12 20 (SHA-256, 32 bytes).
  const marker = "a2646970667358221220";
  const at = bytecode.lastIndexOf(marker);
  assert.ok(at > 0, "no IPFS metadata hash in the bytecode");
  return bytecode.slice(at + marker.length, at + marker.length + 64);
}

describe("build-format fixtures: the metadata is the one the bytecode commits to (R-IN-7)", () => {
  const cases: [string, () => string, () => string][] = [
    [
      "Foundry",
      () => stringAt(foundryArtifact(), "rawMetadata"),
      () => stringAt(foundryArtifact(), "deployedBytecode", "object"),
    ],
    [
      "Foundry with literal content and viaIR",
      () => stringAt(literalArtifact(), "rawMetadata"),
      () => stringAt(literalArtifact(), "deployedBytecode", "object"),
    ],
    [
      "Hardhat 2",
      hardhat2Metadata,
      () => stringAt(fixture("hardhat-2.29.1/Greeter.json"), "deployedBytecode"),
    ],
    [
      "solc with a linked library",
      () => stringAt(libraryArtifact(), "metadata"),
      () => stringAt(libraryArtifact(), "deployedBytecode"),
    ],
  ];
  for (const [name, metadata, bytecode] of cases) {
    it(`${name}: the IPFS hash in the runtime bytecode is the hash of the metadata`, () => {
      assert.equal(bytecodeDigest(bytecode()), ipfsDigest(metadata()));
    });
  }

  it("each metadata records the keccak-256 of the fixture source files", () => {
    const encoder = new TextEncoder();
    const recorded: [string, Record<string, string>][] = [
      [stringAt(foundryArtifact(), "rawMetadata"), FOUNDRY_SOURCES],
      [hardhat2Metadata(), HARDHAT_SOURCES],
      [stringAt(libraryArtifact(), "metadata"), LIBRARY_SOURCES],
    ];
    for (const [raw, sources] of recorded) {
      const listed = objectAt(parsedMetadata(raw), "sources");
      assert.deepEqual(Object.keys(listed).toSorted(), Object.keys(sources).toSorted());
      for (const [path, content] of Object.entries(sources)) {
        assert.equal(stringAt(listed, path, "keccak256"), keccak256(encoder.encode(content)), path);
      }
    }
  });
});

// --- failures -----------------------------------------------------------------------------------

/** Synthetic metadata with `count` sources, none embedded, for limits and paths. */
function syntheticMetadata(paths: readonly string[]): Record<string, unknown> {
  return {
    compiler: { version: LONG_VERSION },
    language: "Solidity",
    settings: { compilationTarget: { [paths[0] ?? "A.sol"]: "A" }, optimizer: { enabled: false } },
    sources: Object.fromEntries(
      paths.map((path) => [path, { keccak256: keccak256(new TextEncoder().encode(path)) }]),
    ),
    version: 1,
  };
}

describe("buildVerifyInput: Solidity metadata failures (R-IN-7, R-DX-3)", () => {
  it("lists every missing source path with incomplete-input on sources", () => {
    const one = rejection([foundryArtifact()], "incomplete-input", {
      sources: { "src/Greeter.sol": GREETER },
    });
    assert.deepEqual(one.details, {
      code: "incomplete-input",
      field: "sources",
      candidates: ["src/Base.sol"],
    });
    assert.match(one.hint, /options\.sources/);
    assert.match(one.message, /lack 1 of the source files/);
    // The path is in details.candidates only, not in the message or the hint.
    assert.ok(!`${one.message} ${one.hint}`.includes("src/Base.sol"));
    // More than the 20 contract candidates: sources are never cut.
    const paths = Array.from(
      { length: 25 },
      (_, index) => `src/F${String(index).padStart(2, "0")}.sol`,
    );
    const many = rejection([syntheticMetadata(paths)], "incomplete-input");
    assert.ok(many.details.code === "incomplete-input");
    assert.deepEqual(many.details.candidates, paths);
  });

  it("fails on one changed byte in one source with source-mismatch naming that file", () => {
    const changed = GREETER.replace("greeting = greeting_", "greeting = greeting_ ");
    assert.equal(changed.length, GREETER.length + 1);
    const error = rejection([foundryArtifact()], "source-mismatch", {
      sources: { "src/Base.sol": BASE, "src/Greeter.sol": changed },
    });
    assert.deepEqual(error.details, {
      code: "source-mismatch",
      path: "src/Greeter.sol",
      expected: "0xa130d93deff246f7f1d3cf1b421dc9df82f2e51fa215f64787ca22c634339d8d",
      actual: keccak256(new TextEncoder().encode(changed)),
    });
    assert.equal(error.toJSON().code, "source-mismatch");
    assert.equal(error.docsUrl, docsUrlOf("source-mismatch"));
  });

  it("fails on a source with Windows line endings with source-mismatch", () => {
    const error = rejection([hardhat2Metadata()], "source-mismatch", {
      sources: { ...HARDHAT_SOURCES, "contracts/Base.sol": BASE.replaceAll("\n", "\r\n") },
    });
    assert.ok(error.details.code === "source-mismatch");
    assert.equal(error.details.path, "contracts/Base.sol");
  });

  it("checks embedded content too: changed literal content fails with source-mismatch", () => {
    const artifact = literalArtifact();
    const metadata = parsedMetadata(stringAt(artifact, "rawMetadata"));
    const sources = objectAt(metadata, "sources");
    sources["src/Base.sol"] = { ...objectAt(sources, "src/Base.sol"), content: `${BASE}// x\n` };
    metadata.sources = sources;
    const error = rejection([metadata], "source-mismatch");
    assert.ok(error.details.code === "source-mismatch");
    assert.equal(error.details.path, "src/Base.sol");
  });

  it("reports an expected hash of another form as empty, never repeating it", () => {
    const metadata = parsedMetadata(stringAt(libraryArtifact(), "metadata"));
    const sources = objectAt(metadata, "sources");
    sources["src/Tally.sol"] = { keccak256: `0x${DUMMY_KEY}` };
    metadata.sources = sources;
    const error = rejection([metadata], "source-mismatch", { sources: LIBRARY_SOURCES });
    assert.ok(error.details.code === "source-mismatch");
    assert.equal(error.details.expected, "");
    assertNotShown(error, DUMMY_KEY);
  });

  it("accepts a hash written in upper case", () => {
    const metadata = parsedMetadata(stringAt(libraryArtifact(), "metadata"));
    const sources = objectAt(metadata, "sources");
    const tally = objectAt(sources, "src/Tally.sol");
    sources["src/Tally.sol"] = {
      ...tally,
      keccak256: `0x${String(tally.keccak256).slice(2).toUpperCase()}`,
    };
    metadata.sources = sources;
    const built = buildVerifyInput([metadata], { sources: LIBRARY_SOURCES });
    assert.equal(built.contractName, "src/Counter.sol:Counter");
  });

  it("fails on two compilationTarget entries, and on none, with invalid-input", () => {
    for (const target of [
      { "src/Greeter.sol": "Greeter", "src/Base.sol": "Base" },
      {},
      { "src/Greeter.sol": 7 },
    ]) {
      const metadata = parsedMetadata(stringAt(foundryArtifact(), "rawMetadata"));
      metadata.settings = { ...objectAt(metadata, "settings"), compilationTarget: target };
      const error = rejection([metadata], "invalid-input", { sources: FOUNDRY_SOURCES });
      assert.equal(invalidField(error), "metadata.settings.compilationTarget");
      assert.match(error.hint, /exactly one contract/);
    }
  });

  it("fails on libraries that are not an object", () => {
    for (const libraries of [[LIBRARY_ADDRESS], null]) {
      const metadata = parsedMetadata(stringAt(libraryArtifact(), "metadata"));
      metadata.settings = { ...objectAt(metadata, "settings"), libraries };
      const error = rejection([metadata], "invalid-input", { sources: LIBRARY_SOURCES });
      assert.equal(invalidField(error), "metadata.settings.libraries");
    }
  });

  it("groups several libraries of one file under that file's path", () => {
    const metadata = parsedMetadata(stringAt(libraryArtifact(), "metadata"));
    const other = "0x00000000000000000000000000000000000000aa";
    metadata.settings = {
      ...objectAt(metadata, "settings"),
      libraries: {
        "src/Tally.sol:Tally": LIBRARY_ADDRESS,
        "src/Tally.sol:Other": other,
        "lib/x:y/Z.sol:Z": other,
      },
    };
    const built = buildVerifyInput([metadata], { sources: LIBRARY_SOURCES });
    assert.deepEqual(objectAt(built.compiler.input, "settings", "libraries"), {
      "src/Tally.sol": { Tally: LIBRARY_ADDRESS, Other: other },
      "lib/x:y/Z.sol": { Z: other },
    });
  });

  it("rejects a local source path before it lists the missing sources, without repeating it", () => {
    const local = "/home/builder/project/src/A.sol";
    const error = rejection([syntheticMetadata(["src/B.sol", local])], "invalid-input");
    assert.equal(invalidField(error), "compiler.input.sources");
    assert.match(JSON.stringify(error.details), /position 2/);
    assertNotShown(error, "/home/builder");
  });

  it("rejects a local path in a converted libraries key", () => {
    const metadata = parsedMetadata(stringAt(libraryArtifact(), "metadata"));
    metadata.settings = {
      ...objectAt(metadata, "settings"),
      libraries: { "/home/builder/src/Tally.sol:Tally": LIBRARY_ADDRESS },
    };
    const error = rejection([metadata], "invalid-input", { sources: LIBRARY_SOURCES });
    assert.equal(invalidField(error), "compiler.input.settings.libraries");
    assertNotShown(error, "/home/builder");
  });

  it("fails on options.sources that is not an object of strings", () => {
    for (const sources of [[GREETER], "src/Greeter.sol", { "src/Greeter.sol": 1 }]) {
      // Code that bypasses the types: set through Reflect, so no cast is needed.
      const options: BuildVerifyInputOptions = {};
      Reflect.set(options, "sources", sources);
      const error = rejection([foundryArtifact()], "invalid-input", options);
      assert.equal(invalidField(error), "sources");
    }
  });

  it("treats metadata without a keccak256 for every source as incomplete-input on input", () => {
    const metadata = parsedMetadata(stringAt(foundryArtifact(), "rawMetadata"));
    const sources = objectAt(metadata, "sources");
    sources["src/Base.sol"] = { urls: [] };
    metadata.sources = sources;
    const error = rejection([metadata], "incomplete-input", { sources: FOUNDRY_SOURCES });
    assert.ok(error.details.code === "incomplete-input");
    assert.equal(error.details.field, "input");
    assert.match(error.hint, /keccak256/);
  });

  it("fails on metadata of another language with unsupported-compiler", () => {
    const metadata = syntheticMetadata(["src/A.vy"]);
    metadata.language = "Vyper";
    const error = rejection([metadata], "unsupported-compiler", {
      sources: { "src/A.vy": "src/A.vy" },
    });
    assert.ok(error.details.code === "unsupported-compiler");
    assert.equal(error.details.field, "language");
  });

  it("classifies a string that is not metadata as no known shape", () => {
    for (const document of [
      "not json",
      '{"abi":[]}',
      JSON.stringify({ input: {}, compiler: {} }),
    ]) {
      const error = rejection([document], "invalid-input");
      assert.equal(invalidField(error), "documents");
    }
  });
});

// --- choosing among several documents --------------------------------------------------------

describe("buildVerifyInput: several metadata documents (R-IN-7)", () => {
  it("needs options.contract when metadata of two contracts is passed", () => {
    const documents = [foundryArtifact(), stringAt(libraryArtifact(), "metadata")];
    const error = rejection(documents, "incomplete-input", {
      sources: { ...FOUNDRY_SOURCES, ...LIBRARY_SOURCES },
    });
    assert.deepEqual(error.details, {
      code: "incomplete-input",
      field: "contract",
      candidates: ["src/Counter.sol:Counter", "src/Greeter.sol:Greeter"],
    });
    assert.match(error.message, /Solidity metadata of 2 contracts/);
  });

  it("picks the metadata options.contract names, as path:Name or as a bare name", () => {
    const documents = [foundryArtifact(), stringAt(libraryArtifact(), "metadata")];
    const sources = { ...FOUNDRY_SOURCES, ...LIBRARY_SOURCES };
    for (const contract of ["src/Counter.sol:Counter", "Counter"]) {
      const built = buildVerifyInput(documents, { contract, sources });
      assert.equal(built.contractName, "src/Counter.sol:Counter");
      assert.deepEqual(Object.keys(built.compiler.input.sources), [
        "src/Counter.sol",
        "src/Tally.sol",
      ]);
    }
    const none = rejection(documents, "invalid-input", { contract: "Missing", sources });
    assert.equal(invalidField(none), "contract");
  });

  it("accepts the same metadata twice in different forms, in any order", () => {
    const artifact = foundryArtifact();
    const object = objectAt(artifact, "metadata");
    const expected = buildVerifyInput([artifact], { sources: FOUNDRY_SOURCES });
    assert.deepEqual(buildVerifyInput([artifact, object], { sources: FOUNDRY_SOURCES }), expected);
    assert.deepEqual(buildVerifyInput([object, artifact], { sources: FOUNDRY_SOURCES }), expected);
  });

  it("fails when two metadata documents for one contract rebuild to different inputs", () => {
    const changed = parsedMetadata(stringAt(foundryArtifact(), "rawMetadata"));
    changed.settings = {
      ...objectAt(changed, "settings"),
      optimizer: { enabled: true, runs: 999 },
    };
    const error = rejection([foundryArtifact(), changed], "invalid-input", {
      sources: FOUNDRY_SOURCES,
    });
    assert.equal(invalidField(error), "documents");
    assert.match(JSON.stringify(error.details), /different Solidity metadata/);
  });

  it("reads an artifact's rawMetadata string before its metadata object", () => {
    const artifact = foundryArtifact();
    const object = objectAt(artifact, "metadata");
    artifact.metadata = { ...object, settings: { ...objectAt(object, "settings"), viaIR: true } };
    const built = buildVerifyInput([artifact], { sources: FOUNDRY_SOURCES });
    assert.deepEqual(built.compiler.input, foundryInput());
  });

  it("rebuilds from a Foundry artifact next to a build-info stub when the sources are passed", () => {
    const built = buildVerifyInput(
      [fixture("foundry-1.8.1/build-info-stub.json"), foundryArtifact()],
      {
        sources: FOUNDRY_SOURCES,
      },
    );
    assert.equal(built.contractName, "src/Greeter.sol:Greeter");
    assert.deepEqual(built.compiler.input, foundryInput());
  });

  it("uses a build-info input over metadata, and ignores options.sources then", () => {
    const buildInfo = fixture("foundry-1.8.1/build-info.json");
    const built = buildVerifyInput([buildInfo, foundryArtifact()], {
      sources: { "src/Greeter.sol": "not the source" },
    });
    const input = objectAt(buildInfo, "input");
    assert.deepEqual(built.compiler.input.sources, input.sources);
  });

  it("returns a copy that shares no object with the metadata", () => {
    const metadata = parsedMetadata(stringAt(libraryArtifact(), "metadata"));
    const built = buildVerifyInput([metadata], { sources: LIBRARY_SOURCES });
    const settings = objectAt(built.compiler.input, "settings");
    assert.notEqual(settings.optimizer, objectAt(metadata, "settings").optimizer);
    assert.deepEqual(settings.optimizer, objectAt(metadata, "settings", "optimizer"));
  });
});

// --- older and edge-case solc output ------------------------------------------------------------

/** One fixture of `solc-legacy/`: the metadata string, the sources and the original bytecode. */
function legacy(file: string): { metadata: string; sources: Record<string, string> } {
  const record = fixture(`solc-legacy/${file}`);
  const sources = objectAt(record, "sources");
  return {
    metadata: stringAt(record, "metadata"),
    sources: Object.fromEntries(
      Object.entries(sources).map(([path, content]) => [path, String(content)]),
    ),
  };
}

const LEGACY_SOURCES = {
  "src/Counter.sol": { content: legacy("solc-0.8.24-no-cbor.json").sources["src/Counter.sol"] },
  "src/Tally.sol": { content: legacy("solc-0.8.24-no-cbor.json").sources["src/Tally.sol"] },
};
const LEGACY_LIBRARIES = { "src/Tally.sol": { Tally: LIBRARY_ADDRESS } };

describe("buildVerifyInput: metadata from older and edge-case solc output (R-IN-7)", () => {
  // Each rebuilt input below was compiled again with the solc version that wrote the metadata;
  // the bytecode and the metadata equaled the original's (fixtures README, 2026-11-03).
  it("solc 0.8.24 with appendCBOR false: drops the bytecodeHash solc records but rejects", () => {
    const { metadata, sources } = legacy("solc-0.8.24-no-cbor.json");
    assert.equal(objectAt(parsedMetadata(metadata), "settings", "metadata").bytecodeHash, "ipfs");
    const built = buildVerifyInput([metadata], { sources });
    assert.equal(built.compiler.version, LONG_VERSION);
    assert.deepEqual(built.compiler.input, {
      language: "Solidity",
      sources: LEGACY_SOURCES,
      settings: {
        evmVersion: "paris",
        libraries: LEGACY_LIBRARIES,
        metadata: { appendCBOR: false },
        optimizer: { enabled: true, runs: 200 },
        remappings: [],
        outputSelection: OUTPUT_SELECTION,
      },
    });
  });

  it("solc 0.8.3: turns optimizer.details.inliner into optimizer.enabled", () => {
    const { metadata, sources } = legacy("solc-0.8.3-inliner.json");
    const built = buildVerifyInput([metadata], { sources });
    assert.equal(built.compiler.version, "0.8.3+commit.8d00100c");
    assert.deepEqual(objectAt(built.compiler.input, "settings", "optimizer"), {
      details: {
        constantOptimizer: true,
        cse: true,
        deduplicate: true,
        jumpdestRemover: true,
        orderLiterals: true,
        peephole: true,
        yul: false,
      },
      runs: 200,
      enabled: true,
    });
    assert.deepEqual(built.compiler.input.sources, LEGACY_SOURCES);
  });

  it("keeps optimizer.details.inliner for solc 0.8.5 and later, which accept it", () => {
    const { metadata, sources } = legacy("solc-0.8.3-inliner.json");
    const parsed = parsedMetadata(metadata);
    for (const version of [
      "0.8.5+commit.a4f2e591",
      "0.8.24+commit.e11b9ed9",
      "0.8.30+commit.73712a01",
    ]) {
      parsed.compiler = { version };
      const built = buildVerifyInput([parsed], { sources });
      assert.deepEqual(
        objectAt(built.compiler.input, "settings", "optimizer"),
        objectAt(parsed, "settings", "optimizer"),
        version,
      );
    }
  });

  it("solc 0.7.0: puts a library keyed by bare name under the empty path", () => {
    const { metadata, sources } = legacy("solc-0.7.0-bare-library.json");
    const built = buildVerifyInput([metadata], { sources });
    assert.equal(built.compiler.version, "0.7.0+commit.9e61f92b");
    assert.deepEqual(built.compiler.input, {
      language: "Solidity",
      sources: LEGACY_SOURCES,
      settings: {
        evmVersion: "istanbul",
        libraries: { "": { Tally: LIBRARY_ADDRESS } },
        metadata: { bytecodeHash: "ipfs" },
        optimizer: { enabled: false, runs: 200 },
        remappings: [],
        outputSelection: OUTPUT_SELECTION,
      },
    });
  });

  it("solc 0.5.0: sets useLiteralContent when the metadata embeds content without the flag", () => {
    const { metadata } = legacy("solc-0.5.0-literal.json");
    assert.equal(objectAt(parsedMetadata(metadata), "settings").metadata, undefined);
    const built = buildVerifyInput([metadata]);
    assert.equal(built.compiler.version, "0.5.0+commit.1d4f565a");
    assert.deepEqual(built.compiler.input, {
      language: "Solidity",
      sources: LEGACY_SOURCES,
      settings: {
        evmVersion: "byzantium",
        libraries: { "": { Tally: LIBRARY_ADDRESS } },
        optimizer: { enabled: false, runs: 200 },
        remappings: [],
        metadata: { useLiteralContent: true },
        outputSelection: OUTPUT_SELECTION,
      },
    });
  });

  it("keeps a metadata setting that is not an object for validateInput to judge", () => {
    const metadata = parsedMetadata(stringAt(libraryArtifact(), "metadata"));
    metadata.settings = { ...objectAt(metadata, "settings"), metadata: "ipfs" };
    const built = buildVerifyInput([metadata], { sources: LIBRARY_SOURCES });
    assert.equal(objectAt(built.compiler.input, "settings").metadata, "ipfs");
  });
});

// --- review findings: shape, choice and order ---------------------------------------------------

describe("buildVerifyInput: metadata shape, choice of contract and document order (R-IN-7)", () => {
  for (const field of ["language", "compilationTarget", "sources"]) {
    it(`treats metadata without ${field} as not rebuildable, with the keccak256 hint`, () => {
      const metadata = parsedMetadata(stringAt(foundryArtifact(), "rawMetadata"));
      if (field === "compilationTarget") {
        const { compilationTarget: _target, ...settings } = objectAt(metadata, "settings");
        metadata.settings = settings;
      } else {
        delete metadata[field];
      }
      const error = rejection([metadata], "incomplete-input", { sources: FOUNDRY_SOURCES });
      assert.ok(error.details.code === "incomplete-input");
      assert.equal(error.details.field, "input");
      assert.match(error.hint, /keccak256/);
    });
  }

  it("keeps the metadata hint for a metadata string that cannot be rebuilt", () => {
    const metadata = parsedMetadata(stringAt(foundryArtifact(), "rawMetadata"));
    const sources = objectAt(metadata, "sources");
    sources["src/Base.sol"] = { urls: [] };
    metadata.sources = sources;
    const error = rejection([JSON.stringify(metadata)], "incomplete-input");
    assert.match(error.hint, /keccak256/);
  });

  it("never rebuilds from the metadata inside a build-info output", () => {
    const output = fixture("hardhat-3.21.2/build-info.output.json");
    const error = rejection([output], "incomplete-input", {
      contract: "Greeter",
      sources: HARDHAT_SOURCES,
    });
    assert.ok(error.details.code === "incomplete-input");
    assert.equal(error.details.field, "input");
  });

  it("uses embedded content over a differing options.sources entry", () => {
    const built = buildVerifyInput([literalArtifact()], {
      sources: { "src/Base.sol": "not the source", "src/Greeter.sol": "not the source" },
    });
    assert.deepEqual(built.compiler.input.sources, {
      "src/Base.sol": { content: BASE },
      "src/Greeter.sol": { content: GREETER },
    });
  });

  it("reads a pretty-printed metadata string", () => {
    const pretty = JSON.stringify(
      parsedMetadata(stringAt(foundryArtifact(), "rawMetadata")),
      null,
      2,
    );
    const built = buildVerifyInput([pretty], { sources: FOUNDRY_SOURCES });
    assert.deepEqual(built.compiler.input, foundryInput());
  });

  it("requires options.contract to name the metadata's own target", () => {
    for (const contract of ["src/Base.sol:Base", "Base", "src/Other.sol:Greeter"]) {
      const error = rejection([foundryArtifact()], "invalid-input", {
        contract,
        sources: FOUNDRY_SOURCES,
      });
      assert.equal(invalidField(error), "contract");
    }
    for (const contract of ["src/Greeter.sol:Greeter", "Greeter"]) {
      const built = buildVerifyInput([foundryArtifact()], { contract, sources: FOUNDRY_SOURCES });
      assert.equal(built.contractName, "src/Greeter.sol:Greeter");
    }
  });

  it("matches a bare name against whole contract names: Greeter is not XGreeter", () => {
    const metadata = parsedMetadata(stringAt(foundryArtifact(), "rawMetadata"));
    metadata.settings = {
      ...objectAt(metadata, "settings"),
      compilationTarget: { "src/Greeter.sol": "XGreeter" },
    };
    const error = rejection([metadata], "invalid-input", {
      contract: "Greeter",
      sources: FOUNDRY_SOURCES,
    });
    assert.equal(invalidField(error), "contract");
  });

  it("fails on two metadata documents for one contract with different source hashes, in both orders", () => {
    const original = parsedMetadata(stringAt(foundryArtifact(), "rawMetadata"));
    const changed = parsedMetadata(stringAt(foundryArtifact(), "rawMetadata"));
    const sources = objectAt(changed, "sources");
    sources["src/Base.sol"] = {
      ...objectAt(sources, "src/Base.sol"),
      keccak256: keccak256(new TextEncoder().encode("other")),
    };
    changed.sources = sources;
    for (const documents of [
      [original, changed],
      [changed, original],
    ]) {
      const error = rejection(documents, "invalid-input", { sources: FOUNDRY_SOURCES });
      assert.equal(invalidField(error), "documents");
      assert.match(JSON.stringify(error.details), /different builds/);
    }
  });

  it("passes on the error of a second metadata document that cannot be rebuilt", () => {
    const original = parsedMetadata(stringAt(libraryArtifact(), "metadata"));
    const broken = parsedMetadata(stringAt(libraryArtifact(), "metadata"));
    broken.settings = { ...objectAt(broken, "settings"), libraries: [] };
    const error = rejection([original, broken], "invalid-input", { sources: LIBRARY_SOURCES });
    assert.equal(invalidField(error), "metadata.settings.libraries");
  });

  it("rejects a source path with a Unicode format character, such as a bidi override (R-IN-6)", () => {
    // A right-to-left override and a zero-width space, written by code point.
    for (const path of [
      `src/${String.fromCodePoint(0x202e)}gol.sol`,
      `src/A${String.fromCodePoint(0x200b)}.sol`,
    ]) {
      const content = "contract A {}";
      const metadata = syntheticMetadata([path]);
      metadata.sources = { [path]: { keccak256: keccak256(new TextEncoder().encode(content)) } };
      const error = rejection([metadata], "invalid-input", { sources: { [path]: content } });
      assert.ok(error.details.code === "invalid-input");
      assert.ok(error.details.issues.some(({ field }) => field === "compiler.input.sources"));
    }
  });

  it("caps the missing source paths at 1000 and gives the full count in the message", () => {
    const paths = Array.from(
      { length: 1005 },
      (_, index) => `src/F${String(index).padStart(4, "0")}.sol`,
    );
    const error = rejection([syntheticMetadata(paths)], "incomplete-input");
    assert.ok(error.details.code === "incomplete-input");
    assert.equal(error.details.candidates.length, 1000);
    assert.deepEqual(error.details.candidates, paths.slice(0, 1000));
    assert.match(error.message, /lack 1005 of the source files/);
  });
});

// --- values that are not JSON data --------------------------------------------------------------

/** An object `levels` deep: `{ a: { a: ... } }`. */
function deep(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let level = 0; level < levels; level++) {
    value = { a: value };
  }
  return value;
}

/** A trap that throws an error holding the dummy key. */
function fail(): never {
  throw new Error(`trap ${DUMMY_KEY}`);
}

/** A Proxy whose every read throws an error that holds the dummy key. */
function hostile(): object {
  return new Proxy({}, { get: fail, ownKeys: fail, getOwnPropertyDescriptor: fail });
}

/** An object that holds itself. */
function cyclic(): Record<string, unknown> {
  const value: Record<string, unknown> = { enabled: true };
  value.self = value;
  return value;
}

describe("buildVerifyInput: metadata settings that are not JSON data (R-IN-7, R-SEC-1)", () => {
  const cases: [string, () => unknown][] = [
    ["nested 200 levels deep", () => deep(200)],
    ["cyclic", cyclic],
    ["a Proxy that throws", hostile],
  ];
  for (const [name, value] of cases) {
    for (const count of [1, 2]) {
      it(`gives invalid-input for an optimizer ${name}, with ${String(count)} document(s)`, () => {
        const documents = Array.from({ length: count }, () => {
          const metadata = parsedMetadata(stringAt(libraryArtifact(), "metadata"));
          metadata.settings = { ...objectAt(metadata, "settings"), optimizer: value() };
          return metadata;
        });
        const error = rejection(documents, "invalid-input", { sources: LIBRARY_SOURCES });
        assertNotShown(error, DUMMY_KEY);
        assert.doesNotMatch(error.message, /Maximum call stack/);
      });
    }
  }

  it("reads a metadata string nested 10000 levels deep without a raw RangeError", () => {
    const nested = `${'{"a":'.repeat(10_000)}{}${"}".repeat(10_000)}`;
    const error = rejection([nested], "invalid-input");
    assert.equal(invalidField(error), "documents");
  });

  it("gives invalid-input for a remappings Proxy on the build-info path, without its text", () => {
    const remappings = new Proxy([], { get: fail });
    const input = {
      language: "Solidity",
      sources: { "src/A.sol": { content: "contract A {}" } },
      settings: { remappings },
    };
    const error = rejection([input], "invalid-input", {
      contract: "src/A.sol:A",
      compilerVersion: LONG_VERSION,
    });
    assert.equal(invalidField(error), "compiler.input.settings.remappings");
    assertNotShown(error, DUMMY_KEY);
  });
});
