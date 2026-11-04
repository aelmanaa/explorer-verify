// Compares the routing table with the public chain lists it was built from (#60, R-RT-1,
// decision 0024). It reads the Etherscan chainlist and Sourcify's chain list, the shipped table and
// the research data of the table's date, and returns one line per difference. It never writes the
// table: a person or the weekly check reads the lines, and a pull request applies the change.
// scripts/compare-routing-table.ts is the command; the tests call these functions with recorded
// responses and a fake fetch.
//
// The rule that built the table: a chain gets a row with Sourcify when Sourcify lists it as
// supported and it is in the Etherscan chainlist or in the prior art's rows.
import { readFileSync } from "node:fs";
import path from "node:path";

/** The public lists the table is checked against. Both answer without a key. */
export const SOURCES = {
  etherscanChainlist: "https://api.etherscan.io/v2/chainlist",
  sourcifyChains: "https://sourcify.dev/server/chains",
} as const;

/** The shipped routing table, relative to the repository root. */
export const TABLE_FILE = "packages/explorer-verify/src/routing/table.json";
/** The research data of the table's date, relative to the repository root. */
export const SEED_FILE = "docs/contributor/research/data/2026-11-03-routing-seed.json";

/** One chain of the Etherscan chainlist. */
export interface ChainlistEntry {
  readonly chainId: number;
  readonly name: string;
  /** The explorer's host, from `blockexplorer`. */
  readonly explorer: string;
  /** Whether the chainlist's comment says "Paid Plan required". */
  readonly paidPlan: boolean;
}

/** The parts of the research data the comparison reads. */
export interface Seed {
  /** The frozen copy of the chainlist on the table's date. */
  readonly etherscan: readonly ChainlistEntry[];
  /** The chain ids of the prior art's rows. */
  readonly priorArt: readonly number[];
}

/** The parts of the routing table the comparison reads. */
export interface TableRows {
  readonly checked: string;
  readonly rows: readonly { readonly chainId: number; readonly backends: readonly string[] }[];
}

/** The four inputs of a comparison. */
export interface Lists {
  readonly table: TableRows;
  readonly seed: Seed;
  readonly chainlist: readonly ChainlistEntry[];
  /** The chain ids Sourcify lists with `supported: true`. */
  readonly sourcify: ReadonlySet<number>;
}

/** `value[key]` when `value` is a non-array object, else `undefined`. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

/** The list at `value[key]`, or at `value` itself when `key` is empty. Throws for anything else. */
function listAt(value: unknown, key: string, what: string): unknown[] {
  const list = key === "" ? value : field(value, key);
  if (!Array.isArray(list)) {
    throw new Error(`${what}: ${key === "" ? "the answer" : key} must be a list`);
  }
  return list;
}

/** A positive safe integer from a number or a decimal string, or `undefined`. */
function chainIdOf(value: unknown): number | undefined {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function textAt(value: unknown, key: string, what: string): string {
  const text = field(value, key);
  if (typeof text !== "string") {
    throw new Error(`${what}: ${key} must be text`);
  }
  return text;
}

function chainIdAt(value: unknown, key: string, what: string): number {
  const id = chainIdOf(field(value, key));
  if (id === undefined) {
    throw new Error(`${what}: ${key} must be a positive integer`);
  }
  return id;
}

/**
 * Reads the Etherscan chainlist answer.
 *
 * @param value - The parsed body of {@link SOURCES.etherscanChainlist}.
 * @returns Its chains, in ascending chain id order.
 * @throws Error naming the field when the answer has another shape.
 */
export function parseChainlist(value: unknown): ChainlistEntry[] {
  const what = "Etherscan chainlist";
  return listAt(value, "result", what)
    .map((item) => ({
      chainId: chainIdAt(item, "chainid", what),
      name: textAt(item, "chainname", what),
      explorer: new URL(textAt(item, "blockexplorer", what)).host,
      paidPlan: textAt(item, "comment", what) === "Paid Plan required",
    }))
    .toSorted((a, b) => a.chainId - b.chainId);
}

/**
 * Reads Sourcify's chain list.
 *
 * @param value - The parsed body of {@link SOURCES.sourcifyChains}.
 * @returns The chain ids listed with `supported: true`.
 * @throws Error when the answer is not a list or a chain has no id.
 */
export function parseSourcifyChains(value: unknown): Set<number> {
  const what = "Sourcify chains";
  return new Set(
    listAt(value, "", what)
      .filter((item) => field(item, "supported") === true)
      .map((item) => chainIdAt(item, "chainId", what)),
  );
}

/**
 * Reads the research data.
 *
 * @param value - The parsed research data file.
 * @returns The frozen chainlist and the prior art's chain ids.
 */
export function parseSeed(value: unknown): Seed {
  const what = "research data";
  return {
    etherscan: listAt(value, "etherscan", what).map((item) => ({
      chainId: chainIdAt(item, "chainId", what),
      name: textAt(item, "name", what),
      explorer: textAt(item, "explorer", what),
      paidPlan: field(item, "paidPlan") === true,
    })),
    priorArt: listAt(value, "priorArt", what).map((item) => chainIdAt(item, "chainId", what)),
  };
}

/**
 * Reads the routing table.
 *
 * @param value - The parsed `table.json`.
 * @returns Its date and, per row, the chain id and the backend names.
 */
export function parseTable(value: unknown): TableRows {
  const what = "routing table";
  return {
    checked: textAt(value, "checked", what),
    rows: listAt(value, "chains", what).map((row) => ({
      chainId: chainIdAt(row, "chainId", what),
      backends: listAt(row, "backends", what).map((entry) => textAt(entry, "backend", what)),
    })),
  };
}

/**
 * The chain ids that get a Sourcify row: Sourcify supports them, and they are in the chainlist or
 * the prior art's rows.
 *
 * @param lists - The chainlist, the prior art and Sourcify's supported chains.
 * @returns The chain ids, ascending.
 */
export function expectedRows(lists: Omit<Lists, "table">): number[] {
  const candidates = new Set([
    ...lists.chainlist.map((chain) => chain.chainId),
    ...lists.seed.priorArt,
  ]);
  return [...candidates].filter((id) => lists.sourcify.has(id)).toSorted((a, b) => a - b);
}

/**
 * Every difference between the table, its research data and the live lists, or none.
 *
 * @param lists - The four inputs.
 * @returns One line per difference.
 */
export function compare(lists: Lists): string[] {
  const lines: string[] = [];
  const expected = expectedRows(lists);
  const listed = new Map(lists.table.rows.map((row) => [row.chainId, row.backends]));
  const inChainlist = new Set(lists.chainlist.map((chain) => chain.chainId));
  for (const id of expected) {
    const backends = listed.get(id);
    if (backends === undefined) {
      const from = inChainlist.has(id) ? "the Etherscan chainlist" : "the prior art";
      lines.push(
        `table: chain ${String(id)} has no row; Sourcify supports it and it is in ${from}`,
      );
    } else if (!backends.includes("sourcify")) {
      lines.push(`table: chain ${String(id)} has no sourcify entry; Sourcify supports it`);
    }
  }
  for (const [id, backends] of listed) {
    if (backends.includes("sourcify") && !lists.sourcify.has(id)) {
      lines.push(`table: chain ${String(id)} lists sourcify, which no longer supports it`);
    } else if (!expected.includes(id) && backends.every((name) => name === "sourcify")) {
      lines.push(`table: chain ${String(id)} is in neither the chainlist nor the prior art`);
    }
  }
  const frozen = new Map(lists.seed.etherscan.map((chain) => [chain.chainId, chain]));
  for (const chain of lists.chainlist) {
    const before = frozen.get(chain.chainId);
    const id = `chain ${String(chain.chainId)}`;
    if (before === undefined) {
      lines.push(`etherscan: ${id} (${chain.name}) is new in the chainlist`);
      continue;
    }
    if (before.paidPlan !== chain.paidPlan) {
      lines.push(
        `etherscan: ${id} ${chain.paidPlan ? "now needs a paid plan" : "is now free-tier"}`,
      );
    }
    if (before.explorer !== chain.explorer) {
      lines.push(`etherscan: ${id} explorer moved from ${before.explorer} to ${chain.explorer}`);
    }
  }
  for (const id of frozen.keys()) {
    if (!inChainlist.has(id)) {
      lines.push(`etherscan: chain ${String(id)} left the chainlist`);
    }
  }
  return lines;
}

/** The result of one run: the difference lines and the notes printed with them. */
export interface RunResult {
  readonly differences: readonly string[];
  readonly notes: readonly string[];
}

/** Fetches `url` and parses its JSON body. Throws on a status other than 200. */
async function fetchJson(fetch: typeof globalThis.fetch, url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status !== 200) {
    throw new Error(`${url} answered HTTP ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  return body;
}

/**
 * Fetches both public lists and compares them with the table and research data under `root`.
 *
 * @param root - The repository root.
 * @param fetch - The fetch to use; the tests pass a fake.
 * @returns The differences, and notes on what was not compared.
 */
export async function run(root: string, fetch: typeof globalThis.fetch): Promise<RunResult> {
  const read = (file: string): unknown => JSON.parse(readFileSync(path.join(root, file), "utf8"));
  const [chainlist, sourcify] = await Promise.all([
    fetchJson(fetch, SOURCES.etherscanChainlist),
    fetchJson(fetch, SOURCES.sourcifyChains),
  ]);
  const table = parseTable(read(TABLE_FILE));
  const differences = compare({
    table,
    seed: parseSeed(read(SEED_FILE)),
    chainlist: parseChainlist(chainlist),
    sourcify: parseSourcifyChains(sourcify),
  });
  return {
    differences,
    notes: [
      `table checked ${table.checked}; ${String(table.rows.length)} rows`,
      "routescan: not compared; its supported-chains page has no machine-readable list (see the research note)",
    ],
  };
}
