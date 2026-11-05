// Compares the routing table with the public chain lists it was built from (#60, R-RT-1,
// decision 0024). It reads the Etherscan chainlist and Sourcify's chain list, the shipped table and
// the research data of the table's date, and returns one line per difference. It never writes the
// table: a person or the weekly check reads the lines, and a pull request applies the change.
// scripts/compare-routing-table.ts is the command; the tests call these functions with recorded
// responses and a fake fetch.
//
// The rules that built the table: a chain gets a row when Sourcify lists it as supported or it is
// in the Etherscan chainlist (decision 0036). The row has Sourcify when Sourcify supports the
// chain. A chain in the chainlist also gets an `etherscan-v2` entry with the chainlist's explorer
// host: first when the free tier covers the chain, after Sourcify when it needs a paid plan
// (decision 0027), and alone when Sourcify does not support it. `tableOf` gives the table these rules build, and
// `scripts/compare-routing-table.ts --rows` prints it with the Routescan entries of
// scripts/routing-routescan.ts added (decision 0037).
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ROUTESCAN_FILE,
  fetchRoutescanList,
  parseRoutescanProbe,
  routescanDifferences,
} from "./routing-routescan.ts";

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
}

/** The parts of the routing table the comparison reads. */
export interface TableRows {
  readonly checked: string;
  readonly rows: readonly {
    readonly chainId: number;
    readonly backends: readonly string[];
    /** The `explorer` host of the row's `etherscan-v2` entry, when it has one. */
    readonly explorer?: string;
    /** The `network` of the row's `routescan` entry, when it has one. */
    readonly network?: string;
  }[];
}

/** The two public lists, as read live. */
export interface LiveLists {
  readonly chainlist: readonly ChainlistEntry[];
  /** The chain ids Sourcify lists with `supported: true`. */
  readonly sourcify: ReadonlySet<number>;
}

/** The four inputs of a comparison. */
export interface Lists extends LiveLists {
  readonly table: TableRows;
  readonly seed: Seed;
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
 * @returns The frozen chainlist.
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
  };
}

/**
 * Reads the routing table.
 *
 * @param value - The parsed `table.json`.
 * @returns Its date and, per row, the chain id, the backend names and the Etherscan explorer host.
 */
export function parseTable(value: unknown): TableRows {
  const what = "routing table";
  return {
    checked: textAt(value, "checked", what),
    rows: listAt(value, "chains", what).map((row) => {
      const entries = listAt(row, "backends", what);
      const explorer = field(
        entries.find((entry) => field(entry, "backend") === "etherscan-v2"),
        "explorer",
      );
      const network = field(
        entries.find((entry) => field(entry, "backend") === "routescan"),
        "network",
      );
      return {
        chainId: chainIdAt(row, "chainId", what),
        backends: entries.map((entry) => textAt(entry, "backend", what)),
        ...(typeof explorer === "string" ? { explorer } : {}),
        ...(typeof network === "string" ? { network } : {}),
      };
    }),
  };
}

/**
 * The chain ids that get a row: every chain Sourcify supports and every chain of the Etherscan
 * chainlist (decision 0036).
 *
 * @param lists - The chainlist and Sourcify's supported chains.
 * @returns The chain ids, ascending.
 */
export function expectedRows(lists: LiveLists): number[] {
  const ids = new Set([...lists.sourcify, ...lists.chainlist.map((chain) => chain.chainId)]);
  return [...ids].toSorted((a, b) => a - b);
}

/** One entry of a `table.json` row, as {@link tableOf} writes it. */
export type TableEntryJson =
  | { readonly backend: "sourcify" }
  | { readonly backend: "etherscan-v2"; readonly explorer: string };

/** The `table.json` the rules give, schema 2 (decision 0024). */
export interface TableJson {
  readonly schemaVersion: 2;
  readonly checked: string;
  readonly chains: readonly {
    readonly chainId: number;
    readonly backends: readonly TableEntryJson[];
  }[];
}

/**
 * The routing table the rules give for the live lists: a row for each chain Sourcify supports or
 * the chainlist lists. The row has Sourcify when Sourcify supports the chain, and for a chainlist
 * chain an `etherscan-v2` entry, first on the free tier and after Sourcify on a paid plan
 * (decisions 0027 and 0036).
 *
 * @param lists - The live chainlist and Sourcify's supported chains.
 * @param checked - The table's date, `YYYY-MM-DD`.
 * @returns The table, rows in ascending chain id order.
 */
export function tableOf(lists: LiveLists, checked: string): TableJson {
  const live = new Map(lists.chainlist.map((chain) => [chain.chainId, chain]));
  return {
    schemaVersion: 2,
    checked,
    chains: expectedRows(lists).map((chainId) => {
      const chain = live.get(chainId);
      const sourcify: TableEntryJson[] = lists.sourcify.has(chainId)
        ? [{ backend: "sourcify" }]
        : [];
      if (chain === undefined) {
        return { chainId, backends: sourcify };
      }
      const etherscan: TableEntryJson = { backend: "etherscan-v2", explorer: chain.explorer };
      return {
        chainId,
        backends: chain.paidPlan ? [...sourcify, etherscan] : [etherscan, ...sourcify],
      };
    }),
  };
}

/** The public list a difference comes from. */
export type ChangedList = "Etherscan chainlist" | "Sourcify chain list" | "Routescan chain list";

/** One difference: the chain, the public list whose answer disagrees, and the line printed. */
export interface Difference {
  readonly chainId: number;
  readonly list: ChangedList;
  readonly text: string;
}

const CHAINLIST: ChangedList = "Etherscan chainlist";
const SOURCIFY: ChangedList = "Sourcify chain list";

/**
 * Every difference between the table, its research data and the live lists, or none.
 *
 * @param lists - The four inputs.
 * @returns One line per difference.
 */
export function compare(lists: Lists): string[] {
  return differences(lists).map((difference) => difference.text);
}

/**
 * Every difference between the table, its research data and the live lists, with the chain and
 * the list each one comes from. A missing row or Sourcify entry of a chain Sourcify supports, and a
 * Sourcify entry for a chain Sourcify dropped, come from Sourcify's list; every other difference,
 * a missing row of a chainlist chain Sourcify does not support included, comes from the chainlist.
 *
 * @param lists - The four inputs.
 * @returns One difference per line {@link compare} returns, in the same order.
 */
export function differences(lists: Lists): Difference[] {
  const found: Difference[] = [];
  const add = (chainId: number, list: ChangedList, text: string): void => {
    found.push({ chainId, list, text });
  };
  const listed = new Map(lists.table.rows.map((row) => [row.chainId, row.backends]));
  const inChainlist = new Set(lists.chainlist.map((chain) => chain.chainId));
  for (const id of expectedRows(lists)) {
    const backends = listed.get(id);
    if (backends === undefined) {
      if (lists.sourcify.has(id)) {
        add(id, SOURCIFY, `table: chain ${String(id)} has no row; Sourcify supports it`);
      } else {
        add(
          id,
          CHAINLIST,
          `table: chain ${String(id)} has no row; it is in the Etherscan chainlist`,
        );
      }
    } else if (lists.sourcify.has(id) && !backends.includes("sourcify")) {
      add(id, SOURCIFY, `table: chain ${String(id)} has no sourcify entry; Sourcify supports it`);
    }
  }
  for (const [id, backends] of listed) {
    if (backends.includes("sourcify") && !lists.sourcify.has(id)) {
      add(id, SOURCIFY, `table: chain ${String(id)} lists sourcify, which no longer supports it`);
    }
  }
  found.push(...etherscanEntries(lists));
  const frozen = new Map(lists.seed.etherscan.map((chain) => [chain.chainId, chain]));
  for (const chain of lists.chainlist) {
    const before = frozen.get(chain.chainId);
    const id = `chain ${String(chain.chainId)}`;
    if (before === undefined) {
      add(chain.chainId, CHAINLIST, `etherscan: ${id} (${chain.name}) is new in the chainlist`);
      continue;
    }
    if (before.paidPlan !== chain.paidPlan) {
      add(
        chain.chainId,
        CHAINLIST,
        `etherscan: ${id} ${chain.paidPlan ? "now needs a paid plan" : "is now free-tier"}`,
      );
    }
    if (before.explorer !== chain.explorer) {
      add(
        chain.chainId,
        CHAINLIST,
        `etherscan: ${id} explorer moved from ${before.explorer} to ${chain.explorer}`,
      );
    }
  }
  for (const id of frozen.keys()) {
    if (!inChainlist.has(id)) {
      add(id, CHAINLIST, `etherscan: chain ${String(id)} left the chainlist`);
    }
  }
  return found;
}

/**
 * The differences between the table's `etherscan-v2` entries and the live chainlist: a row of a
 * chainlist chain without the entry, an explorer host other than the chainlist's, an entry in the
 * wrong place for the chain's plan, and an entry for a chain the chainlist no longer lists.
 */
function etherscanEntries(lists: Lists): Difference[] {
  const found: Difference[] = [];
  const live = new Map(lists.chainlist.map((chain) => [chain.chainId, chain]));
  for (const row of lists.table.rows) {
    const add = (text: string): void => {
      found.push({
        chainId: row.chainId,
        list: CHAINLIST,
        text: `table: chain ${String(row.chainId)} ${text}`,
      });
    };
    const chain = live.get(row.chainId);
    const at = row.backends.indexOf("etherscan-v2");
    if (chain === undefined) {
      if (at !== -1) {
        add("lists etherscan-v2, which the chainlist no longer lists");
      }
      continue;
    }
    if (at === -1) {
      add("has no etherscan-v2 entry; it is in the Etherscan chainlist");
      continue;
    }
    if (row.explorer !== chain.explorer) {
      add(
        `etherscan-v2 explorer is ${row.explorer ?? "missing"}; the chainlist says ${chain.explorer}`,
      );
    }
    const sourcify = row.backends.indexOf("sourcify");
    if (chain.paidPlan && sourcify === -1 && lists.sourcify.has(row.chainId)) {
      add("lists etherscan-v2 with no sourcify entry first; it needs a paid plan");
    } else if (chain.paidPlan && sourcify > at) {
      add("lists etherscan-v2 before sourcify; it needs a paid plan");
    } else if (!chain.paidPlan && at !== 0) {
      add("lists etherscan-v2 after another backend; it is free-tier");
    }
  }
  return found;
}

/** The result of one run: the differences and the notes printed with them. */
export interface RunResult {
  /** The table's `checked` date. */
  readonly checked: string;
  readonly differences: readonly Difference[];
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
 * Fetches both public lists.
 *
 * @param fetch - The fetch to use; the tests pass a fake.
 * @returns The chainlist and Sourcify's supported chains.
 */
export async function fetchLists(fetch: typeof globalThis.fetch): Promise<LiveLists> {
  const [chainlist, sourcify] = await Promise.all([
    fetchJson(fetch, SOURCES.etherscanChainlist),
    fetchJson(fetch, SOURCES.sourcifyChains),
  ]);
  return { chainlist: parseChainlist(chainlist), sourcify: parseSourcifyChains(sourcify) };
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
  const [live, routescan] = await Promise.all([fetchLists(fetch), fetchRoutescanList(fetch)]);
  const table = parseTable(read(TABLE_FILE));
  const probe = parseRoutescanProbe(read(ROUTESCAN_FILE));
  return {
    checked: table.checked,
    differences: [
      ...differences({ ...live, table, seed: parseSeed(read(SEED_FILE)) }),
      ...routescanDifferences(table.rows, probe, routescan).map((difference): Difference => ({
        ...difference,
        list: "Routescan chain list",
      })),
    ],
    notes: [
      `table checked ${table.checked}; ${String(table.rows.length)} rows`,
      `routescan: entries compared with the API probe of ${probe.checked}, and that probe with Routescan's explorer lists`,
    ],
  };
}

/** What the command prints and the exit code it sets. */
export interface Output {
  readonly text: string;
  readonly exitCode: number;
}

/**
 * The command's output for one run. As text: the notes, one line per difference and a count, with
 * exit code 1 when there is a difference. As JSON (`--json`, which the weekly workflow reads): the
 * table's date, the notes and each difference with its chain and list, with exit code 0, because
 * the JSON carries the result.
 *
 * @param result - The run's result.
 * @param json - Whether to print JSON.
 * @returns The text to print and the exit code.
 */
export function output(result: RunResult, json: boolean): Output {
  if (json) {
    const { checked, notes, differences: found } = result;
    return {
      text: `${JSON.stringify({ checked, notes, differences: found }, null, 2)}\n`,
      exitCode: 0,
    };
  }
  const lines = [...result.notes, ...result.differences.map((difference) => difference.text)];
  lines.push(
    result.differences.length === 0
      ? "routing table: no differences"
      : `routing table: ${String(result.differences.length)} differences`,
  );
  return { text: `${lines.join("\n")}\n`, exitCode: result.differences.length === 0 ? 0 : 1 };
}
