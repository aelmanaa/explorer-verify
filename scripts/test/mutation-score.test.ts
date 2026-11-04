// Tests the mutation score rules (scripts/mutation-score.ts) and the check run as
// `pnpm run test:mutation` runs it after Stryker (scripts/check-mutation-score.ts).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  compareScores,
  countMutants,
  formatReport,
  parseFloors,
  score,
} from "../mutation-score.ts";
import type { FileCounts } from "../mutation-score.ts";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mutation-score-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A Stryker report file entry with one mutant per status. */
function reportFile(statuses: readonly string[]): { mutants: { status: string }[] } {
  return { mutants: statuses.map((status) => ({ status })) };
}

const counts = (overrides: Partial<FileCounts> = {}): FileCounts => ({
  killed: 0,
  timeout: 0,
  survived: 0,
  noCoverage: 0,
  ...overrides,
});

describe("parseFloors", () => {
  it("reads each file's floor in order", () => {
    assert.deepEqual(
      parseFloors({
        files: [
          { file: "src/a.ts", measured: 90.5, floor: 90 },
          { file: "src/b.ts", measured: 100, floor: 0 },
        ],
      }),
      [
        { file: "src/a.ts", measured: 90.5, floor: 90, maxUndetected: undefined },
        { file: "src/b.ts", measured: 100, floor: 0, maxUndetected: undefined },
      ],
    );
  });

  it("reads a maximum count of undetected mutants instead of a floor", () => {
    assert.deepEqual(
      parseFloors({ files: [{ file: "src/a.ts", measured: 96, maxUndetected: 0 }] }),
      [{ file: "src/a.ts", measured: 96, floor: undefined, maxUndetected: 0 }],
    );
  });

  it("needs exactly one of floor and maxUndetected", () => {
    for (const entry of [
      { file: "src/a.ts", measured: 96 },
      { file: "src/a.ts", measured: 96, floor: 90, maxUndetected: 1 },
    ]) {
      assert.throws(
        () => parseFloors({ files: [entry] }),
        /files\[0\] needs exactly one of floor and maxUndetected/,
      );
    }
  });

  for (const value of ["1", -1, 1.5, Number.NaN]) {
    it(`rejects the maxUndetected ${String(value)}`, () => {
      assert.throws(
        () => parseFloors({ files: [{ file: "src/a.ts", measured: 96, maxUndetected: value }] }),
        /files\[0\]\.maxUndetected must be an integer from 0/,
      );
    });
  }

  for (const parsed of [null, "x", {}, { files: [] }, { files: "src/a.ts" }]) {
    it(`rejects ${JSON.stringify(parsed)} without a non-empty files list`, () => {
      assert.throws(() => parseFloors(parsed), /`files` must be a non-empty list/);
    });
  }

  for (const file of [undefined, 3, "", "  "]) {
    it(`rejects the file name ${JSON.stringify(file)}`, () => {
      assert.throws(
        () => parseFloors({ files: [{ file, measured: 1, floor: 1 }] }),
        /files\[0\]\.file must be a non-empty string/,
      );
    });
  }

  it("rejects an entry that is not an object", () => {
    assert.throws(() => parseFloors({ files: [7] }), /files\[0\]\.file/);
  });

  it("rejects a file named twice", () => {
    const entry = { file: "src/a.ts", measured: 1, floor: 1 };
    assert.throws(
      () => parseFloors({ files: [entry, entry] }),
      /files\[1\]\.file "src\/a\.ts" appears twice/,
    );
  });

  for (const value of [undefined, "90", -1, 100.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`rejects the percentage ${String(value)}`, () => {
      assert.throws(
        () => parseFloors({ files: [{ file: "src/a.ts", measured: value, floor: 0 }] }),
        /files\[0\]\.measured must be a number from 0 to 100/,
      );
      if (value !== undefined) {
        assert.throws(
          () => parseFloors({ files: [{ file: "src/a.ts", measured: 50, floor: value }] }),
          /files\[0\]\.floor must be a number from 0 to 100/,
        );
      }
    });
  }

  it("accepts 0 and 100", () => {
    assert.equal(parseFloors({ files: [{ file: "a", measured: 100, floor: 0 }] }).length, 1);
  });

  it("rejects a floor above the measured score, and accepts one equal to it", () => {
    assert.throws(
      () => parseFloors({ files: [{ file: "src/a.ts", measured: 80, floor: 80.01 }] }),
      /files\[0\]\.floor is above measured/,
    );
    assert.equal(parseFloors({ files: [{ file: "a", measured: 80, floor: 80 }] })[0]?.floor, 80);
  });
});

describe("countMutants", () => {
  it("counts each status that the score uses, per file", () => {
    const parsed = {
      files: {
        "src/a.ts": reportFile([
          "Killed",
          "Killed",
          "Timeout",
          "Survived",
          "NoCoverage",
          "NoCoverage",
          "CompileError",
          "RuntimeError",
          "Ignored",
        ]),
        "src/b.ts": reportFile([]),
      },
    };
    assert.deepEqual(
      countMutants(parsed),
      new Map([
        ["src/a.ts", { killed: 2, timeout: 1, survived: 1, noCoverage: 2 }],
        ["src/b.ts", counts()],
      ]),
    );
  });

  for (const parsed of [null, {}, { files: null }, { files: [] }, { files: "x" }]) {
    it(`rejects ${JSON.stringify(parsed)} without a files object`, () => {
      assert.throws(() => countMutants(parsed), /`files` must be an object/);
    });
  }

  it("rejects a file without a mutants list", () => {
    assert.throws(
      () => countMutants({ files: { "src/a.ts": { mutants: {} } } }),
      /src\/a\.ts has no `mutants` list/,
    );
  });

  it("ignores a mutant without a status", () => {
    assert.deepEqual(
      countMutants({ files: { "src/a.ts": { mutants: [null, {}] } } }).get("src/a.ts"),
      counts(),
    );
  });
});

describe("score", () => {
  it("divides killed and timed-out mutants by the valid ones", () => {
    assert.equal(score(counts({ killed: 3, timeout: 1, survived: 3, noCoverage: 1 })), 50);
    assert.equal(score(counts({ timeout: 1 })), 100);
    assert.equal(score(counts({ noCoverage: 1 })), 0);
  });

  it("gives undefined when the file has no valid mutant", () => {
    assert.equal(score(counts()), undefined);
  });
});

describe("compareScores", () => {
  const floors = parseFloors({
    files: [
      { file: "src/a.ts", measured: 90, floor: 80 },
      { file: "src/b.ts", measured: 90, floor: 80 },
    ],
  });

  it("passes a file at or above its floor and fails one below it", () => {
    const lines = compareScores(
      floors,
      new Map([
        ["src/a.ts", counts({ killed: 4, survived: 1 })],
        ["src/b.ts", counts({ killed: 3, survived: 1 })],
      ]),
    );
    assert.deepEqual(
      lines.map(({ file, score: value, ok }) => [file, value, ok]),
      [
        ["src/a.ts", 80, true],
        ["src/b.ts", 75, false],
      ],
    );
  });

  it("passes a file with a floor and no valid mutant", () => {
    const lines = compareScores(
      floors,
      new Map([
        ["src/a.ts", counts()],
        ["src/b.ts", counts({ killed: 1 })],
      ]),
    );
    assert.deepEqual(
      lines.map(({ ok }) => ok),
      [true, true],
    );
  });

  it("checks a maxUndetected limit against survived plus not-covered mutants", () => {
    const limited = parseFloors({ files: [{ file: "src/a.ts", measured: 90, maxUndetected: 2 }] });
    const ok = (found: FileCounts): boolean | undefined =>
      compareScores(limited, new Map([["src/a.ts", found]]))[0]?.ok;
    assert.equal(ok(counts({ killed: 1, survived: 1, noCoverage: 1 })), true);
    assert.equal(ok(counts({ killed: 1, survived: 2, noCoverage: 1 })), false);
    assert.equal(ok(counts({ timeout: 5, survived: 2 })), true);
  });

  it("treats a hand-built limit with neither field as a floor of 0", () => {
    const [line] = compareScores(
      [{ file: "src/a.ts", measured: 0, floor: undefined, maxUndetected: undefined }],
      new Map([["src/a.ts", counts({ survived: 1 })]]),
    );
    assert.equal(line?.ok, true);
  });

  it("fails a floor whose file is missing from the report", () => {
    const [missing] = compareScores(floors, new Map([["src/b.ts", counts({ killed: 1 })]]));
    assert.deepEqual(missing, {
      file: "src/a.ts",
      ...counts(),
      score: undefined,
      floor: 80,
      maxUndetected: undefined,
      inReport: false,
      ok: false,
    });
  });

  it("fails each reported file without a floor, after the others, by name", () => {
    const lines = compareScores(
      floors,
      new Map([
        ["src/z.ts", counts({ killed: 1 })],
        ["src/b.ts", counts({ killed: 1 })],
        ["src/c.ts", counts({ killed: 1 })],
        ["src/m.ts", counts({ killed: 1 })],
        ["src/a.ts", counts({ killed: 1 })],
      ]),
    );
    assert.deepEqual(
      lines.map(({ file, floor, ok }) => [file, floor, ok]),
      [
        ["src/a.ts", 80, true],
        ["src/b.ts", 80, true],
        ["src/c.ts", undefined, false],
        ["src/m.ts", undefined, false],
        ["src/z.ts", undefined, false],
      ],
    );
  });
});

describe("formatReport", () => {
  it("prints a Markdown table with the result of each file", () => {
    const text = formatReport([
      {
        file: "src/a.ts",
        ...counts({ killed: 9, survived: 1 }),
        score: 90,
        floor: 85.5,
        maxUndetected: undefined,
        inReport: true,
        ok: true,
      },
      {
        file: "src/b.ts",
        ...counts({ killed: 2, timeout: 1, survived: 3, noCoverage: 4 }),
        score: 30,
        floor: 40,
        maxUndetected: undefined,
        inReport: true,
        ok: false,
      },
      {
        file: "src/c.ts",
        ...counts(),
        score: undefined,
        floor: undefined,
        maxUndetected: undefined,
        inReport: true,
        ok: false,
      },
      {
        file: "src/d.ts",
        ...counts(),
        score: undefined,
        floor: 50,
        maxUndetected: undefined,
        inReport: false,
        ok: false,
      },
      {
        file: "src/e.ts",
        ...counts({ killed: 20, survived: 2 }),
        score: 90.9,
        floor: undefined,
        maxUndetected: 1,
        inReport: true,
        ok: false,
      },
      {
        file: "src/f.ts",
        ...counts({ killed: 20, survived: 1 }),
        score: 95.24,
        floor: undefined,
        maxUndetected: 1,
        inReport: true,
        ok: true,
      },
    ]);
    assert.equal(
      text,
      [
        "| File | Score | Floor | Killed | Timeout | Survived | No coverage | Result |",
        "| --- | --: | --: | --: | --: | --: | --: | --- |",
        "| src/a.ts | 90.00 | 85.50 | 9 | 0 | 1 | 0 | ok |",
        "| src/b.ts | 30.00 | 40.00 | 2 | 1 | 3 | 4 | BELOW |",
        "| src/c.ts | n/a | n/a | 0 | 0 | 0 | 0 | NO FLOOR |",
        "| src/d.ts | n/a | 50.00 | 0 | 0 | 0 | 0 | NOT IN REPORT |",
        "| src/e.ts | 90.90 | max 1 undetected | 20 | 0 | 2 | 0 | TOO MANY |",
        "| src/f.ts | 95.24 | max 1 undetected | 20 | 0 | 1 | 0 | ok |",
        "",
        "Failed: src/b.ts, src/c.ts, src/d.ts, src/e.ts. Add tests that kill the surviving mutants, or add or " +
          "change the file's floor in mutation-floors.json in a pull request that says why.",
        "",
      ].join("\n"),
    );
  });

  it("prints no failure line when every file passes", () => {
    const text = formatReport([
      {
        file: "src/a.ts",
        ...counts({ killed: 1 }),
        score: 100,
        floor: 100,
        maxUndetected: undefined,
        inReport: true,
        ok: true,
      },
    ]);
    assert.doesNotMatch(text, /Failed/);
    assert.ok(text.endsWith("| ok |\n"));
  });
});

/** Runs check-mutation-score.ts on `floors` and `report`, written to files in the test folder. */
function run(
  floors: unknown,
  report: unknown,
): { status: number | null; stdout: string; stderr: string } {
  const floorsFile = path.join(dir, "mutation-floors.json");
  const reportPath = path.join(dir, "mutation.json");
  writeFileSync(floorsFile, JSON.stringify(floors));
  writeFileSync(reportPath, JSON.stringify(report));
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      path.join(scripts, "check-mutation-score.ts"),
      floorsFile,
      reportPath,
    ],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("check-mutation-score.ts", () => {
  const floors = { files: [{ file: "src/a.ts", measured: 75, floor: 70 }] };

  it("exits 0 when every file is at or above its floor", () => {
    const result = run(floors, {
      files: { "src/a.ts": reportFile(["Killed", "Killed", "Killed", "Survived"]) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /^\| src\/a\.ts \| 75\.00 \| 70\.00 \| 3 \| 0 \| 1 \| 0 \| ok \|$/m,
    );
  });

  it("exits 1 when a file is below its floor", () => {
    const result = run(floors, { files: { "src/a.ts": reportFile(["Killed", "Survived"]) } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\| BELOW \|/);
  });

  it("exits non-zero with a usage line when a file is not given", () => {
    const result = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", path.join(scripts, "check-mutation-score.ts"), "x"],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /usage: node scripts\/check-mutation-score\.ts <mutation-floors\.json> <mutation\.json>/,
    );
  });
});
