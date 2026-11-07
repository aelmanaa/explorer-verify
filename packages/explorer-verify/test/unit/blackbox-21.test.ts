// Black-box tests for issue #21: buildVerifyInput rebuilds the Standard JSON input from Solidity
// metadata and sources. Written from the issue, R-IN-7, the how-to "Verify a contract shipped in an
// npm package" (section "Rebuild the input from Solidity metadata"), errors/source-mismatch.md (`source-mismatch`,
// `incomplete-input`) and the buildVerifyInput TSDoc only.
//
// The data at the end of this file comes from fresh solc-js 0.8.24 compiles of contracts that are
// not in the committed fixtures:
// - TREE: an import tree through a remapping (`@oz/=lib/oz/contracts/`), a relative import, a
//   linked external library and a non-ASCII comment;
// - NONE: `bytecodeHash: "none"`, `evmVersion: "paris"`, `debug.revertStrings: "strip"`;
// - VIAIR: `viaIR: true`, optimizer at 1000 runs with `details.peephole: false`, `cancun`;
// - LITERAL: `useLiteralContent: true`, so the metadata embeds the source;
// - NOCBOR: `appendCBOR: false`.
// For each case the input that buildVerifyInput rebuilt was compiled again with solc-js 0.8.24
// outside the test. Its creation bytecode, runtime bytecode and metadata equaled the original's
// for TREE, NONE, VIAIR and LITERAL; `reproducedSettings` records the settings of that input, and
// the tests below assert the builder still returns exactly that input. NOCBOR failed to compile.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ERROR_EXIT_CODES } from "../../src/envelope.ts";
import { ExplorerVerifyError, buildVerifyInput, validateInput } from "../../src/index.ts";
import type { BuiltVerifyInput } from "../../src/index.ts";

// --- helpers -----------------------------------------------------------------------------------

const VERSION = "0.8.24+commit.e11b9ed9";
const HASH = /^0x[0-9a-f]{64}$/;

function obj(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "expected an object",
  );
  const copy: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return copy;
}

function parse(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  return obj(parsed);
}

function caught(run: () => unknown): ExplorerVerifyError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ExplorerVerifyError, "expected an ExplorerVerifyError");
  return thrown;
}

function keccakOf(meta: Record<string, unknown>, path: string): string {
  const value = obj(obj(meta.sources)[path]).keccak256;
  assert.equal(typeof value, "string");
  return String(value);
}

/** What the docs say the rebuilt settings are: the metadata settings without compilationTarget,
 * libraries regrouped by path. outputSelection is checked separately. */
function expectedSettings(meta: Record<string, unknown>): Record<string, unknown> {
  const settings = obj(meta.settings);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key === "compilationTarget") continue;
    if (key === "libraries") {
      const grouped: Record<string, Record<string, unknown>> = {};
      for (const [full, address] of Object.entries(obj(value))) {
        const cut = full.lastIndexOf(":");
        const path = full.slice(0, cut);
        const name = full.slice(cut + 1);
        grouped[path] = { ...grouped[path], [name]: address };
      }
      result[key] = grouped;
      continue;
    }
    result[key] = value;
  }
  return result;
}

function withoutOutputSelection(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "outputSelection"));
}

function assertSelectsAbiBytecodeMetadata(
  settings: Record<string, unknown>,
  path: string,
  name: string,
): void {
  const selection = obj(settings.outputSelection);
  const selected = new Set<unknown>();
  for (const file of [path, "*"]) {
    if (!(file in selection)) continue;
    const perFile = obj(selection[file]);
    for (const contract of [name, "*"]) {
      const list = perFile[contract];
      if (Array.isArray(list)) for (const item of list) selected.add(item);
    }
  }
  assert.ok(selected.has("abi") || selected.has("*"), "abi selected");
  assert.ok(selected.has("metadata") || selected.has("*"), "metadata selected");
  assert.ok(
    selected.has("evm.bytecode") ||
      selected.has("evm.bytecode.object") ||
      selected.has("evm") ||
      selected.has("*"),
    "bytecode selected",
  );
}

function sourcesInput(sources: Record<string, string>): Record<string, { content: string }> {
  return Object.fromEntries(Object.entries(sources).map(([path, content]) => [path, { content }]));
}

/** The full check for one case: name, version, language, sources, settings, reproduced input. */
function assertRebuilt(built: BuiltVerifyInput, c: Case, path: string, name: string): void {
  const meta = parse(c.metadata);
  assert.equal(built.contractName, `${path}:${name}`);
  assert.equal(built.compiler.kind, "solc");
  assert.equal(built.compiler.version, VERSION);
  const input = built.compiler.input;
  assert.deepEqual(Object.keys(input).toSorted(), ["language", "settings", "sources"]);
  assert.equal(input.language, "Solidity");
  assert.deepEqual(input.sources, sourcesInput(c.sources));
  assert.deepEqual(withoutOutputSelection(input.settings), expectedSettings(meta));
  assert.equal("compilationTarget" in input.settings, false);
  assertSelectsAbiBytecodeMetadata(input.settings, path, name);
  if (c.reproducedSettings !== undefined) assert.deepEqual(input.settings, c.reproducedSettings);
  // The result passes validateInput as a VerifyInput.
  validateInput({
    chainId: 11155111,
    address: "0x000000000000000000000000000000000000dEaD",
    ...built,
  });
}

function assertMismatch(
  error: ExplorerVerifyError,
  path: string,
  expected: string,
  actual: string,
): void {
  assert.equal(error.code, "source-mismatch");
  assert.equal(ERROR_EXIT_CODES[error.code], 2);
  assert.equal(error.retryable, false);
  assert.ok(error.details.code === "source-mismatch");
  assert.equal(error.details.path, path);
  assert.equal(error.details.expected, expected);
  assert.equal(error.details.actual, actual);
  assert.match(error.details.actual, HASH);
  // Messages never repeat a value or a path.
  assert.equal(error.message.includes(path), false);
  assert.equal(error.message.includes(actual), false);
  assert.equal(error.message.includes(expected.slice(2)), false);
}

// --- the fresh contracts rebuild and reproduce the bytecode ------------------------------------

describe("blackbox #21: rebuilt inputs reproduce fresh solc 0.8.24 builds", () => {
  it("import tree with remappings, a linked library and UTF-8 content (metadata string)", () => {
    const built = buildVerifyInput([TREE.metadata], { sources: TREE.sources });
    assertRebuilt(built, TREE, "src/Vault.sol", "Vault");
    assert.deepEqual(built.compiler.input.settings.remappings, [":@oz/=lib/oz/contracts/"]);
    assert.deepEqual(built.compiler.input.settings.libraries, {
      "src/math/Fee.sol": { Fee: "0x00000000000000000000000000000000000000fe" },
    });
  });

  it("import tree from a parsed metadata object", () => {
    const built = buildVerifyInput([parse(TREE.metadata)], { sources: TREE.sources });
    assertRebuilt(built, TREE, "src/Vault.sol", "Vault");
  });

  it("import tree from a Foundry-like artifact with rawMetadata and metadata", () => {
    const artifact = {
      abi: [],
      bytecode: { object: `0x${TREE.creation}` },
      deployedBytecode: { object: `0x${TREE.runtime}` },
      rawMetadata: TREE.metadata,
      metadata: parse(TREE.metadata),
    };
    const built = buildVerifyInput([artifact], { sources: TREE.sources });
    assertRebuilt(built, TREE, "src/Vault.sol", "Vault");
  });

  it("an artifact with only a metadata string", () => {
    const built = buildVerifyInput([{ abi: [], metadata: TREE.metadata }], {
      sources: TREE.sources,
    });
    assertRebuilt(built, TREE, "src/Vault.sol", "Vault");
  });

  it("bytecodeHash none, paris and debug.revertStrings strip", () => {
    const built = buildVerifyInput([NONE.metadata], { sources: NONE.sources });
    assertRebuilt(built, NONE, "contracts/Plain.sol", "Plain");
    assert.deepEqual(built.compiler.input.settings.metadata, { bytecodeHash: "none" });
    assert.deepEqual(built.compiler.input.settings.debug, { revertStrings: "strip" });
    assert.equal(built.compiler.input.settings.evmVersion, "paris");
  });

  it("viaIR with the optimizer and non-default optimizer details", () => {
    const built = buildVerifyInput([VIAIR.metadata], { sources: VIAIR.sources });
    assertRebuilt(built, VIAIR, "src/Accumulator.sol", "Accumulator");
    assert.equal(built.compiler.input.settings.viaIR, true);
    assert.equal(obj(obj(built.compiler.input.settings.optimizer).details).peephole, false);
  });

  it("literal content needs no sources", () => {
    const built = buildVerifyInput([LITERAL.metadata]);
    assertRebuilt(built, LITERAL, "contracts/Plain.sol", "Plain");
  });

  it("literal content wins over a differing options.sources entry", () => {
    const built = buildVerifyInput([LITERAL.metadata], {
      sources: {
        "contracts/Plain.sol": `${LITERAL.sources["contracts/Plain.sol"] ?? ""}// other\n`,
      },
    });
    assertRebuilt(built, LITERAL, "contracts/Plain.sol", "Plain");
  });

  it("appendCBOR false: the rebuilt settings are accepted by solc (no bytecodeHash ipfs)", () => {
    // solc 0.8.24 records bytecodeHash "ipfs" in the metadata even with appendCBOR false, and
    // rejects that pair in an input: 'When the parameter "appendCBOR" is set to false, the
    // parameter "bytecodeHash" cannot be set to "ipfs"'. Without bytecodeHash the compile
    // reproduces the bytecode and the metadata.
    const built = buildVerifyInput([NOCBOR.metadata], { sources: NOCBOR.sources });
    const metadata = obj(built.compiler.input.settings.metadata);
    assert.equal(metadata.appendCBOR, false);
    assert.notEqual(metadata.bytecodeHash, "ipfs");
  });

  it("the document order and a duplicate document do not change the result", () => {
    const one = buildVerifyInput([TREE.metadata], { sources: TREE.sources });
    const two = buildVerifyInput([parse(TREE.metadata), TREE.metadata], { sources: TREE.sources });
    assert.deepEqual(two, one);
  });

  it("returns a copy: mutating the result does not change a later build", () => {
    const meta = parse(VIAIR.metadata);
    const first = buildVerifyInput([meta], { sources: VIAIR.sources });
    first.compiler.input.settings.viaIR = false;
    obj(first.compiler.input.sources["src/IAcc.sol"]).content = "x";
    const second = buildVerifyInput([meta], { sources: VIAIR.sources });
    assertRebuilt(second, VIAIR, "src/Accumulator.sol", "Accumulator");
  });
});

// --- documented failures -----------------------------------------------------------------------

describe("blackbox #21: documented failures", () => {
  it("missing sources: incomplete-input, field sources, every missing path sorted", () => {
    const partial = { "src/Vault.sol": TREE.sources["src/Vault.sol"] ?? "" };
    const error = caught(() => buildVerifyInput([TREE.metadata], { sources: partial }));
    assert.equal(error.code, "incomplete-input");
    assert.equal(ERROR_EXIT_CODES[error.code], 2);
    assert.equal(error.retryable, false);
    assert.ok(error.details.code === "incomplete-input");
    assert.equal(error.details.field, "sources");
    assert.deepEqual(error.details.candidates, [
      "lib/oz/contracts/access/Owned.sol",
      "lib/oz/contracts/utils/Ctx.sol",
      "src/math/Fee.sol",
    ]);
  });

  it("no sources at all for metadata without content: incomplete-input lists all four", () => {
    const error = caught(() => buildVerifyInput([TREE.metadata]));
    assert.ok(error.details.code === "incomplete-input");
    assert.equal(error.details.field, "sources");
    assert.deepEqual(error.details.candidates, Object.keys(TREE.sources).toSorted());
  });

  it("one changed byte in one source: source-mismatch with the path and both hashes", () => {
    const meta = parse(TREE.metadata);
    const mutation = MUTATIONS.feeOneByte;
    assert.ok(mutation !== undefined);
    const error = caught(() =>
      buildVerifyInput([TREE.metadata], {
        sources: { ...TREE.sources, "src/math/Fee.sol": mutation.content },
      }),
    );
    assertMismatch(
      error,
      "src/math/Fee.sol",
      keccakOf(meta, "src/math/Fee.sol"),
      mutation.keccak256,
    );
  });

  it("CRLF line endings: source-mismatch", () => {
    const meta = parse(TREE.metadata);
    const mutation = MUTATIONS.vaultCrlf;
    assert.ok(mutation !== undefined);
    assert.ok(mutation.content.includes("\r\n"));
    const error = caught(() =>
      buildVerifyInput([TREE.metadata], {
        sources: { ...TREE.sources, "src/Vault.sol": mutation.content },
      }),
    );
    assertMismatch(error, "src/Vault.sol", keccakOf(meta, "src/Vault.sol"), mutation.keccak256);
  });

  it("a trailing newline: source-mismatch", () => {
    const meta = parse(NONE.metadata);
    const mutation = MUTATIONS.plainTrailingNewline;
    assert.ok(mutation !== undefined);
    const error = caught(() =>
      buildVerifyInput([NONE.metadata], { sources: { "contracts/Plain.sol": mutation.content } }),
    );
    assertMismatch(
      error,
      "contracts/Plain.sol",
      keccakOf(meta, "contracts/Plain.sol"),
      mutation.keccak256,
    );
  });

  it("embedded literal content that does not match its keccak256: source-mismatch", () => {
    const meta = parse(LITERAL.metadata);
    const mutation = MUTATIONS.plainTampered;
    assert.ok(mutation !== undefined);
    const expected = keccakOf(meta, "contracts/Plain.sol");
    const tampered = {
      ...meta,
      sources: { "contracts/Plain.sol": { keccak256: expected, content: mutation.content } },
    };
    const error = caught(() => buildVerifyInput([tampered]));
    assertMismatch(error, "contracts/Plain.sol", expected, mutation.keccak256);
  });

  it("a metadata keccak256 of another form: source-mismatch with expected 0x", () => {
    const meta = parse(NONE.metadata);
    const tampered = {
      ...meta,
      sources: { "contracts/Plain.sol": { keccak256: "0x1234", license: "MIT" } },
    };
    const error = caught(() => buildVerifyInput([tampered], { sources: NONE.sources }));
    assert.equal(error.code, "source-mismatch");
    assert.ok(error.details.code === "source-mismatch");
    assert.equal(error.details.expected, "0x");
    assert.match(error.details.actual, HASH);
    assert.equal(error.details.actual, keccakOf(meta, "contracts/Plain.sol"));
  });

  it("a mismatch on one file and a missing other file: some error is thrown, never a result", () => {
    const fee = MUTATIONS.feeOneByte;
    assert.ok(fee !== undefined);
    const error = caught(() =>
      buildVerifyInput([TREE.metadata], { sources: { "src/math/Fee.sol": fee.content } }),
    );
    assert.ok(error.code === "incomplete-input" || error.code === "source-mismatch");
  });

  it("two compilationTarget entries: invalid-input", () => {
    const meta = parse(TREE.metadata);
    const settings = {
      ...obj(meta.settings),
      compilationTarget: { "src/Vault.sol": "Vault", "src/math/Fee.sol": "Fee" },
    };
    const error = caught(() =>
      buildVerifyInput([{ ...meta, settings }], { sources: TREE.sources }),
    );
    assert.equal(error.code, "invalid-input");
  });

  it("two compilationTarget entries are not rescued by options.contract", () => {
    const meta = parse(TREE.metadata);
    const settings = {
      ...obj(meta.settings),
      compilationTarget: { "src/Vault.sol": "Vault", "src/math/Fee.sol": "Fee" },
    };
    const error = caught(() =>
      buildVerifyInput([{ ...meta, settings }], {
        sources: TREE.sources,
        contract: "src/Vault.sol:Vault",
      }),
    );
    assert.equal(error.code, "invalid-input");
  });

  it("metadata of several contracts: incomplete-input contract with the candidates", () => {
    const error = caught(() =>
      buildVerifyInput([TREE.metadata, FEE_METADATA], { sources: TREE.sources }),
    );
    assert.equal(error.code, "incomplete-input");
    assert.ok(error.details.code === "incomplete-input");
    assert.equal(error.details.field, "contract");
    assert.deepEqual(error.details.candidates, ["src/Vault.sol:Vault", "src/math/Fee.sol:Fee"]);
  });

  it("metadata of several contracts: options.contract picks one, by full or bare name", () => {
    for (const contract of ["src/Vault.sol:Vault", "Vault"]) {
      const built = buildVerifyInput([FEE_METADATA, TREE.metadata], {
        sources: TREE.sources,
        contract,
      });
      assertRebuilt(built, TREE, "src/Vault.sol", "Vault");
    }
    const fee = buildVerifyInput([TREE.metadata, FEE_METADATA], {
      sources: TREE.sources,
      contract: "Fee",
    });
    assert.equal(fee.contractName, "src/math/Fee.sol:Fee");
    assert.deepEqual(Object.keys(fee.compiler.input.sources), ["src/math/Fee.sol"]);
    assert.deepEqual(fee.compiler.input.settings.libraries, {
      "src/math/Fee.sol": { Fee: "0x00000000000000000000000000000000000000fe" },
    });
  });

  it("a compilerVersion option that differs from the metadata: invalid-input", () => {
    const error = caught(() =>
      buildVerifyInput([TREE.metadata], {
        sources: TREE.sources,
        compilerVersion: "0.8.25+commit.b61c2a91",
      }),
    );
    assert.equal(error.code, "invalid-input");
  });
});

// --- generated data (solc-js 0.8.24+commit.e11b9ed9, 2026-11-03) ---------------------------------
interface Case {
  /** The metadata string solc returned. */
  metadata: string;
  /** The source files, as compiled. */
  sources: Record<string, string>;
  /** Creation and runtime bytecode of the original compile. */
  creation: string;
  runtime: string;
  /**
   * The settings of the rebuilt input that was compiled again with solc-js 0.8.24: its creation
   * bytecode, runtime bytecode and metadata equaled the original's. Undefined when that compile failed.
   */
  reproducedSettings: Record<string, unknown> | undefined;
}

const TREE: Case = {
  metadata:
    '{"compiler":{"version":"0.8.24+commit.e11b9ed9"},"language":"Solidity","output":{"abi":[{"inputs":[{"internalType":"uint256","name":"b","type":"uint256"}],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[],"name":"bps","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"quote","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}],"devdoc":{"kind":"dev","methods":{},"version":1},"userdoc":{"kind":"user","methods":{},"version":1}},"settings":{"compilationTarget":{"src/Vault.sol":"Vault"},"evmVersion":"shanghai","libraries":{"src/math/Fee.sol:Fee":"0x00000000000000000000000000000000000000fe"},"metadata":{"bytecodeHash":"ipfs"},"optimizer":{"enabled":false,"runs":200},"remappings":[":@oz/=lib/oz/contracts/"]},"sources":{"lib/oz/contracts/access/Owned.sol":{"keccak256":"0x35343de785779f76ba43d9c97023acc96770089103458a6fff607f7cb6703f43","license":"MIT","urls":["bzz-raw://a7d0dda0bcf3fd159cfe742e8c85ed7419c4fe6cff00437035dec7f23a773254","dweb:/ipfs/Qmco25mb3Xaa5MpDYAwoiYmaFVv6uVV95KrXrecCZ5JfXM"]},"lib/oz/contracts/utils/Ctx.sol":{"keccak256":"0x4fb378bcf2034e9e262dc56228591885d332216f04b9dc423c71095717b0fb83","license":"MIT","urls":["bzz-raw://77635b21891aa7874990c7dd89187cbaf3155b783ff98bac1e1e5f1ab738e7b6","dweb:/ipfs/QmPMeTXKP4yF4Xojtrr78gXJP1R1yiLcnqJcdbQKN8rgUC"]},"src/Vault.sol":{"keccak256":"0xfcf294e15e9f9736fff43f22d6e6d18f880156fddc5cfe3b6449a0415fe4d986","license":"MIT","urls":["bzz-raw://3981fcc4d74474b095bd25b84e14bc0289cea1de146765afd37507176c8dec26","dweb:/ipfs/QmP5GuA3vxc1N84XK8xbqwoWDjKUafsRzweYwCEu1dPqG4"]},"src/math/Fee.sol":{"keccak256":"0x64aa3492601281af0c51da2705551024586ef296dc61395ab722389a428252d0","license":"MIT","urls":["bzz-raw://889d8b84453cbf58a532784af0b30804226dc53f1691ebd392bf135c4981b7a9","dweb:/ipfs/QmfBckohwpoUhSPCeE4aJwYQtLZwXsvD7GfonxPiSpZUuW"]}},"version":1}',
  sources: {
    "src/Vault.sol":
      '// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\n\n// Vault — café ✓ (non-ASCII comment for the UTF-8 hash)\nimport {Owned} from "@oz/access/Owned.sol";\nimport {Fee} from "./math/Fee.sol";\n\ncontract Vault is Owned {\n    uint256 public immutable bps;\n    constructor(uint256 b) { bps = b; }\n    function quote(uint256 amount) external view returns (uint256) { return Fee.take(amount, bps); }\n}\n',
    "src/math/Fee.sol":
      "// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\n\nlibrary Fee {\n    function take(uint256 amount, uint256 bps) public pure returns (uint256) { return amount * bps / 10_000; }\n}\n",
    "lib/oz/contracts/access/Owned.sol":
      '// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\n\nimport {Ctx} from "../utils/Ctx.sol";\n\nabstract contract Owned is Ctx {\n    address public owner;\n    constructor() { owner = _sender(); }\n}\n',
    "lib/oz/contracts/utils/Ctx.sol":
      "// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\n\nabstract contract Ctx {\n    function _sender() internal view returns (address) { return msg.sender; }\n}\n",
  },
  creation:
    "60a060405234801561000f575f80fd5b50604051610435380380610435833981810160405281019061003191906100c9565b61003f61008b60201b60201c565b5f806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055508060808181525050506100f4565b5f33905090565b5f80fd5b5f819050919050565b6100a881610096565b81146100b2575f80fd5b50565b5f815190506100c38161009f565b92915050565b5f602082840312156100de576100dd610092565b5b5f6100eb848285016100b5565b91505092915050565b6080516103236101125f395f818160b1015261011401526103235ff3fe608060405234801561000f575f80fd5b506004361061003f575f3560e01c806368237329146100435780638da5cb5b14610061578063ed1bd76c1461007f575b5f80fd5b61004b6100af565b60405161005891906101ae565b60405180910390f35b6100696100d3565b6040516100769190610206565b60405180910390f35b6100996004803603810190610094919061024d565b6100f6565b6040516100a691906101ae565b60405180910390f35b7f000000000000000000000000000000000000000000000000000000000000000081565b5f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b5f7300000000000000000000000000000000000000fe63978b7c02837f00000000000000000000000000000000000000000000000000000000000000006040518363ffffffff1660e01b8152600401610150929190610287565b602060405180830381865af415801561016b573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061018f91906102c2565b9050919050565b5f819050919050565b6101a881610196565b82525050565b5f6020820190506101c15f83018461019f565b92915050565b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f6101f0826101c7565b9050919050565b610200816101e6565b82525050565b5f6020820190506102195f8301846101f7565b92915050565b5f80fd5b61022c81610196565b8114610236575f80fd5b50565b5f8135905061024781610223565b92915050565b5f602082840312156102625761026161021f565b5b5f61026f84828501610239565b91505092915050565b61028181610196565b82525050565b5f60408201905061029a5f830185610278565b6102a76020830184610278565b9392505050565b5f815190506102bc81610223565b92915050565b5f602082840312156102d7576102d661021f565b5b5f6102e4848285016102ae565b9150509291505056fea264697066735822122032a35472dc3c5e22a623ccf868861342bbe003694bc8be1ec042b6f1651b287c64736f6c63430008180033",
  runtime:
    "608060405234801561000f575f80fd5b506004361061003f575f3560e01c806368237329146100435780638da5cb5b14610061578063ed1bd76c1461007f575b5f80fd5b61004b6100af565b60405161005891906101ae565b60405180910390f35b6100696100d3565b6040516100769190610206565b60405180910390f35b6100996004803603810190610094919061024d565b6100f6565b6040516100a691906101ae565b60405180910390f35b7f000000000000000000000000000000000000000000000000000000000000000081565b5f8054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b5f7300000000000000000000000000000000000000fe63978b7c02837f00000000000000000000000000000000000000000000000000000000000000006040518363ffffffff1660e01b8152600401610150929190610287565b602060405180830381865af415801561016b573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061018f91906102c2565b9050919050565b5f819050919050565b6101a881610196565b82525050565b5f6020820190506101c15f83018461019f565b92915050565b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f6101f0826101c7565b9050919050565b610200816101e6565b82525050565b5f6020820190506102195f8301846101f7565b92915050565b5f80fd5b61022c81610196565b8114610236575f80fd5b50565b5f8135905061024781610223565b92915050565b5f602082840312156102625761026161021f565b5b5f61026f84828501610239565b91505092915050565b61028181610196565b82525050565b5f60408201905061029a5f830185610278565b6102a76020830184610278565b9392505050565b5f815190506102bc81610223565b92915050565b5f602082840312156102d7576102d661021f565b5b5f6102e4848285016102ae565b9150509291505056fea264697066735822122032a35472dc3c5e22a623ccf868861342bbe003694bc8be1ec042b6f1651b287c64736f6c63430008180033",
  reproducedSettings: {
    evmVersion: "shanghai",
    libraries: {
      "src/math/Fee.sol": {
        Fee: "0x00000000000000000000000000000000000000fe",
      },
    },
    metadata: {
      bytecodeHash: "ipfs",
    },
    optimizer: {
      enabled: false,
      runs: 200,
    },
    remappings: [":@oz/=lib/oz/contracts/"],
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"],
      },
    },
  },
};

const NONE: Case = {
  metadata:
    '{"compiler":{"version":"0.8.24+commit.e11b9ed9"},"language":"Solidity","output":{"abi":[{"inputs":[{"internalType":"string","name":"l","type":"string"}],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[],"name":"label","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"}],"devdoc":{"kind":"dev","methods":{},"version":1},"userdoc":{"kind":"user","methods":{},"version":1}},"settings":{"compilationTarget":{"contracts/Plain.sol":"Plain"},"debug":{"revertStrings":"strip"},"evmVersion":"paris","libraries":{},"metadata":{"bytecodeHash":"none"},"optimizer":{"enabled":true,"runs":1},"remappings":[]},"sources":{"contracts/Plain.sol":{"keccak256":"0x212656c939c70520e0bd84818c35c386c9fbba98c7217bed20a555d08b60c4be","license":"MIT","urls":["bzz-raw://d22f2f05fabf000a624065c856ac5e4b8ab194c3b4b6cd5f78dac68d2807a8cd","dweb:/ipfs/QmaAXmbCJj6SJmVCmmh4mF5uwpWd5shAkpHftoU8VQMABa"]}},"version":1}',
  sources: {
    "contracts/Plain.sol":
      '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\n\ncontract Plain {\n    string public label;\n    constructor(string memory l) { require(bytes(l).length > 0, "empty label"); label = l; }\n}\n',
  },
  creation:
    "608060405234801561001057600080fd5b506040516103fa3803806103fa83398101604081905261002f91610066565b600081511161003d57600080fd5b600061004982826101ba565b5050610279565b634e487b7160e01b600052604160045260246000fd5b6000602080838503121561007957600080fd5b82516001600160401b038082111561009057600080fd5b818501915085601f8301126100a457600080fd5b8151818111156100b6576100b6610050565b604051601f8201601f19908116603f011681019083821181831017156100de576100de610050565b8160405282815288868487010111156100f657600080fd5b600093505b8284101561011857848401860151818501870152928501926100fb565b600086848301015280965050505050505092915050565b600181811c9082168061014357607f821691505b60208210810361016357634e487b7160e01b600052602260045260246000fd5b50919050565b601f8211156101b5576000816000526020600020601f850160051c810160208610156101925750805b601f850160051c820191505b818110156101b15782815560010161019e565b5050505b505050565b81516001600160401b038111156101d3576101d3610050565b6101e7816101e1845461012f565b84610169565b602080601f83116001811461021c57600084156102045750858301515b600019600386901b1c1916600185901b1785556101b1565b600085815260208120601f198616915b8281101561024b5788860151825594840194600190910190840161022c565b50858210156102695787850151600019600388901b60f8161c191681555b5050505050600190811b01905550565b610172806102886000396000f3fe608060405234801561001057600080fd5b506004361061002b5760003560e01c8063cb4774c414610030575b600080fd5b61003861004e565b60405161004591906100dc565b60405180910390f35b6000805461005b9061012b565b80601f01602080910402602001604051908101604052809291908181526020018280546100879061012b565b80156100d45780601f106100a9576101008083540402835291602001916100d4565b820191906000526020600020905b8154815290600101906020018083116100b757829003601f168201915b505050505081565b60006020808352835180602085015260005b8181101561010a578581018301518582016040015282016100ee565b506000604082860101526040601f19601f8301168501019250505092915050565b600181811c9082168061013f57607f821691505b60208210810361015f57634e487b7160e01b600052602260045260246000fd5b5091905056fea164736f6c6343000818000a",
  runtime:
    "608060405234801561001057600080fd5b506004361061002b5760003560e01c8063cb4774c414610030575b600080fd5b61003861004e565b60405161004591906100dc565b60405180910390f35b6000805461005b9061012b565b80601f01602080910402602001604051908101604052809291908181526020018280546100879061012b565b80156100d45780601f106100a9576101008083540402835291602001916100d4565b820191906000526020600020905b8154815290600101906020018083116100b757829003601f168201915b505050505081565b60006020808352835180602085015260005b8181101561010a578581018301518582016040015282016100ee565b506000604082860101526040601f19601f8301168501019250505092915050565b600181811c9082168061013f57607f821691505b60208210810361015f57634e487b7160e01b600052602260045260246000fd5b5091905056fea164736f6c6343000818000a",
  reproducedSettings: {
    debug: {
      revertStrings: "strip",
    },
    evmVersion: "paris",
    libraries: {},
    metadata: {
      bytecodeHash: "none",
    },
    optimizer: {
      enabled: true,
      runs: 1,
    },
    remappings: [],
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"],
      },
    },
  },
};

const VIAIR: Case = {
  metadata:
    '{"compiler":{"version":"0.8.24+commit.e11b9ed9"},"language":"Solidity","output":{"abi":[{"inputs":[{"internalType":"uint256","name":"x","type":"uint256"}],"name":"push","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"sum","outputs":[{"internalType":"uint256","name":"s","type":"uint256"}],"stateMutability":"view","type":"function"}],"devdoc":{"kind":"dev","methods":{},"version":1},"userdoc":{"kind":"user","methods":{},"version":1}},"settings":{"compilationTarget":{"src/Accumulator.sol":"Accumulator"},"evmVersion":"cancun","libraries":{},"metadata":{"bytecodeHash":"ipfs"},"optimizer":{"details":{"constantOptimizer":true,"cse":true,"deduplicate":true,"inliner":true,"jumpdestRemover":true,"orderLiterals":true,"peephole":false,"simpleCounterForLoopUncheckedIncrement":true,"yul":true,"yulDetails":{"optimizerSteps":"dhfoDgvulfnTUtnIf[xa[r]EscLMcCTUtTOntnfDIulLculVcul [j]Tpeulxa[rul]xa[r]cLgvifCTUca[r]LSsTFOtfDnca[r]Iulc]jmul[jul] VcTOcul jmul:fDnTOcmu","stackAllocation":true}},"runs":1000},"remappings":[],"viaIR":true},"sources":{"src/Accumulator.sol":{"keccak256":"0x7350e443585c03fbbf10f358afe825fd1fb5b046efb01eac2287492a99490cee","license":"MIT","urls":["bzz-raw://d5177dae5322eba890fb2547b601d5c3e34b1a132ff4bfa8fbfb7538661ce087","dweb:/ipfs/QmQdhWwKviKAmF6Bs83f1EWrV2AJGs33XueVfuZkvm3koj"]},"src/IAcc.sol":{"keccak256":"0xd15576d8750fd144ce30bd8b87316fac0f3fd0bddcc56f8751a4d154b079cbbc","license":"MIT","urls":["bzz-raw://33d4389fcdaeae61025026107c4233a515eb791cda251cc4275e84ce846f90aa","dweb:/ipfs/QmcQTRaPFXhZUZ15bMgY3AiKrSEnvJpZyJW6W17QSssQmh"]}},"version":1}',
  sources: {
    "src/Accumulator.sol":
      '// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\n\nimport "./IAcc.sol";\n\ncontract Accumulator is IAcc {\n    uint256[] private xs;\n    function push(uint256 x) external { xs.push(x); }\n    function sum() external view returns (uint256 s) { for (uint256 i; i < xs.length; ++i) s += xs[i]; }\n}\n',
    "src/IAcc.sol":
      "// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\n\ninterface IAcc {\n    function push(uint256 x) external;\n    function sum() external view returns (uint256);\n}\n",
  },
  creation:
    "608080604052346100165761017e908161001b8239f35b5f80fdfe608060405260046004361015610013575f80fd5b5f3560e01c908163853255cc1461009c575063959ac48414610034575f5f80fd5b34610095576020366003190112610095575f54680100000000000000008110156100815780600161006792015f55610101565b81545f1960039290921b91821b191660043590911b179055005b634e487b7160e01b5f52604160045260245ffd5b5f80fd5f80fd5b34610095575f366003190112610095575f5f5f545b8082106100c357602083604051908152f35b90916100ce83610101565b90549060031b1c81018091116100e85791600101906100b1565b601184634e487b7160e01b5f525260245ffd5f80fd5f80fd5b5f54811015610134575f80527f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e56301905f90565b634e487b7160e01b5f52603260045260245ffdfea2646970667358221220cba21992201111090f6b1b2d4f03472ab1015fb24c06b08d28eca8d7ca5a9fb964736f6c63430008180033",
  runtime:
    "608060405260046004361015610013575f80fd5b5f3560e01c908163853255cc1461009c575063959ac48414610034575f5f80fd5b34610095576020366003190112610095575f54680100000000000000008110156100815780600161006792015f55610101565b81545f1960039290921b91821b191660043590911b179055005b634e487b7160e01b5f52604160045260245ffd5b5f80fd5f80fd5b34610095575f366003190112610095575f5f5f545b8082106100c357602083604051908152f35b90916100ce83610101565b90549060031b1c81018091116100e85791600101906100b1565b601184634e487b7160e01b5f525260245ffd5f80fd5f80fd5b5f54811015610134575f80527f290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e56301905f90565b634e487b7160e01b5f52603260045260245ffdfea2646970667358221220cba21992201111090f6b1b2d4f03472ab1015fb24c06b08d28eca8d7ca5a9fb964736f6c63430008180033",
  reproducedSettings: {
    evmVersion: "cancun",
    libraries: {},
    metadata: {
      bytecodeHash: "ipfs",
    },
    optimizer: {
      details: {
        constantOptimizer: true,
        cse: true,
        deduplicate: true,
        inliner: true,
        jumpdestRemover: true,
        orderLiterals: true,
        peephole: false,
        simpleCounterForLoopUncheckedIncrement: true,
        yul: true,
        yulDetails: {
          optimizerSteps:
            "dhfoDgvulfnTUtnIf[xa[r]EscLMcCTUtTOntnfDIulLculVcul [j]Tpeulxa[rul]xa[r]cLgvifCTUca[r]LSsTFOtfDnca[r]Iulc]jmul[jul] VcTOcul jmul:fDnTOcmu",
          stackAllocation: true,
        },
      },
      runs: 1000,
    },
    remappings: [],
    viaIR: true,
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"],
      },
    },
  },
};

const LITERAL: Case = {
  metadata:
    '{"compiler":{"version":"0.8.24+commit.e11b9ed9"},"language":"Solidity","output":{"abi":[{"inputs":[{"internalType":"string","name":"l","type":"string"}],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[],"name":"label","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"}],"devdoc":{"kind":"dev","methods":{},"version":1},"userdoc":{"kind":"user","methods":{},"version":1}},"settings":{"compilationTarget":{"contracts/Plain.sol":"Plain"},"evmVersion":"shanghai","libraries":{},"metadata":{"bytecodeHash":"ipfs","useLiteralContent":true},"optimizer":{"enabled":false,"runs":200},"remappings":[]},"sources":{"contracts/Plain.sol":{"content":"// SPDX-License-Identifier: MIT\\npragma solidity ^0.8.0;\\n\\ncontract Plain {\\n    string public label;\\n    constructor(string memory l) { require(bytes(l).length > 0, \\"empty label\\"); label = l; }\\n}\\n","keccak256":"0x212656c939c70520e0bd84818c35c386c9fbba98c7217bed20a555d08b60c4be","license":"MIT"}},"version":1}',
  sources: {
    "contracts/Plain.sol":
      '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\n\ncontract Plain {\n    string public label;\n    constructor(string memory l) { require(bytes(l).length > 0, "empty label"); label = l; }\n}\n',
  },
  creation:
    "608060405234801561000f575f80fd5b506040516107ab3803806107ab833981810160405281019061003191906101f0565b5f815111610074576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161006b90610291565b60405180910390fd5b805f908161008291906104bc565b505061058b565b5f604051905090565b5f80fd5b5f80fd5b5f80fd5b5f80fd5b5f601f19601f8301169050919050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52604160045260245ffd5b6100e8826100a2565b810181811067ffffffffffffffff82111715610107576101066100b2565b5b80604052505050565b5f610119610089565b905061012582826100df565b919050565b5f67ffffffffffffffff821115610144576101436100b2565b5b61014d826100a2565b9050602081019050919050565b5f5b8381101561017757808201518184015260208101905061015c565b5f8484015250505050565b5f61019461018f8461012a565b610110565b9050828152602081018484840111156101b0576101af61009e565b5b6101bb84828561015a565b509392505050565b5f82601f8301126101d7576101d661009a565b5b81516101e7848260208601610182565b91505092915050565b5f6020828403121561020557610204610092565b5b5f82015167ffffffffffffffff81111561022257610221610096565b5b61022e848285016101c3565b91505092915050565b5f82825260208201905092915050565b7f656d707479206c6162656c0000000000000000000000000000000000000000005f82015250565b5f61027b600b83610237565b915061028682610247565b602082019050919050565b5f6020820190508181035f8301526102a88161026f565b9050919050565b5f81519050919050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602260045260245ffd5b5f60028204905060018216806102fd57607f821691505b6020821081036103105761030f6102b9565b5b50919050565b5f819050815f5260205f209050919050565b5f6020601f8301049050919050565b5f82821b905092915050565b5f600883026103727fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff82610337565b61037c8683610337565b95508019841693508086168417925050509392505050565b5f819050919050565b5f819050919050565b5f6103c06103bb6103b684610394565b61039d565b610394565b9050919050565b5f819050919050565b6103d9836103a6565b6103ed6103e5826103c7565b848454610343565b825550505050565b5f90565b6104016103f5565b61040c8184846103d0565b505050565b5b8181101561042f576104245f826103f9565b600181019050610412565b5050565b601f8211156104745761044581610316565b61044e84610328565b8101602085101561045d578190505b61047161046985610328565b830182610411565b50505b505050565b5f82821c905092915050565b5f6104945f1984600802610479565b1980831691505092915050565b5f6104ac8383610485565b9150826002028217905092915050565b6104c5826102af565b67ffffffffffffffff8111156104de576104dd6100b2565b5b6104e882546102e6565b6104f3828285610433565b5f60209050601f831160018114610524575f8415610512578287015190505b61051c85826104a1565b865550610583565b601f19841661053286610316565b5f5b8281101561055957848901518255600182019150602085019450602081019050610534565b868310156105765784890151610572601f891682610485565b8355505b6001600288020188555050505b505050505050565b610213806105985f395ff3fe608060405234801561000f575f80fd5b5060043610610029575f3560e01c8063cb4774c41461002d575b5f80fd5b61003561004b565b6040516100429190610160565b60405180910390f35b5f8054610057906101ad565b80601f0160208091040260200160405190810160405280929190818152602001828054610083906101ad565b80156100ce5780601f106100a5576101008083540402835291602001916100ce565b820191905f5260205f20905b8154815290600101906020018083116100b157829003601f168201915b505050505081565b5f81519050919050565b5f82825260208201905092915050565b5f5b8381101561010d5780820151818401526020810190506100f2565b5f8484015250505050565b5f601f19601f8301169050919050565b5f610132826100d6565b61013c81856100e0565b935061014c8185602086016100f0565b61015581610118565b840191505092915050565b5f6020820190508181035f8301526101788184610128565b905092915050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602260045260245ffd5b5f60028204905060018216806101c457607f821691505b6020821081036101d7576101d6610180565b5b5091905056fea26469706673582212200a40d91366cfcc0fd626305c6ddd27acc28350bbeda155926c43939fd675d6da64736f6c63430008180033",
  runtime:
    "608060405234801561000f575f80fd5b5060043610610029575f3560e01c8063cb4774c41461002d575b5f80fd5b61003561004b565b6040516100429190610160565b60405180910390f35b5f8054610057906101ad565b80601f0160208091040260200160405190810160405280929190818152602001828054610083906101ad565b80156100ce5780601f106100a5576101008083540402835291602001916100ce565b820191905f5260205f20905b8154815290600101906020018083116100b157829003601f168201915b505050505081565b5f81519050919050565b5f82825260208201905092915050565b5f5b8381101561010d5780820151818401526020810190506100f2565b5f8484015250505050565b5f601f19601f8301169050919050565b5f610132826100d6565b61013c81856100e0565b935061014c8185602086016100f0565b61015581610118565b840191505092915050565b5f6020820190508181035f8301526101788184610128565b905092915050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602260045260245ffd5b5f60028204905060018216806101c457607f821691505b6020821081036101d7576101d6610180565b5b5091905056fea26469706673582212200a40d91366cfcc0fd626305c6ddd27acc28350bbeda155926c43939fd675d6da64736f6c63430008180033",
  reproducedSettings: {
    evmVersion: "shanghai",
    libraries: {},
    metadata: {
      bytecodeHash: "ipfs",
      useLiteralContent: true,
    },
    optimizer: {
      enabled: false,
      runs: 200,
    },
    remappings: [],
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"],
      },
    },
  },
};

const NOCBOR: Case = {
  metadata:
    '{"compiler":{"version":"0.8.24+commit.e11b9ed9"},"language":"Solidity","output":{"abi":[{"inputs":[{"internalType":"string","name":"l","type":"string"}],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[],"name":"label","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"}],"devdoc":{"kind":"dev","methods":{},"version":1},"userdoc":{"kind":"user","methods":{},"version":1}},"settings":{"compilationTarget":{"contracts/Plain.sol":"Plain"},"evmVersion":"shanghai","libraries":{},"metadata":{"appendCBOR":false,"bytecodeHash":"ipfs"},"optimizer":{"enabled":false,"runs":200},"remappings":[]},"sources":{"contracts/Plain.sol":{"keccak256":"0x212656c939c70520e0bd84818c35c386c9fbba98c7217bed20a555d08b60c4be","license":"MIT","urls":["bzz-raw://d22f2f05fabf000a624065c856ac5e4b8ab194c3b4b6cd5f78dac68d2807a8cd","dweb:/ipfs/QmaAXmbCJj6SJmVCmmh4mF5uwpWd5shAkpHftoU8VQMABa"]}},"version":1}',
  sources: {
    "contracts/Plain.sol":
      '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\n\ncontract Plain {\n    string public label;\n    constructor(string memory l) { require(bytes(l).length > 0, "empty label"); label = l; }\n}\n',
  },
  creation:
    "608060405234801561000f575f80fd5b50604051610775380380610775833981810160405281019061003191906101f0565b5f815111610074576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161006b90610291565b60405180910390fd5b805f908161008291906104bc565b505061058b565b5f604051905090565b5f80fd5b5f80fd5b5f80fd5b5f80fd5b5f601f19601f8301169050919050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52604160045260245ffd5b6100e8826100a2565b810181811067ffffffffffffffff82111715610107576101066100b2565b5b80604052505050565b5f610119610089565b905061012582826100df565b919050565b5f67ffffffffffffffff821115610144576101436100b2565b5b61014d826100a2565b9050602081019050919050565b5f5b8381101561017757808201518184015260208101905061015c565b5f8484015250505050565b5f61019461018f8461012a565b610110565b9050828152602081018484840111156101b0576101af61009e565b5b6101bb84828561015a565b509392505050565b5f82601f8301126101d7576101d661009a565b5b81516101e7848260208601610182565b91505092915050565b5f6020828403121561020557610204610092565b5b5f82015167ffffffffffffffff81111561022257610221610096565b5b61022e848285016101c3565b91505092915050565b5f82825260208201905092915050565b7f656d707479206c6162656c0000000000000000000000000000000000000000005f82015250565b5f61027b600b83610237565b915061028682610247565b602082019050919050565b5f6020820190508181035f8301526102a88161026f565b9050919050565b5f81519050919050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602260045260245ffd5b5f60028204905060018216806102fd57607f821691505b6020821081036103105761030f6102b9565b5b50919050565b5f819050815f5260205f209050919050565b5f6020601f8301049050919050565b5f82821b905092915050565b5f600883026103727fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff82610337565b61037c8683610337565b95508019841693508086168417925050509392505050565b5f819050919050565b5f819050919050565b5f6103c06103bb6103b684610394565b61039d565b610394565b9050919050565b5f819050919050565b6103d9836103a6565b6103ed6103e5826103c7565b848454610343565b825550505050565b5f90565b6104016103f5565b61040c8184846103d0565b505050565b5b8181101561042f576104245f826103f9565b600181019050610412565b5050565b601f8211156104745761044581610316565b61044e84610328565b8101602085101561045d578190505b61047161046985610328565b830182610411565b50505b505050565b5f82821c905092915050565b5f6104945f1984600802610479565b1980831691505092915050565b5f6104ac8383610485565b9150826002028217905092915050565b6104c5826102af565b67ffffffffffffffff8111156104de576104dd6100b2565b5b6104e882546102e6565b6104f3828285610433565b5f60209050601f831160018114610524575f8415610512578287015190505b61051c85826104a1565b865550610583565b601f19841661053286610316565b5f5b8281101561055957848901518255600182019150602085019450602081019050610534565b868310156105765784890151610572601f891682610485565b8355505b6001600288020188555050505b505050505050565b6101dd806105985f395ff3fe608060405234801561000f575f80fd5b5060043610610029575f3560e01c8063cb4774c41461002d575b5f80fd5b61003561004b565b6040516100429190610160565b60405180910390f35b5f8054610057906101ad565b80601f0160208091040260200160405190810160405280929190818152602001828054610083906101ad565b80156100ce5780601f106100a5576101008083540402835291602001916100ce565b820191905f5260205f20905b8154815290600101906020018083116100b157829003601f168201915b505050505081565b5f81519050919050565b5f82825260208201905092915050565b5f5b8381101561010d5780820151818401526020810190506100f2565b5f8484015250505050565b5f601f19601f8301169050919050565b5f610132826100d6565b61013c81856100e0565b935061014c8185602086016100f0565b61015581610118565b840191505092915050565b5f6020820190508181035f8301526101788184610128565b905092915050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602260045260245ffd5b5f60028204905060018216806101c457607f821691505b6020821081036101d7576101d6610180565b5b5091905056",
  runtime:
    "608060405234801561000f575f80fd5b5060043610610029575f3560e01c8063cb4774c41461002d575b5f80fd5b61003561004b565b6040516100429190610160565b60405180910390f35b5f8054610057906101ad565b80601f0160208091040260200160405190810160405280929190818152602001828054610083906101ad565b80156100ce5780601f106100a5576101008083540402835291602001916100ce565b820191905f5260205f20905b8154815290600101906020018083116100b157829003601f168201915b505050505081565b5f81519050919050565b5f82825260208201905092915050565b5f5b8381101561010d5780820151818401526020810190506100f2565b5f8484015250505050565b5f601f19601f8301169050919050565b5f610132826100d6565b61013c81856100e0565b935061014c8185602086016100f0565b61015581610118565b840191505092915050565b5f6020820190508181035f8301526101788184610128565b905092915050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52602260045260245ffd5b5f60028204905060018216806101c457607f821691505b6020821081036101d7576101d6610180565b5b5091905056",
  reproducedSettings: undefined,
};

/** Mutated sources with their keccak-256, read from the metadata of a solc compile of each. */
const MUTATIONS: Record<string, { content: string; keccak256: string }> = {
  vaultCrlf: {
    content:
      '// SPDX-License-Identifier: MIT\r\npragma solidity 0.8.24;\r\n\r\n// Vault — café ✓ (non-ASCII comment for the UTF-8 hash)\r\nimport {Owned} from "@oz/access/Owned.sol";\r\nimport {Fee} from "./math/Fee.sol";\r\n\r\ncontract Vault is Owned {\r\n    uint256 public immutable bps;\r\n    constructor(uint256 b) { bps = b; }\r\n    function quote(uint256 amount) external view returns (uint256) { return Fee.take(amount, bps); }\r\n}\r\n',
    keccak256: "0x4bdffa5c16d5a2fa643d2fd0dd9e5ca38c40485124a4b29aa177f1e16cd64d61",
  },
  feeOneByte: {
    content:
      "// SPDY-License-Identifier: MIT\npragma solidity 0.8.24;\n\nlibrary Fee {\n    function take(uint256 amount, uint256 bps) public pure returns (uint256) { return amount * bps / 10_000; }\n}\n",
    keccak256: "0x9e808fbfd5954c6a7d385e8aa6a3e997d4ef2f61cce8514eebb182fef03f934f",
  },
  plainTrailingNewline: {
    content:
      '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\n\ncontract Plain {\n    string public label;\n    constructor(string memory l) { require(bytes(l).length > 0, "empty label"); label = l; }\n}\n\n',
    keccak256: "0xda34ee4c03c236ec4305ebf2e866433300cdaeb304eabb963092c807298d6a17",
  },
  plainTampered: {
    content:
      '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\n\ncontract Plain {\n    string public label;\n    constructor(string memory l) { require(bytes(l).length > 0, "empty labeL"); label = l; }\n}\n',
    keccak256: "0xefeebc76cdcbf566d964409d87cf1a13042d5b91fa868c5b4da50e5bccfec28c",
  },
};

const FEE_METADATA: string =
  '{"compiler":{"version":"0.8.24+commit.e11b9ed9"},"language":"Solidity","output":{"abi":[{"inputs":[{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"uint256","name":"bps","type":"uint256"}],"name":"take","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"pure","type":"function"}],"devdoc":{"kind":"dev","methods":{},"version":1},"userdoc":{"kind":"user","methods":{},"version":1}},"settings":{"compilationTarget":{"src/math/Fee.sol":"Fee"},"evmVersion":"shanghai","libraries":{"src/math/Fee.sol:Fee":"0x00000000000000000000000000000000000000fe"},"metadata":{"bytecodeHash":"ipfs"},"optimizer":{"enabled":false,"runs":200},"remappings":[":@oz/=lib/oz/contracts/"]},"sources":{"src/math/Fee.sol":{"keccak256":"0x64aa3492601281af0c51da2705551024586ef296dc61395ab722389a428252d0","license":"MIT","urls":["bzz-raw://889d8b84453cbf58a532784af0b30804226dc53f1691ebd392bf135c4981b7a9","dweb:/ipfs/QmfBckohwpoUhSPCeE4aJwYQtLZwXsvD7GfonxPiSpZUuW"]}},"version":1}';
