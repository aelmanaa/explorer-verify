// Project mode of verify in-process (R-DX-1, R-DX-2, R-AX-16): --foundry and --hardhat with
// --contract find the build files, and the helpers' errors name the CLI's flags. Every request
// goes to the fake explorer in globalThis.fetch. Waits run on mock timers.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { ERROR_HINTS, ExplorerVerifyError } from "explorer-verify";
import type { InputIssue } from "explorer-verify";

import type { OptionValue } from "../../src/arguments.ts";
import { USAGE_HINT } from "../../src/command.ts";
import { main } from "../../src/main.ts";
import { cliHintOf, projectOf, withCliFlags } from "../../src/project.ts";
import type { ProjectRequest } from "../../src/project.ts";
import { fakeExplorer } from "../helpers/fake-explorer.ts";
import type { Seen } from "../helpers/fake-explorer.ts";
import { fakeIo } from "../helpers/fake-io.ts";
import { driveMockClock } from "../helpers/mock-clock.ts";
import { envelopeProblems, oneEnvelope } from "../helpers/schema.ts";
import { PROJECT } from "../helpers/spawn-bin.ts";

const ADDRESS = "0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc";
const PACKAGES = new URL("../../../", import.meta.url);
const HARDHAT_FIXTURES = new URL("hardhat/test/fixtures/", PACKAGES);
const HARDHAT_3 = fileURLToPath(new URL("hardhat-3.21.2/", HARDHAT_FIXTURES));
const HARDHAT_2 = fileURLToPath(new URL("hardhat-2.29.1/", HARDHAT_FIXTURES));
const GREETER = "src/Greeter.sol:Greeter";

const DIR = mkdtempSync(join(tmpdir(), "explorer-verify-project-"));
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

/** The CLI's Foundry fixture, copied with its build-info renamed to a hash, as forge names it. */
const FOUNDRY = join(DIR, "foundry");
cpSync(join(PROJECT, "out"), join(FOUNDRY, "out"), { recursive: true });
renameSync(
  join(FOUNDRY, "out/build-info/greeter.json"),
  join(FOUNDRY, "out/build-info/6d1a3c9e0b2f4a87.json"),
);

interface Run {
  code: number;
  stdout: string;
  seen: Seen[];
}

/** Runs the CLI against the fake explorer, with the mock clock driven until the run ends. */
async function run(t: TestContext, argv: readonly string[]): Promise<Run> {
  const seen: Seen[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    fakeExplorer("verified", (request) => {
      seen.push(request);
    }),
  );
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const fake = fakeIo(argv);
  const running = main(fake.io);
  await driveMockClock(running, () => {
    t.mock.timers.runAll();
  });
  const code = await running;
  t.mock.timers.reset();
  return { code, stdout: fake.stdout(), seen };
}

/** The `result` or `error` object of the run's envelope, checked against the shipped schema. */
function part(result: Run, name: "result" | "error"): Record<string, unknown> {
  const envelope = oneEnvelope(result.stdout);
  assert.deepEqual(envelopeProblems(envelope), [], result.stdout);
  const value = envelope[name];
  assert.ok(typeof value === "object" && value !== null, result.stdout);
  return Object.fromEntries(Object.entries(value));
}

/** The verify command line of a dry run on Sourcify, with `extra` after the address and chain. */
function dryRun(extra: readonly string[]): string[] {
  return ["verify", ADDRESS, "--chain", "11155111", ...extra, "--dry-run", "--json"];
}

/** The issues `projectOf` gives for `values`, and what it returns. */
function check(values: Record<string, OptionValue>) {
  const issues: InputIssue[] = [];
  const request = projectOf(new Map(Object.entries(values)), issues);
  return { issues, request };
}

describe("projectOf: the options of project mode (R-DX-1)", () => {
  it("is undefined, with no issue, without --foundry or --hardhat", () => {
    assert.deepEqual(check({ input: ["a.json"] }), { issues: [], request: undefined });
  });

  it("reads --foundry with --contract, --out-dir, --artifact and --compiler-version", () => {
    const { issues, request } = check({
      foundry: ".",
      contract: GREETER,
      "out-dir": "build",
      artifact: "build/Greeter.sol/Greeter.json",
      "compiler-version": "0.8.24+commit.e11b9ed9",
    });
    assert.deepEqual(issues, []);
    assert.deepEqual(request, {
      tool: "foundry",
      root: ".",
      contract: GREETER,
      outDir: "build",
      artifact: "build/Greeter.sol/Greeter.json",
      compilerVersion: "0.8.24+commit.e11b9ed9",
    });
  });

  it("reads --hardhat with --contract alone", () => {
    assert.deepEqual(check({ hardhat: "app", contract: "contracts/Greeter.sol:Greeter" }), {
      issues: [],
      request: { tool: "hardhat", root: "app", contract: "contracts/Greeter.sol:Greeter" },
    });
  });

  it("refuses --foundry with --hardhat", () => {
    const { issues, request } = check({ foundry: ".", hardhat: ".", contract: GREETER });
    assert.equal(request, undefined);
    assert.deepEqual(
      issues.map(({ field }) => field),
      ["--hardhat"],
    );
  });

  it("refuses --out-dir and --artifact without a project", () => {
    const { issues } = check({ "out-dir": "out", artifact: "a.json" });
    assert.deepEqual(issues, [
      { field: "--out-dir", message: "needs --foundry or --hardhat" },
      { field: "--artifact", message: "needs --foundry or --hardhat" },
    ]);
  });

  it("needs --contract, a non-empty folder and no --input", () => {
    const { issues, request } = check({ hardhat: "", input: ["a.json"] });
    assert.equal(request, undefined);
    assert.deepEqual(issues, [
      { field: "--hardhat", message: 'must name the project folder, such as "."' },
      {
        field: "--input",
        message: "cannot be combined with --hardhat: the project gives the build files",
      },
      {
        field: "--contract",
        message:
          "is needed with --hardhat: the contract as path:Name, such as contracts/Greeter.sol:Greeter, or as Name when one contract has that name",
      },
    ]);
  });
});

/** A project request of `tool`, with `--out-dir` when `outDir` is given. */
function requestOf(tool: "foundry" | "hardhat", outDir?: string): ProjectRequest {
  return { tool, root: ".", contract: "Greeter", ...(outDir === undefined ? {} : { outDir }) };
}

/** The `*_HINT` string constants of a helper's source file. */
function hintsOf(file: string): string[] {
  const text = readFileSync(new URL(file, PACKAGES), "utf8");
  const found = [...text.matchAll(/^const \w+_HINT =\s*("(?:[^"\\]|\\.)*");$/gm)].map(
    (match): unknown => JSON.parse(String(match[1])),
  );
  return found.filter((hint) => typeof hint === "string");
}

describe("withCliFlags: the helpers' errors in the CLI's words", () => {
  it("returns anything but an ExplorerVerifyError as it is", () => {
    const error = new Error("plain");
    assert.equal(withCliFlags(error, requestOf("foundry")), error);
  });

  it("leaves no library name in any hint of either helper (guard)", () => {
    const hints = [
      ...hintsOf("foundry/src/foundry.ts"),
      ...hintsOf("hardhat/src/find.ts"),
      ERROR_HINTS["invalid-input"],
      ERROR_HINTS["incomplete-input"],
    ];
    // Both helpers hold several hints; a parse that finds few means the pattern broke.
    assert.ok(hints.length >= 10, String(hints.length));
    for (const hint of hints) {
      const shown = cliHintOf(hint);
      assert.doesNotMatch(
        shown,
        /outDir|buildInfoDir|options\.\w|details\.|\broot\b|call again/,
        `${hint}\n-> ${shown}`,
      );
    }
    assert.equal(cliHintOf(ERROR_HINTS["invalid-input"]), USAGE_HINT);
  });

  it("renames the issues of invalid-input, lists them in the message and keeps a cause", () => {
    const original = new ExplorerVerifyError(
      {
        code: "invalid-input",
        issues: [
          { field: "root", message: "is not a directory" },
          { field: "outDir", message: "is not a directory" },
          { field: "artifacts/x.json", message: "cannot be read." },
        ],
      },
      "The input is invalid: root.",
      {
        hint: "Pass options.outDir, or pass artifact with a file, or Pass contract as path:Name; files under root.",
        secrets: [],
      },
    );
    const error = withCliFlags(original, requestOf("hardhat", "build"));
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(
      error.message,
      "The input is invalid: --hardhat is not a directory; --out-dir is not a directory; artifacts/x.json cannot be read.",
    );
    assert.equal(
      error.hint,
      "Pass --out-dir, or pass --artifact with a file, or Pass --contract as path:Name; files under the project folder.",
    );
    assert.ok(error.cause instanceof Error);
    assert.deepEqual(error.details, {
      code: "invalid-input",
      issues: [
        { field: "--hardhat", message: "is not a directory" },
        { field: "--out-dir", message: "is not a directory" },
        { field: "artifacts/x.json", message: "cannot be read." },
      ],
    });
  });

  it("names the project flag and the default folder when --out-dir was not given", () => {
    for (const [tool, folder] of [
      ["foundry", "out"],
      ["hardhat", "artifacts"],
    ] as const) {
      const original = new ExplorerVerifyError(
        { code: "invalid-input", issues: [{ field: "outDir", message: "is not a directory" }] },
        "The input is invalid: outDir.",
        { hint: ERROR_HINTS["invalid-input"], secrets: [] },
      );
      const error = withCliFlags(original, requestOf(tool));
      assert.ok(error instanceof ExplorerVerifyError);
      assert.equal(
        error.message,
        `The input is invalid: --${tool} has no ${folder} folder: build the project, or pass --out-dir.`,
      );
      assert.equal(error.hint, USAGE_HINT);
    }
  });

  it("keeps the details of another code, adds its candidates and renames its hint", () => {
    const original = new ExplorerVerifyError(
      { code: "incomplete-input", field: "contract", candidates: ["a.sol:A", "b.sol:A"] },
      "The contract name matches 2 artifacts.",
      {
        hint: "Pass options.contract as path:Name, or a Name of one entry of details.candidates.",
        secrets: [],
      },
    );
    const error = withCliFlags(original, requestOf("hardhat"));
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(error.message, "The contract name matches 2 artifacts: a.sol:A, b.sol:A.");
    assert.equal(error.hint, "Pass --contract as path:Name, or a Name of one of the paths listed.");
    assert.deepEqual(error.details, original.details);
    const bare = new ExplorerVerifyError(
      { code: "insufficient-artifact", field: "input" },
      "No metadata.",
      { hint: "Run forge build --build-info, then call again.", secrets: [] },
    );
    const plain = withCliFlags(bare, requestOf("foundry"));
    assert.ok(plain instanceof ExplorerVerifyError);
    assert.equal(plain.message, "No metadata.");
    assert.equal(plain.hint, "Run forge build --build-info, then run the command again.");
  });
});

describe("verify --foundry and --hardhat (R-DX-1, R-DX-2)", () => {
  it("dry runs a Foundry project whose build-info has a hash name", async (t) => {
    const result = await run(t, dryRun(["--foundry", FOUNDRY, "--contract", GREETER]));
    assert.equal(result.code, 0, result.stdout);
    assert.equal(part(result, "result")["lookup"], "exact");
    assert.equal(result.seen.length, 1);
  });

  for (const [name, root] of [
    ["Hardhat 3", HARDHAT_3],
    ["Hardhat 2", HARDHAT_2],
  ]) {
    it(`dry runs a ${name} project`, async (t) => {
      const result = await run(
        t,
        dryRun(["--hardhat", String(root), "--contract", "contracts/Greeter.sol:Greeter"]),
      );
      assert.equal(result.code, 0, result.stdout);
      assert.equal(part(result, "result")["status"], "dry-run");
    });
  }

  it("names the CLI's flags in a helper's error, and sends nothing", async (t) => {
    const result = await run(
      t,
      dryRun(["--foundry", FOUNDRY, "--out-dir", "missing", "--contract", GREETER]),
    );
    assert.equal(result.code, 2);
    const error = part(result, "error");
    assert.equal(error["code"], "invalid-input");
    assert.match(String(error["message"]), /^The input is invalid: --out-dir /);
    assert.match(String(error["hint"]), /pass --out-dir with/);
    assert.deepEqual(result.seen, []);
  });

  it("names --contract when the project has no such contract", async (t) => {
    const result = await run(t, dryRun(["--hardhat", HARDHAT_3, "--contract", "Missing"]));
    assert.equal(result.code, 2);
    assert.match(String(part(result, "error")["message"]), /^The input is invalid: --contract /);
  });

  it("refuses --foundry with --input-json (R-AX-16)", async (t) => {
    const result = await run(t, [
      "verify",
      "--input-json",
      join(PROJECT, "verify-input.json"),
      "--foundry",
      FOUNDRY,
      "--json",
    ]);
    assert.equal(result.code, 2);
    assert.match(String(part(result, "error")["message"]), /--foundry/);
    assert.deepEqual(result.seen, []);
  });

  it("refuses --foundry without --contract, before any request", async (t) => {
    const result = await run(t, dryRun(["--foundry", FOUNDRY]));
    assert.equal(result.code, 2);
    assert.match(
      String(part(result, "error")["message"]),
      /--contract is needed with --foundry: the contract as path:Name, such as src\/Greeter\.sol:Greeter/,
    );
    assert.deepEqual(result.seen, []);
  });

  it("names --foundry and --hardhat when --input names a folder", async (t) => {
    const result = await run(t, dryRun(["--input", join(FOUNDRY, "out")]));
    assert.equal(result.code, 2);
    assert.match(
      String(part(result, "error")["message"]),
      /--input\[1\] names a folder, not a file: for a Foundry or Hardhat project, pass --foundry <dir> or --hardhat <dir> with --contract path:Name/,
    );
  });

  it("keeps the regular-file issue for an --input that is neither a file nor a folder", async (t) => {
    const result = await run(t, dryRun(["--input", "/dev/null"]));
    assert.equal(result.code, 2);
    const message = String(part(result, "error")["message"]);
    assert.match(message, /--input\[1\] must name a regular file\./);
    assert.doesNotMatch(message, /folder/);
  });

  it("says how to pass several files when a second --input value lands as an argument", async (t) => {
    const result = await run(
      t,
      dryRun([
        "--input",
        join(PROJECT, "out/build-info/greeter.json"),
        join(PROJECT, "out/Greeter.sol/Greeter.json"),
      ]),
    );
    assert.equal(result.code, 2);
    assert.match(
      String(part(result, "error")["message"]),
      /--input takes one file; repeat --input for each/,
    );
  });

  it("keeps the default issue for an extra argument without --input", async (t) => {
    const result = await run(t, ["verify", ADDRESS, ADDRESS, "--json"]);
    assert.equal(result.code, 2);
    assert.match(String(part(result, "error")["message"]), /verify takes at most 1 argument\./);
  });

  it("says --artifact takes one file when a glob gives it two", async (t) => {
    const result = await run(
      t,
      dryRun([
        "--foundry",
        FOUNDRY,
        "--contract",
        GREETER,
        "--artifact",
        "out/Greeter.sol/Greeter.json",
        "out/Greeter.sol/Greeter.0.8.24.json",
      ]),
    );
    assert.equal(result.code, 2);
    assert.match(
      String(part(result, "error")["message"]),
      /--artifact takes one file: name the artifact of the build you deployed/,
    );
  });

  it("names --hardhat, not --out-dir, for a folder without artifacts (D1)", async (t) => {
    const result = await run(t, dryRun(["--hardhat", FOUNDRY, "--contract", "Greeter"]));
    assert.equal(result.code, 2);
    const error = part(result, "error");
    assert.match(
      String(error["message"]),
      /^The input is invalid: --hardhat has no artifacts folder/,
    );
    assert.doesNotMatch(String(error["message"]), /--out-dir names/);
  });

  it("finds a unique bare contract name in a project", async (t) => {
    const result = await run(t, dryRun(["--foundry", FOUNDRY, "--contract", "Greeter"]));
    assert.equal(result.code, 0, result.stdout);
  });

  it("names every way to give the build when none is given", async (t) => {
    const result = await run(t, dryRun([]));
    assert.equal(result.code, 2);
    assert.match(
      String(part(result, "error")["message"]),
      /--input is needed: a build file, --foundry or --hardhat with --contract, or the whole request with --input-json/,
    );
  });
});
