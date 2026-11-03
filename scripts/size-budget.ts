// Reads size-budget.json and compares measured bundle sizes with its ceilings (R-RUN-3, decision
// 0008). scripts/check-size.ts does the measuring.

/** One measured public entry. */
export interface BudgetEntry {
  /** A short name, such as `verify`. */
  readonly name: string;
  /** The module the size check bundles, such as `export { verify } from "explorer-verify";`. */
  readonly code: string;
  /** The size recorded when the ceiling was set, in bytes, minified and gzipped. */
  readonly measuredBytes: number;
  /** The largest size the check accepts, in bytes. */
  readonly ceilingBytes: number;
  /**
   * Measure the code without the routing table's rows, which have their own entry (R-RUN-3).
   * `withoutTable` in the file; absent means false.
   */
  readonly withoutTable: boolean;
}

/** One line of the report. */
export interface SizeLine {
  readonly name: string;
  readonly bytes: number;
  readonly ceilingBytes: number;
  readonly ok: boolean;
}

function positiveInteger(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`size-budget.json: ${where} must be a positive integer`);
  }
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`size-budget.json: ${where} must be a non-empty string`);
  }
  return value;
}

/**
 * Reads the `entries` of a parsed size-budget.json.
 *
 * @param parsed - The parsed file.
 * @returns The entries, in file order.
 * @throws Error naming the field when the file does not have the expected shape.
 */
export function parseBudget(parsed: unknown): BudgetEntry[] {
  const entries: unknown =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "entries") : undefined;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("size-budget.json: `entries` must be a non-empty list");
  }
  const names = new Set<string>();
  return entries.map((entry: unknown, index) => {
    const get = (key: string): unknown =>
      typeof entry === "object" && entry !== null ? Reflect.get(entry, key) : undefined;
    const where = `entries[${String(index)}]`;
    const name = text(get("name"), `${where}.name`);
    if (names.has(name)) {
      throw new Error(`size-budget.json: ${where}.name "${name}" appears twice`);
    }
    names.add(name);
    const measuredBytes = positiveInteger(get("measuredBytes"), `${where}.measuredBytes`);
    const ceilingBytes = positiveInteger(get("ceilingBytes"), `${where}.ceilingBytes`);
    if (ceilingBytes < measuredBytes) {
      throw new Error(`size-budget.json: ${where}.ceilingBytes is below measuredBytes`);
    }
    const withoutTable = get("withoutTable") ?? false;
    if (typeof withoutTable !== "boolean") {
      throw new Error(`size-budget.json: ${where}.withoutTable must be true or false`);
    }
    return {
      name,
      code: text(get("code"), `${where}.code`),
      measuredBytes,
      ceilingBytes,
      withoutTable,
    };
  });
}

/**
 * Compares each entry's size with its ceiling.
 *
 * @param entries - The budget entries.
 * @param sizes - The measured size of each entry, by name.
 * @returns One line per entry; `ok` is false above the ceiling.
 * @throws Error when an entry has no measured size.
 */
export function compareSizes(
  entries: readonly BudgetEntry[],
  sizes: ReadonlyMap<string, number>,
): SizeLine[] {
  return entries.map(({ name, ceilingBytes }) => {
    const bytes = sizes.get(name);
    if (bytes === undefined) {
      throw new Error(`no measured size for ${name}`);
    }
    return { name, bytes, ceilingBytes, ok: bytes <= ceilingBytes };
  });
}

/**
 * Formats the report: one line per entry, then what to do when one is over.
 *
 * @param lines - The compared sizes.
 * @returns The report text, ending with a newline.
 */
export function formatReport(lines: readonly SizeLine[]): string {
  const rows = lines.map(
    ({ name, bytes, ceilingBytes, ok }) =>
      `${ok ? "ok  " : "OVER"} ${name}: ${String(bytes)} bytes (ceiling ${String(ceilingBytes)})`,
  );
  const over = lines.filter(({ ok }) => !ok).map(({ name }) => name);
  if (over.length > 0) {
    rows.push(
      `Over the ceiling: ${over.join(", ")}. Make the bundle smaller, or raise the ceiling in ` +
        "size-budget.json in a pull request that says why (decision 0008).",
    );
  }
  return `${rows.join("\n")}\n`;
}
