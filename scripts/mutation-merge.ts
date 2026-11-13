// Merges the Stryker JSON reports of the shards of the full mutation run into one
// (docs/contributor/testing.md#in-ci). scripts/merge-mutation-reports.ts runs it in CI, and
// scripts/mutation-shards.ts plans the shards. It imports nothing, so the merge job needs no
// install.

function get(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function entries(value: unknown, where: string): [string, unknown][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return Object.entries(value);
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be a list`);
  }
  const items: unknown[] = value;
  return items;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Merges the Stryker JSON reports of the shards into one report, as a single run writes it. The
 * files of the shards are joined; a file that several shards mutated in ranges gets all their
 * mutants, renumbered. The test ids of each report are mapped, by test file and test name, to one
 * set of ids, so `coveredBy` and `killedBy` keep naming the same tests. The other top-level fields
 * come from the first report. The same code merges the incremental files the shards write.
 *
 * @param reports - The parsed reports, at least one.
 * @returns The merged report.
 * @throws Error when a report does not have the Stryker shape, two reports hold different text for
 * the same file, two reports hold the same mutant, or a mutant names a test its report lacks.
 */
export function mergeReports(reports: readonly unknown[]): Record<string, unknown> {
  const [first] = reports;
  if (first === undefined) {
    throw new Error("merge: no report to merge");
  }
  const ids = new Map<string, string>();
  const testFiles = new Map<string, { source: unknown; tests: Record<string, unknown>[] }>();
  const files = new Map<
    string,
    { language: unknown; source: unknown; mutants: Record<string, unknown>[] }
  >();
  const seen = new Set<string>();
  reports.forEach((report, index) => {
    const where = `report ${String(index + 1)}`;
    const renamed = new Map<string, string>();
    for (const [testFile, value] of entries(
      get(report, "testFiles") ?? {},
      `${where}: testFiles`,
    )) {
      const merged = testFiles.get(testFile) ?? { source: get(value, "source"), tests: [] };
      testFiles.set(testFile, merged);
      for (const test of list(get(value, "tests"), `${where}: ${testFile} tests`)) {
        const id = get(test, "id");
        const name = get(test, "name");
        if (typeof id !== "string" || typeof name !== "string") {
          throw new Error(`merge: ${where}: a test of ${testFile} has no id or name`);
        }
        const key = `${testFile}\n${name}`;
        let shared = ids.get(key);
        if (shared === undefined) {
          shared = String(ids.size);
          ids.set(key, shared);
          merged.tests.push({ ...Object.fromEntries(entries(test, "test")), id: shared });
        }
        renamed.set(id, shared);
      }
    }
    const rename = (value: unknown[], field: string): string[] =>
      value.map((id) => {
        const shared = typeof id === "string" ? renamed.get(id) : undefined;
        if (shared === undefined) {
          throw new Error(`merge: ${where}: ${field} names a test that is not in testFiles`);
        }
        return shared;
      });
    for (const [file, value] of entries(get(report, "files"), `${where}: files`)) {
      const source = get(value, "source");
      const merged = files.get(file) ?? { language: get(value, "language"), source, mutants: [] };
      if (merged.source !== source) {
        throw new Error(`merge: ${where}: ${file} has another text than in an earlier report`);
      }
      files.set(file, merged);
      for (const mutant of list(get(value, "mutants"), `${where}: ${file} mutants`)) {
        const key = JSON.stringify([
          file,
          get(mutant, "mutatorName"),
          get(mutant, "replacement"),
          get(mutant, "location"),
        ]);
        if (seen.has(key)) {
          throw new Error(`merge: ${where}: ${file} has a mutant that an earlier report has`);
        }
        seen.add(key);
        const copy: Record<string, unknown> = Object.fromEntries(entries(mutant, "mutant"));
        for (const field of ["coveredBy", "killedBy"]) {
          const tests = copy[field];
          if (tests !== undefined) {
            copy[field] = rename(list(tests, `${where}: ${file} ${field}`), `${file} ${field}`);
          }
        }
        merged.mutants.push(copy);
      }
    }
  });
  let next = 0;
  const mergedFiles: Record<string, unknown> = {};
  for (const [file, merged] of [...files].toSorted(([a], [b]) => byText(a, b))) {
    const mutants = merged.mutants.map((mutant, index) => ({
      ...mutant,
      id: String(next + index),
    }));
    next += mutants.length;
    mergedFiles[file] = { language: merged.language, source: merged.source, mutants };
  }
  const mergedTests: Record<string, unknown> = {};
  for (const [file, merged] of [...testFiles].toSorted(([a], [b]) => byText(a, b))) {
    mergedTests[file] = merged;
  }
  return {
    ...Object.fromEntries(entries(first, "report")),
    files: mergedFiles,
    testFiles: mergedTests,
  };
}

/**
 * The part of a Stryker report that one shard owns: the files its `mutate` entries name, and, for
 * an entry with a line range, only the mutants that start inside it. An incremental run with
 * `--mutate` also writes the other files' results from the file it started from; this drops them,
 * so that the merge sees each mutant once.
 *
 * @param report - The parsed report of the shard.
 * @param mutate - The shard's entries, as `stryker run --mutate` takes them, comma-separated.
 * @returns The report with only the shard's files and mutants.
 * @throws Error when the report does not have the Stryker shape.
 */
export function keepShard(report: unknown, mutate: string): Record<string, unknown> {
  const ranges = new Map<string, [number, number][]>();
  for (const entry of mutate.split(",").filter((each) => each !== "")) {
    const [file = entry, from = "1", to = String(Number.MAX_SAFE_INTEGER)] =
      /^(.*):(\d+)-(\d+)$/.exec(entry)?.slice(1) ?? [];
    ranges.set(file, [...(ranges.get(file) ?? []), [Number(from), Number(to)]]);
  }
  const files: Record<string, unknown> = {};
  for (const [file, value] of entries(get(report, "files"), "report: files")) {
    const own = ranges.get(file);
    if (own === undefined) {
      continue;
    }
    const mutants = list(get(value, "mutants"), `report: ${file} mutants`).filter((mutant) => {
      const line = get(get(get(mutant, "location"), "start"), "line");
      return typeof line === "number" && own.some(([from, to]) => from <= line && line <= to);
    });
    files[file] = { ...Object.fromEntries(entries(value, `report: ${file}`)), mutants };
  }
  return { ...Object.fromEntries(entries(report, "report")), files };
}
