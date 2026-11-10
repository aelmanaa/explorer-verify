// Tests added after the first mutation run of src/input/build.ts (#202; R-IN-7): each one fails on
// a code change that the other buildVerifyInput tests let pass. The documents are small synthetic
// ones, shaped as in test/fixtures/build-formats/.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildVerifyInput, ExplorerVerifyError } from "../../src/index.ts";
import type { BuildVerifyInputOptions, BuiltVerifyInput, InputIssue } from "../../src/index.ts";
import { keccak256 } from "../../src/internal/keccak.ts";

const VERSION = "0.8.24+commit.e11b9ed9";
const PATH = "src/A.sol";
const SOURCE = "contract A {}";
const HASH = keccak256(new TextEncoder().encode(SOURCE));

const INVALID_HINT = "Fix the fields that the issues list (details.issues), then call again.";
const CONTRACT_HINT =
  "Pass the contract (options.contract) as path:Name, or as a Name that matches one of the candidates (details.candidates).";
const METADATA_ONLY_HINT =
  "Pass the build-info of the same build, or Solidity metadata with language, compiler.version, settings.compilationTarget and a keccak256 hash for each source.";
const METADATA_TARGET_HINT =
  "Pass the metadata of one contract: settings.compilationTarget must name exactly one contract.";
const OUTPUT_ONLY_HINT =
  "Pass the build-info that holds the compiler input, next to its output file or artifact.";
const STUB_HINT =
  "The build-info holds no compiler input. Rebuild with build-info enabled (forge build --build-info), then pass the new build-info file.";

/** A build-info with one source, `src/A.sol`, whose output lists `contracts`. */
function buildInfo(
  contracts: Record<string, unknown> = { [PATH]: { A: {} } },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "build-1",
    solcLongVersion: VERSION,
    input: { language: "Solidity", sources: { [PATH]: { content: SOURCE } }, settings: {} },
    output: { contracts },
    ...extra,
  };
}

/** Solidity metadata of `src/A.sol:A` with its content embedded, `settings` merged in. */
function metadata(
  settings: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    language: "Solidity",
    compiler: { version: VERSION },
    settings: { compilationTarget: { [PATH]: "A" }, ...settings },
    sources: { [PATH]: { keccak256: HASH, content: SOURCE } },
    ...extra,
  };
}

/** A bare Standard JSON input with `src/A.sol`. */
function standardJson(
  settings: unknown = {},
  source: Record<string, unknown> = { content: SOURCE },
): Record<string, unknown> {
  return { language: "Solidity", sources: { [PATH]: source }, settings };
}

/** An object `levels` levels deep: `nested(1)` is `{}`. */
function nested(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let level = 1; level < levels; level++) {
    value = { a: value };
  }
  return value;
}

/** An array `levels` levels deep: `nestedArray(1)` is `[]`. */
function nestedArray(levels: number): unknown[] {
  let value: unknown[] = [];
  for (let level = 1; level < levels; level++) {
    value = [value];
  }
  return value;
}

/** `documents` and `options` typed without a cast, as a JavaScript caller passes them. */
function loose(
  documents: unknown,
  options: unknown,
): { documents: readonly unknown[]; options?: BuildVerifyInputOptions } {
  const box: { documents: readonly unknown[]; options?: BuildVerifyInputOptions } = {
    documents: [],
  };
  Reflect.set(box, "documents", documents);
  if (options !== undefined) {
    Reflect.set(box, "options", options);
  }
  return box;
}

function rejection(documents: unknown, options?: unknown): ExplorerVerifyError {
  const box = loose(documents, options);
  try {
    buildVerifyInput(box.documents, box.options);
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError, `buildVerifyInput threw ${String(error)}`);
    return error;
  }
  return assert.fail("buildVerifyInput did not throw");
}

/** Asserts an invalid-input error with one issue, its message and its hint. */
function assertInvalid(
  documents: unknown,
  issue: InputIssue,
  options?: unknown,
  hint = INVALID_HINT,
): void {
  const error = rejection(documents, options);
  assert.deepEqual(error.details, { code: "invalid-input", issues: [issue] });
  assert.equal(error.message, `The input is invalid: ${issue.field}.`);
  assert.equal(error.hint, hint);
}

/** Asserts an incomplete-input error with its field, message, hint and candidates. */
function assertIncomplete(
  documents: unknown,
  expected: { field: string; message: string; hint: string; candidates?: string[] },
  options?: unknown,
): void {
  const error = rejection(documents, options);
  assert.deepEqual(error.details, {
    code: "incomplete-input",
    field: expected.field,
    candidates: expected.candidates ?? [],
  });
  assert.equal(error.message, expected.message);
  assert.equal(error.hint, expected.hint);
}

function built(documents: readonly unknown[], options?: BuildVerifyInputOptions): BuiltVerifyInput {
  return buildVerifyInput(documents, options);
}

describe("buildVerifyInput: messages of the argument checks (#202, R-IN-7)", () => {
  it("names every unknown option in the message, and an unnameable key as options (R-IN-6)", () => {
    const error = rejection([buildInfo()], { contracts: "A", extra: 1, "not a name": 2 });
    assert.equal(error.message, "The input is invalid: contracts, extra, options.");
    assert.equal(error.hint, "Pass only contract, compilerVersion and sources as options.");
    assert.ok(error.details.code === "invalid-input");
    assert.deepEqual(
      error.details.issues.map((issue) => issue.field),
      ["contracts", "extra", "options"],
    );
  });

  it("names what is wrong with the documents and the options", () => {
    assertInvalid("build-info", {
      field: "documents",
      message: "must be an array of parsed JSON documents",
    });
    assertInvalid([], { field: "documents", message: "must hold at least one document" });
    assertInvalid([buildInfo()], { field: "options", message: "must be an object" }, 5);
    assertInvalid(
      [buildInfo()],
      { field: "contract", message: "must be a string" },
      {
        contract: 5,
      },
    );
    assertInvalid(
      [buildInfo()],
      { field: "sources", message: "must be an object of source contents by path" },
      { sources: 5 },
    );
    assertInvalid(
      [buildInfo()],
      { field: "sources", message: "must map each path to the source content as a string" },
      { sources: { [PATH]: 5 } },
    );
  });

  it("lists up to five positions of documents of no known shape, and says when there are more", () => {
    assertInvalid([buildInfo(), 1], {
      field: "documents",
      message: "match no known shape at position 2",
    });
    assertInvalid([1, 2, 3, 4, 5], {
      field: "documents",
      message: "match no known shape at positions 1, 2, 3, 4, 5",
    });
    assertInvalid([1, 2, 3, 4, 5, 6], {
      field: "documents",
      message: "match no known shape at positions 1, 2, 3, 4, 5 and more",
    });
  });

  it("counts each document that cannot be written as JSON, even when two of them cannot", () => {
    assertInvalid([buildInfo(), { a: 1n }, { b: 2n }], {
      field: "documents",
      message: "match no known shape at positions 2, 3",
    });
  });

  it("names the compiler field of another compiler in the message, with the code's own hint", () => {
    const error = rejection([buildInfo({}, { compilerType: "vyper" })]);
    assert.deepEqual(error.details, { code: "unsupported-compiler", field: "compilerType" });
    assert.equal(
      error.message,
      "The documents come from a compiler other than solc: compilerType.",
    );
    assert.equal(
      error.hint,
      "Use Solidity compiled with solc, or zksolc through Blockscout on ZKsync Era (324) or Sepolia (300). Verify other compilers with their own tooling.",
    );
  });
});

describe("buildVerifyInput: documents without a compiler input (#202, R-IN-7)", () => {
  it("explains a build-info stub", () => {
    assertIncomplete([{ source_id_to_path: {} }], {
      field: "input",
      message: "The documents hold no compiler input: the build-info was written without it.",
      hint: STUB_HINT,
    });
  });

  it("takes metadata with a compiler or an output object for metadata, without a compilation target", () => {
    const expected = {
      field: "input",
      message: "The documents hold no compiler input: only Solidity metadata.",
      hint: METADATA_ONLY_HINT,
    };
    const shape = { language: "Solidity", sources: { [PATH]: {} }, settings: {} };
    assertIncomplete([{ ...shape, compiler: { version: VERSION } }], expected);
    assertIncomplete([{ ...shape, output: { abi: [] } }], expected);
    // An artifact whose metadata cannot be rebuilt from, without a keccak256 for its source.
    assertIncomplete(
      [{ abi: [], bytecode: "0x", metadata: { ...metadata(), sources: { [PATH]: {} } } }],
      expected,
    );
  });

  it("explains a build-info output without its build-info", () => {
    assertIncomplete([{ id: "build-1", output: { contracts: { [PATH]: { A: {} } } } }], {
      field: "input",
      message: "The documents hold no compiler input.",
      hint: OUTPUT_ONLY_HINT,
    });
  });

  it("asks for the documents of one build when an artifact names another build id", () => {
    const artifact = { abi: [], bytecode: "0x", metadata: metadata(), buildInfoId: "build-2" };
    assertInvalid([buildInfo(), artifact], {
      field: "documents",
      message: "come from different builds; pass the documents of one build",
    });
  });
});

describe("buildVerifyInput: what the documents hold (#202, R-IN-7)", () => {
  it("reads a build-info whose output lists a contract entry that is not an object", () => {
    assert.equal(built([buildInfo({ [PATH]: { A: 5 } })]).contractName, `${PATH}:A`);
  });

  it("reads a build-info without solcLongVersion, with the version from the options", () => {
    const { solcLongVersion: _, ...withoutVersion } = buildInfo();
    const result = built([withoutVersion], { compilerVersion: VERSION });
    assert.equal(result.compiler.version, VERSION);
  });

  it("reads an artifact whose metadata has no compiler version, next to a build-info", () => {
    const { compiler: _, ...withoutCompiler } = metadata();
    const result = built([buildInfo(), { abi: [], bytecode: "0x", metadata: withoutCompiler }]);
    assert.equal(result.compiler.version, VERSION);
    assert.equal(result.contractName, `${PATH}:A`);
  });

  it("ignores a compilation target whose name is not a string", () => {
    const artifact = {
      abi: [],
      bytecode: "0x",
      metadata: metadata({ compilationTarget: { [PATH]: 5 } }),
    };
    assert.equal(built([buildInfo(), artifact]).contractName, `${PATH}:A`);
  });

  it("ignores an artifact without a source name or a contract name", () => {
    for (const artifact of [
      { abi: [], bytecode: "0x", contractName: "B" },
      { abi: [], bytecode: "0x", sourceName: PATH },
    ]) {
      assert.equal(built([buildInfo(), artifact]).contractName, `${PATH}:A`);
    }
  });

  it("keeps only a keccak256 that is a string", () => {
    const result = built([standardJson({}, { content: SOURCE, keccak256: 5 })], {
      contract: `${PATH}:A`,
      compilerVersion: VERSION,
    });
    assert.deepEqual(result.compiler.input.sources, { [PATH]: { content: SOURCE } });
  });

  it("lets validateInput report settings that are not an object", () => {
    const error = rejection([standardJson(5)], { contract: `${PATH}:A`, compilerVersion: VERSION });
    assert.deepEqual(error.details, {
      code: "invalid-input",
      issues: [{ field: "compiler.input.settings", message: "must be an object" }],
    });
  });

  it("names sources that are not an object", () => {
    assertInvalid(
      [{ language: "Solidity", sources: 5, settings: {} }],
      { field: "compiler.input.sources", message: "must be an object of source files by path" },
      { contract: `${PATH}:A`, compilerVersion: VERSION },
    );
  });

  it("names remappings that cannot be read as an array", () => {
    const hostile = new Proxy([], {
      get() {
        throw new Error("trap");
      },
    });
    assertInvalid(
      [standardJson({ remappings: hostile })],
      { field: "compiler.input.settings.remappings", message: "could not be read as an array" },
      { contract: `${PATH}:A`, compilerVersion: VERSION },
    );
  });

  it("finds a local path in each part of a remapping", () => {
    const options = { contract: `${PATH}:A`, compilerVersion: VERSION };
    for (const remapping of [
      "ctx:/abs=lib/",
      "ctx:pre=/abs/",
      "/abs",
      "ctx:/abs",
      "pre=../..",
      "a=/abs/",
      "a/../..",
      "..=lib/",
      "ctx:..=lib/",
      "a/../..:pre=lib/",
      "ctx:..",
    ]) {
      const error = rejection([standardJson({ remappings: ["ok=lib/", remapping] })], options);
      assert.deepEqual(
        error.details,
        {
          code: "invalid-input",
          issues: [
            {
              field: "compiler.input.settings.remappings",
              message: "has a local path at position 2",
            },
          ],
        },
        remapping,
      );
    }
    for (const remapping of [
      "ctx:pre=lib/",
      "pre=lib/",
      "lib/",
      "ctx:lib/",
      "ctx/a:b=c",
      "a/../..x=lib/",
    ]) {
      assert.equal(
        built([standardJson({ remappings: [remapping] })], options).contractName,
        `${PATH}:A`,
        remapping,
      );
    }
  });
});

describe("buildVerifyInput: picking the version and the contract (#202, R-IN-7)", () => {
  it("names a compilerVersion option that differs from the documents", () => {
    assertInvalid(
      [buildInfo()],
      { field: "compilerVersion", message: "differs from the compiler version in the documents" },
      { compilerVersion: "0.8.25+commit.b61c2a91" },
    );
  });

  it("names a contract option whose name is not an identifier", () => {
    assertInvalid(
      [buildInfo()],
      {
        field: "contract",
        message: "must be path:Name, with a Solidity identifier after the last colon",
      },
      { contract: `${PATH}:1A` },
    );
  });

  it("names a user source name mapped to a path that is not a source", () => {
    const document = buildInfo(undefined, {
      userSourceNameMap: { "contracts/A.sol": "src/B.sol" },
    });
    assertInvalid(
      [document],
      {
        field: "contract",
        message: "has a path that is not a key of the compiler input's sources",
      },
      { contract: "contracts/A.sol:A" },
    );
  });

  it("explains a bare name that matches none, several or no listed contracts", () => {
    assertInvalid(
      [buildInfo()],
      { field: "contract", message: "matches no contract in the documents" },
      { contract: "Z" },
    );
    const twoFiles = buildInfo(
      { [PATH]: { A: {} }, "src/B.sol": { A: {} } },
      {
        input: {
          language: "Solidity",
          sources: { [PATH]: { content: SOURCE }, "src/B.sol": { content: SOURCE } },
          settings: {},
        },
      },
    );
    assertIncomplete(
      [twoFiles],
      {
        field: "contract",
        message: "The contract name matches 2 contracts in the documents.",
        hint: CONTRACT_HINT,
        candidates: [`${PATH}:A`, "src/B.sol:A"],
      },
      { contract: "A" },
    );
    assertIncomplete(
      [standardJson()],
      {
        field: "contract",
        message: "The documents list no contracts, so a bare contract name cannot be resolved.",
        hint: "Pass the contract (options.contract) as path:Name, with a path that is a key of the compiler input's sources.",
      },
      { contract: "A", compilerVersion: VERSION },
    );
  });

  it("names an artifact whose source is not in the compiler input", () => {
    assertInvalid(
      [buildInfo(), { abi: [], bytecode: "0x", sourceName: "src/B.sol", contractName: "B" }],
      {
        field: "contract",
        message: "comes from an artifact whose source is not in the compiler input",
      },
    );
  });

  it("counts the contracts the artifacts point at before the ones the build-info lists", () => {
    const listed = buildInfo({ [PATH]: { A: {}, B: {}, C: {} } });
    const artifact = (name: string): Record<string, unknown> => ({
      abi: [],
      bytecode: "0x",
      sourceName: PATH,
      contractName: name,
    });
    assertIncomplete([listed], {
      field: "contract",
      message: "The documents hold 3 contracts and none was chosen.",
      hint: CONTRACT_HINT,
      candidates: [`${PATH}:A`, `${PATH}:B`, `${PATH}:C`],
    });
    assertIncomplete([listed, artifact("A"), artifact("B")], {
      field: "contract",
      message: "The documents hold 2 contracts and none was chosen.",
      hint: CONTRACT_HINT,
      candidates: [`${PATH}:A`, `${PATH}:B`],
    });
  });

  it("says when the documents name no contract", () => {
    assertIncomplete(
      [standardJson()],
      {
        field: "contract",
        message: "The documents name no contract.",
        hint: "Pass the contract (options.contract) as path:Name.",
      },
      { compilerVersion: VERSION },
    );
  });
});

describe("buildVerifyInput: a rebuild from Solidity metadata (#202, R-IN-7)", () => {
  it("never redacts a missing source path in details.candidates, whatever text it holds (R-SEC-1)", () => {
    // Text a mutant could add to the secrets, so a redaction would show in the candidates.
    const path = "src/Stryker was here.sol";
    const error = rejection([metadata({}, { sources: { [path]: { keccak256: HASH } } })]);
    assert.ok(error.details.code === "incomplete-input");
    assert.deepEqual(error.details.candidates, [path]);
  });

  it("names metadata that targets two contracts", () => {
    assertInvalid(
      [metadata({ compilationTarget: { [PATH]: "A", "src/B.sol": "B" } })],
      { field: "metadata.settings.compilationTarget", message: "must name exactly one contract" },
      undefined,
      METADATA_TARGET_HINT,
    );
  });

  it("names a contract option that is not the metadata's target", () => {
    assertInvalid(
      [metadata()],
      { field: "contract", message: "matches no contract in the documents" },
      { contract: "B" },
    );
  });

  it("compares two metadata documents of one contract whatever the key order inside an array", () => {
    const first = metadata({ x: [{ a: 1, b: 2 }] });
    const second = metadata({ x: [{ b: 2, a: 1 }] }, { output: {} });
    assert.equal(built([first, second]).contractName, `${PATH}:A`);
  });

  it("tells apart arrays whose items differ, even when their digits run together", () => {
    for (const [one, two] of [
      [[1], [2]],
      [[12], [1, 2]],
    ]) {
      assertInvalid([metadata({ x: one }), metadata({ x: two })], {
        field: "documents",
        message:
          "hold different Solidity metadata for one contract; pass the documents of one build",
      });
    }
  });

  it("checks every other document against the first, not only one of them", () => {
    const first = metadata();
    const same = metadata({}, { output: {} });
    const otherSettings = metadata({ evmVersion: "paris" });
    assertInvalid([first, same, otherSettings], {
      field: "documents",
      message: "hold different Solidity metadata for one contract; pass the documents of one build",
    });
    const otherSources = metadata(
      {},
      {
        sources: { [PATH]: { keccak256: HASH, content: SOURCE }, "src/B.sol": { keccak256: HASH } },
      },
    );
    assertInvalid([first, same, otherSources], {
      field: "documents",
      message: "come from different builds; pass the documents of one build",
    });
  });

  it("compares metadata nested up to 64 levels, and rejects deeper metadata as not JSON data", () => {
    // Inside the rebuilt input, settings.x sits two levels down.
    const deepest = 63;
    assert.equal(
      built([metadata({ x: nested(deepest) }), metadata({ x: nested(deepest) }, { output: {} })])
        .contractName,
      `${PATH}:A`,
    );
    for (const x of [nested(deepest + 1), nestedArray(deepest + 1)]) {
      assertInvalid([metadata({ x }), metadata({ x }, { output: {} })], {
        field: "documents",
        message: "hold Solidity metadata that is not JSON data",
      });
    }
  });

  it("lets validateInput report one metadata document nested too deeply", () => {
    const error = rejection([metadata({ x: nested(64) })]);
    assert.deepEqual(error.details, {
      code: "invalid-input",
      issues: [{ field: "compiler.input.settings", message: "is nested more than 64 levels deep" }],
    });
  });
});
