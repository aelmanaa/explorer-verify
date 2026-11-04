/**
 * Chain id to backend, API URL and explorer URL (R-RT). The routing table, `routing/table.json`,
 * lists each chain's backends in order of preference; a caller can pick another listed backend,
 * point a backend at another server, or let a chain missing from the table fall back to Sourcify
 * (R-RT-1 to R-RT-3). Hosts come only from the table or the caller's options (R-SEC-2).
 *
 * The table holds only what varies per chain. {@link tableTarget} derives each backend's API URL
 * and explorer page from fixed templates, in one place (decision 0024).
 */
import { BACKEND_NAMES, toBackendName } from "../backend-names.ts";
import type { BackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import { checkRouteKey, needsKey } from "../http/api-keys.ts";
import type { ApiKeys } from "../http/api-keys.ts";
import { readChainId, readOwn } from "../internal/read-fields.ts";
import type { Hex, RouteOverride } from "../types.ts";
import table from "./table.json" with { type: "json" };

/**
 * One backend of a chain in the routing table: the backend's name and the little that varies per
 * chain. The API URL and the explorer page are derived by {@link tableTarget}.
 *
 * @example
 * ```ts
 * const sourcify: TableEntry = { backend: "sourcify" };
 * const routescan: TableEntry = { backend: "routescan", network: "testnet" };
 * const etherscan: TableEntry = { backend: "etherscan-v2", explorer: "sepolia.etherscan.io" };
 * ```
 */
export interface TableEntry {
  /** A name in `BACKEND_NAMES`. */
  readonly backend: string;
  /** `routescan` only, and required there: the network segment, `mainnet` or `testnet`. */
  readonly network?: string;
  /**
   * `etherscan-v2` only, optional: the explorer's host, such as `sepolia.etherscan.io`. The table
   * test checks that it is a bare lowercase host name in CI; the resolver does not check it at run
   * time.
   */
  readonly explorer?: string;
}

/**
 * One chain in the routing table.
 *
 * @example
 * ```ts
 * const row: TableRow = { chainId: 11155111, backends: [{ backend: "sourcify" }] };
 * ```
 */
export interface TableRow {
  /** The EVM chain id, a positive safe integer. Rows are in ascending chain id order. */
  readonly chainId: number;
  /** The chain's backends, in order of preference. */
  readonly backends: readonly TableEntry[];
}

/**
 * The routing table: the shape of `routing/table.json` (R-RT-1).
 *
 * @example
 * ```ts
 * const empty: RoutingTable = { schemaVersion: 2, checked: "2026-11-03", chains: [] };
 * ```
 */
export interface RoutingTable {
  /** The format version, 2. */
  readonly schemaVersion: number;
  /**
   * The date the rows were last checked against their sources, as `YYYY-MM-DD`. The sources are
   * listed in the research note of that date.
   */
  readonly checked: string;
  /** One row per chain. A chain with no usable backend has no row. */
  readonly chains: readonly TableRow[];
}

/**
 * A table entry with its derived URLs.
 *
 * @example
 * ```ts
 * const target: TableTarget | undefined = tableTarget(11155111, { backend: "sourcify" });
 * target?.apiUrl; // "https://sourcify.dev/server"
 * target?.explorerUrl?.("0x5FbDB2315678afecb367f032d93F642f64180aa3");
 * // "https://repo.sourcify.dev/11155111/0x5FbDB2315678afecb367f032d93F642f64180aa3"
 * ```
 */
export interface TableTarget {
  /** The backend. */
  readonly backend: BackendName;
  /** The full API base for this backend and chain: `https:`, no query, no trailing slash. */
  readonly apiUrl: string;
  /** The public page of the contract at an address, or `undefined` when none is known. */
  readonly explorerUrl: ((address: Hex) => string) | undefined;
}

/**
 * The routing table shipped with this version. The unit tests check every row (R-RT-1, R-SEC-2).
 *
 * @example
 * ```ts
 * ROUTING_TABLE.chains.find((row) => row.chainId === 11155111)?.backends[0]?.backend; // "sourcify"
 * ```
 */
export const ROUTING_TABLE: RoutingTable = table;

/**
 * Where one call sends its requests, and where a person sees the verified contract.
 *
 * @example
 * ```ts
 * const route: Route = resolveRoute(11155111);
 * route.requestUrl("/v2/contract/11155111/0x5FbDB2315678afecb367f032d93F642f64180aa3");
 * // "https://sourcify.dev/server/v2/contract/11155111/0x5FbDB2315678afecb367f032d93F642f64180aa3"
 * ```
 */
export interface Route {
  /** The backend that handles the call. */
  readonly backend: BackendName;
  /**
   * The API base: origin and path, with no query string and no trailing slash. Build request
   * URLs with {@link Route.requestUrl}, not by appending to this, so the query is kept.
   */
  readonly apiBase: string;
  /**
   * `apiBase`, followed by `?REDACTED` when the caller's URL had a query string. Only the query
   * is redacted: the host and path appear as given, so a key must never be put in them.
   */
  readonly redactedApiUrl: string;
  /**
   * The full URL of one API endpoint: `apiBase`, then `path`, then the query: the caller's query
   * string and, for `etherscan-v2`, `chainid` set to the call's chain. A `chainid` in the caller's
   * query, in any letter case, is dropped, so a request never goes to another chain. The result
   * can hold a key from the caller's query, so it is for requests only.
   *
   * @throws ExplorerVerifyError with code `invalid-input` when `path` is not empty and does not
   *   start with `/`, or contains `?` or `#`.
   */
  readonly requestUrl: (path: string) => string;
  /**
   * The page that shows a verified contract at `address`, derived from the table entry, or
   * `undefined` when the table knows no page for the backend and chain. Also
   * `undefined` when `route.apiUrl` moved the API to a server other than the table's: the
   * explorer's page shows only contracts verified through the table's API.
   */
  readonly explorerUrl: ((address: Hex) => string) | undefined;
  /**
   * The caller's `route.apiKey`, bound to this route: it goes only to `apiBase`'s host, and only
   * with requests of `backend`. `undefined` when the caller passed none. A function, so
   * `JSON.stringify` of a route never prints the key.
   */
  readonly apiKey: () => string | undefined;
  /** Whether `apiBase` came from the caller's `route.apiUrl` rather than the routing table. */
  readonly overridden: boolean;
  /**
   * The host of the routing table's API URL for this backend and chain, or `undefined` when the
   * table lists none. A key from `apiKeys` goes only to this host, and only when the route is not
   * overridden (R-SEC-2, decision 0016).
   */
  readonly tableHost: string | undefined;
}

/**
 * What decides the route besides the chain id and the override.
 *
 * @example
 * ```ts
 * const route = resolveRoute(11155111, undefined, { apiKeys: { routescan: key }, clients: ["sourcify"] });
 * ```
 */
export interface RouteChoice {
  /** The caller's checked keys. A backend that needs a key is skipped without one. */
  readonly apiKeys?: ApiKeys;
  /** Whether a chain missing from the table resolves to Sourcify (R-RT-3). Defaults to false. */
  readonly allowSourcifyFallback?: boolean;
  /**
   * The backends this version has a client for. `route.backend` naming another one throws
   * `invalid-input`. Absent means every backend name is accepted.
   */
  readonly clients?: readonly BackendName[];
  /** The table to read. Defaults to {@link ROUTING_TABLE}; the tests pass their own. */
  readonly table?: RoutingTable;
}

/**
 * The public Sourcify API base.
 *
 * @example
 * ```ts
 * const route = resolveRoute(1);
 * route.apiBase === SOURCIFY_API_URL; // true
 * ```
 */
export const SOURCIFY_API_URL = "https://sourcify.dev/server";

/**
 * Etherscan's v2 API base: the one API base `tableTarget` derives for `etherscan-v2`, since
 * every chain shares it and `requestUrl` adds the chain as `chainid`. The table check and the
 * server handler read it, so the host has one source.
 *
 * @example
 * ```ts
 * new URL(ETHERSCAN_API_URL).host; // "api.etherscan.io"
 * ```
 */
export const ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api";

const SOURCIFY_REPO_URL = "https://repo.sourcify.dev";
// Hostnames as `URL` reports them: lowercase, IPv4 normalised, IPv6 compressed in brackets.
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];
const MAX_API_URL_LENGTH = 8192;
const PATH = /^(?:\/[^?#]*)?$/;

const SCHEME_MESSAGE = "must use https, or http on localhost, 127.0.0.1 or [::1]";
const ROUTE_HINT = "Pass route as a plain object with backend and apiUrl fields, or leave it out.";
const API_KEY_HINT =
  "Pass route.apiKey as 8 to 1024 letters, digits, '.', '_', '~' or '-', next to route.apiUrl and only for a backend that takes a key, or leave it out.";
const API_URL_HINT =
  "Pass an absolute https URL, or an http URL on localhost, 127.0.0.1 or [::1], with no user name, password or fragment.";

/**
 * Derives a table entry's API URL and explorer page for `chainId` (decision 0024):
 *
 * - `sourcify`: `https://sourcify.dev/server`; page `https://repo.sourcify.dev/<chainId>/<address>`.
 * - `etherscan-v2`: `https://api.etherscan.io/v2/api`; page
 *   `https://<explorer>/address/<address>#code` when the entry names an `explorer` host, else none.
 * - `routescan`: `https://api.routescan.io/v2/network/<network>/evm/<chainId>/etherscan/api`, with
 *   `network` `mainnet` or `testnet`; no page yet.
 *
 * @param chainId - The row's chain id.
 * @param entry - The table entry.
 * @returns The derived target, or `undefined` for a backend the table cannot route (an unknown
 *   name, a backend without a template, or a Routescan entry without a valid network).
 * @example
 * ```ts
 * tableTarget(43113, { backend: "routescan", network: "testnet" })?.apiUrl;
 * // "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api"
 * ```
 */
export function tableTarget(chainId: number, entry: TableEntry): TableTarget | undefined {
  const { backend, network, explorer } = entry;
  const id = String(chainId);
  return backend === "sourcify"
    ? {
        backend,
        apiUrl: SOURCIFY_API_URL,
        explorerUrl: (address) => `${SOURCIFY_REPO_URL}/${id}/${encodeURIComponent(address)}`,
      }
    : backend === "etherscan-v2"
      ? {
          backend,
          apiUrl: ETHERSCAN_API_URL,
          explorerUrl:
            explorer === undefined
              ? undefined
              : (address) => `https://${explorer}/address/${encodeURIComponent(address)}#code`,
        }
      : backend === "routescan" && (network === "mainnet" || network === "testnet")
        ? {
            backend,
            apiUrl: `https://api.routescan.io/v2/network/${network}/evm/${id}/etherscan/api`,
            explorerUrl: undefined,
          }
        : undefined;
}

/**
 * The two override fields, or `undefined` when `value` is not a plain object (prototype
 * `Object.prototype` or `null`) whose fields can be read. Each field is read once.
 */
function readOverride(
  value: unknown,
): { backend: unknown; apiUrl: unknown; apiKey: unknown } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    const fields: {
      readonly backend?: unknown;
      readonly apiUrl?: unknown;
      readonly apiKey?: unknown;
    } = value;
    return {
      backend: readOwn(fields, "backend"),
      apiUrl: readOwn(fields, "apiUrl"),
      apiKey: readOwn(fields, "apiKey"),
    };
  } catch {
    // A Proxy whose traps throw. The raw error is dropped: it may repeat a caller value.
    return undefined;
  }
}

/**
 * Checks an override API URL. Returns the base and query string, or the issue message. The
 * `URL` parse error is dropped, never kept as a cause, because it carries the input.
 */
function checkApiUrl(value: unknown): { apiBase: string; search: string } | string {
  if (typeof value !== "string") {
    return "must be a string";
  }
  if (value.length > MAX_API_URL_LENGTH) {
    return `must be at most ${String(MAX_API_URL_LENGTH)} characters`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute URL";
  }
  const scheme = url.protocol;
  if (!(scheme === "https:" || (scheme === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) {
    return SCHEME_MESSAGE;
  }
  if (url.username !== "" || url.password !== "") {
    return "must not contain a user name or password";
  }
  // `#` can only stand for a fragment in a parsed href; elsewhere it is percent-encoded. `hash`
  // alone misses an empty fragment such as `/server#`.
  if (url.href.includes("#")) {
    return "must not contain a fragment";
  }
  let path = url.pathname;
  while (path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  // `search` is empty for a bare `?`.
  return { apiBase: `${url.origin}${path}`, search: url.search };
}

/**
 * Resolves where a call for `chainId` goes (R-RT-1 to R-RT-3). Hosts come only from the routing
 * table or `override`, never from a handle (R-SEC-2).
 *
 * Without `override.apiUrl`:
 *
 * - A chain in the table resolves to its first backend that is usable with `choice.apiKeys`: one
 *   that needs no key, or one with a key. When none is usable, it resolves to the first, and the
 *   flow reports the missing key. `override.backend` picks another backend the row lists.
 * - `override.backend` that the row does not list throws `unsupported-chain` naming the chain and
 *   the backend.
 * - A chain missing from the table resolves to Sourcify when `choice.allowSourcifyFallback` is
 *   true. Otherwise it throws `unsupported-chain`, whose hint names the fallback option and the
 *   route override.
 * - For `etherscan-v2`, `requestUrl` adds `chainid` to the query; the table's URL has none.
 *
 * With `override.apiUrl`, the call goes to that URL, for any chain, and the backend is
 * `override.backend`, or `sourcify` when it is absent. The route is `overridden`: a key from
 * `apiKeys` never goes to it, only `override.apiKey` does.
 *
 * `override` must be a plain object: its prototype is `Object.prototype` or `null`. Only its own
 * `backend`, `apiUrl` and `apiKey` properties are read, each once; inherited ones are ignored, and
 * so are other fields.
 *
 * `override.apiUrl` must be a primitive string of at most 8192 characters that parses as an
 * absolute `https:` URL, or an `http:` URL whose hostname is exactly `localhost`, `127.0.0.1` or
 * `[::1]`. On Node, `localhost` resolves through the system resolver, so the hosts file decides
 * where it points. The URL must not hold a user name, a password or a fragment. Trailing slashes
 * of the path are removed. A query string is kept for requests and redacted in `redactedApiUrl`.
 * Error messages name the field and never repeat the value, which may hold a key.
 *
 * `override.apiKey` must be a key string as `checkRouteKey` accepts, set next to `apiUrl`, for a
 * backend that takes a `route.apiKey`.
 *
 * @param chainId - The EVM chain id, a positive safe integer.
 * @param override - The caller's `VerifyOptions.route`, if any.
 * @param choice - The caller's keys, the fallback option, the backends with a client, the table.
 * @returns A frozen plain object. Later changes to `override` do not affect it.
 * @throws ExplorerVerifyError with code `invalid-input`, listing `chainId`, `route`,
 *   `route.backend`, `route.apiUrl` or `route.apiKey` in `details.issues`; `unsupported-chain`
 *   as described above.
 * @example
 * ```ts
 * const route = resolveRoute(31337, { apiUrl: "http://127.0.0.1:5555/?token=abc" });
 * route.apiBase; // "http://127.0.0.1:5555"
 * route.requestUrl("/v2/verify/31337/0x5FbDB2315678afecb367f032d93F642f64180aa3");
 * // "http://127.0.0.1:5555/v2/verify/31337/0x5FbDB2315678afecb367f032d93F642f64180aa3?token=abc"
 * route.redactedApiUrl; // "http://127.0.0.1:5555?REDACTED"
 * route.explorerUrl; // undefined: the public repository does not show a local server's contracts
 * ```
 */
export function resolveRoute(
  chainId: number,
  override?: RouteOverride,
  choice: RouteChoice = {},
): Route {
  const issues: InputIssue[] = [];
  let hint: string | undefined;
  if (readChainId(chainId) === undefined) {
    issues.push({ field: "chainId", message: "must be a positive integer" });
  }

  let named: BackendName | undefined;
  let target: { apiBase: string; search: string } | undefined;
  let apiKey: string | undefined;
  let rawKey: unknown;
  const raw: unknown = override;
  if (raw !== undefined) {
    const fields = readOverride(raw);
    if (fields === undefined) {
      issues.push({ field: "route", message: "must be a plain object" });
      hint = ROUTE_HINT;
    } else {
      if (fields.backend !== undefined) {
        named = typeof fields.backend === "string" ? toBackendName(fields.backend) : undefined;
        const problem =
          named === undefined
            ? "must name a known backend"
            : choice.clients?.includes(named) === false
              ? "has no client in this version"
              : undefined;
        if (problem !== undefined) {
          issues.push({ field: "route.backend", message: problem });
          hint = `Leave out route.backend, or name one of: ${(choice.clients ?? BACKEND_NAMES).join(", ")}.`;
        }
      }
      if (fields.apiUrl !== undefined) {
        const checked = checkApiUrl(fields.apiUrl);
        if (typeof checked === "string") {
          issues.push({ field: "route.apiUrl", message: checked });
          hint ??= API_URL_HINT;
        } else {
          target = checked;
        }
      }
      rawKey = fields.apiKey;
      const checked = checkRouteKey(named ?? "sourcify", rawKey, fields.apiUrl !== undefined);
      if (checked.issue !== undefined) {
        issues.push({ field: "route.apiKey", message: checked.issue });
        hint ??= API_KEY_HINT;
      }
      apiKey = checked.key;
    }
  }

  if (issues.length > 0) {
    throw invalid(issues, "The route is invalid", hint, typeof rawKey === "string" ? [rawKey] : []);
  }

  const row = (choice.table ?? ROUTING_TABLE).chains.find((each) => each.chainId === chainId);
  const targets = (entries: readonly TableEntry[]): TableTarget[] =>
    entries.flatMap((each) => tableTarget(chainId, each) ?? []);
  const listed = targets(row?.backends ?? []);
  // The Sourcify fallback: for a chain with no row, or a route.apiUrl without a row entry.
  const fallback = targets([{ backend: "sourcify" }]);
  const keys = choice.apiKeys ?? {};
  let backend: BackendName;
  let entry: TableTarget | undefined;
  let apiBase: string;
  let search = "";
  if (target === undefined) {
    const candidates =
      row === undefined && choice.allowSourcifyFallback === true ? fallback : listed;
    // Backends with a client come first. When none has one, the first entry stays, and the flow
    // throws `unsupported-chain` for it once the handle's backend has been checked.
    const served = candidates.filter((each) => choice.clients?.includes(each.backend) !== false);
    const pool = served.length > 0 ? served : candidates;
    const found =
      named === undefined
        ? (pool.find(
            (each) => !needsKey(each.backend) || readOwn(keys, each.backend) !== undefined,
          ) ?? pool[0])
        : candidates.find((each) => each.backend === named);
    if (found === undefined) {
      // No row, or a row without the named backend. The Sourcify fallback serves only Sourcify,
      // so a named backend on a chain without a row gets the "no row" error.
      throw unsupported(chainId, named ?? "sourcify", row === undefined ? "row" : "listed");
    }
    ({ backend, apiUrl: apiBase } = found);
    entry = found;
  } else {
    ({ apiBase, search } = target);
    backend = named ?? "sourcify";
    entry = [...listed, ...fallback].find((each) => each.backend === backend);
  }

  // Etherscan v2 serves every chain from one URL, so the chain goes in the query, set here only.
  // Any `chainid` of the caller's, in any case, is dropped: it could send a submit to another chain.
  let query = search;
  if (backend === "etherscan-v2") {
    const kept = search
      .slice(1)
      .split("&")
      .filter(
        (part) =>
          part !== "" && [...new URLSearchParams(part).keys()][0]?.toLowerCase() !== "chainid",
      );
    query = `?${[...kept, `chainid=${String(chainId)}`].join("&")}`;
  }
  return Object.freeze({
    backend,
    apiBase,
    redactedApiUrl: search === "" ? apiBase : `${apiBase}?REDACTED`,
    requestUrl: (path: string): string => {
      if (!PATH.test(path)) {
        throw invalid(
          [{ field: "path", message: "must be empty or start with /, and contain no ? or #" }],
          "The request path is invalid",
          undefined,
          [],
        );
      }
      return `${apiBase}${path}${query}`;
    },
    explorerUrl: entry?.apiUrl === apiBase ? entry.explorerUrl : undefined,
    apiKey: () => apiKey,
    overridden: target !== undefined,
    tableHost: entry === undefined ? undefined : new URL(entry.apiUrl).host,
  });
}

/**
 * `unsupported-chain` for a chain the routing table does not route: no row (`row`), a row that
 * does not list the backend the caller named (`listed`), or a row whose chosen backend has no
 * client in this version (`client`). The flow engine throws the last one when it opens the call.
 *
 * @param chainId - The chain of the call.
 * @param backend - The backend named or chosen; `sourcify`, the fallback, for a missing row.
 * @param why - Which of the three cases.
 * @returns The error, with a hint that names the options that fix it.
 * @example
 * ```ts
 * throw unsupported(999_999, "sourcify", "row");
 * ```
 */
export function unsupported(
  chainId: number,
  backend: BackendName,
  why: "row" | "listed" | "client",
): ExplorerVerifyError {
  const chain = `chain ${String(chainId)}`;
  return new ExplorerVerifyError(
    { code: "unsupported-chain", chainId, backend },
    why === "row"
      ? `The routing table has no row for ${chain}.`
      : why === "listed"
        ? `The routing table lists no ${backend} API for ${chain}.`
        : `This version has no ${backend} client, the routing table's choice for ${chain}.`,
    {
      hint:
        why === "row"
          ? "Set allowSourcifyFallback: true, or set route.apiUrl and route.backend."
          : "Set route.backend to another backend the chain lists, or set route.apiUrl with it.",
      secrets: [],
    },
  );
}

function invalid(
  issues: InputIssue[],
  summary: string,
  hint: string | undefined,
  secrets: readonly string[],
): ExplorerVerifyError {
  const names = issues.map((issue) => issue.field).join(", ");
  return new ExplorerVerifyError(
    { code: "invalid-input", issues },
    `${summary}: ${names}.`,
    hint === undefined ? { secrets } : { hint, secrets },
  );
}
