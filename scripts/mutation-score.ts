// Reads the mutation floors and the Stryker JSON report, scores each mutated file and compares the
// score with its floor. scripts/check-mutation-score.ts runs it after `stryker run`.
//
// The score is the one Stryker prints: detected mutants (killed or timed out) divided by valid
// mutants (detected, survived or not covered), as a percentage. Mutants that fail to compile or
// run, and ignored ones, do not count.
//
// A file's limit is either a floor on that score, in percent, or, for a file with few mutants where
// one mutant moves the score by several points, a maximum count of undetected mutants (survived or
// not covered).

/** The floor of one mutated file. */
export interface Floor {
  /** The file, relative to the package, as the report names it: `src/flow/status.ts`. */
  readonly file: string;
  /** The score of the run that set the limit, in percent. */
  readonly measured: number;
  /** The lowest score the check accepts, in percent; undefined when `maxUndetected` is set. */
  readonly floor: number | undefined;
  /** The most undetected mutants the check accepts; undefined when `floor` is set. */
  readonly maxUndetected: number | undefined;
}

/** The mutant counts of one file in the report. */
export interface FileCounts {
  readonly killed: number;
  readonly timeout: number;
  readonly survived: number;
  readonly noCoverage: number;
}

/** One line of the report. */
export interface ScoreLine extends FileCounts {
  readonly file: string;
  /** The score in percent, or undefined when the file has no valid mutant. */
  readonly score: number | undefined;
  /** The floor in percent, or undefined when the file has none. */
  readonly floor: number | undefined;
  /** The most undetected mutants accepted, or undefined when the file has no such limit. */
  readonly maxUndetected: number | undefined;
  /** False when the file has a floor and is not in the report. */
  readonly inReport: boolean;
  readonly ok: boolean;
}

function get(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function percent(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`mutation-floors.json: ${where} must be a number from 0 to 100`);
  }
  return value;
}

/**
 * Reads the `files` of a parsed mutation-floors.json.
 *
 * @param parsed - The parsed file.
 * @returns The floors, in file order.
 * @throws Error naming the field when the file does not have the expected shape.
 */
export function parseFloors(parsed: unknown): Floor[] {
  const files = get(parsed, "files");
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("mutation-floors.json: `files` must be a non-empty list");
  }
  const seen = new Set<string>();
  return files.map((entry: unknown, index) => {
    const where = `files[${String(index)}]`;
    const file = get(entry, "file");
    if (typeof file !== "string" || file.trim() === "") {
      throw new Error(`mutation-floors.json: ${where}.file must be a non-empty string`);
    }
    if (seen.has(file)) {
      throw new Error(`mutation-floors.json: ${where}.file "${file}" appears twice`);
    }
    seen.add(file);
    const measured = percent(get(entry, "measured"), `${where}.measured`);
    const rawFloor = get(entry, "floor");
    const rawMax = get(entry, "maxUndetected");
    if ((rawFloor === undefined) === (rawMax === undefined)) {
      throw new Error(
        `mutation-floors.json: ${where} needs exactly one of floor and maxUndetected`,
      );
    }
    if (rawFloor === undefined) {
      if (typeof rawMax !== "number" || !Number.isInteger(rawMax) || rawMax < 0) {
        throw new Error(`mutation-floors.json: ${where}.maxUndetected must be an integer from 0`);
      }
      return { file, measured, floor: undefined, maxUndetected: rawMax };
    }
    const floor = percent(rawFloor, `${where}.floor`);
    if (floor > measured) {
      throw new Error(`mutation-floors.json: ${where}.floor is above measured`);
    }
    return { file, measured, floor, maxUndetected: undefined };
  });
}

/**
 * Counts the mutants of each file in a parsed Stryker JSON report
 * (`reports/mutation/mutation.json`).
 *
 * @param parsed - The parsed report.
 * @returns The counts, by file name as the report gives it.
 * @throws Error when the report has no `files` object or a file has no `mutants` list.
 */
export function countMutants(parsed: unknown): Map<string, FileCounts> {
  const files = get(parsed, "files");
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new Error("mutation report: `files` must be an object");
  }
  const counts = new Map<string, FileCounts>();
  for (const [file, result] of Object.entries(files)) {
    const mutants = get(result, "mutants");
    if (!Array.isArray(mutants)) {
      throw new Error(`mutation report: ${file} has no \`mutants\` list`);
    }
    const statuses = mutants.map((mutant: unknown) => get(mutant, "status"));
    const count = (status: string): number => statuses.filter((value) => value === status).length;
    counts.set(file, {
      killed: count("Killed"),
      timeout: count("Timeout"),
      survived: count("Survived"),
      noCoverage: count("NoCoverage"),
    });
  }
  return counts;
}

/**
 * The score of one file, as Stryker computes it.
 *
 * @param counts - The file's mutant counts.
 * @returns The score in percent, or undefined when the file has no valid mutant.
 */
export function score({ killed, timeout, survived, noCoverage }: FileCounts): number | undefined {
  const detected = killed + timeout;
  const valid = detected + survived + noCoverage;
  return valid === 0 ? undefined : (detected / valid) * 100;
}

/**
 * Compares each file's score with its floor. A file in the report without a floor fails, and so
 * does a floor whose file is not in the report.
 *
 * @param floors - The floors.
 * @param counts - The mutant counts from the report.
 * @returns One line per file: the files with a floor in floor order, then the others by name.
 */
export function compareScores(
  floors: readonly Floor[],
  counts: ReadonlyMap<string, FileCounts>,
): ScoreLine[] {
  const none: FileCounts = { killed: 0, timeout: 0, survived: 0, noCoverage: 0 };
  const lines: ScoreLine[] = floors.map(({ file, floor, maxUndetected }) => {
    const found = counts.get(file);
    const fileScore = found === undefined ? undefined : score(found);
    let ok = false;
    if (found !== undefined) {
      ok =
        maxUndetected === undefined
          ? fileScore === undefined || fileScore >= (floor ?? 0)
          : found.survived + found.noCoverage <= maxUndetected;
    }
    return {
      file,
      ...(found ?? none),
      score: fileScore,
      floor,
      maxUndetected,
      inReport: found !== undefined,
      ok,
    };
  });
  const named = new Set(floors.map(({ file }) => file));
  const others = [...counts]
    .filter(([file]) => !named.has(file))
    .toSorted(([a], [b]) => (a < b ? -1 : 1));
  for (const [file, found] of others) {
    lines.push({
      file,
      ...found,
      score: score(found),
      floor: undefined,
      maxUndetected: undefined,
      inReport: true,
      ok: false,
    });
  }
  return lines;
}

function formatScore(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(2);
}

function formatLimit({ floor, maxUndetected }: ScoreLine): string {
  return maxUndetected === undefined
    ? formatScore(floor)
    : `max ${String(maxUndetected)} undetected`;
}

/**
 * Formats the report as a Markdown table, readable in a terminal and in a GitHub job summary,
 * followed by what to do when a line fails.
 *
 * @param lines - The compared scores.
 * @returns The report text, ending with a newline.
 */
export function formatReport(lines: readonly ScoreLine[]): string {
  const rows = [
    "| File | Score | Floor | Killed | Timeout | Survived | No coverage | Result |",
    "| --- | --: | --: | --: | --: | --: | --: | --- |",
    ...lines.map((line) => {
      const result = line.ok
        ? "ok"
        : line.floor === undefined && line.maxUndetected === undefined
          ? "NO FLOOR"
          : !line.inReport
            ? "NOT IN REPORT"
            : line.maxUndetected === undefined
              ? "BELOW"
              : "TOO MANY";
      return (
        `| ${line.file} | ${formatScore(line.score)} | ${formatLimit(line)} | ` +
        `${String(line.killed)} | ${String(line.timeout)} | ${String(line.survived)} | ` +
        `${String(line.noCoverage)} | ${result} |`
      );
    }),
  ];
  const failed = lines.filter(({ ok }) => !ok).map(({ file }) => file);
  if (failed.length > 0) {
    rows.push(
      "",
      `Failed: ${failed.join(", ")}. Add tests that kill the surviving mutants, or add or ` +
        "change the file's floor in mutation-floors.json in a pull request that says why.",
    );
  }
  return `${rows.join("\n")}\n`;
}
