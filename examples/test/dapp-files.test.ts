// The dapp example and its tutorial, docs/user/tutorials/deploy-and-verify-from-a-dapp.md, show
// the same code: each module the tutorial shows is an example file, unchanged, so the code a reader
// copies is the code CI type-checks and tests (R-AX-2). The build files the example ships come
// from its own Solidity sources, the export script writes them from a Foundry build, and the
// bundle splits the explorer clients into chunks of their own.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { validateInput } from "explorer-verify";

const root = new URL("../../", import.meta.url);
const dapp = new URL("examples/dapp/", root);
const TUTORIAL = "docs/user/tutorials/deploy-and-verify-from-a-dapp.md";
const tutorial = readFileSync(new URL(TUTORIAL, root), "utf8");

/** The ts blocks of the tutorial, in order. */
const blocks = [...tutorial.matchAll(/^```ts[^\n]*\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? "");

/**
 * The example file each block shows, by the block's index. A block that the tutorial runs on its
 * own ends with a call of the module's function, which the file leaves to the page.
 */
const SHOWN: readonly { block: number; file: string; call?: string }[] = [
  { block: 0, file: "scripts/export-contracts.ts" },
  { block: 1, file: "src/deploy.ts" },
  { block: 2, file: "src/load-input.ts" },
  { block: 3, file: "src/verify.ts", call: "await verifyOnSourcify(input, console.log);\n" },
  { block: 5, file: "src/resume.ts", call: "await resumeVerification(console.log);\n" },
  { block: 7, file: "src/verify-etherscan.ts" },
];

function read(file: string): string {
  return readFileSync(new URL(file, dapp), "utf8");
}

function json(file: string): unknown {
  return JSON.parse(read(file));
}

describe(TUTORIAL, () => {
  for (const { block, file, call } of SHOWN) {
    it(`shows examples/dapp/${file} unchanged`, () => {
      assert.equal(blocks[block], `${read(file)}${call === undefined ? "" : `\n${call}`}`);
    });
  }

  it("links the example", () => {
    assert.match(tutorial, /\]\(\.\.\/\.\.\/\.\.\/examples\/dapp\/src\/main\.ts\)/);
  });
});

describe("examples/dapp build files", () => {
  it("the verify file holds the example's Solidity sources, as the tutorial prints them", () => {
    const verify = json("public/contracts/Greeter.verify.json");
    const input = validateInput({
      ...Object(verify),
      chainId: 11155111,
      address: "0x8275D36F64F047D2D8a1F42c79Bf80Caea39D7cC",
    });
    assert.equal(input.contractName, "src/Greeter.sol:Greeter");
    assert.equal(input.compiler.version, "0.8.24+commit.e11b9ed9");
    const solcInput: unknown = Reflect.get(input.compiler, "input");
    const sources: unknown = Reflect.get(Object(solcInput), "sources");
    assert.ok(typeof sources === "object" && sources !== null);
    assert.deepEqual(Object.keys(sources).toSorted(), ["src/Base.sol", "src/Greeter.sol"]);
    for (const file of ["src/Base.sol", "src/Greeter.sol"]) {
      assert.equal(Reflect.get(Object(Reflect.get(sources, file)), "content"), read(file), file);
    }
  });

  it("the deploy file holds the ABI, with the constructor of (owner, greeting), and the bytecode", () => {
    const deploy = json("public/contracts/Greeter.deploy.json");
    const abi: unknown = Reflect.get(Object(deploy), "abi");
    assert.ok(Array.isArray(abi));
    const constructor: unknown = abi.find(
      (item: unknown) => Reflect.get(Object(item), "type") === "constructor",
    );
    const inputs: unknown = Reflect.get(Object(constructor), "inputs");
    assert.ok(Array.isArray(inputs));
    assert.deepEqual(
      inputs.map((item: unknown): unknown => Reflect.get(Object(item), "type")),
      ["address", "string"],
    );
    assert.match(String(Reflect.get(Object(deploy), "bytecode")), /^0x(?:[0-9a-f]{2})+$/);
  });

  it("scripts/export-contracts.ts writes both files from a Foundry build", (t) => {
    // The Foundry fixture: the same Greeter and Base, built with --build-info.
    const fixture = new URL("packages/foundry/test/fixtures/project/", root);
    const project = mkdtempSync(path.join(tmpdir(), "dapp-export-"));
    t.after(() => rmSync(project, { recursive: true, force: true }));
    cpSync(new URL("foundry.toml", fixture), path.join(project, "foundry.toml"));
    cpSync(new URL("src/", fixture), path.join(project, "src"), { recursive: true });
    cpSync(new URL("out-build-info/", fixture), path.join(project, "out"), { recursive: true });

    const stdout = execFileSync(
      process.execPath,
      [fileURLToPath(new URL("scripts/export-contracts.ts", dapp))],
      { cwd: project, encoding: "utf8" },
    );

    assert.equal(stdout, "src/Greeter.sol:Greeter 0.8.24+commit.e11b9ed9\n");
    const written = (name: string): unknown =>
      JSON.parse(readFileSync(path.join(project, "public/contracts", name), "utf8"));
    assert.ok(Array.isArray(Reflect.get(Object(written("Greeter.deploy.json")), "abi")));
    assert.equal(
      Reflect.get(Object(written("Greeter.verify.json")), "contractName"),
      "src/Greeter.sol:Greeter",
    );
  });

  it("scripts/export-contracts.ts stops when Foundry's artifact holds no bytecode", (t) => {
    const project = mkdtempSync(path.join(tmpdir(), "dapp-export-"));
    t.after(() => rmSync(project, { recursive: true, force: true }));
    mkdirSync(path.join(project, "out/Greeter.sol"), { recursive: true });
    writeFileSync(path.join(project, "out/Greeter.sol/Greeter.json"), '{"abi":[]}');
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [fileURLToPath(new URL("scripts/export-contracts.ts", dapp))],
          {
            cwd: project,
            encoding: "utf8",
            stdio: "pipe",
          },
        ),
      /holds no ABI and bytecode/,
    );
  });

  it("scripts/build.ts bundles the page, with each explorer client in a chunk of its own", (t) => {
    const outdir = mkdtempSync(path.join(tmpdir(), "dapp-bundle-"));
    t.after(() => rmSync(outdir, { recursive: true, force: true }));
    execFileSync(process.execPath, [fileURLToPath(new URL("scripts/build.ts", dapp)), outdir], {
      encoding: "utf8",
    });
    const files = readdirSync(outdir);
    assert.ok(files.includes("main.js"));
    for (const client of ["sourcify", "etherscan"]) {
      assert.ok(
        files.some((file) => file.startsWith(`${client}-`) && file.endsWith(".js")),
        client,
      );
    }
  });
});
