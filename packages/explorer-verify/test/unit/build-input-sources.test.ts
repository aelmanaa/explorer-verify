// buildVerifyInputFromSources (R-IN-7, R-IN-6, #283): the import closure, the remappings, the
// errors for a missing file and a local path, and the option checks.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExplorerVerifyError } from "../../src/errors.ts";
import { buildVerifyInputFromSources } from "../../src/input/sources.ts";
import type { BuildFromSourcesOptions } from "../../src/input/sources.ts";

const VERSION = "0.8.24+commit.e11b9ed9";
const SOURCES: Readonly<Record<string, string>> = {
  "src/Vault.sol": [
    'import {Ownable} from "@acl/Ownable.sol";',
    'import "./Math.sol" as M;',
    '// import "./Unused.sol";',
    "contract Vault is Ownable {}",
    "",
  ].join("\n"),
  "src/Math.sol": 'import * as V from "./Vault.sol";\nlibrary Math {}\n',
  "lib/acl/src/Ownable.sol":
    'import {Context} from "./Context.sol";\nabstract contract Ownable {}\n',
  "lib/acl/src/Context.sol": "abstract contract Context {}\n",
  "src/Unused.sol": "contract Unused {}\n",
};
const BASE: BuildFromSourcesOptions = {
  contract: "src/Vault.sol:Vault",
  compilerVersion: VERSION,
  settings: { optimizer: { enabled: true, runs: 200 } },
  remappings: ["@acl/=lib/acl/src/"],
  sources: SOURCES,
};
const CLOSURE = [
  "lib/acl/src/Context.sol",
  "lib/acl/src/Ownable.sol",
  "src/Math.sol",
  "src/Vault.sol",
];

/** The error the call rejects with, checked to be an `ExplorerVerifyError`. */
async function rejection(options: unknown): Promise<ExplorerVerifyError> {
  let caught: unknown;
  try {
    // The tests pass malformed options on purpose, as a JavaScript caller could.
    await Reflect.apply(buildVerifyInputFromSources, undefined, [options]);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ExplorerVerifyError, String(caught));
  return caught;
}

/** The fields the `invalid-input` error names. */
async function invalidFields(options: unknown): Promise<string[]> {
  const error = await rejection(options);
  assert.ok(ExplorerVerifyError.is(error, "invalid-input"), error.code);
  return error.details.issues.map(({ field }) => field);
}

describe("buildVerifyInputFromSources", () => {
  it("returns the import closure, the settings with the remappings, and the contract", async () => {
    const built = await buildVerifyInputFromSources(BASE);
    assert.deepEqual(Object.keys(built.compiler.input.sources), CLOSURE);
    for (const name of CLOSURE) {
      assert.deepEqual(built.compiler.input.sources[name], { content: SOURCES[name] });
    }
    assert.equal(built.compiler.kind, "solc");
    assert.equal(built.compiler.version, VERSION);
    assert.equal(built.compiler.input.language, "Solidity");
    assert.deepEqual(built.compiler.input.settings, {
      optimizer: { enabled: true, runs: 200 },
      remappings: ["@acl/=lib/acl/src/"],
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] },
      },
    });
    assert.equal(built.contractName, "src/Vault.sol:Vault");
    assert.equal(built.creationBytecode, undefined);
  });

  it("gives the same input from a reader, sync or async, as from a record", async () => {
    const expected = await buildVerifyInputFromSources(BASE);
    const asked: string[] = [];
    const sync = await buildVerifyInputFromSources({
      ...BASE,
      sources: (name) => {
        asked.push(name);
        return SOURCES[name];
      },
    });
    const async = await buildVerifyInputFromSources({
      ...BASE,
      sources: async (name) => await Promise.resolve(SOURCES[name]),
    });
    assert.deepEqual(sync, expected);
    assert.deepEqual(async, expected);
    // Each file is read once, the cycle included, and the commented import never.
    assert.deepEqual(asked.toSorted(), CLOSURE);
  });

  it("ends an import cycle and puts each file in once", async () => {
    const built = await buildVerifyInputFromSources({
      ...BASE,
      remappings: undefined,
      sources: {
        "src/Vault.sol": 'import "./A.sol";\ncontract Vault {}\n',
        "src/A.sol": 'import "./B.sol";\n',
        "src/B.sol": 'import "./Vault.sol";\nimport "./A.sol";\n',
      },
    });
    assert.deepEqual(Object.keys(built.compiler.input.sources), [
      "src/A.sol",
      "src/B.sol",
      "src/Vault.sol",
    ]);
  });

  it("keeps the settings' outputSelection and reads remappings from settings", async () => {
    const outputSelection = { "*": { "*": ["abi"] } };
    const built = await buildVerifyInputFromSources({
      ...BASE,
      remappings: undefined,
      settings: { remappings: ["@acl/=lib/acl/src/"], outputSelection },
    });
    assert.deepEqual(Object.keys(built.compiler.input.sources), CLOSURE);
    assert.deepEqual(built.compiler.input.settings, {
      remappings: ["@acl/=lib/acl/src/"],
      outputSelection,
    });
  });

  it("adds no remappings key when there are none", async () => {
    const built = await buildVerifyInputFromSources({
      ...BASE,
      remappings: [],
      sources: { "src/Vault.sol": "contract Vault {}\n" },
    });
    assert.equal("remappings" in built.compiler.input.settings, false);
  });

  it("throws incomplete-input listing every source unit name it could not read", async () => {
    const error = await rejection({
      ...BASE,
      sources: { "src/Vault.sol": SOURCES["src/Vault.sol"] },
    });
    assert.ok(ExplorerVerifyError.is(error, "incomplete-input"));
    assert.equal(error.details.field, "sources");
    assert.deepEqual(error.details.candidates, ["lib/acl/src/Ownable.sol", "src/Math.sol"]);
    assert.equal(error.message, "The sources lack 2 of the files the contract imports.");
    assert.match(error.hint, /details\.candidates/);
  });

  it("sorts the missing names and lists a file two files import once", async () => {
    const error = await rejection({
      ...BASE,
      remappings: undefined,
      sources: {
        // Found in the order z, m, a; z.sol is imported twice.
        "src/Vault.sol": 'import "./z.sol";\nimport "./B.sol";\nimport "./m.sol";\n',
        "src/B.sol": 'import "./z.sol";\nimport "./a.sol";\n',
      },
    });
    assert.ok(ExplorerVerifyError.is(error, "incomplete-input"));
    assert.deepEqual(error.details.candidates, ["src/a.sol", "src/m.sol", "src/z.sol"]);
    assert.equal(error.message, "The sources lack 3 of the files the contract imports.");
  });

  it("lists the contract's own file when the sources lack it", async () => {
    const error = await rejection({ ...BASE, sources: () => undefined });
    assert.ok(ExplorerVerifyError.is(error, "incomplete-input"));
    assert.deepEqual(error.details.candidates, ["src/Vault.sol"]);
  });

  it("lists at most 1000 missing names and gives the full count", async () => {
    const imports = Array.from({ length: 1001 }, (_, index) => `import "./F${String(index)}.sol";`);
    const error = await rejection({
      ...BASE,
      sources: { "src/Vault.sol": imports.join("\n") },
    });
    assert.ok(ExplorerVerifyError.is(error, "incomplete-input"));
    assert.equal(error.details.candidates.length, 1000);
    assert.match(error.message, /lack 1001 of/);
  });

  it("refuses a remapping with a local path, naming its position and no path", async () => {
    for (const remapping of ["@acl/=/home/me/lib/", "/abs/:@acl/=lib/", "C:\\x=lib/"]) {
      const error = await rejection({ ...BASE, remappings: ["@x/=lib/x/", remapping] });
      assert.ok(ExplorerVerifyError.is(error, "invalid-input"));
      assert.deepEqual(error.details.issues, [
        { field: "remappings", message: "has a local path at position 2" },
      ]);
      assert.doesNotMatch(error.message, /home|abs|C:/);
      assert.match(error.hint, /relative to the project root/);
    }
  });

  it("refuses an import that resolves to a local path, naming no path", async () => {
    for (const path of ["/etc/A.sol", "a/../../A.sol", "~/A.sol"]) {
      const error = await rejection({
        ...BASE,
        sources: { "src/Vault.sol": `import "${path}";` },
      });
      assert.ok(ExplorerVerifyError.is(error, "invalid-input"));
      assert.deepEqual(error.details.issues, [
        { field: "sources", message: "has an import that resolves to a local path" },
      ]);
      assert.doesNotMatch(JSON.stringify(error.toJSON()), /etc|~/);
    }
  });

  it("refuses an import that resolves to nothing", async () => {
    assert.deepEqual(
      await invalidFields({
        ...BASE,
        remappings: ["@x/="],
        sources: { "src/Vault.sol": 'import "@x/";' },
      }),
      ["sources"],
    );
  });

  it("refuses a contract path that is a local path", async () => {
    const error = await rejection({ ...BASE, contract: "/home/me/src/Vault.sol:Vault" });
    assert.ok(ExplorerVerifyError.is(error, "invalid-input"));
    assert.deepEqual(error.details.issues, [{ field: "contract", message: "has a local path" }]);
    assert.doesNotMatch(error.message, /home/);
  });

  it("refuses a source unit name passed through settings that buildVerifyInput rejects", async () => {
    assert.deepEqual(
      await invalidFields({ ...BASE, settings: { libraries: { "/abs/L.sol": { L: "0x00" } } } }),
      ["compiler.input.settings.libraries"],
    );
  });

  it("refuses a malformed remapping, remappings that are not strings, and remappings twice", async () => {
    const malformed = await rejection({ ...BASE, remappings: ["@acl/=lib/", "nothing"] });
    assert.ok(ExplorerVerifyError.is(malformed, "invalid-input"));
    assert.match(malformed.details.issues[0]?.message ?? "", /at position 2/);
    assert.deepEqual(await invalidFields({ ...BASE, remappings: "@acl/=lib/" }), ["remappings"]);
    assert.deepEqual(await invalidFields({ ...BASE, remappings: [1] }), ["remappings"]);
    assert.deepEqual(
      await invalidFields({ ...BASE, remappings: undefined, settings: { remappings: [1] } }),
      ["settings.remappings"],
    );
    assert.deepEqual(
      await invalidFields({ ...BASE, settings: { remappings: ["@acl/=lib/acl/src/"] } }),
      ["remappings"],
    );
    const hostile = new Proxy([], {
      get() {
        throw new Error("trap");
      },
    });
    assert.deepEqual(await invalidFields({ ...BASE, remappings: hostile }), ["remappings"]);
  });

  it("refuses options that are missing, of the wrong type or unknown", async () => {
    assert.deepEqual(await invalidFields(undefined), ["options"]);
    assert.deepEqual(await invalidFields([]), ["options"]);
    assert.deepEqual(await invalidFields({ ...BASE, remapping: [] }), ["remapping"]);
    assert.deepEqual(await invalidFields({ ...BASE, contract: "Vault" }), ["contract"]);
    assert.deepEqual(await invalidFields({ ...BASE, contract: ":Vault" }), ["contract"]);
    assert.deepEqual(await invalidFields({ ...BASE, contract: "src/Vault.sol:1x" }), ["contract"]);
    assert.deepEqual(await invalidFields({ ...BASE, contract: 1 }), ["contract"]);
    assert.deepEqual(await invalidFields({ ...BASE, compilerVersion: undefined }), [
      "compilerVersion",
    ]);
    assert.deepEqual(await invalidFields({ ...BASE, settings: "x" }), ["settings"]);
    assert.deepEqual(
      await invalidFields({ contract: 1, compilerVersion: 2, settings: 3, sources: {} }),
      ["contract", "compilerVersion", "settings"],
    );
    assert.deepEqual(await invalidFields({ ...BASE, sources: "x" }), ["sources"]);
    assert.deepEqual(await invalidFields({ ...BASE, sources: undefined }), ["sources"]);
  });

  it("refuses a source whose content is not a string", async () => {
    assert.deepEqual(await invalidFields({ ...BASE, sources: { "src/Vault.sol": 1 } }), [
      "sources",
    ]);
    assert.deepEqual(await invalidFields({ ...BASE, sources: () => 1 }), ["sources"]);
  });

  it("checks the compiler version through buildVerifyInput", async () => {
    assert.deepEqual(await invalidFields({ ...BASE, compilerVersion: "0.8.24" }), [
      "compiler.version",
    ]);
  });

  it("passes the reader's error through unchanged", async () => {
    const thrown = new Error("disk");
    await assert.rejects(
      buildVerifyInputFromSources({
        ...BASE,
        sources: () => {
          throw thrown;
        },
      }),
      (error) => error === thrown,
    );
  });
});
