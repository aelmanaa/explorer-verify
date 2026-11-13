// Splits the full mutation run into shards that run in parallel
// (docs/contributor/testing.md#in-ci). scripts/plan-mutation-shards.ts runs these functions, and
// scripts/mutation-merge.ts merges the reports of the shards.
//
// A shard is a list of `mutate` entries for `stryker run --mutate`: a whole file, or a range of
// lines of a file. Stryker mutates a node only when the node lies wholly inside a range, so a file
// is cut only between its top-level statements: no node but the file itself crosses such a cut,
// and every mutant lands in exactly one shard.
//
// The shards are balanced by weight. The weight of a statement is the time its mutants took in an
// earlier report, plus a fixed cost per mutant for starting the test process. For a file the
// report does not have, it is the statement's length in characters, scaled by the report's time
// per character.
import { parse } from "@babel/parser";

/** A file to mutate: its path as the Stryker config names it, and its text. */
export interface SourceFile {
  readonly file: string;
  readonly text: string;
}

/** A top-level statement's lines, from 1, and its weight. */
export interface Statement {
  readonly start: number;
  readonly end: number;
  weight: number;
}

/** The time one mutant took, and the line it starts on. */
export interface MutantTime {
  readonly line: number;
  readonly ms: number;
}

/** One `mutate` entry and its weight. */
export interface Unit {
  /** `src/x.ts`, or `src/x.ts:<from>-<to>` for a range of lines. */
  readonly mutate: string;
  readonly weight: number;
}

/** One shard: its `mutate` entries and their total weight. */
export interface Shard {
  readonly mutate: string[];
  weight: number;
}

/**
 * The time Stryker spends on a mutant besides the tests the report times: it restores the file,
 * starts a Node.js process and strips the types. The full run on 0.2.0 took 7 hours with 4
 * processes for 11,128 mutants whose tests took 73,131 seconds: about 2.5 seconds per mutant.
 */
export const MUTANT_OVERHEAD_MS = 2500;

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
 * The lines of each top-level statement of a TypeScript file, in order.
 *
 * @param source - The file.
 * @returns One entry per statement, with weight 0.
 */
export function topLevelStatements(source: SourceFile): Statement[] {
  // The parser Stryker uses, so the lines are the ones its ranges compare.
  const parsed = parse(source.text, { sourceType: "module", plugins: ["typescript"] });
  return parsed.program.body.map((statement) => ({
    start: statement.loc?.start.line ?? 1,
    end: statement.loc?.end.line ?? 1,
    weight: 0,
  }));
}

/**
 * The number of lines of `text`, a last line without a newline included.
 *
 * @param text - The text.
 * @returns The count.
 */
export function lineCount(text: string): number {
  const lines = text.split("\n");
  return text.endsWith("\n") || text === "" ? lines.length - 1 : lines.length;
}

/**
 * The time each mutant took, by file, from a parsed Stryker JSON report: its `duration` plus
 * {@link MUTANT_OVERHEAD_MS}. Ignored and uncovered mutants run no test and are left out.
 *
 * @param parsed - The parsed report, or undefined when there is none.
 * @returns For each file, the start line and the time in milliseconds of each mutant.
 * @throws Error when the report does not have the Stryker shape.
 */
export function mutantTimes(parsed: unknown): Map<string, MutantTime[]> {
  const times = new Map<string, MutantTime[]>();
  if (parsed === undefined) {
    return times;
  }
  for (const [file, result] of entries(get(parsed, "files"), "report: files")) {
    const own: MutantTime[] = [];
    for (const mutant of list(get(result, "mutants"), `report: ${file} mutants`)) {
      const status = get(mutant, "status");
      const line = get(get(get(mutant, "location"), "start"), "line");
      const duration = get(mutant, "duration");
      if (status === "Ignored" || status === "NoCoverage" || typeof line !== "number") {
        continue;
      }
      own.push({ line, ms: (typeof duration === "number" ? duration : 0) + MUTANT_OVERHEAD_MS });
    }
    times.set(file, own);
  }
  return times;
}

/**
 * Gives each top-level statement of each file its weight: the time of the mutants that start in
 * it, from the report, or, for a file the report does not have, its length scaled by the report's
 * time per character (1 per character without a report).
 *
 * @param sources - The files to mutate.
 * @param times - The mutant times from {@link mutantTimes}.
 * @returns The statements of each file, weighed, in the order of `sources`.
 */
export function weigh(
  sources: readonly SourceFile[],
  times: ReadonlyMap<string, readonly MutantTime[]>,
): Statement[][] {
  const weighed = sources.map((source) => ({ source, statements: topLevelStatements(source) }));
  let knownMs = 0;
  let knownChars = 0;
  for (const { source, statements } of weighed) {
    const timed = times.get(source.file);
    if (timed === undefined) {
      continue;
    }
    for (const { line, ms } of timed) {
      // A mutant outside every statement, from a report on older code, counts for nothing.
      const holder = statements.find((each) => each.start <= line && line <= each.end);
      if (holder !== undefined) {
        holder.weight += ms;
        knownMs += ms;
      }
    }
    knownChars += source.text.length;
  }
  const perChar = knownChars === 0 ? 1 : knownMs / knownChars;
  for (const { source, statements } of weighed) {
    if (times.has(source.file)) {
      continue;
    }
    const lines = source.text.split("\n");
    for (const statement of statements) {
      const chars = lines
        .slice(statement.start - 1, statement.end)
        .reduce((sum, text) => sum + text.length + 1, 0);
      statement.weight = chars * perChar;
    }
  }
  return weighed.map(({ statements }) => statements);
}

/**
 * Cuts one file into `mutate` entries no heavier than `limit` where its statements allow: the whole
 * file when it fits, otherwise ranges of whole statements. A statement heavier than `limit` gets a
 * range of its own. The ranges cover every line of the file, from 1 to its last line, once.
 *
 * @param file - The file, as the Stryker config names it.
 * @param statements - Its weighed top-level statements, in order.
 * @param lines - Its number of lines.
 * @param limit - The weight a unit should not pass.
 * @returns The units, in line order.
 */
export function cut(
  file: string,
  statements: readonly Statement[],
  lines: number,
  limit: number,
): Unit[] {
  const total = statements.reduce((sum, statement) => sum + statement.weight, 0);
  if (total <= limit || statements.length < 2) {
    return [{ mutate: file, weight: total }];
  }
  // With more weight than the limit, the last statement starts a new group if no earlier one did,
  // so there are always two groups or more.
  const groups: { to: number; weight: number }[] = [];
  let current: { to: number; weight: number } | undefined;
  for (const statement of statements) {
    if (current === undefined || current.weight + statement.weight > limit) {
      current = { to: statement.end, weight: 0 };
      groups.push(current);
    }
    current.to = statement.end;
    current.weight += statement.weight;
  }
  let from = 1;
  return groups.map((group, index) => {
    const to = index === groups.length - 1 ? lines : group.to;
    const unit = { mutate: `${file}:${String(from)}-${String(to)}`, weight: group.weight };
    from = to + 1;
    return unit;
  });
}

/**
 * Checks that the shards mutate every line of every file exactly once: each file is named whole
 * once, or as ranges that start at line 1, follow each other and end at its last line.
 *
 * @param sources - The files to mutate.
 * @param shards - The plan.
 * @throws Error naming the first file that is not a file to mutate, is missing, or whose lines are
 * not each covered once.
 */
export function checkPlan(sources: readonly SourceFile[], shards: readonly Shard[]): void {
  const ranges = new Map<string, [number, number][]>();
  for (const entry of shards.flatMap((shard) => shard.mutate)) {
    // A whole file is the range [0, 0], which no range can follow.
    const [file = entry, from = "0", to = "0"] = /^(.*):(\d+)-(\d+)$/.exec(entry)?.slice(1) ?? [];
    const own = ranges.get(file) ?? [];
    own.push([Number(from), Number(to)]);
    ranges.set(file, own);
  }
  const known = new Set(sources.map((source) => source.file));
  for (const file of ranges.keys()) {
    if (!known.has(file)) {
      throw new Error(`mutation shards: ${file} is not a file to mutate`);
    }
  }
  for (const source of sources) {
    const own = (ranges.get(source.file) ?? []).toSorted((a, b) => a[0] - b[0]);
    if (own.length === 0) {
      throw new Error(`mutation shards: no shard mutates ${source.file}`);
    }
    if (own.length === 1 && own[0]?.[0] === 0) {
      continue;
    }
    let next = 1;
    for (const [from, to] of own) {
      if (from !== next || to < from) {
        throw new Error(
          `mutation shards: the ranges of ${source.file} do not cover each line once`,
        );
      }
      next = to + 1;
    }
    if (next !== lineCount(source.text) + 1) {
      throw new Error(`mutation shards: the ranges of ${source.file} stop before its last line`);
    }
  }
}

/**
 * Splits the files into `count` shards of about the same weight: each file heavier than the
 * average shard is cut ({@link cut}), then the heaviest unit goes to the lightest shard, and so on.
 * The plan is checked with {@link checkPlan}.
 *
 * @param sources - The files to mutate, in config order.
 * @param times - The mutant times of an earlier report ({@link mutantTimes}); may be empty.
 * @param count - The number of shards, from 1.
 * @returns The shards. A shard is empty when there are fewer units than shards.
 * @throws Error when `count` is not a whole number from 1.
 */
export function planShards(
  sources: readonly SourceFile[],
  times: ReadonlyMap<string, readonly MutantTime[]>,
  count: number,
): Shard[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("mutation shards: the number of shards must be a whole number from 1");
  }
  const statements = weigh(sources, times);
  const total = statements.flat().reduce((sum, statement) => sum + statement.weight, 0);
  const limit = total / count;
  const units = sources.flatMap((source, index) =>
    cut(source.file, statements[index] ?? [], lineCount(source.text), limit),
  );
  const shards: Shard[] = Array.from({ length: count }, () => ({ mutate: [], weight: 0 }));
  const ordered = units.toSorted((a, b) => b.weight - a.weight || byText(a.mutate, b.mutate));
  for (const unit of ordered) {
    const lightest = shards.reduce((best, shard) => (shard.weight < best.weight ? shard : best));
    lightest.mutate.push(unit.mutate);
    lightest.weight += unit.weight;
  }
  for (const shard of shards) {
    shard.mutate.sort(byText);
  }
  checkPlan(sources, shards);
  return shards;
}
