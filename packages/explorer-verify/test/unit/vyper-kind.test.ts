// The Vyper compiler kind (R-EXT-1, R-IN-1, R-IN-6, decision 0075): the field rules of
// validateInput, the Vyper capability list, which maps Sourcify and Etherscan v2, and the refusal
// of Vyper input on every other backend before any request, in verify(), dryRun() and verifyEach() of the
// default entry and of explorer-verify/core.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blockscout } from "../../src/clients/blockscout.ts";
import { sourcify } from "../../src/clients/sourcify.ts";
import { COMPILER_ROUTES, kindCheck, VYPER_ROUTES } from "../../src/compiler-kinds.ts";
import {
  dryRun as coreDryRun,
  verify as coreVerify,
  verifyEach as coreVerifyEach,
} from "../../src/core/index.ts";
import { routingTable } from "../../src/core/table.ts";
import {
  ERROR_HINTS,
  ExplorerVerifyError,
  dryRun,
  linkLibraries,
  validateInput,
  verify,
  verifyEach,
} from "../../src/index.ts";
import type { BackendName, Hex, RouteOverride, VerifyInput } from "../../src/index.ts";
import { replay } from "../helpers/fake-fetch.ts";

// A fake key in lowercase hex. Never a real one (R-SEC-1).
const DUMMY_KEY = "0123456789abcdef0123456789abcdef";
const ADDRESS: Hex = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const VERSION = "0.4.3+commit.bff19ea2";
const COUNTER = "# pragma version 0.4.3\ncount: public(uint256)\n";
const CHAINS = [1, 11155111, 324, 300, 8453, 999999];

/** A valid Vyper input. Each call returns a new object. */
function vyperInput(): VerifyInput {
  return {
    chainId: 11155111,
    address: ADDRESS,
    compiler: {
      kind: "vyper",
      version: VERSION,
      input: {
        language: "Vyper",
        sources: { "src/Counter.vy": { content: COUNTER } },
        settings: { evmVersion: "prague", optimize: "gas" },
      },
    },
    contractName: "src/Counter.vy:Counter",
  };
}

/** `vyperInput()` with `compiler` fields replaced. */
function withCompiler(fields: Record<string, unknown>): Record<string, unknown> {
  const base = vyperInput();
  return { ...base, compiler: { ...base.compiler, ...fields } };
}

/** `vyperInput()` with `compiler.input` fields replaced. */
function withJson(fields: Record<string, unknown>): Record<string, unknown> {
  const base = vyperInput();
  return { ...base, compiler: { ...base.compiler, input: { ...base.compiler.input, ...fields } } };
}

/** The error `validateInput` throws for `value`. */
function rejection(value: unknown): ExplorerVerifyError {
  try {
    validateInput(value);
  } catch (error) {
    assert.ok(error instanceof ExplorerVerifyError, `validateInput threw ${String(error)}`);
    return error;
  }
  return assert.fail("validateInput accepted the value");
}

/** Asserts that `text` appears in none of the places an error can be printed from. */
function assertNotShown(error: ExplorerVerifyError, text: string): void {
  for (const place of [
    error.message,
    error.hint,
    String(error),
    // The stack's `at …` frames name the checkout, which no error controls.
    (error.stack ?? "")
      .split("\n")
      .filter((line) => !/^\s+at /.test(line))
      .join("\n"),
    JSON.stringify(error),
    JSON.stringify(error.toJSON()),
  ]) {
    assert.ok(!place.includes(text), `shown in: ${place.slice(0, 120)}`);
  }
}

/**
 * Asserts an `invalid-input` error whose issues name exactly `fields`, with `message` on the first
 * when given, and with the dummy key nowhere.
 */
function assertInvalid(value: unknown, fields: string[], message?: string): ExplorerVerifyError {
  const error = rejection(value);
  assert.equal(error.code, "invalid-input");
  assert.ok(error.details.code === "invalid-input");
  assert.deepEqual(
    error.details.issues.map((issue) => issue.field),
    fields,
  );
  if (message !== undefined) {
    assert.equal(error.details.issues[0]?.message, message);
  }
  assert.ok(error.hint.length > 0);
  assert.ok(error.docsUrl.endsWith("invalid-input.md") || error.docsUrl.includes("invalid-input"));
  assertNotShown(error, DUMMY_KEY);
  return error;
}

/** Asserts `unsupported-compiler` on `field`, with the dummy key nowhere. */
function assertUnsupported(error: unknown, field: string): ExplorerVerifyError {
  assert.ok(error instanceof ExplorerVerifyError, `threw ${String(error)}`);
  assert.deepEqual(error.details, { code: "unsupported-compiler", field });
  assert.equal(error.retryable, false);
  assert.ok(error.hint.length > 0);
  assert.ok(error.docsUrl.includes("unsupported-compiler"));
  assertNotShown(error, DUMMY_KEY);
  return error;
}

/** Asserts the refusal of Vyper input by the kind check. */
function isKindRefusal(error: unknown, chainId: number, backend?: BackendName): true {
  const refusal = assertUnsupported(error, "compiler.kind");
  assert.equal(
    refusal.message,
    backend === undefined
      ? `No backend of this release verifies vyper input on chain ${String(chainId)}.`
      : `The ${backend} backend does not verify vyper input on chain ${String(chainId)}.`,
  );
  assert.equal(refusal.hint, ERROR_HINTS["unsupported-compiler"]);
  return true;
}

describe("the VyperCompiler member of VerifyInput (R-EXT-1, R-IN-1, decision 0075)", () => {
  it("validates a Vyper input and returns it normalised", () => {
    const base = vyperInput();
    const checked = validateInput({
      ...withCompiler({ version: `v${VERSION}` }),
      address: ADDRESS.toUpperCase().replace("0X", "0x"),
    });
    assert.equal(checked.compiler.kind, "vyper");
    assert.equal(checked.compiler.version, VERSION);
    assert.equal(checked.address, ADDRESS);
    assert.deepEqual(checked.compiler.input, base.compiler.input);
    assert.equal(checked.contractName, "src/Counter.vy:Counter");
  });

  it("keeps interfaces, keccak256 and extra Standard JSON fields", () => {
    const interfaces = {
      "src/ICounter.vyi": { content: "@external\ndef count() -> uint256: ...\n" },
      "src/IERC20.json": { abi: [{ type: "function", name: "totalSupply" }] },
    };
    const sources = { "src/Counter.vy": { content: COUNTER, keccak256: "0xab" } };
    const checked = validateInput(withJson({ sources, interfaces, integrity: "0xcd" }));
    assert.ok(checked.compiler.kind === "vyper");
    assert.deepEqual(checked.compiler.input.interfaces, interfaces);
    assert.deepEqual(checked.compiler.input.sources, sources);
    assert.equal(Reflect.get(checked.compiler.input, "integrity"), "0xcd");
    // The copy shares no object with the input.
    assert.notEqual(checked.compiler.input.interfaces, interfaces);
  });

  it("accepts a key of sources in a subfolder and an empty interfaces object", () => {
    const sources = { "contracts/tokens/Token.vy": { content: COUNTER } };
    const checked = validateInput({
      ...withJson({ sources, interfaces: {} }),
      contractName: "contracts/tokens/Token.vy:Token",
    });
    assert.ok(checked.compiler.kind === "vyper");
    assert.deepEqual(checked.compiler.input.interfaces, {});
  });

  it("accepts the release floor and later releases", () => {
    for (const version of [
      "0.3.10+commit.91361694",
      "0.4.0+commit.e9db8d9f",
      "v0.4.3+commit.bff19ea2",
      "0.10.0+commit.00000000",
      "1.0.0+commit.00000000",
    ]) {
      assert.equal(
        validateInput(withCompiler({ version })).compiler.version,
        version.replace(/^v/, ""),
      );
    }
  });
});

const VERSION_MESSAGE =
  "must be a Vyper version with its 8-character commit, such as 0.4.3+commit.bff19ea2";
const NAME_MESSAGE = "must be a .vy path, a colon and the file name, which must be an identifier";

describe("validateInput rules for Vyper (R-IN-6, decision 0075)", () => {
  it("D1: compiler.version must be the long form, with a Vyper message", () => {
    for (const version of [
      "0.4.3",
      "v0.4.3",
      "vyper:0.4.3",
      "0.4.3+commit.BFF19EA2",
      "0.4.3+commit.bff19ea2z",
      "0.4.3+commit.bff19ea2.linux",
      `0.4.3+commit.${DUMMY_KEY}`,
      "",
      43,
      undefined,
    ]) {
      const error = assertInvalid(withCompiler({ version }), ["compiler.version"], VERSION_MESSAGE);
      assert.match(error.hint, /8-character commit from the name of the Vyper release asset/);
      // The solc short-version message never fires for Vyper.
      assert.doesNotMatch(error.hint, /0\.8\.24/);
    }
  });

  it("D1: a 7-character commit is invalid-input on compiler.version, with the release asset hint", () => {
    for (const version of [
      "0.4.0+commit.e9db8d9",
      "0.3.10+commit.9136169",
      "0.4.0rc6+commit.3371956",
    ]) {
      const error = assertInvalid(withCompiler({ version }), ["compiler.version"], VERSION_MESSAGE);
      assert.match(error.hint, /release asset/);
    }
  });

  it("D1: a part with a leading zero is invalid-input on compiler.version", () => {
    for (const version of [
      "00.3.10+commit.91361694",
      "0.03.10+commit.91361694",
      "0.3.010+commit.91361694",
      "0.4.03+commit.bff19ea2",
    ]) {
      assertInvalid(withCompiler({ version }), ["compiler.version"], VERSION_MESSAGE);
    }
    // The solc rules do not change: a leading zero is still a solc version.
    assert.equal(
      validateInput({
        chainId: 1,
        address: ADDRESS,
        compiler: {
          kind: "solc",
          version: "0.08.24+commit.e11b9ed9",
          input: { language: "Solidity", sources: { "A.sol": { content: "" } }, settings: {} },
        },
        contractName: "A.sol:A",
      }).compiler.version,
      "0.08.24+commit.e11b9ed9",
    );
  });

  it("D2: a release before 0.3.10 is unsupported-compiler on compiler.version", () => {
    for (const version of [
      "0.3.9+commit.66b96705",
      "0.3.7+commit.6020b8bb",
      "0.2.16+commit.59e1bdd1",
      "0.1.0+commit.00000000",
    ]) {
      const error = assertUnsupported(rejection(withCompiler({ version })), "compiler.version");
      assert.equal(
        error.message,
        "Vyper before 0.3.10 and prereleases are not supported: compiler.version.",
      );
      assert.equal(error.hint, "Use Vyper 0.3.10 or a later release.");
    }
    // A 7-character commit is a format error first.
    assertInvalid(withCompiler({ version: "0.2.16+commit.59e1bdd" }), ["compiler.version"]);
  });

  it("D2: the unsupported version comes before the other problems of the input", () => {
    const error = rejection({
      ...withCompiler({ version: "0.3.9+commit.66b96705" }),
      chainId: 0,
      contractName: "src/Counter.vy:Other",
    });
    assertUnsupported(error, "compiler.version");
  });

  it("D3: a prerelease is unsupported-compiler on compiler.version", () => {
    for (const version of [
      "0.4.0rc6+commit.33719560",
      "v0.4.0-rc6+commit.33719560",
      "0.5.0b1+commit.00000000",
      "0.5.0a1+commit.00000000",
      "0.3.1rc1+commit.00000000",
    ]) {
      assertUnsupported(rejection(withCompiler({ version })), "compiler.version");
    }
  });

  it("D4: compiler.input.language must be Vyper", () => {
    for (const language of ["Solidity", "vyper", "", undefined]) {
      assertInvalid(withJson({ language }), ["compiler.input.language"], 'must be "Vyper"');
    }
  });

  it("D4: settings is required, and a source with urls or a bad keccak256 is refused", () => {
    assertInvalid(
      withJson({ settings: undefined }),
      ["compiler.input.settings"],
      "must be an object",
    );
    for (const entry of [
      { content: COUNTER, urls: ["ipfs://Qm"] },
      { content: COUNTER, keccak256: 1 },
    ]) {
      assertInvalid(
        withJson({ sources: { "src/Counter.vy": entry } }),
        ["compiler.input.sources"],
        "has 1 file with urls or a bad keccak256, at position 1",
      );
    }
  });

  it("D4: an interface needs a string content or an abi array", () => {
    for (const interfaces of [
      { "I.vyi": {} },
      { "I.vyi": { content: 1 } },
      { "I.json": { abi: {} } },
      { "I.vyi": "text" },
    ]) {
      assertInvalid(
        withJson({ interfaces }),
        ["compiler.input.interfaces"],
        "has 1 file without a string content, at position 1",
      );
    }
    assertInvalid(
      withJson({ interfaces: { "I.vyi": { content: 1n } } }),
      ["compiler.input.interfaces"],
      "has 1 file that cannot be read as JSON data, at position 1",
    );
    assertInvalid(
      withJson({ interfaces: { [`I\u0000.vyi`]: { content: "" } } }),
      ["compiler.input.interfaces"],
      "has 1 path of more than 1024 characters or with control characters, at position 1",
    );
    for (const interfaces of [[], "I.vyi", null, 1]) {
      assertInvalid(
        withJson({ interfaces }),
        ["compiler.input.interfaces"],
        "must be an object of source files by path",
      );
    }
  });

  it("D4: an interface with a non-string content is refused even when it has an abi", () => {
    for (const content of [1, null, ["x"]]) {
      assertInvalid(
        withJson({ interfaces: { "I.json": { content, abi: [] } } }),
        ["compiler.input.interfaces"],
        "has 1 file without a string content, at position 1",
      );
    }
    const checked = validateInput(
      withJson({ interfaces: { "I.json": { content: "[]", abi: [] } } }),
    );
    assert.ok(checked.compiler.kind === "vyper");
    assert.deepEqual(checked.compiler.input.interfaces, { "I.json": { content: "[]", abi: [] } });
  });

  it("D5: contractName is the .vy source path and the file stem", () => {
    for (const contractName of [
      "src/Counter.vy:Other",
      "src/Counter.vy:counter",
      "src/Counter.vy:Count",
    ]) {
      const error = assertInvalid(
        { ...vyperInput(), contractName },
        ["contractName"],
        NAME_MESSAGE,
      );
      assert.match(error.hint, /src\/Counter\.vy:Counter/);
    }
    const sol = { "src/Counter.sol": { content: COUNTER } };
    assertInvalid(
      { ...withJson({ sources: sol }), contractName: "src/Counter.sol:Counter" },
      ["contractName"],
      NAME_MESSAGE,
    );
    const flat = { "Counter.vy": { content: COUNTER }, "a\\Token.vy": { content: COUNTER } };
    assert.equal(
      validateInput({ ...withJson({ sources: flat }), contractName: "Counter.vy:Counter" })
        .contractName,
      "Counter.vy:Counter",
    );
    assert.equal(
      validateInput({ ...withJson({ sources: flat }), contractName: "a\\Token.vy:Token" })
        .contractName,
      "a\\Token.vy:Token",
    );
    // A path outside the sources is reported as for solc.
    assertInvalid(
      { ...vyperInput(), contractName: "src/Other.vy:Other" },
      ["contractName"],
      "must start with a key of compiler.input.sources",
    );
  });

  it("D5: a contractName that fails the shape rule gets the Vyper message and hint", () => {
    const sources = { "src/my-token.vy": { content: COUNTER } };
    for (const contractName of [
      "Counter",
      "src/Counter.vy:",
      ":Counter",
      42,
      "src/my-token.vy:my-token",
    ]) {
      const error = assertInvalid(
        { ...withJson({ sources }), contractName },
        ["contractName"],
        NAME_MESSAGE,
      );
      assert.match(error.hint, /Name a Vyper contract after its file/);
      assert.doesNotMatch(
        error.details.code === "invalid-input" ? (error.details.issues[0]?.message ?? "") : "",
        /Solidity/,
      );
    }
  });

  it("D5: contractName is checked against the stem when the sources are invalid", () => {
    assertInvalid(
      { ...withJson({ sources: { "src/Counter.vy": {} } }), contractName: "src/Counter.vy:Other" },
      ["compiler.input.sources", "contractName"],
    );
  });

  it("D6: libraries is refused, and so is a library placeholder in creationBytecode", () => {
    const error = assertInvalid(
      { ...vyperInput(), libraries: { "src/Counter.vy:Lib": ADDRESS } },
      ["libraries"],
      "must be absent for Vyper",
    );
    assert.match(error.hint, /no linked libraries/);
    assertInvalid({ ...vyperInput(), libraries: {} }, ["libraries"]);
    const placeholder = `6080__$${"ab".repeat(17)}$__00`;
    assertInvalid(
      { ...vyperInput(), creationBytecode: placeholder },
      ["creationBytecode"],
      "must not hold library placeholders for Vyper",
    );
    assert.equal(
      validateInput({ ...vyperInput(), creationBytecode: "0x6080" }).creationBytecode,
      "0x6080",
    );
  });

  it("D6: zksolc-only fields are refused on a Vyper compiler", () => {
    for (const field of ["solcVersion", "solcFork"]) {
      assertInvalid(withCompiler({ [field]: "1.0.2" }), [`compiler.${field}`], "is zksolc only");
    }
  });

  it("D7: a key of sources that holds a local path is refused, without naming it", () => {
    const home = `/home/${DUMMY_KEY}/.venv/lib/python3.12/site-packages/snekmate/auth/ownable.vy`;
    for (const key of [
      `0/1/2/3/4/5/6/7/8${home}`,
      `0/1/2/3/4/5/6/7/8/${home.slice(1)}`,
      `0/${DUMMY_KEY}.vy`,
      home,
      `C:\\Users\\${DUMMY_KEY}\\ownable.vy`,
      `../${DUMMY_KEY}/ownable.vy`,
      `~/${DUMMY_KEY}/ownable.vy`,
    ]) {
      const sources = { "src/Counter.vy": { content: COUNTER }, [key]: { content: COUNTER } };
      const error = assertInvalid(
        withJson({ sources }),
        ["compiler.input.sources"],
        "has 1 local path in its keys or items, at position 2",
      );
      assert.match(error.hint, /snekmate\/auth\/ownable\.vy/);
      assertNotShown(error, key);
    }
  });

  it("D7: an indexed path after leading spaces or ./ segments is refused in every list", () => {
    for (const path of [
      ` 0/1/home/${DUMMY_KEY}/x.vy`,
      `./0/1/home/${DUMMY_KEY}/x.vy`,
      `  ././0\\1\\x.vy`,
    ]) {
      assertInvalid(
        withJson({ sources: { "src/Counter.vy": { content: COUNTER }, [path]: { content: "" } } }),
        ["compiler.input.sources"],
        "has 1 local path in its keys or items, at position 2",
      );
      assertInvalid(
        withJson({ interfaces: { [path]: { content: "" } } }),
        ["compiler.input.interfaces"],
        "has 1 local path in its keys or items, at position 1",
      );
      assertInvalid(
        withJson({ settings: { search_paths: [path] } }),
        ["compiler.input.settings.search_paths"],
        "has 1 local path in its keys or items, at position 1",
      );
    }
  });

  it("D7: a key of interfaces and an entry of settings.search_paths that hold a local path are refused", () => {
    const key = `0/1/2/home/${DUMMY_KEY}/IOwnable.vyi`;
    assertInvalid(
      withJson({ interfaces: { "src/I.vyi": { content: "" }, [key]: { content: "" } } }),
      ["compiler.input.interfaces"],
      "has 1 local path in its keys or items, at position 2",
    );
    const error = assertInvalid(
      withJson({
        settings: { search_paths: [".", `/home/${DUMMY_KEY}/.venv`, `0/1/home/${DUMMY_KEY}`] },
      }),
      ["compiler.input.settings.search_paths"],
      "has 2 local paths in its keys or items, at positions 2, 3",
    );
    // The hint fits search_paths entries as well as keys.
    assert.match(error.hint, /^Use paths inside the project/);
  });

  it("D7: a key of settings.outputSelection that holds a local path is refused", () => {
    const home = `/home/${DUMMY_KEY}/src/Counter.vy`;
    for (const key of [home, `0/1/2${home}`]) {
      assertInvalid(
        withJson({ settings: { outputSelection: { "src/Counter.vy": ["*"], [key]: ["*"] } } }),
        ["compiler.input.settings.outputSelection"],
        "has 1 local path in its keys or items, at position 2",
      );
    }
    const checked = validateInput(
      withJson({ settings: { outputSelection: { "src/Counter.vy": ["*"] } } }),
    );
    assert.equal(checked.compiler.kind, "vyper");
  });

  it("D7: settings.search_paths must be an array of strings", () => {
    for (const search_paths of ["lib", ".", { a: "." }, [".", 1], [null], [["."]], 7, null]) {
      assertInvalid(
        withJson({ settings: { search_paths } }),
        ["compiler.input.settings.search_paths"],
        "must be an array of strings",
      );
    }
  });

  it("D7: a settings.search_paths that is not an array of strings gets that one issue", () => {
    for (const search_paths of ["/abs", [1, "/abs"], `0/1/home/${DUMMY_KEY}`]) {
      assertInvalid(
        withJson({ settings: { search_paths } }),
        ["compiler.input.settings.search_paths"],
        "must be an array of strings",
      );
    }
  });

  it("D7: relative keys and search paths pass", () => {
    const checked = validateInput(
      withJson({
        sources: {
          "src/Counter.vy": { content: COUNTER },
          "snekmate/auth/ownable.vy": { content: COUNTER },
          "lib/0/x.vy": { content: COUNTER },
          "10/x.vy": { content: COUNTER },
          "./lib/x.vy": { content: COUNTER },
        },
        interfaces: { "interfaces/IOwnable.vyi": { content: "" } },
        settings: { search_paths: [".", "lib"] },
      }),
    );
    assert.equal(checked.compiler.kind, "vyper");
  });

  it("D7: Solidity input keeps its rules: local keys, 0/ keys and any search_paths pass here", () => {
    const sources = {
      "src/Token.sol": { content: "contract Token {}" },
      [`/home/${DUMMY_KEY}/Lib.sol`]: { content: "" },
      "0/1/Lib.sol": { content: "" },
    };
    const checked = validateInput({
      chainId: 1,
      address: ADDRESS,
      compiler: {
        kind: "solc",
        version: "0.8.24+commit.e11b9ed9",
        input: {
          language: "Solidity",
          sources,
          settings: { search_paths: "/abs", outputSelection: { "/abs/A.sol": {} } },
          interfaces: 1,
        },
      },
      contractName: "src/Token.sol:Token",
    });
    assert.equal(Reflect.get(checked.compiler.input, "interfaces"), 1);
  });

  it("D1: a version that is not a string is refused, even one whose toString is a version", () => {
    for (const version of [{ toString: () => VERSION }, [VERSION], new Date(0)]) {
      assertInvalid(withCompiler({ version }), ["compiler.version"], VERSION_MESSAGE);
    }
  });

  it("D1: multi-digit parts are accepted and come back without the leading v", () => {
    for (const [given, expected] of [
      ["v10.0.0+commit.bff19ea2", "10.0.0+commit.bff19ea2"],
      ["0.10.0+commit.bff19ea2", "0.10.0+commit.bff19ea2"],
      ["v0.4.12+commit.bff19ea2", "0.4.12+commit.bff19ea2"],
      ["1234.5678.9999+commit.bff19ea2", "1234.5678.9999+commit.bff19ea2"],
    ]) {
      const checked = validateInput(withCompiler({ version: given }));
      assert.deepEqual(checked.compiler, { ...vyperInput().compiler, version: expected });
    }
    // Five digits in a part is not a version.
    assertInvalid(withCompiler({ version: "0.12345.0+commit.bff19ea2" }), ["compiler.version"]);
  });

  it("D3: a prerelease with a multi-digit number is unsupported-compiler on compiler.version", () => {
    for (const version of [
      "0.4.1rc10+commit.bff19ea2",
      "0.5.0b12+commit.bff19ea2",
      "v0.4.0-rc1234+commit.bff19ea2",
    ]) {
      assertUnsupported(rejection(withCompiler({ version })), "compiler.version");
    }
    // Five digits in the prerelease number is not a version.
    assertInvalid(withCompiler({ version: "0.4.1rc12345+commit.bff19ea2" }), ["compiler.version"]);
  });

  it("D4: an interface with urls or a bad keccak256 is refused, as a source is", () => {
    for (const entry of [
      { content: "", urls: ["ipfs://Qm"] },
      { content: "", keccak256: 1 },
    ]) {
      assertInvalid(
        withJson({ interfaces: { "I.vyi": entry } }),
        ["compiler.input.interfaces"],
        "has 1 file with urls or a bad keccak256, at position 1",
      );
    }
  });

  it("D4: an input or settings that cannot be read is reported once, without other Vyper issues", () => {
    for (const input of [null, "x", []]) {
      assertInvalid(
        withCompiler({ input }),
        ["compiler.input"],
        "must be the Standard JSON input object",
      );
    }
    for (const settings of [null, "x"]) {
      assertInvalid(withJson({ settings }), ["compiler.input.settings"], "must be an object");
    }
  });

  it("D4: a source that is not an object has no content, and one that is not JSON is unreadable", () => {
    for (const entry of [1, "x", true, 1n, undefined]) {
      assertInvalid(
        withJson({ sources: { "src/Counter.vy": entry } }),
        ["compiler.input.sources"],
        "has 1 file without a string content, at position 1",
      );
    }
    assertInvalid(
      withJson({ sources: { "src/Counter.vy": { content: COUNTER, n: 1n } } }),
      ["compiler.input.sources"],
      "has 1 file that cannot be read as JSON data, at position 1",
    );
  });

  it("D7: a refused local path still lets contractName be checked against the sources", () => {
    assertInvalid(
      {
        ...withJson({
          sources: {
            "src/Counter.vy": { content: COUNTER },
            [`/home/${DUMMY_KEY}/x.vy`]: { content: "" },
          },
        }),
        contractName: "src/Other.vy:Other",
      },
      ["compiler.input.sources", "contractName"],
    );
  });

  it("takes settings.optimize as Vyper 0.3.10 to 0.4.3 read it, and refuses any other value (decision 0078)", () => {
    // Vyper reads a level, a boolean (true as gas, false as none) or nothing; null reads as nothing.
    for (const optimize of [undefined, null, "none", "gas", "codesize", true, false]) {
      const settings = optimize === undefined ? {} : { optimize };
      const checked = validateInput(withJson({ settings }));
      assert.ok(checked.compiler.kind === "vyper");
      assert.deepEqual(checked.compiler.input.settings, settings);
    }
    for (const optimize of ["Gas", "", "speed", 0, 1, {}, [], "true"]) {
      assertInvalid(
        withJson({ settings: { optimize } }),
        ["compiler.input.settings.optimize"],
        'must be "none", "gas", "codesize", true or false',
      );
    }
  });

  it("returns the whole Vyper compiler, without interfaces when the input has none", () => {
    const checked = validateInput(vyperInput());
    assert.deepEqual(checked.compiler, vyperInput().compiler);
    assert.ok(checked.compiler.kind === "vyper");
    assert.equal(Object.hasOwn(checked.compiler.input, "interfaces"), false);
  });

  it("reports every Vyper field problem at once, in field order", () => {
    assertInvalid(
      {
        ...withCompiler({
          version: "0.4.0+commit.e9db8d9",
          input: {
            language: "Solidity",
            sources: { "/abs/Counter.vy": { content: COUNTER } },
            interfaces: { "I.vyi": {} },
            settings: { search_paths: ["/abs"] },
          },
        }),
        contractName: "/abs/Counter.vy:Other",
        libraries: { "a:B": ADDRESS },
      },
      [
        "compiler.version",
        "compiler.input.language",
        "compiler.input.interfaces",
        "compiler.input.sources",
        "compiler.input.settings.search_paths",
        "contractName",
        "libraries",
      ],
    );
  });
});

describe("linkLibraries refuses Vyper input (R-IN-4, decision 0075)", () => {
  it("throws invalid-input on compiler.kind without libraries, and on libraries with them", () => {
    assert.throws(
      () => linkLibraries(vyperInput()),
      (error: unknown) => {
        assert.ok(error instanceof ExplorerVerifyError);
        assert.deepEqual(error.details, {
          code: "invalid-input",
          issues: [
            { field: "compiler.kind", message: "must not be vyper: Vyper has no linked libraries" },
          ],
        });
        return true;
      },
    );
    assert.throws(
      () => linkLibraries({ ...vyperInput(), libraries: { "src/Counter.vy:L": ADDRESS } }),
      (error: unknown) => error instanceof ExplorerVerifyError && error.code === "invalid-input",
    );
  });
});

describe("the Vyper capability list (R-EXT-1, decisions 0075, 0077 and 0078)", () => {
  it("maps Sourcify and Etherscan v2 on every chain, so the kind check refuses only the other backends", () => {
    assert.deepEqual(VYPER_ROUTES, [
      ["sourcify", "every"],
      ["etherscan-v2", "every"],
    ]);
    assert.equal(COMPILER_ROUTES.vyper, VYPER_ROUTES);
    for (const chainId of CHAINS) {
      const check = kindCheck("vyper", chainId);
      assert.equal(check.verifies("sourcify"), true);
      assert.equal(check.verifies("etherscan-v2"), true);
      assert.equal(check.verifies("blockscout"), false);
      isKindRefusal(check.refused("blockscout"), chainId, "blockscout");
    }
  });

  it("maps a backend on its listed chains only", () => {
    const routes = { vyper: [["sourcify", [1]]] } as const;
    const listed = kindCheck("vyper", 1, routes);
    assert.equal(listed.verifies("sourcify"), true);
    assert.equal(listed.verifies("blockscout"), false);
    isKindRefusal(listed.refused("blockscout"), 1, "blockscout");
    assert.throws(
      () => kindCheck("vyper", 324, routes),
      (error) => isKindRefusal(error, 324),
    );
    assert.equal(kindCheck("solc", 324, routes).verifies("routescan"), true);
  });

  it("refuses the kind on every chain when its list is empty", () => {
    for (const chainId of CHAINS) {
      assert.throws(
        () => kindCheck("vyper", chainId, { vyper: [] }),
        (error) => isKindRefusal(error, chainId),
      );
    }
  });

  it("takes the shipped list of each kind the override leaves out (FlowDependencies.compilers)", () => {
    // Overriding vyper keeps ZKSOLC_ROUTES for zksolc, and the reverse.
    assert.equal(kindCheck("zksolc", 324, { vyper: [] }).verifies("blockscout"), true);
    assert.equal(
      kindCheck("vyper", 324, { zksolc: [["blockscout", [324]]] }).verifies("sourcify"),
      true,
    );
  });
});

describe("Vyper input is refused before any request on a backend other than Sourcify and Etherscan v2 (R-EXT-1, decision 0057 point 4, decisions 0075 and 0078)", () => {
  const routes: [BackendName, RouteOverride][] = [
    ["blockscout-hosted", { backend: "blockscout-hosted" }],
    [
      "routescan",
      {
        backend: "routescan",
        apiUrl: "https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api",
      },
    ],
    [
      "etherscan-compatible",
      { backend: "etherscan-compatible", apiUrl: "https://x.example/api", apiKey: DUMMY_KEY },
    ],
  ];

  it("by verify() and dryRun() of the default entry, on every chain and named route", async () => {
    for (const chainId of CHAINS) {
      for (const [backend, route] of routes) {
        for (const run of [verify, dryRun]) {
          const fake = replay();
          await assert.rejects(
            run(
              { ...vyperInput(), chainId },
              { fetch: fake.fetch, route, apiKeys: { "etherscan-v2": DUMMY_KEY } },
            ),
            (error) => isKindRefusal(error, chainId, backend),
          );
          assert.deepEqual(fake.calls, []);
        }
      }
    }
  });

  it("by verify() with handlerUrl and the Routescan backend named", async () => {
    const fake = replay();
    await assert.rejects(
      verify(
        { ...vyperInput(), creationTxHash: `0x${"ab".repeat(32)}` },
        {
          fetch: fake.fetch,
          handlerUrl: "https://handler.example/verify",
          route: { backend: "routescan" },
        },
      ),
      (error) => isKindRefusal(error, 11155111, "routescan"),
    );
    assert.deepEqual(fake.calls, []);
  });

  it("by verifyEach() of the default entry, for a named backend", async () => {
    const fake = replay();
    const { outcomes } = await verifyEach(
      { ...vyperInput(), chainId: 1 },
      { fetch: fake.fetch, backends: ["blockscout"] },
    );
    assert.equal(outcomes.length, 1);
    isKindRefusal(outcomes[0]?.error, 1, "blockscout");
    assert.deepEqual(fake.calls, []);
  });

  it("by verify() and dryRun() of explorer-verify/core, for a named backend", async () => {
    const clients = [sourcify(), blockscout()] as const;
    for (const chainId of [1, 11155111]) {
      const fake = replay();
      const input = { ...vyperInput(), chainId };
      const options = { fetch: fake.fetch, clients, table: routingTable };
      const route = { backend: "blockscout" } as const;
      await assert.rejects(coreVerify(input, { ...options, route }), (error) =>
        isKindRefusal(error, chainId, "blockscout"),
      );
      await assert.rejects(coreDryRun(input, { ...options, route }), (error) =>
        isKindRefusal(error, chainId, "blockscout"),
      );
      const { outcomes } = await coreVerifyEach(input, { ...options, backends: ["blockscout"] });
      isKindRefusal(outcomes[0]?.error, chainId, "blockscout");
      assert.deepEqual(fake.calls, []);
    }
  });

  it("an unsupported Vyper version is refused by validation, before the kind check", async () => {
    const fake = replay();
    await assert.rejects(
      verify(
        {
          ...vyperInput(),
          compiler: { ...vyperInput().compiler, version: "0.3.9+commit.66b96705" },
        },
        { fetch: fake.fetch },
      ),
      (error) => assertUnsupported(error, "compiler.version") instanceof ExplorerVerifyError,
    );
    assert.deepEqual(fake.calls, []);
  });
});
