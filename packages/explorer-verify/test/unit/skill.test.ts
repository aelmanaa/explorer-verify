// The skill that ships in the package (R-AX-4), tested against the build: each example compiles
// and prints its documented output, and each API name, member path, event name and exit code the
// skill mentions matches the package. Run after the build, as `pnpm test` does: the build copies
// the skill into the package, and the examples import `explorer-verify`, which resolves to `dist/`.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";

import {
  API_SURFACE,
  apiNames,
  checkApiNames,
  codeBlocks,
  createProject,
  eventNames,
  EXAMPLE_LANGUAGES,
  examples,
  inlineSpans,
  memberPaths,
  removeProject,
  resolveInProject,
  runExample,
  SKILL_ENTRIES,
  SKILL_FILE,
  startExample,
  tsc,
  typeCheck,
  typeNamesModule,
  writeFiles,
} from "../helpers/skill.ts";

const skill = readFileSync(SKILL_FILE, "utf8");

// The runtime exports as a user gets them: what `import "explorer-verify"` and the other entries
// the skill uses resolve to from a project that installed the package.
const [resolved = "", ...others] = ((): string[] => {
  const dir = createProject();
  try {
    return SKILL_ENTRIES.map((entry) => resolveInProject(dir, entry));
  } finally {
    removeProject(dir);
  }
})();
const api: Record<string, unknown> = {};
for (const url of [resolved, ...others]) {
  const module: unknown = await import(url);
  Object.assign(api, module);
}
const exitCodes: Record<string, unknown> = Object(api.ERROR_EXIT_CODES);

const HANDLE_FILE = "verification-handle.txt";
const HANDLE =
  "ev1:sourcify:11155111:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
const VERIFIED =
  "verified exact https://repo.sourcify.dev/11155111/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc\n";

/** One run of an example: the recorded answers it gets, and what it must print and leave. */
interface RunSpec {
  readonly what: string;
  /** The index of the example in the skill, from 0. */
  readonly example: number;
  readonly fixtures: readonly string[];
  readonly exitCode: number;
  /** The expected stdout; the example's documented output when absent. */
  readonly stdout?: string;
  /** Files written before the run. */
  readonly before?: Readonly<Record<string, string>>;
  /** The stored handle after the run: its content, or `null` when there must be none. */
  readonly handleAfter?: string | null;
}

// The runs, in order, in one project: later runs read the files earlier ones write.
const RUNS: readonly RunSpec[] = [
  { what: "build the input from metadata and sources", example: 0, fixtures: [], exitCode: 0 },
  {
    what: "verify: not verified yet, submit accepted, the first poll finds an exact match",
    example: 1,
    fixtures: [
      "2026-11-02-lookup-not-verified",
      "2026-11-02-submit-accepted",
      "2026-11-02-job-exact-match",
    ],
    exitCode: 0,
    handleAfter: null,
  },
  {
    what: "a stored handle: checkStatus, no submit, and the handle is deleted",
    example: 1,
    fixtures: ["2026-11-02-job-exact-match"],
    exitCode: 0,
    stdout: VERIFIED,
    before: { [HANDLE_FILE]: `${HANDLE}\n` },
    handleAfter: null,
  },
  {
    what: "the job stays pending past the budget: not-confirmed, exit 4, the handle is kept",
    example: 1,
    fixtures: [
      "2026-11-02-lookup-not-verified",
      "2026-11-02-submit-accepted",
      "2026-11-02-job-pending*",
      "2026-11-02-lookup-not-verified",
    ],
    exitCode: 4,
    stdout: `not-confirmed ${HANDLE} Call checkStatus with details.handle later to continue polling.\n`,
    handleAfter: HANDLE,
  },
  {
    what: "the envelope of a verify() whose lookup finds the contract verified",
    example: 2,
    fixtures: ["2026-11-02-lookup-exact-match"],
    exitCode: 0,
    before: {},
  },
  { what: "the envelope of an invalid input", example: 3, fixtures: [], exitCode: 2 },
];

const fileOf = (index: number): string => `example-${String(index + 1)}.ts`;

/** The rows of the first Markdown table after the line that holds `heading`, without its head. */
function tableAfter(markdown: string, heading: string): string[][] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.includes(heading));
  assert.ok(start >= 0, `no "${heading}" in the skill`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("|")) {
      rows.push(
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    } else if (rows.length > 0) {
      break;
    }
  }
  return rows.slice(2);
}

/** Every `const` string in a JSON Schema. */
function constants(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null) {
    return [];
  }
  const own: unknown = Reflect.get(schema, "const");
  return [
    ...(typeof own === "string" ? [own] : []),
    ...Object.values(schema).flatMap((value: unknown) => constants(value)),
  ];
}

describe("the shipped skill (R-AX-4)", () => {
  it("has the frontmatter an agent reads: name and description", () => {
    const head = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    assert.ok(head, "SKILL.md must start with a frontmatter block");
    const fields = new Map<string, string>();
    for (const line of String(head[1]).split("\n")) {
      const colon = line.indexOf(":");
      fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    assert.equal(fields.get("name"), "explorer-verify");
    const description = fields.get("description") ?? "";
    assert.ok(description.length > 0 && description.length <= 1024, "description: 1 to 1024 chars");
    for (const word of ["Sourcify", "Etherscan", "Foundry", "Hardhat", "permanently"]) {
      assert.ok(description.includes(word), `the description names ${word}`);
    }
  });

  it("uses only ts and sh blocks for code, each ts block followed by the text block it prints", () => {
    const languages = new Set(codeBlocks(skill).map((block) => block.lang));
    assert.deepEqual(
      [...languages].filter((lang) => !EXAMPLE_LANGUAGES.includes(lang)),
      [],
      `code blocks may only be ${EXAMPLE_LANGUAGES.join(" or ")}`,
    );
    const found = examples(skill);
    for (const [index, example] of found.entries()) {
      assert.notEqual(
        example.output,
        undefined,
        `the example at line ${String(example.line)} has no output block`,
      );
      assert.ok(
        RUNS.some((run) => run.example === index && run.stdout === undefined),
        `the example at line ${String(example.line)} needs a run in RUNS that checks its output`,
      );
    }
    assert.ok(RUNS.every((run) => run.example < found.length));
  });

  it("resolves explorer-verify to dist/ for types and runtime, as a user gets it", () => {
    assert.match(resolved, /\/dist\/src\/index\.js$/);
    const dir = createProject();
    try {
      writeFiles(dir, {
        "probe.ts":
          'import type * as api from "explorer-verify";\nexport type T = api.VerifyInput;\n',
      });
      const files = tsc(dir, "--listFilesOnly");
      assert.match(files, /explorer-verify\/dist\/src\/index\.d\.ts/);
      assert.doesNotMatch(files, /explorer-verify\/src\//);
    } finally {
      removeProject(dir);
    }
  });

  it("compiles every example, and names only exported APIs and existing fields", () => {
    const { problems, typeNames } = checkApiNames(apiNames(skill), api);
    assert.deepEqual(problems, []);
    // The types the skill names, which the runtime exports cannot show.
    assert.ok(typeNames.includes("VerifyOutcome") && typeNames.includes("VerifyInput"));
    const paths = memberPaths(skill);
    assert.ok(paths.includes("error.details.issues") && paths.includes("result.reason"));
    const dir = createProject();
    try {
      const files: Record<string, string> = {
        ...API_SURFACE,
        "api-names.ts": typeNamesModule(typeNames, paths),
      };
      examples(skill).forEach((example, index) => {
        files[fileOf(index)] = example.code;
      });
      assert.deepEqual(typeCheck(dir, files), []);
    } finally {
      removeProject(dir);
    }
  });

  it("names only events the event schema defines", () => {
    const schema: unknown = JSON.parse(
      readFileSync(new URL("../../schema/event.schema.json", import.meta.url), "utf8"),
    );
    const known = constants(schema);
    const named = eventNames(skill);
    assert.ok(named.includes("verify.submitted"));
    assert.deepEqual(
      named.filter((name) => !known.includes(name)),
      [],
    );
  });

  it("lists each exit code the package uses, and each error code under its exit code", () => {
    const rows = tableAfter(skill, "Act on the exit code");
    const table = rows.map((row) => Number(row[0])).toSorted((a, b) => a - b);
    const used = [...new Set([0, 1, ...Object.values(exitCodes).map(Number)])].toSorted(
      (a, b) => a - b,
    );
    assert.deepEqual(table, used);
    for (const row of rows) {
      for (const match of String(row[1]).matchAll(/`([a-z-]+)`/g)) {
        const code = String(match[1]);
        if (Object.hasOwn(exitCodes, code)) {
          assert.equal(
            exitCodes[code],
            Number(row[0]),
            `${code} is under exit code ${String(row[0])}`,
          );
        }
      }
    }
  });

  it("never lists verify() among the calls that never submit", () => {
    const calls = tableAfter(skill, "These calls never submit").map((row) => row[0]);
    assert.ok(calls.length > 0);
    assert.ok(!calls.includes("`verify()`"), "verify() submits");
  });

  it('keeps the rules on redirects and stopping: redirect: "manual" and When to stop', () => {
    const doNot = skill.slice(skill.indexOf("## Do not"));
    assert.match(doNot, /redirect: "manual"/);
    assert.match(skill, /^## When to stop$/m);
  });

  it("runs every example against recorded Sourcify answers and prints its documented output", () => {
    const found = examples(skill);
    const dir = createProject();
    try {
      found.forEach((example, index) => {
        writeFiles(dir, { [fileOf(index)]: example.code });
      });
      for (const spec of RUNS) {
        const example = found[spec.example];
        assert.ok(example);
        if (spec.before !== undefined) {
          rmSync(path.join(dir, HANDLE_FILE), { force: true });
          writeFiles(dir, spec.before);
        }
        const run = runExample(dir, fileOf(spec.example), spec.fixtures);
        const where = `${spec.what} (example ${String(spec.example + 1)}, SKILL.md line ${String(example.line)})`;
        assert.equal(run.status, spec.exitCode, `${where}: exit code. stderr:\n${run.stderr}`);
        assert.equal(run.stdout, spec.stdout ?? example.output, `${where}: output`);
        if (spec.handleAfter === null) {
          assert.equal(existsSync(path.join(dir, HANDLE_FILE)), false, `${where}: handle deleted`);
        } else if (spec.handleAfter !== undefined) {
          assert.equal(readFileSync(path.join(dir, HANDLE_FILE), "utf8"), spec.handleAfter);
        }
      }
    } finally {
      removeProject(dir);
    }
  });
});

describe("the skill checks catch a stale skill", () => {
  const stale = [
    "Call `notExported()` and read `MissingType`. `verify()`, `VerifyResult`, `Request`,",
    "`ERROR_EXIT_CODES[code]`, `checkStatus(handle, { timeoutMs })` and `result.status` are fine;",
    "`fetch` and `route` are not API names. `ERROR_CODES()` is not a call.",
    "",
    "```ts",
    "`notInsideFences()`",
    "```",
    "",
  ].join("\n");

  it("lists the API names in inline code, outside code blocks, including calls with arguments", () => {
    assert.deepEqual(
      apiNames(stale).map(({ name, call }) => `${name}${call ? "()" : ""}`),
      [
        "notExported()",
        "MissingType",
        "verify()",
        "VerifyResult",
        "Request",
        "ERROR_EXIT_CODES",
        "checkStatus()",
        "ERROR_CODES()",
      ],
    );
    assert.deepEqual(memberPaths(stale), ["result.status"]);
    assert.deepEqual(
      inlineSpans(stale).map(({ line }) => line),
      [1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3],
    );
  });

  it("fails a call that is not an exported function, and a type or field that does not exist", () => {
    const { problems, typeNames } = checkApiNames(apiNames(stale), api);
    assert.deepEqual(problems, [
      "line 1: notExported() is not a function the package exports",
      "line 3: ERROR_CODES() is not a function the package exports",
    ]);
    assert.deepEqual(typeNames, ["MissingType", "VerifyResult"]);
    const dir = createProject();
    try {
      const diagnostics = typeCheck(dir, {
        ...API_SURFACE,
        "api-names.ts": typeNamesModule(typeNames, [
          "result.status",
          "error.details.issues",
          "error.details.gone",
          "result.nothing",
        ]),
        "example-1.ts":
          'import { verify } from "explorer-verify";\n\nawait verify({ chainId: 1 });\n',
      });
      // Line 4 checks MissingType, line 5 VerifyResult, lines 6 to 9 the valid paths, line 10
      // `gone` and line 11 `nothing`.
      const failing = diagnostics.flatMap((line) => {
        const match = /api-names\.ts\((\d+),/.exec(line);
        return match === null ? [] : [Number(match[1])];
      });
      assert.deepEqual(failing, [4, 10, 11]);
      assert.match(diagnostics.join("\n"), /api-names\.ts\(4,.*MissingType/);
      assert.ok(diagnostics.some((line) => line.includes("example-1.ts")));
    } finally {
      removeProject(dir);
    }
  });

  it("pairs each ts block with the text block after it, and rejects an unclosed fence", () => {
    const text = ["```ts", "a();", "```", "", "```text", "out", "```", "```ts  no-run x ", "b();"];
    assert.deepEqual(examples([...text, "```", ""].join("\n")), [
      { line: 1, flags: [], title: undefined, code: "a();\n", output: "out\n" },
      { line: 8, flags: ["no-run", "x"], title: undefined, code: "b();\n", output: undefined },
    ]);
    // A title in brackets follows the language and the flags, with or without a space inside.
    assert.deepEqual(
      codeBlocks("```ts no-run [src/my file.ts]\nc();\n```\n").map(({ flags, title }) => ({
        flags,
        title,
      })),
      [{ flags: ["no-run"], title: "src/my file.ts" }],
    );
    assert.equal(examples("```ts\na();\n```\n\n```json\n{}\n```\n")[0]?.output, undefined);
    assert.throws(() => codeBlocks("```ts\na();\n"), /line 1 is never closed/);
  });

  it("fails a run whose requests differ from the fixtures, or leave one unused", () => {
    const dir = createProject();
    try {
      const job = "https://sourcify.dev/server/v2/verify/ae2fbfae-1d81-4284-9a2d-3dfd8cdb1718";
      writeFiles(dir, {
        "follows.ts": `await fetch("${job}");\n`,
        "nothing.ts": 'console.log("no request");\n',
        "wrong.ts":
          'await fetch("https://sourcify.dev/server/v2/other", { redirect: "manual" });\n',
        "post.ts": `await fetch("${job}", { method: "POST", redirect: "manual" });\n`,
        "extra.ts": 'await fetch("https://sourcify.dev/", { redirect: "manual" });\n',
        "repeat.ts": [
          `for (let i = 0; i < 3; i += 1) await fetch("${job}", { redirect: "manual" });`,
          'await fetch("https://sourcify.dev/server/v2/other", { redirect: "manual" });',
          "",
        ].join("\n"),
      });
      const exact = ["2026-11-02-job-exact-match"];
      const follows = runExample(dir, "follows.ts", exact);
      assert.equal(follows.status, 1);
      assert.match(follows.stderr, /without redirect: "manual"/);
      const unused = runExample(dir, "nothing.ts", exact);
      assert.equal(unused.status, 1);
      assert.match(unused.stderr, /1 fixtures left unused/);
      const wrong = runExample(dir, "wrong.ts", exact);
      assert.equal(wrong.status, 1);
      assert.match(wrong.stderr, /but the fixture recorded GET/);
      const post = runExample(dir, "post.ts", exact);
      assert.equal(post.status, 1);
      assert.match(post.stderr, /request 1 is POST .* but the fixture recorded GET/);
      const extra = runExample(dir, "extra.ts", []);
      assert.equal(extra.status, 1);
      assert.match(extra.stderr, /unexpected request 1/);
      // A repeating fixture answers each matching request, then gives way to the next one.
      const repeat = runExample(dir, "repeat.ts", ["2026-11-02-job-pending*"]);
      assert.equal(repeat.status, 1);
      assert.match(repeat.stderr, /unexpected request 4/);
      const unusedRepeat = runExample(dir, "nothing.ts", ["2026-11-02-job-pending*"]);
      assert.match(unusedRepeat.stderr, /1 fixtures left unused/);
    } finally {
      removeProject(dir);
    }
  });

  it("keeps sync and async example output plain under forced colors (#272)", async () => {
    const dir = createProject();
    const previous = process.env["FORCE_COLOR"];
    try {
      process.env["FORCE_COLOR"] = "3";
      writeFiles(dir, {
        "colors.ts": [
          'console.log(false, 2, { status: "verified" });',
          'console.error(true, 4, { status: "pending" });',
          "",
        ].join("\n"),
      });
      const sync = runExample(dir, "colors.ts", []);
      const asyncRun = await startExample(dir, "colors.ts", [], [], { FORCE_COLOR: "3" });
      for (const run of [sync, asyncRun]) {
        assert.equal(run.status, 0);
        assert.equal(run.stdout, "false 2 { status: 'verified' }\n");
        // Node 24.0 prints a type-stripping warning for the preload before the example runs.
        assert.match(run.stderr, /(?:^|\n)true 4 \{ status: 'pending' \}\n$/);
        assert.equal(run.stderr, stripVTControlCharacters(run.stderr));
        assert.doesNotMatch(run.stderr, /NO_COLOR.*ignored/);
      }
      assert.equal(process.env["FORCE_COLOR"], "3");
    } finally {
      if (previous === undefined) {
        delete process.env["FORCE_COLOR"];
      } else {
        process.env["FORCE_COLOR"] = previous;
      }
      removeProject(dir);
    }
  });

  it("speeds up long waits and moves the clock by the time they were due", () => {
    const dir = createProject();
    try {
      writeFiles(dir, {
        "wait.ts": [
          "const start = Date.now();",
          "await new Promise((resolve) => setTimeout(resolve, 60_000));",
          "const long = Date.now() - start;",
          "await new Promise((resolve) => setTimeout(resolve, 5));",
          "console.log(long >= 60_000, long < 61_000);",
          "",
        ].join("\n"),
      });
      const started = performance.now();
      const run = runExample(dir, "wait.ts", []);
      assert.equal(run.stdout, "true true\n");
      assert.ok(performance.now() - started < 10_000);
    } finally {
      removeProject(dir);
    }
  });
});
