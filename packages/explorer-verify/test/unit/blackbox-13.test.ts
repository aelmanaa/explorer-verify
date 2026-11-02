// Black-box tests for issue #13: validateInput. They use only the public entry point and the
// promises in the issue, R-IN-1, R-IN-6, R-SEC-1, decision 0009 and the user docs.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ExplorerVerifyError, validateInput } from "../../src/index.ts";
import type { InputIssue, VerifyInput } from "../../src/index.ts";

// --- fixtures -----------------------------------------------------------------------------------

const DUMMY_KEY = "DUMMYKEY13ABCDEFGHIJKLMNOPQRSTUV";

const BASE_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

abstract contract Base {
    address public owner;

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }
}
`;

const TOKEN_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.sol";

contract Token is Base {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    constructor(address initialOwner, uint256 supply) Base(initialOwner) {
        balanceOf[initialOwner] = supply;
        totalSupply = supply;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        balanceOf[to] += amount;
        totalSupply += amount;
    }
}
`;

const GREETER_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract Greeter {
    string public greeting = "hello";
}
`;

const ADDRESS_MIXED = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const ADDRESS_LOWER = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
// abi.encode(address(0x...dEaD), uint256(1e24))
const CONSTRUCTOR_ARGS =
  "0x000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000d3c21bcecceda1000000";
const TX_HASH = "0x8a0b6b7e3f0d2c1a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a";

interface Fixture {
  input: VerifyInput;
  tokenSource: { content: string };
  settings: Record<string, unknown>;
  optimizer: { enabled: boolean; runs: number };
}

function tokenFixture(): Fixture {
  const tokenSource = { content: TOKEN_SOL };
  const optimizer = { enabled: true, runs: 200 };
  const settings: Record<string, unknown> = {
    optimizer,
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "metadata"] } },
    metadata: { bytecodeHash: "ipfs" },
    remappings: [],
  };
  const input: VerifyInput = {
    chainId: 11155111,
    address: ADDRESS_MIXED,
    compiler: {
      kind: "solc",
      version: "0.8.24+commit.e11b9ed9",
      input: {
        language: "Solidity",
        sources: { "src/Base.sol": { content: BASE_SOL }, "src/Token.sol": tokenSource },
        settings,
      },
    },
    contractName: "src/Token.sol:Token",
    constructorArgs: CONSTRUCTOR_ARGS,
    creationTxHash: TX_HASH,
  };
  return { input, tokenSource, settings, optimizer };
}

function hardhatInput(): VerifyInput {
  return {
    chainId: 84532,
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    compiler: {
      kind: "solc",
      version: "v0.8.26+commit.8a97fa7a",
      input: {
        language: "Solidity",
        sources: { "project/contracts/Greeter.sol": { content: GREETER_SOL } },
        settings: { optimizer: { enabled: false, runs: 200 }, evmVersion: "cancun" },
      },
    },
    contractName: "project/contracts/Greeter.sol:Greeter",
  };
}

/** A copy of the valid token input with some fields replaced, typed loosely on purpose. */
function withFields(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...tokenFixture().input, ...patch };
}

function withCompiler(patch: Record<string, unknown>): Record<string, unknown> {
  const { input } = tokenFixture();
  return { ...input, compiler: { ...input.compiler, ...patch } };
}

function withStandardJson(patch: Record<string, unknown>): Record<string, unknown> {
  const { input } = tokenFixture();
  return {
    ...input,
    compiler: { ...input.compiler, input: { ...input.compiler.input, ...patch } },
  };
}

function rejectionOf(value: unknown): ExplorerVerifyError {
  let caught: unknown;
  try {
    validateInput(value);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ExplorerVerifyError, "throws ExplorerVerifyError");
  return caught;
}

function issuesOf(error: ExplorerVerifyError): InputIssue[] {
  assert.equal(error.code, "invalid-input");
  assert.equal(error.details.code, "invalid-input");
  if (error.details.code !== "invalid-input") return [];
  return error.details.issues;
}

function assertRejectsField(value: unknown, field: string): ExplorerVerifyError {
  const error = rejectionOf(value);
  const fields = issuesOf(error).map((issue) => issue.field);
  assert.ok(fields.includes(field), `issues name ${field}; got ${JSON.stringify(fields)}`);
  assert.ok(error.message.includes(field), `message names ${field}: ${error.message}`);
  return error;
}

function everyText(error: ExplorerVerifyError): string[] {
  return [
    error.message,
    error.hint,
    String(error),
    error.stack ?? "",
    JSON.stringify(error),
    JSON.stringify(error.toJSON()),
    JSON.stringify(error.details),
    error.docsUrl,
  ];
}

// --- no network ---------------------------------------------------------------------------------

let fetchCalls = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = (): Promise<Response> => {
    fetchCalls += 1;
    return Promise.reject(new Error("validateInput must not call fetch"));
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  assert.equal(fetchCalls, 0, "no fetch call (R-IN-6)");
});

// --- valid inputs -------------------------------------------------------------------------------

describe("blackbox #13: valid inputs pass and come back usable (R-IN-1, R-IN-6)", () => {
  it("a two-file Standard JSON with constructor args and a creation hash passes", () => {
    const { input } = tokenFixture();
    const result = validateInput(input);
    assert.equal(result.chainId, 11155111);
    assert.equal(result.address, ADDRESS_LOWER);
    assert.equal(result.compiler.kind, "solc");
    assert.equal(result.compiler.version, "0.8.24+commit.e11b9ed9");
    assert.equal(result.contractName, "src/Token.sol:Token");
    assert.equal(result.constructorArgs, CONSTRUCTOR_ARGS);
    assert.equal(result.creationTxHash, TX_HASH);
    assert.deepEqual(result.compiler.input, tokenFixture().input.compiler.input);
  });

  it("a v-prefixed version loses the v; a Hardhat 3 source name passes", () => {
    const result = validateInput(hardhatInput());
    assert.equal(result.compiler.version, "0.8.26+commit.8a97fa7a");
    assert.equal(result.contractName, "project/contracts/Greeter.sol:Greeter");
    assert.equal(result.address, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    assert.equal(result.constructorArgs, undefined);
    assert.equal(result.creationTxHash, undefined);
  });

  it("nightly versions pass, with and without v", () => {
    for (const version of [
      "0.8.27-nightly.2024.7.1+commit.d5bf47e0",
      "v0.8.28-nightly.2024.10.11+commit.3a2d1c0b",
    ]) {
      const result = validateInput(withCompiler({ version }));
      assert.equal(result.compiler.version, version.replace(/^v/, ""));
    }
  });

  it("the result validates again to an equal value (idempotent)", () => {
    const once = validateInput(tokenFixture().input);
    assert.deepEqual(validateInput(once), once);
  });

  it("the same input gives the same output twice (deterministic)", () => {
    assert.deepEqual(validateInput(tokenFixture().input), validateInput(tokenFixture().input));
    const bad = { ...withFields({ chainId: 0, address: "0x1" }) };
    assert.deepEqual(issuesOf(rejectionOf(bad)), issuesOf(rejectionOf(bad)));
  });
});

// --- no aliasing --------------------------------------------------------------------------------

describe("blackbox #13: the result does not alias the caller's objects", () => {
  it("the caller's input is not changed", () => {
    const input = hardhatInput();
    const before = structuredClone(input);
    validateInput(input);
    assert.deepEqual(input, before);
    assert.equal(input.compiler.version, "v0.8.26+commit.8a97fa7a");
  });

  it("mutating top-level fields, sources or settings keys after validation leaves the result unchanged", () => {
    const { input, tokenSource, settings } = tokenFixture();
    const result = validateInput(input);
    const snapshot = structuredClone(result);

    input.chainId = 1;
    input.contractName = "src/Base.sol:Base";
    input.compiler.version = "0.8.25+commit.b61c2a91";
    input.compiler.input.sources["src/Evil.sol"] = { content: "contract Evil {}" };
    tokenSource.content = "contract Changed {}";
    settings["evmVersion"] = "paris";

    assert.deepEqual(result, snapshot);
    assert.notEqual(result, input);
    assert.notEqual(result.compiler, input.compiler);
    assert.notEqual(result.compiler.input, input.compiler.input);
    assert.notEqual(result.compiler.input.sources, input.compiler.input.sources);
    assert.notEqual(result.compiler.input.settings, input.compiler.input.settings);
  });

  it("mutating a nested settings object after validation leaves the result unchanged", () => {
    const { input, optimizer } = tokenFixture();
    const result = validateInput(input);
    const snapshot = structuredClone(result);
    optimizer.runs = 1;
    assert.deepEqual(result, snapshot);
  });
});

// --- rejections, one per rule -------------------------------------------------------------------

describe("blackbox #13: every promised rejection names its field (R-IN-6)", () => {
  it("chainId must be a positive safe integer", () => {
    for (const chainId of [0, -1, 1.5, "1", "11155111", Number.NaN, Infinity, 2 ** 53, null]) {
      assertRejectsField(withFields({ chainId }), "chainId");
    }
  });

  it("address must be 0x and 40 hex digits", () => {
    for (const address of [
      "5FbDB2315678afecb367f032d93F642f64180aa3",
      "0x5FbDB2315678afecb367f032d93F642f64180aa",
      "0x5FbDB2315678afecb367f032d93F642f64180aa3a",
      "0x5FbDB2315678afecb367f032d93F642f64180aag",
      "vitalik.eth",
      "",
      12345,
    ]) {
      assertRejectsField(withFields({ address }), "address");
    }
  });

  it("contractName must be path:Name with a known path and a Solidity identifier", () => {
    for (const contractName of [
      "Token",
      "src/Token.sol",
      "src/Missing.sol:Token",
      "Token.sol:Token",
      "src/Token.sol:",
      ":Token",
      "src/Token.sol:1Token",
      "src/Token.sol:Tok-en",
      "src/Token.sol:Tok en",
      "src/Token.sol:Tökén",
      "",
      42,
    ]) {
      assertRejectsField(withFields({ contractName }), "contractName");
    }
  });

  it("compiler.kind must be solc, and the hint names the supported kind", () => {
    for (const kind of ["vyper", "solidity", "", undefined]) {
      const error = assertRejectsField(withCompiler({ kind }), "compiler.kind");
      assert.match(error.hint, /solc/);
    }
  });

  it("compiler.version must be the full form", () => {
    for (const version of [
      "latest",
      "^0.8.24",
      "0.8.24+commit.e11b9ed",
      "0.8.24+commit.e11b9ed9z",
      "0.8+commit.e11b9ed9",
      "0.8.24-nightly+commit.e11b9ed9",
      " 0.8.24+commit.e11b9ed9",
      "",
      824,
    ]) {
      assertRejectsField(withCompiler({ version }), "compiler.version");
    }
  });

  it("a short compiler.version gets a hint to pass the full version", () => {
    for (const version of ["0.8.24", "v0.8.24"]) {
      const error = assertRejectsField(withCompiler({ version }), "compiler.version");
      assert.match(error.hint, /full|long|commit/i);
    }
  });

  it("compiler.input.language must be Solidity", () => {
    for (const language of ["Yul", "Vyper", "solidity", ""]) {
      assertRejectsField(withStandardJson({ language }), "compiler.input.language");
    }
  });

  it("compiler.input.sources needs at least one entry, each with a string content", () => {
    for (const sources of [
      {},
      { "src/Token.sol": {} },
      { "src/Token.sol": { content: 1 } },
      { "src/Token.sol": { content: TOKEN_SOL }, "src/Base.sol": { urls: ["ipfs://Qm"] } },
      "not an object",
      null,
    ]) {
      const error = rejectionOf(withStandardJson({ sources }));
      const fields = issuesOf(error).map((issue) => issue.field);
      assert.ok(
        fields.some((field) => field.startsWith("compiler.input.sources")),
        `issues name compiler.input.sources; got ${JSON.stringify(fields)}`,
      );
    }
  });

  it("constructorArgs, when present, must be 0x and an even number of hex digits", () => {
    for (const constructorArgs of ["0xabc", "abcd", "0xzz", "0X00", 0, ""]) {
      assertRejectsField(withFields({ constructorArgs }), "constructorArgs");
    }
  });

  it("creationTxHash, when present, must be 0x and 64 hex digits", () => {
    for (const creationTxHash of [
      TX_HASH.slice(0, -1),
      `${TX_HASH}0`,
      TX_HASH.slice(2),
      `${TX_HASH.slice(0, -1)}g`,
      "",
    ]) {
      assertRejectsField(withFields({ creationTxHash }), "creationTxHash");
    }
  });

  it("rejections are invalid-input, not retryable, with the docs entry and no handle", () => {
    const error = rejectionOf(withFields({ chainId: 0 }));
    assert.equal(error.name, "ExplorerVerifyError");
    assert.equal(error.retryable, false);
    assert.match(error.docsUrl, /#invalid-input$/);
    const json = error.toJSON();
    assert.equal(json.code, "invalid-input");
    assert.equal(json.handle, undefined);
    assert.ok(error.hint.length > 0);
  });

  it("non-object inputs are rejected with invalid-input, not a TypeError", () => {
    for (const value of [null, undefined, 42, "input", [], {}]) {
      const error = rejectionOf(value);
      assert.ok(issuesOf(error).length > 0);
    }
  });

  it("an empty object reports each required top-level field", () => {
    const fields = issuesOf(rejectionOf({})).map((issue) => issue.field);
    for (const field of ["chainId", "address", "contractName"]) {
      assert.ok(fields.includes(field), `missing ${field} in ${JSON.stringify(fields)}`);
    }
    assert.ok(fields.some((field) => field.startsWith("compiler")));
  });
});

// --- several bad fields -------------------------------------------------------------------------

describe("blackbox #13: several bad fields are all reported (R-IN-6)", () => {
  it("three bad fields give one error listing all three", () => {
    const error = rejectionOf(
      withFields({
        chainId: -5,
        address: "0x1234",
        compiler: {
          ...tokenFixture().input.compiler,
          version: "0.8.24",
        },
      }),
    );
    const fields = issuesOf(error).map((issue) => issue.field);
    for (const field of ["chainId", "address", "compiler.version"]) {
      assert.ok(fields.includes(field), `issues name ${field}; got ${JSON.stringify(fields)}`);
      assert.ok(error.message.includes(field), `message names ${field}`);
    }
    assert.equal(fields.length, 3, "only the three bad fields are reported");
  });

  it("every rule broken at once reports each field, each once", () => {
    const error = rejectionOf({
      chainId: 0,
      address: "nope",
      compiler: {
        kind: "vyper",
        version: "0.8",
        input: { language: "Yul", sources: {}, settings: {} },
      },
      contractName: "Token",
      constructorArgs: "0x1",
      creationTxHash: "0x1",
    });
    const fields = issuesOf(error).map((issue) => issue.field);
    for (const field of [
      "chainId",
      "address",
      "compiler.kind",
      "compiler.version",
      "compiler.input.language",
      "contractName",
      "constructorArgs",
      "creationTxHash",
    ]) {
      assert.ok(fields.includes(field), `issues name ${field}; got ${JSON.stringify(fields)}`);
    }
    assert.ok(fields.some((field) => field.startsWith("compiler.input.sources")));
    assert.equal(new Set(fields).size, fields.length, "no field reported twice");
  });
});

// --- secrets ------------------------------------------------------------------------------------

describe("blackbox #13: values are never echoed (R-SEC-1)", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["chainId", withFields({ chainId: DUMMY_KEY })],
    ["address", withFields({ address: `0x${DUMMY_KEY}` })],
    ["address (plain key)", withFields({ address: DUMMY_KEY })],
    ["contractName name part", withFields({ contractName: `src/Token.sol:${DUMMY_KEY}-x` })],
    ["contractName path part", withFields({ contractName: `src/${DUMMY_KEY}.sol:Token` })],
    ["contractName without colon", withFields({ contractName: DUMMY_KEY })],
    ["compiler.kind", withCompiler({ kind: DUMMY_KEY })],
    ["compiler.version", withCompiler({ version: DUMMY_KEY })],
    ["compiler.version (key in commit)", withCompiler({ version: `0.8.24+commit.${DUMMY_KEY}` })],
    ["compiler.input.language", withStandardJson({ language: DUMMY_KEY })],
    [
      "source path with bad content",
      withStandardJson({ sources: { [DUMMY_KEY]: { content: 1 } } }),
    ],
    ["source content not a string", withStandardJson({ sources: { "a.sol": DUMMY_KEY } })],
    ["constructorArgs", withFields({ constructorArgs: `0x${DUMMY_KEY}` })],
    ["creationTxHash", withFields({ creationTxHash: DUMMY_KEY })],
    ["settings not an object", withStandardJson({ settings: DUMMY_KEY })],
  ];

  for (const [label, value] of cases) {
    it(`a dummy key in ${label} is not echoed`, () => {
      const error = rejectionOf(value);
      for (const text of everyText(error)) {
        assert.ok(!text.includes(DUMMY_KEY), `key echoed: ${label}`);
        assert.ok(!text.includes(DUMMY_KEY.slice(0, 12)), `key prefix echoed: ${label}`);
      }
    });
  }

  it("a dummy key in every field at once is not echoed", () => {
    const error = rejectionOf({
      chainId: DUMMY_KEY,
      address: DUMMY_KEY,
      compiler: {
        kind: DUMMY_KEY,
        version: DUMMY_KEY,
        input: {
          language: DUMMY_KEY,
          sources: { [DUMMY_KEY]: { content: 0 } },
          settings: DUMMY_KEY,
        },
      },
      contractName: `${DUMMY_KEY}:${DUMMY_KEY}`,
      constructorArgs: DUMMY_KEY,
      creationTxHash: DUMMY_KEY,
    });
    for (const text of everyText(error)) assert.ok(!text.includes(DUMMY_KEY));
  });

  it("a key in a valid source path is kept in the result, not lost", () => {
    const { input } = tokenFixture();
    const path = `src/${DUMMY_KEY}.sol`;
    const value = {
      ...input,
      compiler: {
        ...input.compiler,
        input: { ...input.compiler.input, sources: { [path]: { content: GREETER_SOL } } },
      },
      contractName: `${path}:Greeter`,
    };
    assert.equal(validateInput(value).contractName, `${path}:Greeter`);
  });
});
