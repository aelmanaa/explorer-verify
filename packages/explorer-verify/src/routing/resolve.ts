// References: R-RT-1, R-RT-3, R-SEC-2, decision 0024, decision 0052, decision 0040.
/**
 * Chain id to backend, API URL and explorer URL (R-RT). The routing table, `routing/table.json`,
 * lists each chain's backends in order of preference; a caller can pick another listed backend,
 * point a backend at another server, or let a chain missing from the table fall back to Sourcify.
 * Hosts come only from the table or the caller's options.
 *
 * The table holds only what varies per chain. {@link tableTarget} derives each backend's API URL
 * and explorer page from fixed templates, in one place.
 *
 * This module does not import the table, and holds no dynamic `import()`. Its rows sit in
 * `routing/table.ts`, which the default entry loads with a dynamic `import()`, through
 * `loadRoutingTable` in `routing/load-table.ts`, so a bundler that splits code puts them in a chunk
 * of their own; `explorer-verify/core` takes them from its caller.
 * {@link readsTable} tells which routes need it: a call whose `route.apiUrl` cannot be a URL the
 * table lists does not load it.
 */
import { BACKEND_NAMES, toBackendName } from "../backend-names.ts";
import type { BackendName } from "../backend-names.ts";
import { newError } from "../error-hints.ts";
import type { ExplorerVerifyError, InputIssue } from "../errors.ts";
import { checkRouteKey, HOSTED_BLOCKSCOUT_HOST, needsKey } from "../http/api-keys.ts";
import type { CheckedKeys } from "../http/api-keys.ts";
import { ownKeys, unknownKeys } from "../internal/known-keys.ts";
import { readChainId, readOwn } from "../internal/read-fields.ts";
import type { CallOptions, Hex, RoutedBy, RouteOverride } from "../types.ts";

/**
 * One backend of a chain in the routing table: the backend's name and the little that varies per
 * chain. The API URL and the explorer page are derived by {@link tableTarget}.
 *
 * @example
 * ```ts
 * const sourcify: TableEntry = { backend: "sourcify" };
 * const routescan: TableEntry = { backend: "routescan", network: "testnet" };
 * const etherscan: TableEntry = { backend: "etherscan-v2", explorer: "sepolia.etherscan.io" };
 * const blockscout: TableEntry = { backend: "blockscout", instance: "eth-sepolia.blockscout.com" };
 * const standalone: TableEntry = {
 *   backend: "etherscan-compatible",
 *   api: "api.btrscan.com/scan/api",
 *   explorer: "www.btrscan.com",
 * };
 * ```
 */
export interface TableEntry {
  /** A name in `BACKEND_NAMES`. */
  readonly backend: string;
  /** `routescan` only, and required there: the network segment, `mainnet` or `testnet`. */
  readonly network?: string;
  /**
   * `etherscan-v2` and `etherscan-compatible` only, optional: the explorer's host, such as
   * `sepolia.etherscan.io`. The table test checks that it is a bare lowercase host name in CI; the
   * resolver does not check it at run time.
   */
  readonly explorer?: string;
  /**
   * `etherscan-compatible` only, and required there (schema 3): the API's host and path, without
   * the scheme, such as `api.btrscan.com/scan/api`. The API base is `https://<api>`. The table
   * test checks it in CI; the resolver does not check it at run time.
   */
  readonly api?: string;
  /**
   * `etherscan-compatible` only, optional (schema 3): `true` when the API refuses a request without
   * a key. Such an entry is skipped without `route.apiKey`, and a call that names it without one
   * throws `missing-api-key` before any request.
   */
  readonly needsKey?: boolean;
  /**
   * `blockscout` only, and required there: the instance's host, such as
   * `eth-sepolia.blockscout.com`. The API is `https://<instance>/api`. The table test checks that
   * it is a bare lowercase host name in CI; the resolver does not check it at run time.
   */
  readonly instance?: string;
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

// References: R-RT-1.
/**
 * The routing table: the shape of `routing/table.json`.
 *
 * @example
 * ```ts
 * const empty: RoutingTable = { schemaVersion: 3, checked: "2026-11-05", chains: [] };
 * ```
 */
export interface RoutingTable {
  /**
   * The format version, 3. Schema 3 adds the `etherscan-compatible` entry to schema 2. A schema 2
   * table is a schema 3 table without such entries, so the resolver reads both and does not look
   * at this field.
   */
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
  /** `true` when the entry says its API refuses a request without a key. */
  readonly needsKey?: boolean;
}

// References: decision 0040.
/** Loads the routing table. The shipped one sits behind a dynamic `import()`. */
export type TableLoader = () => Promise<RoutingTable>;

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
  // References: R-SEC-2, decision 0016, decision 0053, decision 0040.
  /**
   * The host of the routing table's API URL for this backend and chain, or `undefined` when the
   * table lists none. A key from `apiKeys` goes only to this host, and only when the route is not
   * overridden, or is an `etherscan-v2` route whose `route.apiUrl` is on
   * this host. For a route with `route.apiUrl` it is the backend's one API host,
   * for `sourcify`, `etherscan-v2`, `routescan` and `blockscout-hosted`, and `undefined` for the
   * others.
   */
  readonly tableHost: string | undefined;
  /**
   * `true` when the route goes to a table entry whose API refuses a request without a key, beyond
   * the backends that always need one. Absent otherwise.
   */
  readonly needsKey?: boolean;
  /**
   * How the backend was chosen: `caller` for `route.backend`, `table` for the routing table's
   * pick, `fallback` for the Sourcify fallback, `api-url` for `route.apiUrl`. `verify.routed`
   * carries it.
   */
  readonly routedBy: RoutedBy;
  /**
   * The backends the routing table lists before `backend` that a `table` route passed over,
   * because each needs an API key and none is set, in table order. Empty for any other route.
   */
  readonly skipped: readonly BackendName[];
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
  readonly apiKeys?: CheckedKeys;
  // References: R-RT-3.
  /** Whether a chain missing from the table resolves to Sourcify. Defaults to false. */
  readonly allowSourcifyFallback?: boolean;
  /**
   * The backends this version has a client for. `route.backend` naming another one throws
   * `invalid-input`. Absent means every backend name is accepted.
   */
  readonly clients?: readonly BackendName[];
  // References: decision 0057.
  /**
   * Whether a backend's client verifies the input's compiler kind. The table
   * passes over a backend that does not, unless no listed backend does; the flow engine then
   * refuses the input. Absent means every backend does.
   */
  readonly verifies?: ((backend: BackendName) => boolean) | undefined;
  // References: decision 0040.
  /**
   * The routing table, loaded. A route without `route.apiUrl` throws a `TypeError` without it. A
   * route with `route.apiUrl` reads it, when given, only for what the row says about its own API
   * URL: the explorer page and `needsKey`. The flow engine loads it only when {@link readsTable}
   * says so.
   */
  readonly table?: RoutingTable | undefined;
}

/**
 * The caller's route override, checked by {@link checkRoute}: what {@link routeFrom} needs from it.
 * {@link readsTable} tells from it whether the route needs the routing table.
 *
 * @example
 * ```ts
 * const checked: CheckedRoute = checkRoute(11155111, { backend: "sourcify" });
 * readsTable(checked); // true: the route comes from the table
 * ```
 */
export interface CheckedRoute {
  /** `route.backend`, when the caller named one. */
  readonly named: BackendName | undefined;
  /** `route.apiUrl` as its base and query string, when the caller set one. */
  readonly target: { readonly apiBase: string; readonly search: string } | undefined;
  /** `route.apiKey`, when the caller set one. */
  readonly apiKey: string | undefined;
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

// References: decision 0046.
/**
 * What `choiceKeys` puts under `etherscan-v2` when `handlerUrl` is set, so that the routing table
 * chooses as it does with an Etherscan key. The empty string is never sent: it
 * only marks the backend as keyed. {@link routeFrom} reads keys with `!== undefined`; a
 * truthiness check there would drop it and break `handlerUrl`.
 *
 * @example
 * ```ts
 * const keys = {...settings.apiKeys(), "etherscan-v2": HANDLER_KEY };
 * ```
 */
export const HANDLER_KEY = "";

const SOURCIFY_REPO_URL = "https://repo.sourcify.dev";
const ROUTESCAN_HOST = "api.routescan.io";
// An API base that may be a Blockscout row's: `https://<instance>/api` (decision 0040).
const BLOCKSCOUT_API = /^https:\/\/[^/]+\/api$/;

// References: decision 0040.
/**
 * The one API host of a backend whose API host does not depend on the row, for the hint of a
 * route with `route.apiUrl`, or `undefined`. A function, not a constant, so a
 * bundle that does not resolve routes, such as the server handler's, drops it.
 */
function fixedHost(backend: BackendName): string | undefined {
  return backend === "sourcify"
    ? new URL(SOURCIFY_API_URL).host
    : backend === "etherscan-v2"
      ? new URL(ETHERSCAN_API_URL).host
      : backend === "routescan"
        ? ROUTESCAN_HOST
        : backend === "blockscout-hosted"
          ? HOSTED_BLOCKSCOUT_HOST
          : undefined;
}
// Hostnames as `URL` reports them: lowercase, IPv4 normalised, IPv6 compressed in brackets.
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];
const MAX_API_URL_LENGTH = 8192;
const PATH = /^(?:\/[^?#]*)?$/;

const SCHEME_MESSAGE = "must use https, or http on localhost, 127.0.0.1 or [::1]";
const ROUTE_HINT =
  "Pass route as a plain object with backend, apiUrl and apiKey fields, or leave it out.";
const API_KEY_HINT =
  "Pass route.apiKey as 8 to 1024 letters, digits, '.', '_', '~' or '-', next to route.apiUrl or with route.backend etherscan-compatible, and only for a backend that takes a key, or leave it out.";
const API_URL_HINT =
  "Pass an absolute https URL, or an http URL on localhost, 127.0.0.1 or [::1], with no user name, password or fragment.";

// References: decision 0024.
/**
 * Derives a table entry's API URL and explorer page for `chainId`:
 *
 * - `sourcify`: `https://sourcify.dev/server`; page
 * `https://repo.sourcify.dev/<chainId>/<address>`.
 * - `etherscan-v2`: `https://api.etherscan.io/v2/api`; page
 *   `https://<explorer>/address/<address>#code` when the entry names an `explorer` host, else none.
 * - `routescan`: `https://api.routescan.io/v2/network/<network>/evm/<chainId>/etherscan/api`, with
 *   `network` `mainnet` or `testnet`; no page yet.
 * - `blockscout`: `https://<instance>/api`; page
 * `https://<instance>/address/<address>?tab=contract`.
 * - `etherscan-compatible`: `https://<api>`; page as for `etherscan-v2`. `needsKey` is copied.
 *
 * @param chainId - The row's chain id.
 * @param entry - The table entry.
 * @returns The derived target, or `undefined` for a backend the table cannot route (an unknown
 *   name, a backend without a template, a Routescan entry without a valid network, or a Blockscout
 *   or standalone entry without its host).
 * @example
 * ```ts
 * tableTarget(43113, { backend: "routescan", network: "testnet" })?.apiUrl;
 * // "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api"
 * ```
 */
export function tableTarget(chainId: number, entry: TableEntry): TableTarget | undefined {
  const { backend, network, explorer, instance, api } = entry;
  const id = String(chainId);
  const page =
    explorer === undefined
      ? undefined
      : (address: Hex): string => `https://${explorer}/address/${encodeURIComponent(address)}#code`;
  return backend === "sourcify"
    ? {
        backend,
        apiUrl: SOURCIFY_API_URL,
        explorerUrl: (address) => `${SOURCIFY_REPO_URL}/${id}/${encodeURIComponent(address)}`,
      }
    : backend === "etherscan-v2"
      ? { backend, apiUrl: ETHERSCAN_API_URL, explorerUrl: page }
      : backend === "etherscan-compatible" && api !== undefined
        ? {
            backend,
            apiUrl: `https://${api}`,
            explorerUrl: page,
            needsKey: entry.needsKey === true,
          }
        : backend === "routescan" && (network === "mainnet" || network === "testnet")
          ? {
              backend,
              apiUrl: `https://${ROUTESCAN_HOST}/v2/network/${network}/evm/${id}/etherscan/api`,
              explorerUrl: undefined,
            }
          : backend === "blockscout" && instance !== undefined
            ? {
                backend,
                apiUrl: `https://${instance}/api`,
                explorerUrl: (address) =>
                  `https://${instance}/address/${encodeURIComponent(address)}?tab=contract`,
              }
            : undefined;
}

// References: R-IN-6.
/** The keys of a route override, in documentation order. */
export function routeKeys(): readonly string[] {
  return Object.keys({
    backend: true,
    apiUrl: true,
    apiKey: true,
  } satisfies Record<keyof RouteOverride, true>);
}

/**
 * The three override fields and an issue for each other own enumerable key, or `undefined` when
 * `value` is not a plain object (prototype `Object.prototype` or `null`) whose fields can be read.
 * Each field is read once; a getter on an unknown key never runs.
 */
function readOverride(value: unknown):
  | {
      backend: unknown;
      apiUrl: unknown;
      apiKey: unknown;
      unknown: readonly InputIssue[];
    }
  | undefined {
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
      unknown: unknownKeys(Object.keys(value), routeKeys(), "route.", "route"),
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
 * Checks an override API URL, or another URL the caller configures, such as the resolver's
 * `rpcUrl` and `ipfsGateway`. Returns the base and query string, or the issue message. The
 * `URL` parse error is dropped, never kept as a cause, because it carries the input.
 */
export function checkApiUrl(value: unknown): { apiBase: string; search: string } | string {
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

// References: R-RT-1, R-RT-3, R-SEC-2, decision 0041, decision 0039.
/**
 * Resolves where a call for `chainId` goes. Hosts come only from the routing
 * table or `override`, never from a handle.
 *
 * Without `override.apiUrl`:
 *
 * - A chain in the table resolves to its first backend that is usable with `choice.apiKeys`: one
 *   that needs no key, or one with a key. A standalone entry with `needsKey` counts as needing
 *   one, and no `apiKeys` entry gives it one. When none is usable, it resolves to the first, and
 * the
 *   flow reports the missing key. `override.backend` picks another backend the row lists.
 * - `override.backend` that the row does not list throws `unsupported-chain` naming the chain and
 *   the backend, except `blockscout-hosted`, which no row lists: it goes to
 *   `https://api.blockscout.com/<chainId>/api` for any chain, with the page of the row's
 *   Blockscout instance.
 * - A chain missing from the table resolves to Sourcify when `choice.allowSourcifyFallback` is
 *   true. Otherwise it throws `unsupported-chain`, whose hint names the fallback option and the
 *   route override.
 * - For `etherscan-v2`, `requestUrl` adds `chainid` to the query; the table's URL has none.
 *
 * With `override.apiUrl`, the call goes to that URL, for any chain, and the backend is
 * `override.backend`, or `sourcify` when it is absent. The route is `overridden`: a key from
 * `apiKeys` never goes to it, only `override.apiKey` does. Its explorer page is the row's when
 * `override.apiUrl` is the row's own API URL for the backend, and `undefined` otherwise.
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
 * `override.apiKey` must be a key string as `checkRouteKey` accepts, for a backend that takes a
 * `route.apiKey`, and set next to `apiUrl`. With `backend` `etherscan-compatible` it may also be
 * set without `apiUrl` when the chain's row lists a standalone host with `needsKey`: the key then
 * goes to that host. A row whose standalone entry takes no key throws `invalid-input` naming
 * `route.apiKey`, and a chain whose row lists none throws `unsupported-chain`.
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
  return routeFrom(chainId, checkRoute(chainId, override, choice.clients), choice);
}

// References: decision 0040, decision 0052.
/**
 * The first step of {@link resolveRoute}: checks `chainId` and `override`, and reads the override's
 * fields, each once. It reads no routing table, so the flow engine checks a route before it loads
 * the table.
 *
 * @param chainId - The EVM chain id, a positive safe integer.
 * @param override - The caller's `VerifyOptions.route`, if any.
 * @param clients - The backends this version has a client for; absent accepts every name.
 * @param passed - Set by `explorer-verify/core`, whose `clients` are the caller's: the hint for a
 *   `route.backend` the caller left out of them.
 * @returns The checked override. `target` is `undefined` when the route reads the routing table.
 * @throws ExplorerVerifyError with code `invalid-input`, as {@link resolveRoute} describes.
 * @example
 * ```ts
 * checkRoute(31337, { apiUrl: "http://127.0.0.1:5555" }).target?.apiBase; // "http://127.0.0.1:5555"
 * ```
 */
export function checkRoute(
  chainId: number,
  override?: RouteOverride,
  clients?: readonly BackendName[],
  passed?: (named: BackendName) => string,
): CheckedRoute {
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
      if (fields.unknown.length > 0) {
        issues.push(...fields.unknown);
        hint = ROUTE_HINT;
      }
      if (fields.backend !== undefined) {
        named = toBackendName(fields.backend);
        const problem =
          named === undefined
            ? "must name a known backend"
            : clients?.includes(named) === false
              ? passed === undefined
                ? "has no client in this version"
                : "has no client in clients"
              : undefined;
        if (problem !== undefined) {
          issues.push({ field: "route.backend", message: problem });
          hint =
            (named === undefined ? undefined : passed?.(named)) ??
            `Leave out route.backend, or name one of: ${(clients ?? BACKEND_NAMES).join(", ")}.`;
        }
      }
      if (fields.apiUrl !== undefined) {
        const checked = checkApiUrl(fields.apiUrl);
        if (typeof checked === "string") {
          issues.push({ field: "route.apiUrl", message: checked });
          hint ??= API_URL_HINT;
        } else if (
          (named === "blockscout" || named === "blockscout-hosted") &&
          !checked.apiBase.endsWith("/api")
        ) {
          // The client derives the REST lookup from the instance's /api.
          issues.push({ field: "route.apiUrl", message: `must end in /api for ${named}` });
          hint ??= "Pass the instance's API URL, such as https://eth-sepolia.blockscout.com/api.";
        } else if (
          named === "blockscout" &&
          checked.apiBase.startsWith(`https://${HOSTED_BLOCKSCOUT_HOST}/`)
        ) {
          // The instance client sends no key and reads no key answer (decision 0041).
          issues.push({ field: "route.apiUrl", message: "is Blockscout's hosted API" });
          hint ??= `Set route.backend "blockscout-hosted" and leave out route.apiUrl.`;
        } else {
          target = checked;
        }
      }
      rawKey = fields.apiKey;
      // A standalone explorer's key may also go to the host the table lists for the chain
      // (decision 0039): the row is checked below, and a chain without one throws.
      const checked = checkRouteKey(
        named ?? "sourcify",
        rawKey,
        fields.apiUrl !== undefined || named === "etherscan-compatible",
      );
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
  return { named, target, apiKey };
}

// References: decision 0052.
/**
 * Whether a checked route resolves without the routing table: it has `route.apiUrl`, or names a
 * backend with one public host for every chain (Sourcify, Etherscan v2, Blockscout's hosted API).
 * Only `explorer-verify/core` routes without a table; such a route then reads no row, so it has no
 * explorer page from one.
 *
 * @param checked - The checked override, from {@link checkRoute}.
 * @returns `true` when the route needs no table.
 * @example
 * ```ts
 * servesWithoutTable(checkRoute(1, { backend: "sourcify" })); // true
 * ```
 */
export function servesWithoutTable(checked: CheckedRoute): boolean {
  const { named, target } = checked;
  return (
    target !== undefined ||
    named === "sourcify" ||
    named === "etherscan-v2" ||
    named === "blockscout-hosted"
  );
}

// References: decision 0040.
/**
 * Whether a checked route needs the routing table. A route without `route.apiUrl`
 * does. A route with it needs the table only for what the row says about its own API URL, the
 * explorer page and `needsKey`, and only for a backend whose row decides them:
 *
 * - `etherscan-v2` at Etherscan's v2 API, whose page host the row names;
 * - `blockscout` at an `https` URL whose path is `/api`, which may be the row's instance;
 * - `etherscan-compatible` at an `https` URL, which may be the row's standalone API, with its page
 * and `needsKey`.
 *
 * Any other route with `route.apiUrl` gives the same route with or without the table: a Sourcify
 * page needs no row, a Routescan entry has no page, and the row never lists an `http` URL.
 *
 * @param checked - The override, from {@link checkRoute}.
 * @returns Whether the flow engine loads the table before {@link routeFrom}.
 * @example
 * ```ts
 * readsTable(checkRoute(1)); // true
 * readsTable(checkRoute(1, { backend: "sourcify", apiUrl: "http://127.0.0.1:5555" })); // false
 * readsTable(checkRoute(1, { backend: "etherscan-v2", apiUrl: ETHERSCAN_API_URL })); // true
 * ```
 */
export function readsTable(checked: CheckedRoute): boolean {
  const { named, target } = checked;
  return (
    target === undefined ||
    (named === "etherscan-v2" && target.apiBase === ETHERSCAN_API_URL) ||
    (named === "blockscout" && BLOCKSCOUT_API.test(target.apiBase)) ||
    (named === "etherscan-compatible" && target.apiBase.startsWith("https://"))
  );
}

// References: decision 0040.
/**
 * The second step of {@link resolveRoute}: the route of a checked override. A route without
 * `route.apiUrl` reads `choice.table`. A route with it reads the table, when given, only for the
 * explorer page and `needsKey` of the row's own API URL, which {@link readsTable} tells apart; its
 * `tableHost` is
 * the backend's one API host, read from no row.
 *
 * @param chainId - The chain id, checked by {@link checkRoute}.
 * @param checked - The override, from {@link checkRoute}.
 * @param choice - The caller's keys, the fallback option, the backends with a client, the table.
 * @returns A frozen plain object, as {@link resolveRoute} returns it.
 * @throws ExplorerVerifyError `unsupported-chain`, as {@link resolveRoute} describes; `TypeError`
 *   when the route reads the table and `choice.table` is absent.
 * @example
 * ```ts
 * const route = routeFrom(11155111, checkRoute(11155111), { table: ROUTING_TABLE });
 * ```
 */
export function routeFrom(chainId: number, checked: CheckedRoute, choice: RouteChoice): Route {
  const { named, target, apiKey } = checked;
  const targets = (entries: readonly TableEntry[]): TableTarget[] =>
    entries.flatMap((each) => tableTarget(chainId, each) ?? []);
  const { table } = choice;
  // Without a table, which only explorer-verify/core allows, a backend with one public host for
  // every chain stands for its own row; the host is the library's, not the caller's (decision 0052).
  const row =
    table === undefined
      ? named === "sourcify" || named === "etherscan-v2"
        ? { chainId, backends: [{ backend: named }] }
        : undefined
      : table.chains.find((each) => each.chainId === chainId);
  // Stryker disable next-line ArrayDeclaration: equivalent. tableTarget routes no entry that is not an object with a backend.
  const listed = targets(row?.backends ?? []);
  // The Sourcify fallback: for a chain with no row, or a route.apiUrl without a row entry.
  const fallback = targets([{ backend: "sourcify" }]);
  // A key without apiUrl binds to the row's standalone host, which must say it takes one: a
  // keyed request is a form POST, which a keyless explorer such as Bitlayer refuses (decision
  // 0039).
  const standalone = listed.find((each) => each.backend === "etherscan-compatible");
  if (
    target === undefined &&
    apiKey !== undefined &&
    named === "etherscan-compatible" &&
    standalone !== undefined &&
    standalone.needsKey !== true
  ) {
    throw invalid(
      [{ field: "route.apiKey", message: "is not accepted: this explorer takes no API key" }],
      "The route is invalid",
      "The routing table's explorer for this chain takes no key, so leave out route.apiKey.",
      [apiKey],
    );
  }
  const keys = choice.apiKeys ?? {};
  let backend: BackendName;
  let entry: TableTarget | undefined;
  let tableHost: string | undefined;
  let apiBase: string;
  let search = "";
  let routedBy: RoutedBy;
  let skipped: readonly BackendName[] = [];
  if (target === undefined && named === "blockscout-hosted") {
    // Blockscout's hosted API serves each chain it indexes at one host, with the chain in the
    // path, so it needs no row. The page is the row's instance page: a contract verified through
    // the hosted API shows there (live, 2026-11-05). Decision 0041.
    backend = named;
    routedBy = "caller";
    tableHost = HOSTED_BLOCKSCOUT_HOST;
    apiBase = `https://${tableHost}/${String(chainId)}/api`;
    entry = {
      backend,
      apiUrl: apiBase,
      explorerUrl: listed.find((each) => each.backend === "blockscout")?.explorerUrl,
    };
  } else if (target === undefined) {
    if (row === undefined && table === undefined) {
      throw new TypeError(
        "The routing table is not loaded: pass choice.table for a route without route.apiUrl.",
      );
    }
    const candidates =
      row === undefined && choice.allowSourcifyFallback === true ? fallback : listed;
    // Backends that verify the input's compiler kind come first. When none does, every entry
    // stays, and the flow refuses the input for the pick (decision 0057).
    const capable = candidates.filter((each) => choice.verifies?.(each.backend) !== false);
    const kinds = capable.length > 0 ? capable : candidates;
    // Then backends with a client. When none has one, the first entry stays, and the flow
    // throws `unsupported-chain` for it once the handle's backend has been checked.
    const served = kinds.filter((each) => choice.clients?.includes(each.backend) !== false);
    const pool = served.length > 0 ? served : kinds;
    const found =
      named === undefined
        ? (pool.find(
            (each) =>
              !(needsKey(each.backend) || each.needsKey === true) ||
              // `!== undefined`, not truthiness: with `handlerUrl`, `etherscan-v2` holds HANDLER_KEY,
              // the empty string, and must count as keyed (decision 0046).
              readOwn(keys, each.backend) !== undefined,
          ) ?? pool[0])
        : candidates.find((each) => each.backend === named);
    if (found === undefined) {
      // No row, or a row without the named backend. The Sourcify fallback serves only Sourcify,
      // so a named backend on a chain without a row gets the "no row" error.
      throw unsupported(chainId, named ?? "sourcify", row === undefined ? "row" : "listed");
    }
    ({ backend, apiUrl: apiBase } = found);
    entry = found;
    if (named !== undefined) {
      routedBy = "caller";
    } else if (row === undefined) {
      routedBy = "fallback";
    } else {
      routedBy = "table";
      // Each entry before the pick needs a key the call lacks. None when no entry was usable.
      skipped = pool.slice(0, pool.indexOf(found)).map((each) => each.backend);
    }
    tableHost = new URL(found.apiUrl).host;
  } else {
    ({ apiBase, search } = target);
    backend = named ?? "sourcify";
    routedBy = "api-url";
    entry = [...listed, ...fallback].find((each) => each.backend === backend);
    // Only an etherscan-v2 route on this host takes a key from apiKeys (decision 0053).
    tableHost = fixedHost(backend);
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
          // Stryker disable next-line ArrayDeclaration: equivalent. The message names only the field, so no secret can appear in it.
          [],
        );
      }
      return `${apiBase}${path}${query}`;
    },
    explorerUrl: entry?.apiUrl === apiBase ? entry.explorerUrl : undefined,
    apiKey: () => apiKey,
    overridden: target !== undefined,
    tableHost,
    needsKey: entry?.apiUrl === apiBase && entry.needsKey === true,
    routedBy,
    skipped,
  });
}

/**
 * The routing table's pick for a chain, as `verify()` would make it without `route`.
 *
 * @experimental
 */
export interface RoutePick {
  /** The backend `verify()` would use. */
  readonly backend: BackendName;
  /** `table` for the row's pick, `fallback` for the Sourcify fallback of a chain without a row. */
  readonly routedBy: RoutedBy;
  /** The backends listed before `backend` that were passed over: each needs a key and has none. */
  readonly skipped: readonly BackendName[];
  /**
   * `true` when `backend` needs an API key and none is set: every backend of the row needs one, so
   * `verify()` would throw `missing-api-key`.
   */
  readonly keyMissing: boolean;
}

/**
 * What `routesFor()` finds for a chain.
 *
 * @experimental
 */
export interface ChainRoutes {
  /** The backends the chain's row lists, in the row's order of preference. Empty without a row. */
  readonly listed: readonly BackendName[];
  /**
   * The routing table's pick, or the `unsupported-chain` error `verify()` would throw: the chain
   * has no row and `allowSourcifyFallback` is not set.
   */
  readonly pick: RoutePick | ExplorerVerifyError;
}

/** The options `routesFor()` reads: those of `CallOptions` that choose the route. */
export type RoutesForOptions = Pick<CallOptions, "apiKeys" | "allowSourcifyFallback">;

/**
 * `routesFor()` with the table loader passed in: the default entry passes the shipped one.
 * Internal: the package entry point exports `routesFor`.
 *
 * @param chainId - The EVM chain id.
 * @param options - As `routesFor` takes them.
 * @param load - Loads the routing table, once the options pass.
 * @returns The row's backends and the pick.
 * @throws As `routesFor` throws.
 * @example
 * ```ts
 * const routes = await routesWith(11155111, {}, loadRoutingTable);
 * ```
 */
export async function routesWith(
  chainId: number,
  options: RoutesForOptions,
  load: TableLoader,
): Promise<ChainRoutes> {
  const checked = checkRoute(chainId);
  // The keys first, so a getter on an unknown key never runs.
  const keys = ownKeys(options);
  const issues =
    keys === undefined
      ? [{ field: "options", message: "must be a plain object" }]
      : unknownKeys(
          keys,
          Object.keys({ apiKeys: true, allowSourcifyFallback: true } satisfies Record<
            keyof RoutesForOptions,
            true
          >),
          "",
          "options",
        );
  if (issues.length > 0) {
    throw invalid(issues, "The options are invalid", undefined, []);
  }
  const table = await load();
  const row = table.chains.find((each) => each.chainId === chainId);
  const listed = (row?.backends ?? []).flatMap((each) => tableTarget(chainId, each)?.backend ?? []);
  const apiKeys: CheckedKeys = Object.fromEntries(
    Object.entries(options.apiKeys ?? {}).filter(([, key]) => typeof key === "string"),
  );
  const allowSourcifyFallback = options.allowSourcifyFallback === true;
  if (row === undefined && !allowSourcifyFallback) {
    return { listed, pick: unsupported(chainId, "sourcify", "row") };
  }
  // With a row, or with the fallback, a route without `route.backend` always resolves.
  const route = routeFrom(chainId, checked, { table, apiKeys, allowSourcifyFallback });
  const { backend, routedBy, skipped } = route;
  const keyMissing =
    (needsKey(backend) || route.needsKey === true) && readOwn(apiKeys, backend) === undefined;
  return { listed, pick: { backend, routedBy, skipped, keyMissing } };
}

// References: decision 0052.
/**
 * `unsupported-chain` for a chain the routing table does not route: no row (`row`), a row that
 * does not list the backend the caller named (`listed`), or a row whose chosen backend has no
 * client in this version (`client`). The flow engine throws the last one when it opens the call;
 * through `explorer-verify/core`, it throws the error of `Missing.client` instead.
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
  return newError(
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
      // Stryker disable next-line ArrayDeclaration: equivalent. The message holds only the chain id and the backend name.
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
  return newError(
    { code: "invalid-input", issues },
    `${summary}: ${names}.`,
    // Stryker disable next-line ConditionalExpression: equivalent when always false. An undefined hint takes the catalogue's hint, as an absent one does.
    hint === undefined ? { secrets } : { hint, secrets },
  );
}
