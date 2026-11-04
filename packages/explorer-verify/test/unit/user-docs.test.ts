// The TypeScript examples of the user docs (R-AX-2), tested against the build as the skill's are
// (R-AX-4): every `ts` block under docs/user/ compiles, and runs with recorded Sourcify answers and
// prints its documented output. A `ts no-run` block is only type-checked; a `ts fragment` block is
// skipped. Run after the build, as `pnpm test` does: the examples import `explorer-verify`,
// `@explorer-verify/foundry` and `@explorer-verify/hardhat`, which resolve to each `dist/`.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  removeProject,
  runExample,
  startExample,
  typeCheck,
  writeFiles,
} from "../helpers/skill.ts";
import type { Run } from "../helpers/skill.ts";
import {
  createDocsProject,
  DOC_FLAGS,
  DOC_GLOBALS,
  docExamples,
  DOCS_PRELOAD,
  exampleFile,
  globalsModule,
  runs,
  shippedContractFiles,
  typeChecked,
  USER_DOCS_DIR,
  userDocPages,
} from "../helpers/user-docs.ts";
import type { DocExample, DocSetup } from "../helpers/user-docs.ts";

const pages = userDocPages();
const parsed = pages.map((page) =>
  docExamples(page, readFileSync(path.join(USER_DOCS_DIR, page), "utf8")),
);
const all: readonly DocExample[] = parsed.flatMap((page) => page.examples);

/** One run of a block: the files it starts from, the answers it gets and what it must print. */
interface DocRun {
  readonly page: string;
  /** The index of the block among the page's `ts` blocks, from 0. */
  readonly example: number;
  readonly what: string;
  /** The files the run starts from; `core` when absent. */
  readonly setup?: DocSetup;
  /** The recorded Sourcify answers, in order (see `skill-fetch.ts`); none when absent. */
  readonly fixtures?: readonly string[];
  /** The expected exit code; 0 when absent. */
  readonly exitCode?: number;
  /** The expected stdout; the block's output block when absent, or nothing when it has none. */
  readonly stdout?: string;
  /** The items `localStorage` starts with, as after a page reload; none when absent. */
  readonly storage?: Readonly<Record<string, string>>;
  /** Files the run must write, relative to the project; none when absent. */
  readonly files?: readonly string[];
}

const NOT_CONFIRMED = [
  "2026-11-02-lookup-not-verified",
  "2026-11-02-submit-accepted",
  "2026-11-02-job-pending*",
  "2026-11-02-lookup-not-verified",
];
const ALREADY_VERIFIED = ["2026-11-02-lookup-exact-match"];
// Etherscan's getsourcecode answer for the Sepolia Greeter, recorded live on 2026-11-04.
const ETHERSCAN_VERIFIED = ["etherscan/2026-11-04-getsourcecode-sepolia-greeter"];
const VERIFIED = [
  "2026-11-02-lookup-not-verified",
  "2026-11-02-submit-accepted",
  "2026-11-02-job-exact-match",
];
/** The handle of the job that `2026-11-02-submit-accepted` recorded. */
const RECORDED_HANDLE =
  "ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const TUTORIAL = "tutorials/deploy-and-verify-from-a-dapp.md";

// A block with no entry here runs once in a `core` project with no answers, and must exit 0 and
// print its output block, or nothing.
const RUNS: readonly DocRun[] = [
  {
    page: "guides/verify-a-contract-from-an-npm-package.md",
    example: 0,
    what: "build the input from Hardhat 3 files in a package",
    setup: "npm-package",
  },
  {
    page: "guides/verify-a-contract-from-an-npm-package.md",
    example: 1,
    what: "rebuild the input from Foundry metadata and sources in a package",
    setup: "npm-package",
  },
  {
    page: "guides/verify-contracts-your-package-ships.md",
    example: 0,
    what: "write the Standard JSON input and the manifest from a Foundry build",
    setup: "foundry",
  },
  {
    page: "guides/verify-contracts-your-package-ships.md",
    example: 1,
    what: "verify the recorded Greeter deployment from the shipped files: already verified",
    setup: "shipped-contracts",
    fixtures: ALREADY_VERIFIED,
  },
  {
    page: "guides/verify-contracts-your-package-ships.md",
    example: 1,
    what: "verify the recorded Greeter deployment from the shipped files: submitted and verified",
    setup: "shipped-contracts",
    fixtures: [
      "2026-11-02-lookup-not-verified",
      "2026-11-02-submit-accepted",
      "2026-11-02-job-exact-match",
    ],
    stdout:
      "verified exact https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc\n",
  },
  {
    page: "guides/verify-from-a-foundry-project.md",
    example: 0,
    what: "verifyInputFromFoundry in a Foundry project",
    setup: "foundry",
  },
  {
    page: "guides/verify-from-a-foundry-project.md",
    example: 1,
    what: "verifyInputFromFoundry picks one of two compiler versions",
    setup: "foundry-multi",
  },
  {
    page: "guides/verify-from-a-foundry-project.md",
    example: 2,
    what: "findFoundryBuild in a Foundry project",
    setup: "foundry",
  },
  {
    page: "guides/verify-from-a-hardhat-project.md",
    example: 0,
    what: "verifyInputFromHardhat on Hardhat 3",
    setup: "hardhat-3",
  },
  {
    page: "guides/verify-from-a-hardhat-project.md",
    example: 0,
    what: "verifyInputFromHardhat on Hardhat 2",
    setup: "hardhat-2",
    stdout: "contracts/Greeter.sol:Greeter\n",
  },
  {
    page: "guides/verify-from-a-hardhat-project.md",
    example: 1,
    what: "findHardhatBuild on Hardhat 3",
    setup: "hardhat-3",
  },
  {
    page: "guides/verify-from-a-hardhat-project.md",
    example: 2,
    what: "libraries for a Hardhat 3 contract that links Tally",
    setup: "hardhat-3",
  },
  {
    page: "reference/api-keys.md",
    example: 0,
    what: "an Etherscan key in route.apiKey: Etherscan finds the Greeter verified",
    fixtures: ETHERSCAN_VERIFIED,
  },
  {
    page: "reference/api-keys.md",
    example: 1,
    what: "an Etherscan key in apiKeys alone; the chain routes to Sourcify",
    fixtures: ALREADY_VERIFIED,
  },
  {
    page: "reference/etherscan.md",
    example: 0,
    what: "route to Etherscan with route.apiKey: Etherscan finds the Greeter verified",
    fixtures: ETHERSCAN_VERIFIED,
  },
  {
    page: "reference/check-status.md",
    example: 1,
    what: "verify() ends not-confirmed, then checkStatus() on the stored handle",
    fixtures: [...NOT_CONFIRMED, "2026-11-02-job-exact-match"],
  },
  {
    page: "reference/errors/index.md",
    example: 0,
    what: "verify() finds the contract verified",
    fixtures: ALREADY_VERIFIED,
  },
  {
    page: "reference/errors/index.md",
    example: 0,
    what: "verify() ends not-confirmed: the handle is stored and the error rethrown",
    fixtures: NOT_CONFIRMED,
    exitCode: 1,
  },
  {
    page: "reference/json-output.md",
    example: 0,
    what: "the envelope of a verified result",
    fixtures: ALREADY_VERIFIED,
  },
  {
    page: "reference/routing.md",
    example: 0,
    what: "allowSourcifyFallback on a listed chain",
    fixtures: ALREADY_VERIFIED,
  },
  {
    page: "reference/server-handler.md",
    example: 0,
    what: "the handler forwards a status poll to Etherscan",
    fixtures: ["etherscan/2026-11-03-checkverifystatus-form-post-key-in-body"],
  },
  {
    page: "reference/verify.md",
    example: 1,
    what: "verify() finds the contract verified",
    fixtures: ALREADY_VERIFIED,
  },
  {
    page: "reference/verify.md",
    example: 1,
    what: "verify() ends not-confirmed: the handle is stored",
    fixtures: NOT_CONFIRMED,
    stdout: "",
  },
  {
    page: "reference/verify.md",
    example: 2,
    what: "linked libraries: verify() finds the contract verified",
    fixtures: ALREADY_VERIFIED,
  },
  {
    page: TUTORIAL,
    example: 0,
    what: "the build script writes the deploy and verify files",
    setup: "foundry",
    files: ["public/contracts/Greeter.deploy.json", "public/contracts/Greeter.verify.json"],
  },
  {
    page: TUTORIAL,
    example: 3,
    what: "verify() submits, shows the handle and ends verified",
    fixtures: VERIFIED,
  },
  {
    page: TUTORIAL,
    example: 3,
    what: "verify() finds the contract verified and submits nothing",
    fixtures: ALREADY_VERIFIED,
    stdout:
      "already-verified (exact) https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc\n",
  },
  {
    page: TUTORIAL,
    example: 3,
    what: "verify() ends not-confirmed: the handle stays saved",
    fixtures: NOT_CONFIRMED,
    stdout: [
      `Submitted. Handle: ${RECORDED_HANDLE}`,
      "Sourcify is still checking. Reload the page later to see the result.",
      "",
    ].join("\n"),
  },
  {
    page: TUTORIAL,
    example: 3,
    what: "another submission is in progress: the code and hint are shown",
    fixtures: ["2026-11-02-lookup-not-verified", "2026-11-02-submit-duplicate"],
    stdout:
      "in-progress: Wait for the explorer to finish its current verification of this contract, then call again.\n",
  },
  {
    page: TUTORIAL,
    example: 5,
    what: "after a reload, checkStatus() resumes the saved handle",
    fixtures: ["2026-11-02-job-exact-match"],
    storage: { "greeter-verification": RECORDED_HANDLE },
  },
  {
    page: TUTORIAL,
    example: 5,
    what: "a load with no saved handle sends nothing",
    stdout: "",
  },
  {
    page: TUTORIAL,
    example: 6,
    what: "verify() reaches Etherscan through the handler, which passes the origin check",
    fixtures: ETHERSCAN_VERIFIED,
  },
  {
    page: "reference/verify.md",
    example: 3,
    what: "keep the handle from verify.submitted",
    fixtures: [
      "2026-11-02-lookup-not-verified",
      "2026-11-02-submit-accepted",
      "2026-11-02-job-exact-match",
    ],
  },
];

/** The runs of each block that runs: its entries in RUNS, or the default run. */
function runsOf(example: DocExample): DocRun[] {
  const listed = RUNS.filter((run) => run.page === example.page && run.example === example.index);
  return listed.length > 0
    ? listed
    : [{ page: example.page, example: example.index, what: "the default run" }];
}

/** A compiler diagnostic without the folder of its file. */
const brief = (line: string): string => line.replace(/^[^(]*\//, "");

/** What went wrong in one run, or `undefined` when it exited and printed as expected. */
function runProblem(example: DocExample, spec: DocRun, run: Run): string | undefined {
  const where = `${example.page}:${String(example.line)}, ${spec.what}`;
  const exitCode = spec.exitCode ?? 0;
  const stdout = spec.stdout ?? example.output ?? "";
  if (run.status !== exitCode) {
    return `${where}: exit code ${String(run.status)}, expected ${String(exitCode)}. stderr:\n${run.stderr}`;
  }
  if (run.stdout !== stdout) {
    return `${where}: printed\n${run.stdout}expected\n${stdout}`;
  }
  return undefined;
}

/** Calls `use` with a new project for each setup it asks for, and removes them all after. */
async function withProjects<T>(
  use: (projectOf: (setup: DocSetup) => string) => T | Promise<T>,
): Promise<T> {
  const projects = new Map<DocSetup, string>();
  try {
    return await use((setup) => {
      const dir = projects.get(setup) ?? createDocsProject(setup);
      projects.set(setup, dir);
      return dir;
    });
  } finally {
    for (const dir of projects.values()) {
      removeProject(dir);
    }
  }
}

/** `work` on each item, at most `limit` at a time, with the results in the order of `items`. */
async function inBatches<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    results.push(...(await Promise.all(items.slice(start, start + limit).map(work))));
  }
  return results;
}

describe("the TypeScript examples of the user docs (R-AX-2)", () => {
  it("finds the pages and their ts blocks", () => {
    assert.ok(pages.includes("reference/verify.md") && pages.includes("README.md"));
    assert.ok(all.length >= 20, `found only ${String(all.length)} ts blocks`);
    assert.ok(all.some((example) => example.flags.includes("fragment")));
  });

  it("flags a block only with no-run or fragment, each with its reason before the block", () => {
    assert.deepEqual(
      parsed.flatMap((page) => page.problems),
      [],
    );
  });

  it("lists in RUNS only blocks that run", () => {
    for (const run of RUNS) {
      const example = all.find((found) => found.page === run.page && found.index === run.example);
      assert.ok(example, `${run.page} has no ts block ${String(run.example)}`);
      assert.ok(runs(example), `${run.page}:${String(example.line)} is flagged and does not run`);
    }
  });

  it("type-checks every block that is not a fragment against the build", async () => {
    // The files a block imports, besides the packages: the verification files a package ships.
    const files: Record<string, string> = shippedContractFiles();
    for (const example of all.filter(typeChecked)) {
      files[exampleFile(example)] = example.code;
    }
    const diagnostics = await withProjects((projectOf) => typeCheck(projectOf("core"), files));
    assert.deepEqual(diagnostics.map(brief), []);
  });

  it("runs every block that is not flagged and prints its documented output", async () => {
    const jobs = all
      .filter(runs)
      .flatMap((example) => runsOf(example).map((spec) => ({ example, spec })));
    const problems = await withProjects(
      async (projectOf) =>
        // Each run is its own process. Only the tutorial's build script and the package guide's
        // script write files, each in a folder no other example reads, so runs can overlap.
        await inBatches(jobs, availableParallelism(), async ({ example, spec }) => {
          const dir = projectOf(spec.setup ?? "core");
          const file = exampleFile(example);
          writeFiles(dir, { [file]: example.code });
          const run = await startExample(dir, file, spec.fixtures ?? [], [DOCS_PRELOAD], {
            DOCS_LOCAL_STORAGE: JSON.stringify(spec.storage ?? {}),
          });
          const missing = (spec.files ?? []).filter((name) => !existsSync(path.join(dir, name)));
          return (
            runProblem(example, spec, run) ??
            (missing.length > 0
              ? `${example.page}:${String(example.line)}, ${spec.what}: did not write ${missing.join(", ")}`
              : undefined)
          );
        }),
    );
    assert.deepEqual(
      problems.filter((problem) => problem !== undefined),
      [],
    );
  });
});

describe("the user-docs checks catch a broken example", () => {
  const page = [
    "Text.",
    "",
    "<!-- no-run: it needs a live explorer -->",
    "",
    "```ts no-run",
    "await verify(input);",
    "```",
    "",
    "```ts fragment",
    "function verify(input: VerifyInput): Promise<VerifyResult>;",
    "```",
    "",
    "<!-- fragment: wrong flag -->",
    "```ts no-run",
    "a();",
    "```",
    "",
    "```text",
    "out",
    "```",
    "",
    "```ts skip fragment",
    "b();",
    "```",
    "",
    "```ts no-run fragment",
    "c();",
    "```",
    "",
    "```ts",
    'console.log("ok");',
    "```",
    "",
  ].join("\n");

  it("reads each block's page, index and flags, and reports a flag without its reason", () => {
    const { examples, problems } = docExamples("guides/x.md", page);
    assert.deepEqual(
      examples.map(({ index, line, flags }) => ({ index, line, flags })),
      [
        { index: 0, line: 5, flags: ["no-run"] },
        { index: 1, line: 9, flags: ["fragment"] },
        { index: 2, line: 14, flags: ["no-run"] },
        { index: 3, line: 22, flags: ["skip", "fragment"] },
        { index: 4, line: 26, flags: ["no-run", "fragment"] },
        { index: 5, line: 30, flags: [] },
      ],
    );
    assert.deepEqual(problems, [
      "guides/x.md:9: a fragment block needs its reason on the line before it: <!-- fragment: why -->",
      "guides/x.md:14: a no-run block needs its reason on the line before it: <!-- no-run: why -->",
      "guides/x.md:14: a no-run block has an output block that no run checks",
      "guides/x.md:22: unknown flag skip; use no-run or fragment",
      "guides/x.md:26: use one flag, not no-run and fragment",
      "guides/x.md:26: a no-run block needs its reason on the line before it: <!-- no-run: why -->",
    ]);
    assert.deepEqual(
      examples.map((example) => [typeChecked(example), runs(example)]),
      [
        [true, false],
        [false, false],
        [true, false],
        [false, false],
        [false, false],
        [true, true],
      ],
    );
    const last = examples.at(-1);
    assert.ok(last);
    assert.equal(exampleFile(last), "guides__x--l30.ts");
    assert.deepEqual(Object.keys(DOC_FLAGS), ["no-run", "fragment"]);
  });

  it("reports code the test would skip: an indented fence or another language name", () => {
    const skipped = [
      "1. A step:",
      "",
      "   ```ts",
      "   a();",
      "   ```",
      "",
      "```typescript",
      "b();",
      "```",
      "",
      "```TS",
      "c();",
      "```",
      "",
      "~~~js",
      "d();",
      "~~~",
      "",
      "- item",
      "",
      "  ```tsx",
      "  e();",
      "  ```",
      "",
      "```json",
      '{ "ok": true }',
      "```",
      "",
      "````md",
      "```javascript",
      "````",
      "",
      "```ts",
      "f();",
      "```",
      "",
    ].join("\n");
    const { examples, problems } = docExamples("guides/y.md", skipped);
    assert.deepEqual(
      examples.map(({ line }) => line),
      [33],
    );
    assert.deepEqual(problems, [
      "guides/y.md:3: an indented ts block is not tested; move it out of the list, unindented, as ts",
      "guides/y.md:7: a typescript block is not tested; use ts",
      "guides/y.md:11: a TS block is not tested; use ts",
      "guides/y.md:15: a js block is not tested; use ts",
      "guides/y.md:21: an indented tsx block is not tested; move it out of the list, unindented, as ts",
    ]);
  });

  it("fails a block that does not compile, and declares only the documented globals", async () => {
    assert.match(globalsModule(), /const input: api\.VerifyInput;/);
    assert.deepEqual(Object.keys(DOC_GLOBALS), [
      "input",
      "apiKey",
      "etherscanKey",
      "explorerKey",
      "deployerAddress",
      "built",
      "request",
    ]);
    const diagnostics = await withProjects((projectOf) =>
      typeCheck(projectOf("core"), {
        "broken--l1.ts": [
          'import { ExplorerVerifyError } from "explorer-verify";',
          "",
          "await verify(input);",
          "console.log(ExplorerVerifyError.name, apiKey.length, undeclared);",
          "",
        ].join("\n"),
      }),
    );
    // Line 3 calls verify without importing it; line 4 names a global the docs do not declare.
    assert.deepEqual(
      diagnostics.map((line) => /^broken--l1\.ts\((\d+),\d+\): error /.exec(brief(line))?.[1]),
      ["3", "4"],
      diagnostics.join("\n"),
    );
  });

  it("defines the globals for a run: input for the recorded contract, dummy keys, localStorage", async () => {
    const run = await withProjects((projectOf) => {
      const dir = projectOf("core");
      writeFiles(dir, {
        "globals--l1.ts": [
          'import { verify } from "explorer-verify";',
          "",
          'localStorage.setItem("k", "v");',
          "const result = await verify(input);",
          'console.log(result.status, input.chainId, localStorage.getItem("k"));',
          'console.log([apiKey, etherscanKey, explorerKey].every((key) => key.startsWith("dummy-")));',
          "",
        ].join("\n"),
      });
      return runExample(dir, "globals--l1.ts", ALREADY_VERIFIED, [DOCS_PRELOAD]);
    });
    assert.equal(run.stdout, "already-verified 11155111 v\ntrue\n", run.stderr);
    assert.equal(run.status, 0);
  });

  it("reports a run that exits with another code or prints something else", () => {
    const example: DocExample = {
      page: "guides/x.md",
      index: 0,
      line: 3,
      flags: [],
      code: "",
      output: "ok\n",
    };
    const spec: DocRun = { page: "guides/x.md", example: 0, what: "a probe" };
    assert.equal(runProblem(example, spec, { stdout: "ok\n", stderr: "", status: 0 }), undefined);
    assert.equal(
      runProblem(example, spec, { stdout: "ok\n", stderr: "boom\n", status: 1 }),
      "guides/x.md:3, a probe: exit code 1, expected 0. stderr:\nboom\n",
    );
    assert.equal(
      runProblem(example, spec, { stdout: "other\n", stderr: "", status: 0 }),
      "guides/x.md:3, a probe: printed\nother\nexpected\nok\n",
    );
    // Without an output block, a run must print nothing.
    assert.match(
      runProblem({ ...example, output: undefined }, spec, {
        stdout: "x\n",
        stderr: "",
        status: 0,
      }) ?? "",
      /printed\nx\nexpected\n$/,
    );
    assert.deepEqual(runsOf(example), [
      { page: "guides/x.md", example: 0, what: "the default run" },
    ]);
  });
});
