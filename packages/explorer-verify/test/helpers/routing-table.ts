// Checks a routing table against the rules of #59 and the compact format of #60 (R-RT-1, R-SEC-2,
// decision 0024). The table decides which hosts get requests and keys, so a malformed row is a
// security bug. The checks run on the table as written and on the URLs the resolver derives from
// it. The unit tests run them on the shipped table and on broken copies of it.
import { toBackendName } from "../../src/backend-names.ts";
import type { BackendName } from "../../src/backend-names.ts";
import { redact } from "../../src/redact.ts";
import { ETHERSCAN_API_URL, tableTarget } from "../../src/routing/resolve.ts";

const ETHERSCAN = new URL(ETHERSCAN_API_URL);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TABLE_KEYS = ["schemaVersion", "checked", "chains"];
const ROW_KEYS = ["chainId", "backends"];
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const HOST = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})+$`);
const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
// A standalone API: a host, then an optional path of lowercase segments, no trailing slash.
const API = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})+(?:/[a-z0-9._~-]+)*$`);

/** Whether `URL` writes `https://<api>` back unchanged: no port, no dot segments, no escapes. */
/** Whether a host is an IP literal: IPv4 (a last label of digits) or bracketed IPv6. */
function isIpLiteral(host: string): boolean {
  return host.startsWith("[") || /(?:^|\.)\d+$/.test(host);
}

function isApiPath(api: string): boolean {
  const url = urlOf(`https://${api}`);
  return url !== undefined && `${url.host}${url.pathname === "/" ? "" : url.pathname}` === api;
}

/** The fields each backend's entry may hold: [required, optional]. */
const ENTRY_KEYS: Readonly<Partial<Record<BackendName, [string[], string[]]>>> = {
  "etherscan-v2": [["backend"], ["explorer"]],
  routescan: [["backend", "network"], []],
  sourcify: [["backend"], []],
  blockscout: [["backend", "instance"], []],
  "etherscan-compatible": [
    ["backend", "api"],
    ["explorer", "needsKey"],
  ],
};

/**
 * The API host and path each backend's derived `apiUrl` must have. A backend without a rule cannot
 * appear in the table: its issue adds the rule, and the resolver's template, with its first row.
 * A Blockscout instance's host is the entry's `instance`, and a standalone explorer's host and
 * path are its `api`; `entryProblems` checks both first.
 */
const API_RULES: Readonly<
  Partial<Record<BackendName, (chainId: number, instance: string) => [string, RegExp]>>
> = {
  blockscout: (_chainId, instance) => [instance, /^\/api$/],
  "etherscan-compatible": (_chainId, api) => {
    const at = api.indexOf("/");
    // `URL` writes an empty path as `/`.
    const path = at === -1 ? "/" : api.slice(at);
    return [at === -1 ? api : api.slice(0, at), new RegExp(`^${path.replaceAll(".", "\\.")}$`)];
  },
  "etherscan-v2": () => [ETHERSCAN.host, new RegExp(`^${ETHERSCAN.pathname}$`)],
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

/** What is wrong with the keys of `fields`, compared with the required and optional ones. */
function keyProblems(
  fields: Map<string, unknown>,
  required: string[],
  optional: string[],
  where: string,
): string[] {
  const keys = [...fields.keys()];
  const missing = required.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !required.includes(key) && !optional.includes(key));
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
function urlOf(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * The problems of a derived `apiUrl` for `backend` on `chainId`. The resolver builds it from fixed
 * templates, so these checks guard the templates and the per-row fields that go into them.
 * `instance` is a Blockscout entry's host, or a standalone entry's `api`; for those backends, the
 * empty default matches no host.
 */
export function apiUrlProblems(
  value: string,
  backend: BackendName,
  chainId: number,
  where: string,
  instance = "",
): string[] {
  const url = urlOf(value);
  if (url === undefined) {
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
  const [host, path] = rule(chainId, instance);
  if (url.host !== host) {
    problems.push(`${where}: apiUrl host must be ${host} for ${backend}`);
  } else if (!path.test(url.pathname)) {
    problems.push(`${where}: apiUrl path must match ${String(path)} for ${backend}`);
  }
  return problems;
}

/** The problems of a derived explorer page, filled with a sample address. */
export function explorerUrlProblems(value: string, where: string): string[] {
  const url = urlOf(value);
  if (url?.protocol !== "https:") {
    return [`${where}: explorerUrl must be an https: URL`];
  }
  const problems: string[] = [];
  if (url.username !== "" || url.password !== "") {
    problems.push(`${where}: explorerUrl must not hold a user name or password`);
  }
  if (!url.pathname.includes(ADDRESS)) {
    problems.push(`${where}: explorerUrl must hold the address in its path`);
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

/** The problems of one backend entry of the row for `chainId`. */
function entryProblems(
  entry: Map<string, unknown>,
  backend: BackendName,
  chainId: number,
  at: string,
): string[] {
  const keys = ENTRY_KEYS[backend];
  if (keys === undefined) {
    return [`${at}: ${backend} has no host rule yet`];
  }
  const problems = keyProblems(entry, ...keys, at);
  const network = entry.get("network");
  if (entry.has("network") && network !== "mainnet" && network !== "testnet") {
    problems.push(`${at}: network must be mainnet or testnet`);
  }
  const explorer = entry.get("explorer");
  const instance = entry.get("instance");
  const api = entry.get("api");
  const needsKey = entry.get("needsKey");
  if (entry.has("needsKey") && needsKey !== true) {
    problems.push(`${at}: needsKey must be true, or left out`);
  }
  if (
    entry.has("api") &&
    (typeof api !== "string" ||
      !API.test(api) ||
      !isApiPath(api) ||
      isIpLiteral(api.split("/")[0] ?? ""))
  ) {
    problems.push(
      `${at}: api must be a lowercase host name and path, with no scheme, port or query`,
    );
  }
  const hosts: [string, unknown][] = [
    ["explorer", explorer],
    ["instance", instance],
  ];
  for (const [name, host] of hosts) {
    if (
      entry.has(name) &&
      (typeof host !== "string" ||
        !HOST.test(host) ||
        isIpLiteral(host) ||
        urlOf(`https://${host}`)?.host !== host)
    ) {
      problems.push(`${at}: ${name} must be a lowercase host name, with no scheme, port or path`);
    }
  }
  if (problems.length > 0) {
    return problems;
  }
  const target = tableTarget(chainId, {
    backend,
    ...(typeof network === "string" ? { network } : {}),
    ...(typeof explorer === "string" ? { explorer } : {}),
    ...(typeof instance === "string" ? { instance } : {}),
    ...(typeof api === "string" ? { api } : {}),
    ...(needsKey === true ? { needsKey } : {}),
  });
  if (target === undefined) {
    return [`${at}: the resolver derives no URL for this entry`];
  }
  return [
    ...apiUrlProblems(
      target.apiUrl,
      backend,
      chainId,
      at,
      typeof instance === "string" ? instance : typeof api === "string" ? api : "",
    ),
    ...(target.explorerUrl === undefined
      ? []
      : explorerUrlProblems(target.explorerUrl(ADDRESS), at)),
  ];
}

/**
 * Every problem of a routing table, or none. Checks the schema and types; unique, ascending,
 * positive safe-integer chain ids; known backends, each at most once per row, with only the fields
 * their format has; the API host and path the resolver derives for each entry; the derived
 * explorer page; the date; and that no value looks like a key.
 *
 * @param value - The parsed table.
 * @returns One line per problem.
 */
export function tableProblems(value: unknown): string[] {
  const table = fieldsOf(value);
  if (table === undefined) {
    return ["the table must be an object"];
  }
  const problems = keyProblems(table, TABLE_KEYS, [], "table");
  if (table.get("schemaVersion") !== 3) {
    problems.push("table: schemaVersion must be 3");
  }
  if (dateOf(table.get("checked")) === undefined) {
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
    problems.push(...keyProblems(row, ROW_KEYS, [], where));
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
      problems.push(...entryProblems(entry, backend, chainId, at));
    });
  });
  for (const text of strings(value)) {
    if (redact(text) !== text) {
      problems.push(`a value matches a key pattern of the redaction module: ${redact(text)}`);
    }
  }
  return problems;
}
