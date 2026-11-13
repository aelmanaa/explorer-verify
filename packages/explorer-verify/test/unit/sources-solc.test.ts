// buildVerifyInputFromSources on the sources-package fixture (R-IN-7, R-DX-2, #283): the input it
// builds holds exactly the import closure of Vault, and solc-js compiles it to the bytecode the
// fixture committed, for a build without a metadata hash and a build with the default one.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import solc from "solc";

import type { BuiltVerifyInput } from "../../src/input/build.ts";
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
