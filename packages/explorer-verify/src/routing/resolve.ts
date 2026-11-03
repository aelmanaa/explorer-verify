/**
 * Chain id to backend, API URL and explorer URL (R-RT). In this release every chain goes to
 * Sourcify, and a caller can point at another Sourcify server with `VerifyOptions.route`. The
 * routing table with per-chain data, `routing/table.json`, replaces the default in M2 (R-RT-1).
 */
import { toBackendName } from "../backend-names.ts";
import type { BackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import { readChainId, readOwn } from "../internal/read-fields.ts";
import type { Hex, RouteOverride } from "../types.ts";

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
   * URLs with {@link Route.requestUrl}, not by appending to this, so the caller's query is kept.
   */
  readonly apiBase: string;
  /**
   * `apiBase`, followed by `?REDACTED` when the caller's URL had a query string. Only the query
   * is redacted: the host and path appear as given, so a key must never be put in them. Put a
   * key in the query string, or in the per-backend key option planned for a later release.
   */
  readonly redactedApiUrl: string;
  /**
   * The full URL of one API endpoint: `apiBase`, then `path`, then the caller's query string.
   * The result can hold a key from that query, so it is for requests only.
   *
   * @throws ExplorerVerifyError with code `invalid-input` when `path` does not start with `/` or
   *   contains `?` or `#`.
   */
  readonly requestUrl: (path: string) => string;
  /**
   * The page that shows a verified contract, for the chain id and address of the call.
   * `undefined` when the override moved the API to another server: repo.sourcify.dev shows only
   * contracts verified on the public Sourcify server.
   */
  readonly explorerUrl: ((chainId: number, address: Hex) => string) | undefined;
}

/**
 * The public Sourcify API base, the default for every chain in this release.
 *
 * @example
 * ```ts
 * const route = resolveRoute(1);
 * route.apiBase === SOURCIFY_API_URL; // true
 * route.requestUrl("/v2/contract/1/0x5FbDB2315678afecb367f032d93F642f64180aa3");
 * ```
 */
export const SOURCIFY_API_URL = "https://sourcify.dev/server";

const SOURCIFY_REPO_URL = "https://repo.sourcify.dev";
// Hostnames as `URL` reports them: lowercase, IPv4 normalised, IPv6 compressed in brackets.
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];
const SUPPORTED_BACKEND: BackendName = "sourcify";
const MAX_API_URL_LENGTH = 8192;

const SCHEME_MESSAGE = "must use https, or http on localhost, 127.0.0.1 or [::1]";
const BACKEND_MESSAGE = "must be sourcify; only sourcify is available in this version";
const BACKEND_HINT = "Only sourcify is available in this version. Remove route.backend.";
const ROUTE_HINT = "Pass route as a plain object with backend and apiUrl fields, or leave it out.";
const API_URL_HINT =
  "Pass an absolute https URL, or an http URL on localhost, 127.0.0.1 or [::1], with no user name, password or fragment.";

function sourcifyExplorerUrl(chainId: number, address: Hex): string {
  return `${SOURCIFY_REPO_URL}/${String(chainId)}/${encodeURIComponent(address)}`;
}

/**
 * The two override fields, or `undefined` when `value` is not a plain object (prototype
 * `Object.prototype` or `null`) whose fields can be read. Each field is read once.
 */
function readOverride(value: unknown): { backend: unknown; apiUrl: unknown } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    const fields: { readonly backend?: unknown; readonly apiUrl?: unknown } = value;
    return { backend: readOwn(fields, "backend"), apiUrl: readOwn(fields, "apiUrl") };
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
 * Resolves where a call for `chainId` goes. In this release every chain resolves to Sourcify at
 * {@link SOURCIFY_API_URL}; `override` can name another Sourcify server, such as a self-hosted one
 * or a local fake in tests (R-RT-2). Hosts come only from here, never from a handle (R-SEC-2).
 *
 * `override` must be a plain object: its prototype is `Object.prototype` or `null`. Only its own
 * `backend` and `apiUrl` properties are read, each once; inherited ones are ignored, and so are
 * other fields.
 *
 * `override.apiUrl` must be a primitive string of at most 8192 characters that parses as an
 * absolute `https:` URL, or an `http:` URL whose hostname is exactly `localhost`, `127.0.0.1` or
 * `[::1]`. On Node, `localhost` resolves through the system resolver, so the hosts file decides
 * where it points. The URL must not hold a user name, a password or a fragment. Trailing slashes
 * of the path are removed. A query string is kept for requests and redacted in `redactedApiUrl`.
 * Error messages name the field and never repeat the value, which may hold a key.
 *
 * @param chainId - The EVM chain id, a positive safe integer.
 * @param override - The caller's `VerifyOptions.route`, if any.
 * @returns A frozen plain object. Later changes to `override` do not affect it.
 * @throws ExplorerVerifyError with code `invalid-input`, listing `chainId`, `route`,
 *   `route.backend` or `route.apiUrl` in `details.issues`.
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
export function resolveRoute(chainId: number, override?: RouteOverride): Route {
  const issues: InputIssue[] = [];
  let hint: string | undefined;
  if (readChainId(chainId) === undefined) {
    issues.push({ field: "chainId", message: "must be a positive integer" });
  }

  let backend: BackendName = SUPPORTED_BACKEND;
  let target = { apiBase: SOURCIFY_API_URL, search: "" };
  const raw: unknown = override;
  if (raw !== undefined) {
    const fields = readOverride(raw);
    if (fields === undefined) {
      issues.push({ field: "route", message: "must be a plain object" });
      hint = ROUTE_HINT;
    } else {
      if (fields.backend !== undefined) {
        const named =
          typeof fields.backend === "string" ? toBackendName(fields.backend) : undefined;
        if (named === SUPPORTED_BACKEND) {
          backend = named;
        } else {
          issues.push({
            field: "route.backend",
            message: named === undefined ? "must name a known backend" : BACKEND_MESSAGE,
          });
          hint = BACKEND_HINT;
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
    }
  }

  if (issues.length > 0) {
    throw invalid(issues, "The route is invalid", hint);
  }
  const { apiBase, search } = target;
  return Object.freeze({
    backend,
    apiBase,
    redactedApiUrl: search === "" ? apiBase : `${apiBase}?REDACTED`,
    requestUrl: (path: string): string => {
      if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
        throw invalid(
          [{ field: "path", message: "must start with / and contain no ? or #" }],
          "The request path is invalid",
          undefined,
        );
      }
      return `${apiBase}${path}${search}`;
    },
    explorerUrl: apiBase === SOURCIFY_API_URL ? sourcifyExplorerUrl : undefined,
  });
}

function invalid(
  issues: InputIssue[],
  summary: string,
  hint: string | undefined,
): ExplorerVerifyError {
  const names = issues.map((issue) => issue.field).join(", ");
  return new ExplorerVerifyError(
    { code: "invalid-input", issues },
    `${summary}: ${names}.`,
    hint === undefined ? { secrets: [] } : { hint, secrets: [] },
  );
}
