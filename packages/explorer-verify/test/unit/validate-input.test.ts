import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ExplorerVerifyError, validateInput } from "../../src/index.ts";
import type { InputIssue, VerifyInput } from "../../src/index.ts";

const DUMMY_KEY = "DUMMYKEY0123456789ABCDEFGHIJKLMNO";
const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const VERSION = "0.8.24+commit.e11b9ed9";
const TX_HASH = `0x${"ab".repeat(32)}`;

const MESSAGES = {
  input: "must be a plain object whose fields can be read",
  chainId: "must be a positive integer",
  address: "must be 0x followed by 40 hex digits",
  compiler: "must be an object with kind, version and input",
  kind: 'must be "solc", the only supported kind',
  shortVersion:
    "is a short version; pass the full version with its commit, such as 0.8.24+commit.e11b9ed9",
  version: "must be a full solc version, such as 0.8.24+commit.e11b9ed9",
  standardJson: "must be the Standard JSON input object",
  language: 'must be "Solidity"',
  sources: "must be an object of source files by path",
  noSources: "must hold at least one source file",
  settings: "must be an object",
  contractNameFormat: "must be path:Name, with a Solidity identifier after the last colon",
  contractNamePath: "must start with a key of compiler.input.sources",
  constructorArgs: "must be 0x followed by an even number of hex digits",
  creationTxHash: "must be 0x followed by 64 hex digits",
};

/** A valid input with two sources. Each call returns a new object. */
function input(): VerifyInput {
  return {
    chainId: 11155111,
    address: ADDRESS,
    compiler: {
      kind: "solc",
      version: VERSION,
      input: {
        language: "Solidity",
        sources: {
          "src/Token.sol": { content: "contract Token {}" },
          "src/lib/Math.sol": { content: "library Math {}" },
        },
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
      },
    },
    contractName: "src/Token.sol:Token",
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

/** Runs `validateInput` on `value` and returns the error it throws. */
function rejection(value: unknown): ExplorerVerifyError {
  try {
    validateInput(value);
  } catch (error) {
    assert.ok(error instanceof ExplorerVerifyError, `validateInput threw ${String(error)}`);
    return error;
  }
  return assert.fail("validateInput accepted the value");
}

/** The issues of an invalid-input error. */
function issuesOf(error: ExplorerVerifyError): InputIssue[] {
  if (error.details.code !== "invalid-input") {
    return assert.fail("details do not match the code");
  }
  return error.details.issues;
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
  ];
  for (const place of places) {
    assert.ok(!place.includes(text), `shown in: ${place.slice(0, 120)}`);
  }
}

/** Asserts an invalid-input error naming exactly `fields`, with no dummy key anywhere in it. */
function assertRejected(value: unknown, fields: string[]): ExplorerVerifyError {
  const error = rejection(value);
  assert.equal(error.code, "invalid-input");
  assert.equal(error.retryable, false);
  assert.deepEqual(
    issuesOf(error).map((issue) => issue.field),
    fields,
  );
  assertNotShown(error, DUMMY_KEY);
  return error;
}

/** Asserts a rejection with exactly one issue, on `field`, with `message`. */
function assertIssue(value: unknown, field: string, message: string): ExplorerVerifyError {
  const error = assertRejected(value, [field]);
  assert.deepEqual(issuesOf(error), [{ field, message }]);
  return error;
}

describe("validateInput accepts", () => {
  it("a complete valid input and returns an equal new object (R-IN-1, R-IN-6)", () => {
    const original = input();
    const validated = validateInput(original);
    assert.notEqual(validated, original);
    assert.deepEqual(validated, { ...original, address: ADDRESS.toLowerCase() });
  });

  it("an input read back with JSON.parse (R-IN-6)", () => {
    const validated = validateInput(JSON.parse(JSON.stringify(input())));
    assert.equal(validated.chainId, 11155111);
  });

  it("returns the fields of VerifyInput only, in a stable order (R-AX-12)", () => {
    const validated = validateInput({
      ...input(),
      constructorArgs: "0x",
      creationTxHash: TX_HASH,
      apiKey: DUMMY_KEY,
    });
    assert.deepEqual(Object.keys(validated), [
      "chainId",
      "address",
      "compiler",
      "contractName",
      "constructorArgs",
      "creationTxHash",
    ]);
    assert.deepEqual(Object.keys(validated.compiler), ["kind", "version", "input"]);
    assert.ok(!JSON.stringify(validated).includes(DUMMY_KEY));
  });

  it("keeps sources and settings unchanged, extra Standard JSON fields included (R-IN-1)", () => {
    const original = input();
    const sources = {
      "src/Token.sol": {
        content: "contract Token {}",
        keccak256: "0x01",
        urls: ["ipfs://x"],
      },
    };
    const standardJson = {
      ...original.compiler.input,
      sources,
      settings: { remappings: ["a=b"], libraries: { "src/L.sol": { L: ADDRESS } } },
    };
    const validated = validateInput({
      ...original,
      compiler: { ...original.compiler, input: standardJson },
    });
    assert.deepEqual(validated.compiler.input, standardJson);
  });

  it("does not change the object it was given (R-IN-1)", () => {
    const original = {
      ...input(),
      address: ADDRESS,
      compiler: { ...input().compiler, version: `v${VERSION}` },
    };
    const copy = structuredClone(original);
    validateInput(original);
    assert.deepEqual(original, copy);
  });

  it("keeps a source path named __proto__ as a plain key (R-IN-6)", () => {
    const value: unknown = JSON.parse(
      JSON.stringify({ ...input(), contractName: "__proto__:Token" }).replace(
        '"src/Token.sol"',
        '"__proto__"',
      ),
    );
    const validated = validateInput(value);
    assert.deepEqual(Object.keys(validated.compiler.input.sources), [
      "__proto__",
      "src/lib/Math.sol",
    ]);
    assert.equal(Object.getPrototypeOf(validated.compiler.input.sources), Object.prototype);
  });
});

describe("validateInput normalises (R-IN-1)", () => {
  it("v0.8.24+commit.e11b9ed9 becomes 0.8.24+commit.e11b9ed9 (R-IN-1)", () => {
    const validated = validateInput(withCompiler({ version: "v0.8.24+commit.e11b9ed9" }));
    assert.equal(validated.compiler.version, "0.8.24+commit.e11b9ed9");
  });

  it("a version without v stays as it is (R-IN-1)", () => {
    assert.equal(validateInput(input()).compiler.version, VERSION);
  });

  it("a mixed-case address becomes lower case (R-IN-1)", () => {
    const validated = validateInput({ ...input(), address: ADDRESS });
    assert.equal(validated.address, "0x5fbdb2315678afecb367f032d93f642f64180aa3");
  });
});

describe("rule: chainId is a positive safe integer (R-IN-6)", () => {
  it("accepts 1 and Number.MAX_SAFE_INTEGER (R-IN-6)", () => {
    for (const chainId of [1, 11155111, Number.MAX_SAFE_INTEGER]) {
      assert.equal(validateInput({ ...input(), chainId }).chainId, chainId);
    }
  });

  it("rejects zero, negatives, fractions, unsafe integers, strings and NaN (R-IN-6)", () => {
    for (const chainId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", Number.NaN, null]) {
      assertIssue({ ...input(), chainId }, "chainId", MESSAGES.chainId);
    }
    const { chainId: _chainId, ...withoutChainId } = input();
    assertIssue(withoutChainId, "chainId", MESSAGES.chainId);
  });
});

describe("rule: address is 0x and 40 hex digits, any case, checksum not checked (R-IN-6)", () => {
  it("accepts lower, upper and mixed case, and a wrong checksum (R-IN-6)", () => {
    const hex = ADDRESS.slice(2);
    for (const address of [
      `0x${hex.toLowerCase()}`,
      `0x${hex.toUpperCase()}`,
      ADDRESS,
      // The checksum of ADDRESS with the case of its first letter flipped is wrong.
      `0x5fbDB2315678afecb367f032d93F642f64180aa3`,
    ]) {
      assert.equal(validateInput({ ...input(), address }).address, address.toLowerCase());
    }
  });

  it("rejects wrong lengths, non-hex digits, 0X, junk and non-strings (R-IN-6)", () => {
    const hex = ADDRESS.slice(2);
    for (const address of [
      "0x1234",
      hex,
      `0x${"g".repeat(40)}`,
      `0x${hex.slice(1)}`,
      `0x${hex}a`,
      `0X${hex}`,
      `junk0x${hex}`,
      `0x${hex}\n`,
      42,
    ]) {
      assertIssue({ ...input(), address }, "address", MESSAGES.address);
    }
  });
});

describe("rule: compiler.kind is solc (R-IN-6, decision 0004)", () => {
  it("accepts solc (R-IN-6)", () => {
    assert.equal(validateInput(input()).compiler.kind, "solc");
  });

  it("rejects any other kind with a hint naming the supported kinds (R-IN-6)", () => {
    for (const kind of ["vyper", "SOLC", undefined]) {
      const error = assertIssue(withCompiler({ kind }), "compiler.kind", MESSAGES.kind);
      assert.equal(error.hint, 'Set compiler.kind to "solc", the only supported compiler kind.');
    }
  });

  it("rejects a compiler that is not an object, without checking its fields (R-IN-6)", () => {
    for (const compiler of [null, "solc", [], undefined]) {
      assertIssue({ ...input(), compiler }, "compiler", MESSAGES.compiler);
    }
  });
});

describe("rule: compiler.version is the full form (R-IN-1, R-IN-6)", () => {
  it("accepts a release, a v prefix and a nightly build (R-IN-6)", () => {
    for (const [version, expected] of [
      ["0.8.24+commit.e11b9ed9", "0.8.24+commit.e11b9ed9"],
      ["v0.4.11+commit.68ef5810", "0.4.11+commit.68ef5810"],
      ["0.8.25-nightly.2024.1.17+commit.2a7d79a1", "0.8.25-nightly.2024.1.17+commit.2a7d79a1"],
      ["v0.8.30-nightly.2025.12.31+commit.0123abcd", "0.8.30-nightly.2025.12.31+commit.0123abcd"],
    ]) {
      assert.equal(validateInput(withCompiler({ version })).compiler.version, expected);
    }
  });

  it("rejects a short version with a hint to pass the long one (R-IN-6)", () => {
    for (const version of ["0.8.24", "v0.8.24"]) {
      const error = assertIssue(
        withCompiler({ version }),
        "compiler.version",
        MESSAGES.shortVersion,
      );
      assert.equal(
        error.hint,
        "Pass the full compiler version with its commit, such as 0.8.24+commit.e11b9ed9.",
      );
    }
  });

  it("rejects other shapes (R-IN-6)", () => {
    for (const version of [
      "",
      "0.8",
      "latest",
      "^0.8.24",
      "0.8.24+commit",
      "0.8.24+commit.e11b9ed",
      "0.8.24+commit.E11B9ED9",
      "0.8.24+commit.e11b9ed9.Linux.g++",
      "V0.8.24+commit.e11b9ed9",
      "vv0.8.24+commit.e11b9ed9",
      "0.8.24-nightly+commit.e11b9ed9",
      "0.8.24-nightly.24.1.17+commit.e11b9ed9",
      " 0.8.24+commit.e11b9ed9",
      "0.8.24+commit.e11b9ed9\n",
      824,
    ]) {
      assertIssue(withCompiler({ version }), "compiler.version", MESSAGES.version);
    }
  });
});

describe("rule: compiler.input.language is Solidity (R-IN-6)", () => {
  it("accepts Solidity (R-IN-6)", () => {
    assert.equal(validateInput(input()).compiler.input.language, "Solidity");
  });

  it("rejects Yul, Vyper, a lower-case name and a missing language (R-IN-6)", () => {
    for (const language of ["Yul", "Vyper", "solidity", undefined]) {
      assertIssue(withStandardJson({ language }), "compiler.input.language", MESSAGES.language);
    }
  });

  it("rejects a Standard JSON that is not an object, without checking its fields (R-IN-6)", () => {
    for (const standardJson of [null, "{}", [], undefined]) {
      assertIssue(withCompiler({ input: standardJson }), "compiler.input", MESSAGES.standardJson);
    }
  });
});

describe("rule: compiler.input.sources has entries with string content (R-IN-6)", () => {
  it("accepts one source and an empty content string (R-IN-6)", () => {
    const sources = { "src/Token.sol": { content: "" } };
    assert.deepEqual(validateInput(withStandardJson({ sources })).compiler.input.sources, sources);
  });

  it("rejects sources that are not an object (R-IN-6)", () => {
    for (const sources of [null, "src/Token.sol", [{ content: "x" }], undefined]) {
      assertIssue(withStandardJson({ sources }), "compiler.input.sources", MESSAGES.sources);
    }
  });

  it("rejects an empty sources object (R-IN-6)", () => {
    assertIssue(withStandardJson({ sources: {} }), "compiler.input.sources", MESSAGES.noSources);
  });

  it("rejects entries without a string content, by position and without their paths (R-IN-6)", () => {
    const error = assertIssue(
      withStandardJson({
        sources: {
          "src/Token.sol": { content: "contract Token {}" },
          [`src/${DUMMY_KEY}.sol`]: { content: 1 },
          "src/B.sol": null,
          "src/C.sol": { urls: ["ipfs://x"] },
        },
      }),
      "compiler.input.sources",
      "has 3 files without a string content, at positions 2, 3, 4",
    );
    assert.ok(!error.message.includes("src/"));
  });

  it("lists at most five positions (R-IN-6)", () => {
    const sources: Record<string, unknown> = { "src/Token.sol": { content: "" } };
    for (let index = 0; index < 200_000; index++) {
      sources[`src/F${String(index)}.sol`] = {};
    }
    const error = assertIssue(
      withStandardJson({ sources }),
      "compiler.input.sources",
      "has 200000 files without a string content, at positions 2, 3, 4, 5, 6 and more",
    );
    assert.ok(JSON.stringify(error).length < 1_000);
  });

  it("rejects a source entry whose fields cannot be read (R-IN-6)", () => {
    const hostile = new Proxy(
      { content: "x" },
      {
        ownKeys: () => {
          throw new Error(`trap ${DUMMY_KEY}`);
        },
      },
    );
    assertIssue(
      withStandardJson({ sources: { "src/Token.sol": hostile } }),
      "compiler.input.sources",
      "has 1 file without a string content, at position 1",
    );
  });
});

describe("rule: compiler.input.settings is an object (R-IN-6)", () => {
  it("accepts an empty settings object (R-IN-6)", () => {
    assert.deepEqual(validateInput(withStandardJson({ settings: {} })).compiler.input.settings, {});
  });

  it("rejects settings that are not an object (R-IN-6)", () => {
    for (const settings of [null, "optimizer", [], undefined]) {
      assertIssue(withStandardJson({ settings }), "compiler.input.settings", MESSAGES.settings);
    }
  });
});

describe("rule: contractName is path:Name with path in the sources (R-IN-1, R-IN-6)", () => {
  it("accepts a path with colons, and $ and _ in the name (R-IN-6)", () => {
    for (const [path, name] of [
      ["src/Token.sol", "Token"],
      ["C:/work/Token.sol", "Token"],
      ["src/Token.sol", "$_Token2"],
      ["src/Token.sol", "_"],
    ]) {
      const contractName = `${String(path)}:${String(name)}`;
      const value = withStandardJson({ sources: { [String(path)]: { content: "" } } });
      assert.equal(validateInput({ ...value, contractName }).contractName, contractName);
    }
  });

  it("rejects a name without a path, an empty path or a bad identifier (R-IN-6)", () => {
    for (const contractName of [
      "Token",
      ":Token",
      "src/Token.sol:",
      "src/Token.sol:2Token",
      "src/Token.sol:Tok-en",
      "src/Token.sol:Token ",
      "src/Token.sol:Token\n",
      "",
      7,
      undefined,
    ]) {
      assertIssue({ ...input(), contractName }, "contractName", MESSAGES.contractNameFormat);
    }
  });

  it("rejects a path that is not a key of compiler.input.sources (R-IN-6)", () => {
    for (const contractName of ["src/Other.sol:Token", "Token.sol:Token", "src/token.sol:Token"]) {
      assertIssue({ ...input(), contractName }, "contractName", MESSAGES.contractNamePath);
    }
  });

  it("does not check the path when sources are invalid (R-IN-6)", () => {
    assertRejected({ ...withStandardJson({ sources: {} }), contractName: "src/Other.sol:Token" }, [
      "compiler.input.sources",
    ]);
  });

  it("checks the path against every source path when some entries are bad (R-IN-6)", () => {
    const value = withStandardJson({
      sources: { "src/Token.sol": { content: 1 }, "src/Good.sol": { content: "" } },
    });
    assertRejected({ ...value, contractName: "src/Good.sol:Good" }, ["compiler.input.sources"]);
    assertRejected({ ...value, contractName: "src/Token.sol:Token" }, ["compiler.input.sources"]);
    assertRejected({ ...value, contractName: "src/Other.sol:Token" }, [
      "compiler.input.sources",
      "contractName",
    ]);
  });
});

describe("rule: constructorArgs, when present, is 0x and an even number of hex digits (R-IN-6)", () => {
  it("accepts 0x, one word and mixed case, and leaves it unchanged (R-IN-6)", () => {
    for (const constructorArgs of ["0x", `0x${"00".repeat(32)}`, "0xAbCd"]) {
      assert.equal(validateInput({ ...input(), constructorArgs }).constructorArgs, constructorArgs);
    }
  });

  it("accepts an absent or undefined value and leaves the field out (R-IN-6)", () => {
    assert.ok(!("constructorArgs" in validateInput(input())));
    assert.ok(!("constructorArgs" in validateInput({ ...input(), constructorArgs: undefined })));
  });

  it("rejects an odd length, a missing 0x, non-hex digits, null and non-strings (R-IN-6)", () => {
    for (const constructorArgs of ["0x0", "00", "0xzz", "0X00", "", null, 0, ["0x00"]]) {
      assertIssue({ ...input(), constructorArgs }, "constructorArgs", MESSAGES.constructorArgs);
    }
  });
});

describe("rule: creationTxHash, when present, is 0x and 64 hex digits (R-IN-6)", () => {
  it("accepts 64 hex digits in any case and leaves the field out when absent (R-IN-6)", () => {
    for (const creationTxHash of [TX_HASH, TX_HASH.toUpperCase().replace("0X", "0x")]) {
      assert.equal(validateInput({ ...input(), creationTxHash }).creationTxHash, creationTxHash);
    }
    assert.ok(!("creationTxHash" in validateInput(input())));
    assert.ok(!("creationTxHash" in validateInput({ ...input(), creationTxHash: undefined })));
  });

  it("rejects 63 or 65 digits, a missing 0x, non-hex digits and non-strings (R-IN-6)", () => {
    for (const creationTxHash of [
      TX_HASH.slice(0, -1),
      `${TX_HASH}a`,
      TX_HASH.slice(2),
      `0x${"g".repeat(64)}`,
      null,
      1,
    ]) {
      assertIssue({ ...input(), creationTxHash }, "creationTxHash", MESSAGES.creationTxHash);
    }
  });
});

describe("validateInput collects every problem (R-IN-6)", () => {
  it("lists three bad fields in one error (R-IN-6)", () => {
    const error = assertRejected(
      { ...withCompiler({ version: "latest" }), chainId: 0, address: "0x1234" },
      ["chainId", "address", "compiler.version"],
    );
    assert.equal(error.message, "The input is invalid: chainId, address, compiler.version.");
    assert.deepEqual(issuesOf(error), [
      { field: "chainId", message: MESSAGES.chainId },
      { field: "address", message: MESSAGES.address },
      { field: "compiler.version", message: MESSAGES.version },
    ]);
  });

  it("lists every field in field order when all are wrong (R-IN-6)", () => {
    const error = assertRejected(
      {
        chainId: -1,
        address: "",
        compiler: {
          kind: "vyper",
          version: "0.8.24",
          input: { language: "Yul", sources: {}, settings: null },
        },
        contractName: "Token",
        constructorArgs: "0x0",
        creationTxHash: "0x",
      },
      [
        "chainId",
        "address",
        "compiler.kind",
        "compiler.version",
        "compiler.input.language",
        "compiler.input.sources",
        "compiler.input.settings",
        "contractName",
        "constructorArgs",
        "creationTxHash",
      ],
    );
    assert.ok(error.message.length < 300);
  });

  it("gives the specific hint first and points to the other issues (R-DX-3, R-AX-10)", () => {
    const error = rejection({ ...withCompiler({ version: "0.8.24", kind: "x" }), chainId: 0 });
    assert.equal(
      error.hint,
      'Set compiler.kind to "solc", the only supported compiler kind. Then fix the other fields in details.issues.',
    );
  });

  it("uses the catalogue hint and docs URL when no rule has a specific hint (R-AX-10)", () => {
    const error = rejection({ ...input(), chainId: 0 });
    const reference = new ExplorerVerifyError({ code: "invalid-input", issues: [] }, "x");
    assert.equal(error.hint, reference.hint);
    assert.equal(error.docsUrl, reference.docsUrl);
    assert.equal(error.message, "The input is invalid: chainId.");
  });
});

describe("validateInput rejects hostile input as invalid-input (R-IN-6, R-SEC-1)", () => {
  it("a value that is not a plain object (R-IN-6)", () => {
    for (const value of [null, undefined, "input", 1, [input()]]) {
      assertIssue(value, "input", MESSAGES.input);
    }
  });

  it("a Proxy whose ownKeys throws, at any depth (R-IN-6)", () => {
    const trap = {
      ownKeys: (): never => {
        throw new Error(`trap ${DUMMY_KEY}`);
      },
    };
    assertIssue(new Proxy(input(), trap), "input", MESSAGES.input);
    const base = input();
    assertIssue(
      { ...base, compiler: new Proxy(base.compiler, trap) },
      "compiler",
      MESSAGES.compiler,
    );
    assertIssue(
      withCompiler({ input: new Proxy(base.compiler.input, trap) }),
      "compiler.input",
      MESSAGES.standardJson,
    );
    assertIssue(
      withStandardJson({ sources: new Proxy(base.compiler.input.sources, trap) }),
      "compiler.input.sources",
      MESSAGES.sources,
    );
    assertIssue(
      withStandardJson({ settings: new Proxy({}, trap) }),
      "compiler.input.settings",
      MESSAGES.settings,
    );
  });

  it("a revoked Proxy (R-IN-6)", () => {
    const { proxy, revoke } = Proxy.revocable(input(), {});
    revoke();
    assertIssue(proxy, "input", MESSAGES.input);
  });

  it("an object whose getter throws (R-IN-6)", () => {
    const value = {
      ...input(),
      get address(): string {
        throw new Error(`getter ${DUMMY_KEY}`);
      },
    };
    assertIssue(value, "input", MESSAGES.input);
  });

  it("reads each field once, so a getter cannot change a value after the check (R-IN-6)", () => {
    let reads = 0;
    const value = {
      ...input(),
      get address(): string {
        reads++;
        return reads === 1 ? ADDRESS : "not an address";
      },
    };
    assert.equal(validateInput(value).address, ADDRESS.toLowerCase());
    assert.equal(reads, 1);
  });

  it("fields that come from the prototype (R-IN-6)", () => {
    const value: unknown = Object.create(input());
    assertRejected(value, ["chainId", "address", "compiler", "contractName"]);
  });

  it("200,000 extra fields, ignored (R-IN-6)", () => {
    const value: Record<string, unknown> = { ...input() };
    for (let index = 0; index < 200_000; index++) {
      value[`k${String(index)}`] = index;
    }
    assert.deepEqual(Object.keys(validateInput(value)), [
      "chainId",
      "address",
      "compiler",
      "contractName",
    ]);
  });

  it("a 10 MB string in every string field, with a short message (R-IN-6)", () => {
    const huge = `0x${"a".repeat(10_000_000)}!`;
    const error = assertRejected(
      {
        ...withCompiler({ version: huge, kind: huge }),
        address: huge,
        contractName: huge,
        constructorArgs: huge,
        creationTxHash: huge,
      },
      [
        "address",
        "compiler.kind",
        "compiler.version",
        "contractName",
        "constructorArgs",
        "creationTxHash",
      ],
    );
    assert.ok(JSON.stringify(error).length < 1_000);
  });
});

describe("validateInput errors never repeat a value (R-SEC-1, R-AX-9)", () => {
  it("places a dummy key in every field and finds it nowhere in the error (R-SEC-1)", () => {
    const fields: [string, (value: string) => Record<string, unknown>][] = [
      ["chainId", (value) => ({ ...input(), chainId: value })],
      ["address", (value) => ({ ...input(), address: value })],
      ["compiler.kind", (value) => withCompiler({ kind: value })],
      ["compiler.version", (value) => withCompiler({ version: value })],
      ["compiler.input.language", (value) => withStandardJson({ language: value })],
      [
        "compiler.input.sources",
        (value) =>
          withStandardJson({ sources: { "src/Token.sol": { content: "" }, [value]: value } }),
      ],
      ["compiler.input.settings", (value) => withStandardJson({ settings: value })],
      ["contractName", (value) => ({ ...input(), contractName: `${value}:Token` })],
      ["constructorArgs", (value) => ({ ...input(), constructorArgs: value })],
      ["creationTxHash", (value) => ({ ...input(), creationTxHash: value })],
    ];
    for (const [field, build] of fields) {
      for (const value of [DUMMY_KEY, `0x${DUMMY_KEY}`, `v${DUMMY_KEY}+commit.${DUMMY_KEY}`]) {
        assertRejected(build(value), [field]);
      }
    }
    assertRejected({ ...input(), compiler: DUMMY_KEY }, ["compiler"]);
    assertRejected(withCompiler({ input: DUMMY_KEY }), ["compiler.input"]);
    assertRejected(DUMMY_KEY, ["input"]);
  });

  it("keeps a key from a hostile trap out of the error and its cause (R-SEC-1)", () => {
    const hostile = new Proxy(input(), {
      ownKeys: () => {
        throw new Error(`trap ${DUMMY_KEY}`);
      },
    });
    const error = rejection(hostile);
    assert.equal(error.cause, undefined);
    assertNotShown(error, DUMMY_KEY);
  });
});

describe("validateInput sends nothing (R-IN-6)", () => {
  const realFetch = globalThis.fetch;
  let calls = 0;

  beforeEach(() => {
    calls = 0;
    globalThis.fetch = (): Promise<Response> => {
      calls++;
      return Promise.reject(new Error("validateInput must not call fetch"));
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("makes no fetch call when validation fails (R-IN-6)", () => {
    rejection({ ...input(), chainId: 0, address: "0x" });
    assert.equal(calls, 0);
  });

  it("makes no fetch call when validation passes (R-IN-6)", () => {
    validateInput(input());
    assert.equal(calls, 0);
  });
});
