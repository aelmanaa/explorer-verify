// Checks a routing table against the rules of #59 (R-RT-1, R-SEC-2). The table decides which hosts
// get requests and keys, so a malformed row is a security bug. The unit tests run it on the shipped
// table and on broken copies of it.
import { toBackendName } from "../../src/backend-names.ts";
import type { BackendName } from "../../src/backend-names.ts";
import { redact } from "../../src/redact.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TABLE_KEYS = ["schemaVersion", "checked", "chains"];
const ROW_KEYS = ["chainId", "name", "checked", "backends"];
const ENTRY_KEYS = ["backend", "apiUrl", "explorerUrl"];

/**
 * The API host and path each backend's `apiUrl` must have. A backend without a rule cannot appear
 * in the table: its issue adds the rule with its first row.
 */
const API_RULES: Readonly<Partial<Record<BackendName, (chainId: number) => [string, RegExp]>>> = {
  "etherscan-v2": () => ["api.etherscan.io", /^\/v2\/api$/],
  routescan: (chainId) => [
    "api.routescan.io",
    new RegExp(`^/v2/network/(mainnet|testnet)/evm/${String(chainId)}/etherscan/api$`),
  ],
  sourcify: () => ["sourcify.dev", /^\/server$/],
};

/** The own fields of a plain object, or `undefined` for anything else. */
function fieldsOf(value: unknown): Map<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return new Map(Object.entries(value));
}

/** What is wrong with the keys of `fields`, compared with `expected`. */
function keyProblems(fields: Map<string, unknown>, expected: string[], where: string): string[] {
  const keys = [...fields.keys()];
  const missing = expected.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !expected.includes(key));
  return [
    ...missing.map((key) => `${where}: ${key} is missing`),
    ...extra.map((key) => `${where}: ${key} is not a known field`),
  ];
}

/** `value` when it is a real calendar date written as `YYYY-MM-DD`, else `undefined`. */
function dateOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !DATE.test(value)) {
    return undefined;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
    ? value
    : undefined;
}

/** `value` parsed as a URL, or `undefined`. */
function urlOf(value: unknown): URL | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** The problems of an `apiUrl` for `backend` on `chainId`. */
function apiUrlProblems(
  value: unknown,
  backend: BackendName,
  chainId: number,
  where: string,
): string[] {
  const url = urlOf(value);
  if (url === undefined || typeof value !== "string") {
    return [`${where}: apiUrl is not an absolute URL`];
  }
  const problems: string[] = [];
  if (url.protocol !== "https:") {
    problems.push(`${where}: apiUrl must use https:`);
  }
  if (url.username !== "" || url.password !== "") {
    problems.push(`${where}: apiUrl must not hold a user name or password`);
  }
  if (value.includes("?")) {
    problems.push(`${where}: apiUrl must not hold a query string`);
  }
  if (value.includes("#")) {
    problems.push(`${where}: apiUrl must not hold a fragment`);
  }
  if (problems.length === 0 && value !== `${url.origin}${url.pathname}`.replace(/\/+$/, "")) {
    problems.push(`${where}: apiUrl must be written as origin and path, with no trailing slash`);
  }
  const rule = API_RULES[backend];
  if (rule === undefined) {
    problems.push(`${where}: ${backend} has no host rule yet`);
    return problems;
  }
  const [host, path] = rule(chainId);
  if (url.host !== host) {
    problems.push(`${where}: apiUrl host must be ${host} for ${backend}`);
  } else if (!path.test(url.pathname)) {
    problems.push(`${where}: apiUrl path must match ${String(path)} for ${backend}`);
  }
  return problems;
}

/** The problems of an `explorerUrl` template. */
function explorerUrlProblems(value: unknown, where: string): string[] {
  if (typeof value !== "string") {
    return [`${where}: explorerUrl must be a string`];
  }
  const problems: string[] = [];
  if (value.split("{address}").length !== 2) {
    problems.push(`${where}: explorerUrl must hold exactly one {address}`);
  }
  const url = urlOf(value.replace("{address}", "0x5FbDB2315678afecb367f032d93F642f64180aa3"));
  if (url?.protocol !== "https:") {
    problems.push(`${where}: explorerUrl must be an https: URL`);
  } else if (url.username !== "" || url.password !== "") {
    problems.push(`${where}: explorerUrl must not hold a user name or password`);
  }
  return problems;
}

/** Every string in `value`, at any depth. */
function strings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

/**
 * Every problem of a routing table, or none. Checks the schema and types; unique, ascending,
 * positive safe-integer chain ids; known backends, each at most once per row; the API host and
 * path of each backend; the explorer template; the dates; and that no value looks like a key.
 *
 * @param value - The parsed table.
 * @returns One line per problem.
 */
export function tableProblems(value: unknown): string[] {
  const table = fieldsOf(value);
  if (table === undefined) {
    return ["the table must be an object"];
  }
  const problems = keyProblems(table, TABLE_KEYS, "table");
  if (table.get("schemaVersion") !== 1) {
    problems.push("table: schemaVersion must be 1");
  }
  const tableDate = dateOf(table.get("checked"));
  if (tableDate === undefined) {
    problems.push("table: checked must be a YYYY-MM-DD date");
  }
  const chains = table.get("chains");
  if (!Array.isArray(chains)) {
    problems.push("table: chains must be a list");
    return problems;
  }
  let previous = 0;
  chains.forEach((rawRow: unknown, index) => {
    const row = fieldsOf(rawRow);
    let where = `chains[${String(index)}]`;
    if (row === undefined) {
      problems.push(`${where}: must be an object`);
      return;
    }
    problems.push(...keyProblems(row, ROW_KEYS, where));
    const chainId = row.get("chainId");
    if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
      problems.push(`${where}: chainId must be a positive safe integer`);
      return;
    }
    where = `chain ${String(chainId)}`;
    if (chainId <= previous) {
      problems.push(`${where}: chain ids must be unique and ascending`);
    }
    previous = Math.max(previous, chainId);
    const name = row.get("name");
    if (typeof name !== "string" || name.trim() === "") {
      problems.push(`${where}: name must be a non-empty string`);
    }
    const checked = dateOf(row.get("checked"));
    if (checked === undefined) {
      problems.push(`${where}: checked must be a YYYY-MM-DD date`);
    } else if (tableDate !== undefined && checked > tableDate) {
      problems.push(`${where}: checked must not be after the table's date`);
    }
    const backends = row.get("backends");
    if (!Array.isArray(backends) || backends.length === 0) {
      problems.push(`${where}: backends must be a non-empty list`);
      return;
    }
    const seen = new Set<string>();
    backends.forEach((rawEntry: unknown, position) => {
      const entry = fieldsOf(rawEntry);
      const at = `${where} backends[${String(position)}]`;
      if (entry === undefined) {
        problems.push(`${at}: must be an object`);
        return;
      }
      problems.push(...keyProblems(entry, ENTRY_KEYS, at));
      const rawName = entry.get("backend");
      const backend = typeof rawName === "string" ? toBackendName(rawName) : undefined;
      if (backend === undefined) {
        problems.push(`${at}: backend must be a name in BACKEND_NAMES`);
        return;
      }
      if (seen.has(backend)) {
        problems.push(`${at}: ${backend} is listed twice`);
      }
      seen.add(backend);
      problems.push(...apiUrlProblems(entry.get("apiUrl"), backend, chainId, at));
      problems.push(...explorerUrlProblems(entry.get("explorerUrl"), at));
    });
  });
  for (const text of strings(value)) {
    if (redact(text) !== text) {
      problems.push(`a value matches a key pattern of the redaction module: ${redact(text)}`);
    }
  }
  return problems;
}
