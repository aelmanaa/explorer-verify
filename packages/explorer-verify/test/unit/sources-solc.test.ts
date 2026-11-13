// buildVerifyInputFromSources on the sources-package fixture (R-IN-7, R-DX-2, #283): the input it
// builds holds exactly the import closure of Vault, and solc-js compiles it to the bytecode the
// fixture committed, for a build without a metadata hash and a build with the default one.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import solc from "solc";

import type { BuiltVerifyInput } from "../../src/input/build.ts";
import { importPaths, parseRemapping, resolveImport } from "../../src/input/imports.ts";
import { buildVerifyInputFromSources } from "../../src/input/sources.ts";
import { readFields } from "../../src/internal/read-fields.ts";
import { vaultVerificationFiles } from "../helpers/user-docs.ts";

const FIXTURE = path.join(import.meta.dirname, "../fixtures/sources-package");
const SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" };

/** Reads one source of the fixture by its source unit name, or `undefined` when it has none. */
async function read(name: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(FIXTURE, name), "utf8");
  } catch {
    return undefined;
  }
}

/** The remappings the fixture ships in `remappings.txt`. */
async function remappings(): Promise<string[]> {
  const text = await readFile(path.join(FIXTURE, "remappings.txt"), "utf8");
  return text.split("\n").filter((line) => line !== "");
}

/** The creation bytecode a fixture file holds. */
async function committed(file: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(path.join(FIXTURE, "bytecode", file), "utf8"));
  return readFields(parsed)?.get("bytecode");
}

/** Compiles the built input with solc-js and returns the contract's creation bytecode. */
function compile(built: BuiltVerifyInput): string {
  const output: unknown = JSON.parse(solc.compile(JSON.stringify(built.compiler.input)));
  const fields = readFields(output);
  const errors = fields?.get("errors");
  const failed = Array.isArray(errors)
    ? errors.filter((error: unknown) => readFields(error)?.get("severity") === "error")
    : [];
  assert.deepEqual(failed, []);
  const [file = "", name = ""] = built.contractName.split(":");
  const object = readFields(
    readFields(readFields(readFields(fields?.get("contracts"))?.get(file))?.get(name))?.get("evm"),
  );
  const bytecode = readFields(object?.get("bytecode"))?.get("object");
  assert.equal(typeof bytecode, "string");
  return `0x${String(bytecode)}`;
}

describe("buildVerifyInputFromSources on a package that ships only sources", () => {
  it("uses the solc-js version the fixture was built with", () => {
    assert.match(solc.version(), /^0\.8\.24\+commit\.e11b9ed9\./);
  });

  it("gives the input the docs examples check, as the guide's build step writes it", async () => {
    const built = await buildVerifyInputFromSources({
      contract: "src/Vault.sol:Vault",
      compilerVersion: "0.8.24+commit.e11b9ed9",
      settings: { ...SETTINGS, metadata: { bytecodeHash: "none" } },
      remappings: await remappings(),
      sources: read,
    });
    const files = vaultVerificationFiles();
    assert.equal(files["verification/Vault.input.json"], JSON.stringify(built.compiler.input));
    assert.equal(
      files["verification/Vault.manifest.json"],
      JSON.stringify({ contract: built.contractName, compilerVersion: built.compiler.version }),
    );
  });

  it("puts exactly the import closure in the input, each file byte for byte", async () => {
    const built = await buildVerifyInputFromSources({
      contract: "src/Vault.sol:Vault",
      compilerVersion: "0.8.24+commit.e11b9ed9",
      settings: { ...SETTINGS, metadata: { bytecodeHash: "none" } },
      remappings: await remappings(),
      sources: read,
    });
    const names = [
      "lib/acl/src/Context.sol",
      "lib/acl/src/Ownable.sol",
      "src/Events.sol",
      "src/Vault.sol",
      "src/VaultMath.sol",
    ];
    assert.deepEqual(Object.keys(built.compiler.input.sources), names);
    for (const name of names) {
      assert.deepEqual(built.compiler.input.sources[name], { content: await read(name) });
    }
    assert.equal(built.contractName, "src/Vault.sol:Vault");
    assert.deepEqual(built.compiler.input.settings["remappings"], ["@acl/=lib/acl/src/"]);
  });

  it("compiles with solc-js to the committed bytecode: bytecodeHash none and the default hash", async () => {
    const cases = [
      { file: "Vault.json", settings: { ...SETTINGS, metadata: { bytecodeHash: "none" } } },
      { file: "Vault.default-hash.json", settings: SETTINGS },
    ];
    for (const { file, settings } of cases) {
      const built = await buildVerifyInputFromSources({
        contract: "src/Vault.sol:Vault",
        compilerVersion: "0.8.24+commit.e11b9ed9",
        settings,
        remappings: await remappings(),
        sources: read,
      });
      assert.equal(compile(built), await committed(file), file);
    }
  });
});

/**
 * The source unit names solc-js asks its import callback for when it compiles one file named
 * `importer` with `content` and `remapped`, sorted.
 */
function solcImports(importer: string, content: string, remapped: readonly string[]): string[] {
  const asked: string[] = [];
  const input = {
    language: "Solidity",
    sources: { [importer]: { content } },
    settings: { remappings: remapped, outputSelection: {} },
  };
  solc.compile(JSON.stringify(input), {
    import: (name) => {
      asked.push(name);
      return { contents: "" };
    },
  });
  return asked.toSorted();
}

/** The source unit names the builder's scanner and resolver give for the same file, sorted. */
function ownImports(importer: string, content: string, remapped: readonly string[]): string[] {
  const parsed = remapped.flatMap((text) => parseRemapping(text) ?? []);
  const names = importPaths(content).map((found) => resolveImport(found, importer, parsed));
  return [...new Set(names)].toSorted();
}

describe("import scanning and resolution against solc-js 0.8.24", () => {
  const cases: readonly { importer: string; content: string; remappings?: string[] }[] = [
    { importer: "a//b/c.sol", content: 'import "../d.sol";' },
    { importer: "a/b//c.sol", content: 'import "../d.sol";' },
    { importer: "a/b//c.sol", content: 'import "../../d.sol";' },
    { importer: "a///c.sol", content: 'import "../d.sol";' },
    { importer: "a/b//", content: 'import "./c.sol";' },
    { importer: "lib/x//b.sol", content: 'import "./c.sol"; import "../e.sol";' },
    { importer: "src/A.sol", content: 'import "../../B.sol"; import "./x/./../C.sol";' },
    { importer: "src/A.sol", content: 'import ".//B.sol"; import "./a//b.sol"; import "./x/";' },
    { importer: "src/A.sol", content: 'import "../x//../y.sol"; import "x/../z.sol";' },
    { importer: "src/A.sol", content: 'import "@x/b.sol";', remappings: ["@x=lib/x/"] },
    {
      importer: "src/A.sol",
      content: 'import "@a/b/X.sol"; import "@a/Y.sol";',
      remappings: ["@a/b/=lib/ab/", "@a/=lib/a/"],
    },
    {
      importer: "lib/a/A.sol",
      content: 'import "@x/y/X.sol";',
      remappings: ["lib/:@x/y/=lib/one/", "lib/a/:@x/=lib/two/"],
    },
    { importer: "src/A.sol", content: '// note\rimport "./b.sol";' },
    { importer: "src/A.sol", content: '/* import "./no.sol"; */ import "./yes.sol";' },
    { importer: "src/A.sol", content: 'import "a\\\nb.sol"; import "c\\\r\nd.sol";' },
    { importer: "src/A.sol", content: 'import "\\xc3\\xa9.sol"; import "\\u2603.sol";' },
    {
      importer: "src/A.sol",
      content: "import * as E from './e.sol'; import {F as G} from \"f.sol\";",
    },
  ];
  for (const { importer, content, remappings: remapped = [] } of cases) {
    it(`asks for the same files as solc: ${JSON.stringify(content)} in ${importer}`, () => {
      assert.deepEqual(
        ownImports(importer, content, remapped),
        solcImports(importer, content, remapped),
      );
    });
  }
});
