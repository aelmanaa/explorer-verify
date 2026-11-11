// Tests added after the first mutation run of src/input/validate.ts (#202; R-IN-1, R-IN-4,
// R-IN-6): each one fails on a code change that the other validateInput tests let pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError, validateInput } from "../../src/index.ts";
import type { InputIssue, VerifyInput } from "../../src/index.ts";

const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const LIBRARY = "0xd0B737fC4e4195144824eB07b2d1bb778525b86B";
const VERSION = "0.8.24+commit.e11b9ed9";

const SHORT =
  "is a short version; pass the full version with its commit, such as 0.8.24+commit.e11b9ed9";
const PLATFORM =
  "has a platform suffix; pass the version up to the commit hash, such as 0.8.24+commit.e11b9ed9";
const NOT_A_VERSION = "must be a full solc version, such as 0.8.24+commit.e11b9ed9";
const SHORT_HINT =
  "Pass the full compiler version with its commit, such as 0.8.24+commit.e11b9ed9.";
const KEYED = "must be keyed by path:Name of compiler.input.sources";

/** A valid input whose only source is `path`. Each call returns a new object. */
function input(path = "src/Token.sol"): VerifyInput {
  return {
    chainId: 11155111,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: VERSION,
      input: {
        language: "Solidity",
        sources: { [path]: { content: "contract Token {}" } },
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
    contractName: `${path}:Token`,
  };
}

/** `input()` with `compiler` fields replaced. */
function withCompiler(fields: Record<string, unknown>): Record<string, unknown> {
  const base = input();
  return { ...base, compiler: { ...base.compiler, ...fields } };
}

/** `input()` with `compiler.input` fields replaced. */
function withStandardJson(fields: Record<string, unknown>): Record<string, unknown> {
  const base = input();
  return {
    ...base,
    compiler: { ...base.compiler, input: { ...base.compiler.input, ...fields } },
  };
}

function rejection(value: unknown): ExplorerVerifyError {
  try {
    validateInput(value);
  } catch (error: unknown) {
    assert.ok(error instanceof ExplorerVerifyError, `validateInput threw ${String(error)}`);
    return error;
  }
  return assert.fail("validateInput accepted the value");
}

function issuesOf(value: unknown): readonly InputIssue[] {
  const error = rejection(value);
  if (error.details.code !== "invalid-input") {
    return assert.fail("details do not match the code");
  }
  return error.details.issues;
}

describe("validateInput: compiler.version messages (#202, R-IN-6)", () => {
  it("names a platform suffix after a version with multi-digit parts, a nightly or a pre-release", () => {
    for (const version of [
      "10.10.0-nightly.2024.12.15+commit.0123abcd.Linux.g++",
      "0.8.4-pre.10+commit.0123abcd.Emscripten.clang",
    ]) {
      assert.deepEqual(issuesOf(withCompiler({ version })), [
        { field: "compiler.version", message: PLATFORM },
      ]);
    }
  });

  it("does not take a platform suffix after text before the version for one", () => {
    assert.deepEqual(issuesOf(withCompiler({ version: "x0.8.24+commit.e11b9ed9.Linux.g++" })), [
      { field: "compiler.version", message: NOT_A_VERSION },
    ]);
  });

  it("names a short version with multi-digit parts", () => {
    for (const version of ["10.8.24", "0.10.0"]) {
      const error = rejection(withCompiler({ version }));
      assert.deepEqual(error.details.code === "invalid-input" && error.details.issues, [
        { field: "compiler.version", message: SHORT },
      ]);
      assert.equal(error.hint, SHORT_HINT);
    }
  });

  it("rejects a value that is not a string, even when its text is a full version", () => {
    for (const version of [[VERSION], { toString: () => VERSION }]) {
      assert.deepEqual(issuesOf(withCompiler({ version })), [
        { field: "compiler.version", message: NOT_A_VERSION },
      ]);
    }
  });

  it("adds the pointer to the other issues only when there are other issues (R-DX-3)", () => {
    const error = rejection({ ...withCompiler({ version: "0.8.24" }), chainId: 0 });
    assert.equal(
      error.hint,
      `${SHORT_HINT} Then fix the other fields that the issues list (details.issues).`,
    );
  });
});

describe("validateInput: hex fields start with 0x (#202, R-IN-6)", () => {
  it("rejects constructorArgs and creationTxHash with text before 0x", () => {
    assert.deepEqual(issuesOf({ ...input(), constructorArgs: "zz0x00" }), [
      { field: "constructorArgs", message: "must be 0x followed by an even number of hex digits" },
    ]);
    assert.deepEqual(issuesOf({ ...input(), creationTxHash: `z0x${"ab".repeat(32)}` }), [
      { field: "creationTxHash", message: "must be 0x followed by 64 hex digits" },
    ]);
  });

  it("names the creationBytecode rule in its message", () => {
    assert.deepEqual(issuesOf({ ...input(), creationBytecode: "0x" }), [
      {
        field: "creationBytecode",
        message: "must be hex bytes and __$...$__ library placeholders, 1 to 65536 bytes",
      },
    ]);
  });
});

describe("validateInput: Standard JSON fields (#202, R-IN-6)", () => {
  it("reports a language that is not JSON data once, as a language issue", () => {
    assert.deepEqual(issuesOf(withStandardJson({ language: 1n })), [
      { field: "compiler.input.language", message: 'must be "Solidity"' },
    ]);
  });

  it("reports a source entry that is undefined as a file without content", () => {
    assert.deepEqual(issuesOf(withStandardJson({ sources: { "src/Token.sol": undefined } })), [
      {
        field: "compiler.input.sources",
        message: "has 1 file without a string content, at position 1",
      },
    ]);
  });
});

describe("validateInput: names with a one-character path (#202, R-IN-1, R-IN-4)", () => {
  it("accepts contractName and a library under a path of one character", () => {
    const validated = validateInput({ ...input("a"), libraries: { "a:Math": LIBRARY } });
    assert.equal(validated.contractName, "a:Token");
    assert.deepEqual(validated.libraries, { "a:Math": LIBRARY.toLowerCase() });
  });

  it("reports a library name without a path when the sources cannot be read", () => {
    for (const name of ["Math", ":Math"]) {
      const base = withStandardJson({ sources: {} });
      assert.deepEqual(issuesOf({ ...base, libraries: { [name]: LIBRARY } }), [
        { field: "compiler.input.sources", message: "must hold at least one source file" },
        { field: "libraries.1", message: KEYED },
      ]);
    }
  });
});
