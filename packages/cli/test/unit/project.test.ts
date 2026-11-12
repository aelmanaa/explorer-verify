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
import { inCliWords } from "../../src/hints.ts";
import { main } from "../../src/main.ts";
import { projectOf, withCliFlags } from "../../src/project.ts";
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

/** The field of the first issue of an `invalid-input` envelope, and its message. */
function firstIssue(result: Run): string {
  const details: unknown = part(result, "error")["details"];
  const issues: unknown =
    typeof details === "object" && details !== null ? Reflect.get(details, "issues") : undefined;
  const first: unknown = Array.isArray(issues) ? issues[0] : undefined;
  assert.ok(typeof first === "object" && first !== null, result.stdout);
  return `${String(Reflect.get(first, "field"))} ${String(Reflect.get(first, "message"))}`;
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
  it("returns anything but an ExplorerVerifyError, and one with nothing to rewrite, as it is", () => {
    const error = new Error("plain");
    assert.equal(withCliFlags(error, requestOf("foundry")), error);
    const other = new ExplorerVerifyError(
      { code: "incomplete-input", field: "contract", candidates: ["a.sol:A", "b.sol:A"] },
      "The contract name matches 2 artifacts.",
      { hint: "Pass options.contract as path:Name.", secrets: [] },
    );
    assert.equal(withCliFlags(other, requestOf("hardhat")), other);
  });

  it("leaves no library name in any hint of either helper, through the CLI's hint layer (guard)", () => {
    const hints = [
      ...hintsOf("foundry/src/foundry.ts"),
      ...hintsOf("hardhat/src/find.ts"),
      ERROR_HINTS["invalid-input"],
      ERROR_HINTS["incomplete-input"],
    ];
    // Both helpers hold several hints; a parse that finds few means the pattern broke.
    assert.ok(hints.length >= 10, String(hints.length));
    for (const hint of hints) {
      // `undefined` means a word with no CLI form is left: the code's CLI hint replaces it.
      const shown = inCliWords(hint);
      if (shown !== undefined) {
        assert.doesNotMatch(
          shown,
          /outDir|buildInfoDir|options\.\w|details\.|\broot\b|call again/,
          `${hint}\n-> ${shown}`,
        );
      }
    }
    assert.equal(inCliWords(ERROR_HINTS["invalid-input"]), undefined);
    assert.equal(
      inCliWords(
        "Pass options.outDir, or pass artifact with a file, or Pass contract as path:Name; files under root.",
      ),
      "Pass --out-dir, or pass --artifact with a file, or Pass --contract as path:Name; files under the project folder.",
    );
    assert.equal(
      inCliWords("Run forge build --build-info, then call again."),
      "Run forge build --build-info, then run the command again.",
    );
  });

  it("rewrites the helper's message with the same table as the hints, when it can", () => {
    const original = new ExplorerVerifyError(
      { code: "incomplete-input", field: "contract", candidates: ["a.sol:A"] },
      "No artifact under outDir matches contract; call again with one.",
      { hint: "h", secrets: [] },
    );
    const error = withCliFlags(original, requestOf("foundry"));
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(
      error.message,
      "No artifact under --out-dir matches contract; run the command again with one.",
    );
    assert.deepEqual(error.details, original.details);
    const kept = new ExplorerVerifyError(
      { code: "incomplete-input", field: "sources", candidates: [] },
      "The documents and options.sources lack 2 files.",
      { hint: "h", secrets: [] },
    );
    assert.equal(withCliFlags(kept, requestOf("foundry")), kept);
  });

  it("renames the issues of invalid-input, rewrites the message and keeps the hint and a cause", () => {
    const hint = "Pass options.outDir.";
    const original = new ExplorerVerifyError(
      {
        code: "invalid-input",
        issues: [
          { field: "root", message: "is not a directory" },
          { field: "outDir", message: "is not a directory" },
          { field: "artifacts/x.json", message: "cannot be read." },
        ],
      },
      "The input is invalid: root is not a directory; also outDir, artifacts/x.json.",
      { hint, secrets: [] },
    );
    const error = withCliFlags(original, requestOf("hardhat", "build"));
    assert.ok(error instanceof ExplorerVerifyError);
    assert.equal(
      error.message,
      "The input is invalid: root is not a directory; also --out-dir, artifacts/x.json.",
    );
    assert.equal(error.hint, hint);
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

  it("names the project flag for a root that is not a folder, and says to check it (#350)", () => {
    for (const [tool, holds] of [
      ["foundry", "foundry.toml"],
      ["hardhat", "the Hardhat config"],
    ] as const) {
      const cause = new ExplorerVerifyError(
        {
          code: "invalid-input",
          issues: [{ field: "root", message: "is not a folder: it does not exist" }],
        },
        "The input is invalid: root is not a folder: it does not exist.",
        { hint: "Check that root names the project folder.", secrets: [] },
      );
      for (const request of [requestOf(tool), requestOf(tool, "build")]) {
        const error = withCliFlags(cause, request);
        assert.ok(error instanceof ExplorerVerifyError);
        assert.equal(
          error.message,
          `The input is invalid: --${tool} is not a folder: it does not exist.`,
        );
        assert.deepEqual(error.details, {
          code: "invalid-input",
          issues: [{ field: `--${tool}`, message: "is not a folder: it does not exist" }],
        });
        assert.equal(
          error.hint,
          `Check the folder that --${tool} names: it must exist and should hold ${holds}. Pass . for the current folder.`,
        );
        assert.ok(error.cause instanceof Error);
      }
    }
  });

  it("puts the project flag in the headline for the default output folder (#350)", () => {
    const cases: [string, string, "foundry" | "hardhat", string][] = [
      [
        "outDir",
        "is not a directory",
        "foundry",
        "--foundry has no out folder: build the project, or pass --out-dir",
      ],
      ["outDir", "could not be read", "foundry", "--foundry out folder could not be read"],
      ["artifacts", "cannot be read", "hardhat", "--hardhat artifacts folder cannot be read"],
      [
        "outDir",
        "names no folder: artifacts is a file",
        "hardhat",
        "--hardhat has no artifacts folder: build the project, or pass --out-dir",
      ],
    ];
    for (const [field, message, tool, headline] of cases) {
      const error = withCliFlags(
        new ExplorerVerifyError(
          { code: "invalid-input", issues: [{ field, message }] },
          `The input is invalid: ${field} ${message}.`,
          { hint: ERROR_HINTS["invalid-input"], secrets: [] },
        ),
        requestOf(tool),
      );
      assert.ok(error instanceof ExplorerVerifyError);
      assert.equal(error.message, `The input is invalid: ${headline}.`);
    }
  });

  it("names the project flag and the default folder when --out-dir was not given", () => {
    for (const [tool, folder] of [
      ["foundry", "out"],
      ["hardhat", "artifacts"],
    ] as const) {
      const original = new ExplorerVerifyError(
        { code: "invalid-input", issues: [{ field: "outDir", message: "is not a directory" }] },
        "The input is invalid: outDir is not a directory.",
        { hint: ERROR_HINTS["invalid-input"], secrets: [] },
      );
      const error = withCliFlags(original, requestOf(tool));
      assert.ok(error instanceof ExplorerVerifyError);
      assert.deepEqual(error.details, {
        code: "invalid-input",
        issues: [
          {
            field: `--${tool}`,
            message: `has no ${folder} folder: build the project, or pass --out-dir`,
          },
        ],
      });
      assert.equal(error.hint, ERROR_HINTS["invalid-input"]);
    }
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
    assert.match(firstIssue(result), /^--out-dir /);
    assert.match(String(error["hint"]), /pass --out-dir with/);
    assert.deepEqual(result.seen, []);
  });

  it("names --contract when the project has no such contract", async (t) => {
    const result = await run(t, dryRun(["--hardhat", HARDHAT_3, "--contract", "Missing"]));
    assert.equal(result.code, 2);
    assert.match(firstIssue(result), /^--contract /);
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
    assert.equal(error["code"], "invalid-input");
    assert.match(firstIssue(result), /^--hardhat has no artifacts folder/);
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
