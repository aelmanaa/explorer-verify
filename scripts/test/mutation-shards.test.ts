// Tests the shard plan of the full mutation run (scripts/mutation-shards.ts and
// scripts/plan-mutation-shards.ts) and the merge of the shards' reports (scripts/mutation-merge.ts
// and scripts/merge-mutation-reports.ts), as the Mutation workflow runs them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { keepShard, mergeReports } from "../mutation-merge.ts";
import {
  checkPlan,
  cut,
  lineCount,
  MUTANT_OVERHEAD_MS,
  mutantTimes,
  planShards,
  topLevelStatements,
  weigh,
} from "../mutation-shards.ts";
import type { MutantTime, Shard, SourceFile, Statement } from "../mutation-shards.ts";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mutation-shards-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Three top-level statements: lines 1, 3-5 and 7-9, then a comment on line 10.
const THREE = [
  'const a = "a";',
  "",
  "export function b(x: number): number {",
  "  return x + 1;",
  "}",
  "",
  "function c(): string {",
  "  return `${a}`;",
  "}",
  "// end",
  "",
].join("\n");

const statement = (start: number, end: number, weight: number): Statement => ({
  start,
  end,
  weight,
});

/** The location of a mutant that starts on `line`. */
const at = (line: number): unknown => ({ start: { line, column: 0 } });

/** A package with stryker.config.json and three files to mutate, two of them by a glob. */
function writePackage(): string {
  const pkg = path.join(dir, "pkg");
  mkdirSync(path.join(pkg, "src", "clients"), { recursive: true });
  writeFileSync(path.join(pkg, "src", "a.ts"), THREE);
  writeFileSync(path.join(pkg, "src", "clients", "b.ts"), "const b = 1;\n");
  writeFileSync(path.join(pkg, "src", "clients", "c.ts"), "const c = 1;\n");
  writeFileSync(
    path.join(pkg, "stryker.config.json"),
    JSON.stringify({ mutate: ["src/a.ts", "src/clients/*.ts", "src/a.ts"] }),
  );
  return pkg;
}

function shard(...mutate: string[]): Shard {
  return { mutate, weight: 0 };
}

function run(
  script: string,
  args: readonly string[],
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", path.join(scripts, script), ...args],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("topLevelStatements and lineCount", () => {
  it("gives the lines of each top-level statement, as Stryker's parser reads them", () => {
    assert.deepEqual(topLevelStatements({ file: "src/x.ts", text: THREE }), [
      statement(1, 1, 0),
      statement(3, 5, 0),
      statement(7, 9, 0),
    ]);
  });

  it("counts a last line with or without a newline", () => {
    assert.equal(lineCount(THREE), 10);
    assert.equal(lineCount("a\nb"), 2);
    assert.equal(lineCount(""), 0);
  });
});

describe("mutantTimes", () => {
  it("is empty without a report", () => {
    assert.equal(mutantTimes(undefined).size, 0);
  });

  it("adds the overhead to each mutant that ran, and skips the others", () => {
    const times = mutantTimes({
      files: {
        "src/x.ts": {
          mutants: [
            { status: "Killed", duration: 100, location: at(3) },
            { status: "Timeout", location: at(4) },
            { status: "Ignored", duration: 5, location: at(1) },
            { status: "NoCoverage", location: at(7) },
            { status: "Survived", duration: 7 },
          ],
        },
      },
    });
    assert.deepEqual(times.get("src/x.ts"), [
      { line: 3, ms: 100 + MUTANT_OVERHEAD_MS },
      { line: 4, ms: MUTANT_OVERHEAD_MS },
    ]);
  });

  it("refuses a report without the Stryker shape", () => {
    assert.throws(() => mutantTimes({}), /report: files must be an object/);
    assert.throws(() => mutantTimes({ files: [] }), /report: files must be an object/);
    assert.throws(
      () => mutantTimes({ files: { "src/x.ts": {} } }),
      /report: src\/x\.ts mutants must be a list/,
    );
  });
});

describe("weigh", () => {
  const sources: SourceFile[] = [
    { file: "src/x.ts", text: THREE },
    { file: "src/y.ts", text: THREE },
  ];

  it("weighs a statement by its mutants' time, and a file without times by its length", () => {
    const times = new Map<string, MutantTime[]>([
      [
        "src/x.ts",
        [
          { line: 4, ms: 300 },
          { line: 8, ms: 100 },
          { line: 8, ms: 100 },
          // A mutant from older code, outside every statement.
          { line: 10, ms: 1000 },
        ],
      ],
    ]);
    const [x, y] = weigh(sources, times);
    assert.deepEqual(x, [statement(1, 1, 0), statement(3, 5, 300), statement(7, 9, 200)]);
    // 500 ms over the characters of src/x.ts.
    const perChar = 500 / THREE.length;
    assert.deepEqual(
      y?.map((each) => Math.round(each.weight / perChar)),
      [15, 57, 42],
    );
  });

  it("weighs every file by its length without a report", () => {
    const [x] = weigh(sources, new Map());
    assert.deepEqual(
      x?.map((each) => each.weight),
      [15, 57, 42],
    );
  });
});

describe("cut", () => {
  const statements = [statement(1, 1, 5), statement(3, 5, 5), statement(7, 9, 5)];

  it("keeps a file whole when it fits, or when it has one statement", () => {
    assert.deepEqual(cut("src/x.ts", statements, 10, 15), [{ mutate: "src/x.ts", weight: 15 }]);
    assert.deepEqual(cut("src/x.ts", [statement(1, 9, 50)], 10, 15), [
      { mutate: "src/x.ts", weight: 50 },
    ]);
  });

  it("cuts between statements, from line 1 to the last line", () => {
    assert.deepEqual(cut("src/x.ts", statements, 10, 10), [
      { mutate: "src/x.ts:1-5", weight: 10 },
      { mutate: "src/x.ts:6-10", weight: 5 },
    ]);
  });

  it("gives a statement heavier than the limit a range of its own", () => {
    const heavy = [statement(1, 1, 1), statement(3, 5, 30), statement(7, 9, 1)];
    assert.deepEqual(cut("src/x.ts", heavy, 10, 10), [
      { mutate: "src/x.ts:1-1", weight: 1 },
      { mutate: "src/x.ts:2-5", weight: 30 },
      { mutate: "src/x.ts:6-10", weight: 1 },
    ]);
  });
});

describe("checkPlan", () => {
  const sources: SourceFile[] = [
    { file: "src/x.ts", text: THREE },
    { file: "src/y.ts", text: "const y = 1;\n" },
  ];

  it("accepts whole files and ranges that cover each line once", () => {
    checkPlan(sources, [shard("src/x.ts:1-5", "src/y.ts"), shard("src/x.ts:6-10")]);
  });

  it("refuses a file that is not in the config", () => {
    assert.throws(
      () => checkPlan(sources, [shard("src/x.ts", "src/y.ts", "src/z.ts")]),
      /src\/z\.ts is not a file to mutate/,
    );
  });

  it("refuses a missing file", () => {
    assert.throws(() => checkPlan(sources, [shard("src/x.ts")]), /no shard mutates src\/y\.ts/);
  });

  it("refuses a gap, an overlap, a whole file next to a range, or a short last range", () => {
    for (const plan of [
      [shard("src/x.ts:1-4", "src/x.ts:6-10", "src/y.ts")],
      [shard("src/x.ts:1-5", "src/x.ts:5-10", "src/y.ts")],
      [shard("src/x.ts", "src/x.ts:1-10", "src/y.ts")],
      [shard("src/x.ts:1-5", "src/x.ts:7-6", "src/y.ts")],
    ]) {
      assert.throws(() => checkPlan(sources, plan), /do not cover each line once/);
    }
    assert.throws(
      () => checkPlan(sources, [shard("src/x.ts:1-5", "src/x.ts:6-9", "src/y.ts")]),
      /stop before its last line/,
    );
  });
});

describe("planShards", () => {
  const sources: SourceFile[] = [
    { file: "src/a.ts", text: THREE },
    { file: "src/b.ts", text: "const b = 1;\n" },
    { file: "src/c.ts", text: "const c = 1;\n" },
  ];
  const times = new Map<string, MutantTime[]>([
    [
      "src/a.ts",
      [
        { line: 1, ms: 40 },
        { line: 4, ms: 40 },
        { line: 8, ms: 40 },
      ],
    ],
    ["src/b.ts", [{ line: 1, ms: 30 }]],
    ["src/c.ts", [{ line: 1, ms: 30 }]],
  ]);

  it("cuts a file heavier than a shard and balances the units", () => {
    const shards = planShards(sources, times, 3);
    assert.deepEqual(shards, [
      { mutate: ["src/a.ts:1-1", "src/b.ts"], weight: 70 },
      { mutate: ["src/a.ts:2-5", "src/c.ts"], weight: 70 },
      { mutate: ["src/a.ts:6-10"], weight: 40 },
    ]);
  });

  it("leaves a shard empty when there are fewer units than shards", () => {
    const shards = planShards(sources.slice(1), times, 3);
    assert.deepEqual(
      shards.map((each) => each.mutate),
      [["src/b.ts"], ["src/c.ts"], []],
    );
  });

  it("refuses a shard count that is not a whole number from 1", () => {
    for (const count of [0, 1.5, Number.NaN]) {
      assert.throws(() => planShards(sources, times, count), /whole number from 1/);
    }
  });
});

describe("plan-mutation-shards.ts", () => {
  it("prints the matrix of the non-empty shards and their weights", () => {
    const pkg = writePackage();
    const reportFile = path.join(dir, "report.json");
    writeFileSync(
      reportFile,
      JSON.stringify({
        files: {
          "src/a.ts": { mutants: [{ status: "Killed", duration: 9000, location: at(4) }] },
        },
      }),
    );
    const result = run("plan-mutation-shards.ts", [pkg, "4", reportFile]);
    assert.equal(result.status, 0, result.stderr);
    const matrix: unknown = JSON.parse(result.stdout);
    assert.deepEqual(matrix, {
      include: [
        { shard: 1, mutate: "src/a.ts:2-5" },
        { shard: 2, mutate: "src/clients/b.ts" },
        { shard: 3, mutate: "src/clients/c.ts" },
        { shard: 4, mutate: "src/a.ts:1-1,src/a.ts:6-10" },
      ],
    });
    assert.match(result.stderr, /shard 1: weight 11500, src\/a\.ts:2-5\n/);
  });

  it("weighs by length when the report is missing, and says so", () => {
    const pkg = writePackage();
    const result = run("plan-mutation-shards.ts", [pkg, "1", path.join(dir, "none.json")]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /No report at .*none\.json: the shards are weighed by file length/);
    assert.deepEqual(JSON.parse(result.stdout), {
      include: [{ shard: 1, mutate: "src/a.ts,src/clients/b.ts,src/clients/c.ts" }],
    });
  });

  it("plans without a report argument", () => {
    const pkg = writePackage();
    const result = run("plan-mutation-shards.ts", [pkg, "2"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /No report/);
  });

  it("fails without arguments or with a config whose mutate is not a list of patterns", () => {
    assert.notEqual(run("plan-mutation-shards.ts", []).status, 0);
    const pkg = path.join(dir, "bad");
    mkdirSync(pkg);
    for (const config of [{ mutate: "src/a.ts" }, { mutate: [1] }, null]) {
      writeFileSync(path.join(pkg, "stryker.config.json"), JSON.stringify(config));
      const result = run("plan-mutation-shards.ts", [pkg, "2"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /`mutate` must be a list of file patterns/);
    }
  });
});

/** A Stryker report of one shard: its files, and the tests it names, each id given. */
function report(
  files: Record<string, unknown>,
  tests: Record<string, { id: string; name: string }[]>,
): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    thresholds: { high: 90, low: 80, break: null },
    files,
    testFiles: Object.fromEntries(
      Object.entries(tests).map(([file, list]) => [file, { source: `// ${file}`, tests: list }]),
    ),
  };
}

const loc = (line: number): unknown => ({
  start: { line, column: 1 },
  end: { line, column: 5 },
});

describe("mergeReports", () => {
  const shardOne = report(
    {
      "src/b.ts": {
        language: "typescript",
        source: "b",
        mutants: [
          {
            id: "0",
            mutatorName: "BooleanLiteral",
            replacement: "false",
            status: "Killed",
            location: loc(1),
            coveredBy: ["0", "1"],
            killedBy: ["1"],
          },
        ],
      },
      "src/a.ts": {
        language: "typescript",
        source: "a",
        mutants: [
          {
            id: "1",
            mutatorName: "StringLiteral",
            replacement: '""',
            status: "Survived",
            location: loc(2),
            coveredBy: ["0"],
          },
        ],
      },
    },
    {
      "test/unit/one.test.ts": [{ id: "0", name: "test/unit/one.test.ts" }],
      "test/unit/two.test.ts": [{ id: "1", name: "test/unit/two.test.ts" }],
    },
  );
  // The same test files under other ids, and a range of src/a.ts that shard one did not mutate.
  const shardTwo = report(
    {
      "src/a.ts": {
        language: "typescript",
        source: "a",
        mutants: [
          {
            id: "0",
            mutatorName: "StringLiteral",
            replacement: '""',
            status: "Killed",
            location: loc(9),
            coveredBy: ["5"],
            killedBy: ["5"],
          },
          {
            id: "1",
            mutatorName: "Regex",
            replacement: "/a/",
            status: "NoCoverage",
            location: loc(9),
          },
        ],
      },
    },
    {
      "test/unit/two.test.ts": [{ id: "5", name: "test/unit/two.test.ts" }],
      "test/unit/three.test.ts": [{ id: "6", name: "test/unit/three.test.ts" }],
    },
  );

  it("joins the files, renumbers the mutants and maps the test ids", () => {
    const merged = mergeReports([shardOne, shardTwo]);
    assert.equal(merged["schemaVersion"], "1.0");
    assert.deepEqual(merged["thresholds"], { high: 90, low: 80, break: null });
    assert.deepEqual(merged["files"], {
      "src/a.ts": {
        language: "typescript",
        source: "a",
        mutants: [
          {
            id: "0",
            mutatorName: "StringLiteral",
            replacement: '""',
            status: "Survived",
            location: loc(2),
            coveredBy: ["0"],
          },
          {
            id: "1",
            mutatorName: "StringLiteral",
            replacement: '""',
            status: "Killed",
            location: loc(9),
            coveredBy: ["1"],
            killedBy: ["1"],
          },
          {
            id: "2",
            mutatorName: "Regex",
            replacement: "/a/",
            status: "NoCoverage",
            location: loc(9),
          },
        ],
      },
      "src/b.ts": {
        language: "typescript",
        source: "b",
        mutants: [
          {
            id: "3",
            mutatorName: "BooleanLiteral",
            replacement: "false",
            status: "Killed",
            location: loc(1),
            coveredBy: ["0", "1"],
            killedBy: ["1"],
          },
        ],
      },
    });
    assert.deepEqual(merged["testFiles"], {
      "test/unit/one.test.ts": {
        source: "// test/unit/one.test.ts",
        tests: [{ id: "0", name: "test/unit/one.test.ts" }],
      },
      "test/unit/three.test.ts": {
        source: "// test/unit/three.test.ts",
        tests: [{ id: "2", name: "test/unit/three.test.ts" }],
      },
      "test/unit/two.test.ts": {
        source: "// test/unit/two.test.ts",
        tests: [{ id: "1", name: "test/unit/two.test.ts" }],
      },
    });
  });

  it("merges a report without testFiles", () => {
    const merged = mergeReports([{ files: { "src/c.ts": { source: "c", mutants: [] } } }]);
    assert.deepEqual(merged, {
      files: { "src/c.ts": { language: undefined, source: "c", mutants: [] } },
      testFiles: {},
    });
  });

  it("refuses no report, two texts of a file, a mutant twice and a test it cannot name", () => {
    assert.throws(() => mergeReports([]), /no report to merge/);
    const other = report({ "src/b.ts": { source: "B", mutants: [] } }, {});
    assert.throws(() => mergeReports([shardOne, other]), /src\/b\.ts has another text/);
    assert.throws(
      () => mergeReports([shardOne, shardOne]),
      /has a mutant that an earlier report has/,
    );
    const unnamed = report(
      {
        "src/c.ts": {
          source: "c",
          mutants: [
            { mutatorName: "Regex", replacement: "/c/", location: loc(1), killedBy: ["9"] },
          ],
        },
      },
      {},
    );
    assert.throws(() => mergeReports([unnamed]), /src\/c\.ts killedBy names a test that is not in/);
    const numbered = report(
      {
        "src/c.ts": {
          source: "c",
          mutants: [{ mutatorName: "Regex", replacement: "/c/", location: loc(1), coveredBy: [0] }],
        },
      },
      {},
    );
    assert.throws(() => mergeReports([numbered]), /coveredBy names a test that is not in/);
  });

  it("refuses a report without the Stryker shape", () => {
    assert.throws(() => mergeReports([{}]), /report 1: files must be an object/);
    assert.throws(
      () => mergeReports([{ files: { "src/c.ts": { mutants: {} } } }]),
      /report 1: src\/c\.ts mutants must be a list/,
    );
    assert.throws(
      () => mergeReports([{ files: {}, testFiles: { "t.ts": { tests: [{ id: 1 }] } } }]),
      /a test of t\.ts has no id or name/,
    );
    assert.throws(
      () => mergeReports([{ files: {}, testFiles: { "t.ts": {} } }]),
      /t\.ts tests must be a list/,
    );
    assert.throws(
      () =>
        mergeReports([
          { files: { "src/c.ts": { source: "c", mutants: [{ coveredBy: "0" }] } }, testFiles: {} },
        ]),
      /src\/c\.ts coveredBy must be a list/,
    );
  });
});

describe("merge-mutation-reports.ts", () => {
  it("writes the merged report, making its directory", () => {
    const one = path.join(dir, "one.json");
    const two = path.join(dir, "two.json");
    writeFileSync(one, JSON.stringify(report({ "src/a.ts": { source: "a", mutants: [] } }, {})));
    writeFileSync(two, JSON.stringify(report({ "src/b.ts": { source: "b", mutants: [] } }, {})));
    const out = path.join(dir, "reports", "mutation", "mutation.json");
    const result = run("merge-mutation-reports.ts", [out, one, two]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Merged 2 reports into /);
    const merged: unknown = JSON.parse(readFileSync(out, "utf8"));
    const expected = mergeReports([
      JSON.parse(readFileSync(one, "utf8")),
      JSON.parse(readFileSync(two, "utf8")),
    ]);
    // JSON text drops the undefined language of these files.
    assert.deepEqual(merged, JSON.parse(JSON.stringify(expected)));
  });

  it("fails without a report to merge", () => {
    const result = run("merge-mutation-reports.ts", [path.join(dir, "out.json")]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage: node scripts\/merge-mutation-reports\.ts/);
  });
});

describe("keepShard", () => {
  const full = report(
    {
      "src/a.ts": {
        source: "a",
        mutants: [
          { mutatorName: "Regex", replacement: "/1/", location: loc(2) },
          { mutatorName: "Regex", replacement: "/2/", location: loc(9) },
          { mutatorName: "Regex", replacement: "/3/" },
        ],
      },
      "src/b.ts": {
        source: "b",
        mutants: [{ mutatorName: "Regex", replacement: "/b/", location: loc(1) }],
      },
      "src/c.ts": { source: "c", mutants: [] },
    },
    {},
  );

  it("keeps the shard's whole files and the mutants inside its ranges", () => {
    const kept = keepShard(full, "src/a.ts:1-5,src/b.ts,");
    assert.deepEqual(kept["files"], {
      "src/a.ts": {
        source: "a",
        mutants: [{ mutatorName: "Regex", replacement: "/1/", location: loc(2) }],
      },
      "src/b.ts": {
        source: "b",
        mutants: [{ mutatorName: "Regex", replacement: "/b/", location: loc(1) }],
      },
    });
    assert.equal(kept["schemaVersion"], "1.0");
  });

  it("refuses a report without the Stryker shape", () => {
    assert.throws(() => keepShard({}, "src/a.ts"), /report: files must be an object/);
    assert.throws(
      () => keepShard({ files: { "src/a.ts": {} } }, "src/a.ts"),
      /report: src\/a\.ts mutants must be a list/,
    );
  });
});

describe("merge-mutation-reports.ts --only", () => {
  it("writes the shard's part of a report", () => {
    const input = path.join(dir, "in.json");
    const files = {
      "src/a.ts": { source: "a", mutants: [] },
      "src/b.ts": { source: "b", mutants: [] },
    };
    writeFileSync(input, JSON.stringify(report(files, {})));
    const out = path.join(dir, "out.json");
    const result = run("merge-mutation-reports.ts", ["--only", "src/b.ts", out, input]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Kept the shard's part of the report in /);
    const kept: unknown = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(kept, keepShard(report(files, {}), "src/b.ts"));
  });

  it("takes one report only", () => {
    const out = path.join(dir, "out.json");
    const result = run("merge-mutation-reports.ts", [
      "--only",
      "src/b.ts",
      out,
      "x.json",
      "y.json",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage: /);
  });
});
