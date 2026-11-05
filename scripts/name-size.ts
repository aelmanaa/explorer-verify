// Rules of the per-name size check (R-RUN-3, decisions 0008 and 0014): which entries of a
// package.json `exports` hold code, how name-budget.json is read, and how measured sizes compare
// with it. scripts/name-bundle.ts does the bundling and scripts/check-names.ts runs the check.

/** The three builds each exported name is measured with. */
export const MODES = ["esbuildSplit", "esbuildOneFile", "rollup"] as const;

/** One of {@link MODES}. */
export type Mode = (typeof MODES)[number];

/** How a mode is named in the report. */
const MODE_LABELS: Readonly<Record<Mode, string>> = {
  esbuildSplit: "esbuild split",
  esbuildOneFile: "esbuild one file",
  rollup: "Rollup",
};

/** The runtime a package's code targets, as the bundler's `platform`. */
export type Platform = "browser" | "node";

/** What one build of one name ships before any call runs. */
export interface Measure {
  /** The entry file and the files it imports statically, minified, in bytes. */
  readonly minBytes: number;
  /** The same files, each gzipped on its own at level 6, in bytes. */
  readonly gzipBytes: number;
  /** Every JavaScript file the build emits, including chunks only a dynamic `import()` loads. */
  readonly files: number;
}

/** One name measured in every mode. */
export interface MeasuredName {
  /** The import specifier, such as `explorer-verify` or `explorer-verify/server`. */
  readonly entry: string;
  /** The exported name, such as `verify`. */
  readonly name: string;
  readonly modes: Readonly<Record<Mode, Measure>>;
}

/** A budget for one mode: the measurement when the ceiling was set, and the ceiling. */
export interface ModeBudget extends Measure {
  /** The largest gzipped initial load the check accepts, in bytes. */
  readonly ceilingBytes: number;
}

/** One row of name-budget.json. */
export interface NameRow {
  readonly entry: string;
  readonly name: string;
  readonly modes: Readonly<Record<Mode, ModeBudget>>;
}

/** The rule for light names: small subpaths that never reach the verification flow. */
export interface LightRule {
  /** The issue that adds the subpaths, named while one is missing. */
  readonly issue: string;
  /** Specifiers whose every name must stay at `maxFiles` files under esbuild splitting. */
  readonly subpaths: readonly string[];
  /** The most files an esbuild split build of a light name may emit. */
  readonly maxFiles: number;
  /** Names from a light subpath that must stay under `maxMinBytes` minified in every mode. */
  readonly smallNames: readonly string[];
  readonly maxMinBytes: number;
}

/** name-budget.json, read. */
export interface NameBudget {
  /** The platform of each package that has code entries, by package name. */
  readonly packages: ReadonlyMap<string, Platform>;
  readonly light: LightRule;
  /** Names reported beside the size-budget.json model of `bundleApart`. */
  readonly model: readonly { readonly entry: string; readonly name: string }[];
  readonly rows: readonly NameRow[];
}

/** One line of the report. `pending` lines never fail. */
export interface NameLine {
  readonly text: string;
  readonly ok: boolean;
}

/** A code entry of a package.json `exports`. */
export interface CodeEntry {
  /** The subpath, such as `.` or `./server`. */
  readonly subpath: string;
  /** The file it points at, relative to the package folder, such as `./dist/src/index.js`. */
  readonly target: string;
}

const CODE_FILE = /\.[cm]?js$/;

/**
 * The file an `exports` value points at for an ESM import: the string itself, or the `import`
 * condition, else the `default` one, followed into nested conditions.
 *
 * @param value - One value of `exports`.
 * @returns The path, or undefined when no condition applies.
 */
export function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return exportTarget(Reflect.get(value, "import")) ?? exportTarget(Reflect.get(value, "default"));
}

/**
 * The entries of a package.json whose target is a JavaScript file. JSON schemas and
 * `./package.json` are not code and are left out.
 *
 * @param pkg - The parsed package.json.
 * @returns The code entries, in file order.
 */
export function codeEntries(pkg: unknown): CodeEntry[] {
  const exports: unknown =
    typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "exports") : undefined;
  if (exports === undefined) {
    return [];
  }
  if (typeof exports !== "object" || exports === null) {
    return codeEntries({ exports: { ".": exports } });
  }
  // An object whose keys are conditions, not subpaths, is the `.` entry.
  const map: object = Object.keys(exports).some((key) => key.startsWith("."))
    ? exports
    : { ".": exports };
  const entries: CodeEntry[] = [];
  for (const [subpath, value] of Object.entries(map)) {
    const target = exportTarget(value);
    if (target !== undefined && CODE_FILE.test(target) && !subpath.includes("*")) {
      entries.push({ subpath, target });
    }
  }
  return entries;
}

/**
 * The specifier a user writes for a subpath of a package.
 *
 * @param packageName - The package name, such as `explorer-verify`.
 * @param subpath - The `exports` key, such as `.` or `./server`.
 * @returns The specifier, such as `explorer-verify/server`.
 */
export function specifierOf(packageName: string, subpath: string): string {
  return subpath === "." ? packageName : `${packageName}/${subpath.replace(/^\.\//, "")}`;
}

/**
 * The ceiling for a measured size: plus 20%, rounded up (decision 0014).
 *
 * @param bytes - The measured size.
 * @returns The ceiling.
 */
export function ceilingOf(bytes: number): number {
  return Math.ceil(bytes * 1.2);
}

function fail(where: string, what: string): never {
  throw new Error(`name-budget.json: ${where} ${what}`);
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function count(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(where, "must be a non-negative integer");
  }
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(where, "must be a non-empty string");
  }
  return value;
}

function texts(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) {
    fail(where, "must be a list of strings");
  }
  return value.map((item: unknown, index) => text(item, `${where}[${String(index)}]`));
}

function modeBudget(value: unknown, where: string): ModeBudget {
  const minBytes = count(field(value, "minBytes"), `${where}.minBytes`);
  const gzipBytes = count(field(value, "gzipBytes"), `${where}.gzipBytes`);
  const files = count(field(value, "files"), `${where}.files`);
  const ceilingBytes = count(field(value, "ceilingBytes"), `${where}.ceilingBytes`);
  if (ceilingBytes < gzipBytes) {
    fail(`${where}.ceilingBytes`, "is below gzipBytes");
  }
  return { minBytes, gzipBytes, files, ceilingBytes };
}

/**
 * Reads a parsed name-budget.json.
 *
 * @param parsed - The parsed file.
 * @returns The budget.
 * @throws Error naming the field when the file does not have the expected shape.
 */
export function parseNameBudget(parsed: unknown): NameBudget {
  const packagesField = field(parsed, "packages");
  if (typeof packagesField !== "object" || packagesField === null || Array.isArray(packagesField)) {
    fail("`packages`", "must map each package name to browser or node");
  }
  const packages = new Map<string, Platform>();
  for (const name of Object.keys(packagesField)) {
    const platform: unknown = Reflect.get(packagesField, name);
    if (platform !== "browser" && platform !== "node") {
      fail(`packages.${name}`, "must be browser or node");
    }
    packages.set(name, platform);
  }
  const lightField = field(parsed, "light");
  const light: LightRule = {
    issue: text(field(lightField, "issue"), "light.issue"),
    subpaths: texts(field(lightField, "subpaths"), "light.subpaths"),
    maxFiles: count(field(lightField, "maxFiles"), "light.maxFiles"),
    smallNames: texts(field(lightField, "smallNames"), "light.smallNames"),
    maxMinBytes: count(field(lightField, "maxMinBytes"), "light.maxMinBytes"),
  };
  const modelField = field(parsed, "model") ?? [];
  if (!Array.isArray(modelField)) {
    fail("`model`", "must be a list");
  }
  const model = modelField.map((item: unknown, index) => ({
    entry: text(field(item, "entry"), `model[${String(index)}].entry`),
    name: text(field(item, "name"), `model[${String(index)}].name`),
  }));
  const rowsField = field(parsed, "names");
  if (!Array.isArray(rowsField)) {
    fail("`names`", "must be a list");
  }
  const seen = new Set<string>();
  const rows = rowsField.map((row: unknown, index): NameRow => {
    const where = `names[${String(index)}]`;
    const entry = text(field(row, "entry"), `${where}.entry`);
    const name = text(field(row, "name"), `${where}.name`);
    const key = `${entry} ${name}`;
    if (seen.has(key)) {
      fail(where, `repeats ${name} from ${entry}`);
    }
    seen.add(key);
    const modes = {
      esbuildSplit: modeBudget(field(row, "esbuildSplit"), `${where}.esbuildSplit`),
      esbuildOneFile: modeBudget(field(row, "esbuildOneFile"), `${where}.esbuildOneFile`),
      rollup: modeBudget(field(row, "rollup"), `${where}.rollup`),
    };
    return { entry, name, modes };
  });
  return { packages, light, model, rows };
}

/**
 * A new row for a measured name, with each ceiling at the measured size plus 20%.
 *
 * @param measured - The measured name.
 * @returns The row as name-budget.json stores it.
 */
export function rowFor(measured: MeasuredName): Record<string, unknown> {
  const row: Record<string, unknown> = { entry: measured.entry, name: measured.name };
  for (const mode of MODES) {
    const { minBytes, gzipBytes, files } = measured.modes[mode];
    row[mode] = { minBytes, gzipBytes, files, ceilingBytes: ceilingOf(gzipBytes) };
  }
  return row;
}

function label(entry: string, name: string): string {
  return `${name} from ${entry}`;
}

function describe(measure: Measure): string {
  return `${String(measure.minBytes)} min / ${String(measure.gzipBytes)} gzip, ${String(measure.files)} file${measure.files === 1 ? "" : "s"}`;
}

/**
 * Compares each measured name with its row. A measured name with no row fails, and so does a row
 * whose name is no longer exported (R-RUN-3).
 *
 * @param rows - The budget rows.
 * @param measured - Every exported name, measured.
 * @returns One line per name and mode, then one per missing or stale row.
 */
export function compareNames(
  rows: readonly NameRow[],
  measured: readonly MeasuredName[],
): NameLine[] {
  const lines: NameLine[] = [];
  const byKey = new Map(rows.map((row) => [`${row.entry} ${row.name}`, row]));
  const found = new Set<string>();
  for (const item of measured) {
    const key = `${item.entry} ${item.name}`;
    const row = byKey.get(key);
    if (row === undefined) {
      lines.push({
        text:
          `NONE ${label(item.entry, item.name)}: no row in name-budget.json. Add one with ` +
          "`node scripts/check-names.ts name-budget.json --add-missing` (R-RUN-3)",
        ok: false,
      });
      continue;
    }
    found.add(key);
    for (const mode of MODES) {
      const measure = item.modes[mode];
      const { ceilingBytes } = row.modes[mode];
      const ok = measure.gzipBytes <= ceilingBytes;
      lines.push({
        text: `${ok ? "ok  " : "OVER"} ${label(item.entry, item.name)}, ${MODE_LABELS[mode]}: ${describe(measure)} (ceiling ${String(ceilingBytes)} gzip)`,
        ok,
      });
    }
  }
  for (const row of rows) {
    if (!found.has(`${row.entry} ${row.name}`)) {
      lines.push({
        text: `GONE ${label(row.entry, row.name)}: not exported any more; remove its row from name-budget.json`,
        ok: false,
      });
    }
  }
  return lines;
}

/**
 * Checks the light-name rule. While a light subpath is missing from `exports`, the rule for it is
 * pending: the line names the issue that adds it and today's size of each small name, and does
 * not fail.
 *
 * @param rule - The light rule.
 * @param entries - Every code entry specifier, such as `explorer-verify/server`.
 * @param measured - Every exported name, measured.
 * @returns The lines.
 */
export function checkLight(
  rule: LightRule,
  entries: readonly string[],
  measured: readonly MeasuredName[],
): NameLine[] {
  const lines: NameLine[] = [];
  for (const subpath of rule.subpaths) {
    if (!entries.includes(subpath)) {
      lines.push({
        text: `PEND light rule for ${subpath}: not in exports yet (${rule.issue}); it applies once the subpath exists`,
        ok: true,
      });
      continue;
    }
    for (const item of measured.filter(({ entry }) => entry === subpath)) {
      const split = item.modes.esbuildSplit;
      const filesOk = split.files <= rule.maxFiles;
      lines.push({
        text: `${filesOk ? "ok  " : "OVER"} light ${label(item.entry, item.name)}: ${String(split.files)} file${split.files === 1 ? "" : "s"} under esbuild split (at most ${String(rule.maxFiles)})`,
        ok: filesOk,
      });
      if (!rule.smallNames.includes(item.name)) {
        continue;
      }
      const largest = Math.max(...MODES.map((mode) => item.modes[mode].minBytes));
      const bytesOk = largest < rule.maxMinBytes;
      lines.push({
        text: `${bytesOk ? "ok  " : "OVER"} light ${label(item.entry, item.name)}: ${String(largest)} bytes min at most (under ${String(rule.maxMinBytes)})`,
        ok: bytesOk,
      });
    }
  }
  const pending = rule.subpaths.filter((subpath) => !entries.includes(subpath));
  if (pending.length > 0) {
    for (const item of measured.filter(({ name }) => rule.smallNames.includes(name))) {
      lines.push({
        text: `PEND ${label(item.entry, item.name)} today, esbuild split: ${describe(item.modes.esbuildSplit)}`,
        ok: true,
      });
    }
  }
  return lines;
}

/** The size-budget.json model of one name beside what the bundlers ship. */
export interface ModelComparison {
  /** The entry as `bundleApart` measures it, gzipped, in bytes. */
  readonly modelBytes: number;
  readonly measured: MeasuredName;
}

/**
 * Formats the model next to the measured sizes. These lines report; they never fail.
 *
 * @param comparisons - The names to show.
 * @returns One line per name.
 */
export function formatModel(comparisons: readonly ModelComparison[]): NameLine[] {
  return comparisons.map(({ modelBytes, measured }) => {
    const real = MODES.map(
      (mode) => `${MODE_LABELS[mode]} ${String(measured.modes[mode].gzipBytes)}`,
    ).join(", ");
    return {
      text: `info ${label(measured.entry, measured.name)}, gzip: size-budget.json model ${String(modelBytes)}; ${real}`,
      ok: true,
    };
  });
}

/**
 * Formats the report and, when a line fails, what to do.
 *
 * @param lines - The lines, in order.
 * @returns The report text, ending with a newline.
 */
export function formatNameReport(lines: readonly NameLine[]): string {
  const rows = lines.map(({ text: line }) => line);
  if (lines.some(({ ok }) => !ok)) {
    rows.push(
      "The per-name check failed. Make the import smaller, or change name-budget.json in a pull " +
        "request that says why (decisions 0008 and 0014).",
    );
  }
  return `${rows.join("\n")}\n`;
}
