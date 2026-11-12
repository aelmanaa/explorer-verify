// Project mode on the built bin (R-DX-1, R-DX-2, R-AX-16, R-RUN-1): verify reads a Foundry or
// Hardhat 3 project with --foundry or --hardhat and --contract, run in the project folder as a
// user would, against the fake explorer. The helpers load only in the CLI, and only on demand.
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";
import { PROJECT, runBin } from "../helpers/spawn-bin.ts";

const TIMEOUT = { timeout: 30_000 };
// Permissions do not stop root from reading, so the unreadable-folder tests skip under root.
const RUNS_AS_ROOT = process.getuid?.() === 0;
const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const PACKAGES = new URL("../../../", import.meta.url);
const DIST = fileURLToPath(new URL("cli/dist/src/", PACKAGES));

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-bin-project-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

/** The CLI's Foundry fixture, with its build-info renamed to a hash as forge names it. */
const FOUNDRY = join(DIR, "foundry");
cpSync(join(PROJECT, "out"), join(FOUNDRY, "out"), { recursive: true });
renameSync(
  join(FOUNDRY, "out/build-info/greeter.json"),
  join(FOUNDRY, "out/build-info/8f3e2a91c04d7b65.json"),
);

/** The Hardhat 3 fixture of `@explorer-verify/hardhat`, copied into its own project folder. */
const HARDHAT = join(DIR, "hardhat");
cpSync(fileURLToPath(new URL("hardhat/test/fixtures/hardhat-3.21.2/", PACKAGES)), HARDHAT, {
  recursive: true,
});

/** The `result` or `error` of the envelope, checked against the shipped schema. */
function part(stdout: string, name: "result" | "error"): Record<string, unknown> {
  const envelope = oneEnvelope(stdout);
  assert.deepEqual(envelopeProblems(envelope), [], stdout);
  const value = envelope[name];
  assert.ok(typeof value === "object" && value !== null, stdout);
  return Object.fromEntries(Object.entries(value));
}

describe("bin: verify from a project (R-DX-1, R-DX-2)", { concurrency: true }, () => {
  it("--foundry . finds a hash-named build-info and dry runs on Sourcify", TIMEOUT, async () => {
    const result = await runBin(
      [
        "verify",
        ADDRESS,
        "--chain",
        "11155111",
        "--foundry",
        ".",
        "--contract",
        "src/Greeter.sol:Greeter",
        "--backend",
        "sourcify",
        "--dry-run",
        "--json",
      ],
      { cwd: FOUNDRY, fake: {} },
    );
    assert.equal(result.code, 0, result.stderr);
    const dry = part(result.stdout, "result");
    assert.equal(dry["status"], "dry-run");
    assert.equal(dry["backend"], "sourcify");
  });

  it("--hardhat . reads a Hardhat 3 build and dry runs on Sourcify", TIMEOUT, async () => {
    const result = await runBin(
      [
        ADDRESS,
        "--chain",
        "11155111",
        "--hardhat",
        ".",
        "--contract",
        "contracts/Greeter.sol:Greeter",
        "--backend",
        "sourcify",
        "--dry-run",
        "--json",
      ],
      { cwd: HARDHAT, fake: {} },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(part(result.stdout, "result")["status"], "dry-run");
  });

  it("a contract the project lacks exits 2, naming --contract", TIMEOUT, async () => {
    const result = await runBin(
      [
        "verify",
        ADDRESS,
        "--chain",
        "11155111",
        "--foundry",
        ".",
        "--contract",
        "src/Missing.sol:Missing",
        "--dry-run",
        "--json",
      ],
      { cwd: FOUNDRY, fake: {} },
    );
    assert.equal(result.code, 2);
    const error = part(result.stdout, "error");
    assert.equal(error["code"], "invalid-input");
    // The issues carry the CLI's flags in details (decision 0049); the hint is in its words.
    const details: unknown = error["details"];
    assert.match(JSON.stringify(details), /"field":"--contract"/);
    assert.match(String(error["hint"]), /--out-dir/);
  });

  // References: R-DX-2, R-AX-10, issue #350.
  for (const tool of ["foundry", "hardhat"] as const) {
    for (const outDir of [[], ["--out-dir", "artifacts"]]) {
      it(
        `--${tool} with a missing folder ${outDir.length === 0 ? "" : "and --out-dir "}names --${tool}, never the path`,
        TIMEOUT,
        async () => {
          const result = await runBin(
            [
              "verify",
              ADDRESS,
              "--chain",
              "11155111",
              `--${tool}`,
              "no/such/project",
              ...outDir,
              "--contract",
              "contracts/A.sol:A",
              "--dry-run",
              "--json",
            ],
            { cwd: DIR, fake: {} },
          );
          assert.equal(result.code, 2);
          const error = part(result.stdout, "error");
          assert.equal(error["code"], "invalid-input");
          const message = `--${tool} is not a folder: it does not exist`;
          assert.equal(error["message"], `The input is invalid: ${message}.`);
          assert.deepEqual(error["details"], {
            code: "invalid-input",
            issues: [{ field: `--${tool}`, message: message.slice(tool.length + 3) }],
          });
          const hint = String(error["hint"]);
          assert.match(hint, new RegExp(`^Check the folder that --${tool} names`));
          assert.doesNotMatch(hint, /compile|build/i);
          assert.doesNotMatch(result.stdout + result.stderr, /--out-dir names no folder/);
        },
      );
    }
  }

  // References: R-DX-2, R-AX-10, issue #350. Without --out-dir, the headline names the project
  // flag: an empty folder has no output folder, and one this process cannot read cannot be read.
  for (const [tool, folder] of [
    ["foundry", "out"],
    ["hardhat", "artifacts"],
  ] as const) {
    it(
      `--${tool} on an empty folder names --${tool} and the ${folder} folder`,
      TIMEOUT,
      async () => {
        const empty = join(DIR, `empty-${tool}`);
        mkdirSync(empty);
        const result = await runBin(
          [
            "verify",
            ADDRESS,
            "--chain",
            "11155111",
            `--${tool}`,
            ".",
            "--contract",
            "A",
            "--dry-run",
            "--json",
          ],
          { cwd: empty, fake: {} },
        );
        assert.equal(result.code, 2);
        const error = part(result.stdout, "error");
        const message = `has no ${folder} folder: build the project, or pass --out-dir`;
        assert.equal(error["message"], `The input is invalid: --${tool} ${message}.`);
        assert.deepEqual(error["details"], {
          code: "invalid-input",
          issues: [{ field: `--${tool}`, message }],
        });
      },
    );

    it(
      `--${tool} on a folder it cannot read names --${tool}`,
      { ...TIMEOUT, skip: RUNS_AS_ROOT ? "file modes do not apply to root" : false },
      async () => {
        const locked = join(DIR, `locked-${tool}`);
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        try {
          const result = await runBin(
            [
              "verify",
              ADDRESS,
              "--chain",
              "11155111",
              `--${tool}`,
              locked,
              "--contract",
              "A",
              "--dry-run",
              "--json",
            ],
            { cwd: DIR, fake: {} },
          );
          assert.equal(result.code, 2);
          const message = String(part(result.stdout, "error")["message"]);
          assert.equal(
            message,
            `The input is invalid: --${tool} ${tool === "foundry" ? "out folder could not be read" : "artifacts folder cannot be read"}.`,
          );
          assert.ok(!message.includes(locked));
        } finally {
          chmodSync(locked, 0o755);
        }
      },
    );
  }

  it("--foundry with --input-json exits 2 (R-AX-16)", TIMEOUT, async () => {
    const result = await runBin(
      ["verify", "--input-json", "verify-input.json", "--foundry", ".", "--json"],
      { cwd: PROJECT, fake: {} },
    );
    assert.equal(result.code, 2);
    const error = part(result.stdout, "error");
    assert.equal(error["code"], "invalid-input");
    assert.match(String(error["message"]), /--foundry/);
  });
});

describe("the helpers load only in the CLI, on demand (R-RUN-1)", () => {
  it("the core package does not depend on them", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("explorer-verify/package.json", PACKAGES), "utf8"),
    );
    const text = JSON.stringify(manifest);
    assert.doesNotMatch(text, /@explorer-verify\/(?:foundry|hardhat)/);
  });

  it("no built CLI file imports them statically", () => {
    const files = readdirSync(DIST).filter((name) => name.endsWith(".js"));
    assert.ok(files.includes("project.js"));
    for (const name of files) {
      const text = readFileSync(join(DIST, name), "utf8");
      assert.doesNotMatch(text, /^import[^;]*["']@explorer-verify\/(?:foundry|hardhat)["']/m, name);
    }
    const project = readFileSync(join(DIST, "project.js"), "utf8");
    assert.match(project, /await import\("@explorer-verify\/foundry"\)/);
    assert.match(project, /await import\("@explorer-verify\/hardhat"\)/);
  });
});
