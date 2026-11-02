/**
 * Chain id to backend, API URL and explorer URL (R-RT). In this release every chain goes to
 * Sourcify, and a caller can point at another Sourcify server with `VerifyOptions.route`. The
 * routing table with per-chain data, `routing/table.json`, replaces the default in M2 (R-RT-1).
 */
import { toBackendName } from "../backend-names.ts";
import type { BackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import type { Hex, RouteOverride } from "../types.ts";

/**
 * Where one call sends its requests, and where a person sees the verified contract.
 *
 * @example
 * ```ts
 * const route: Route = resolveRoute(11155111);
 * route.apiUrl; // "https://sourcify.dev/server"
 * ```
 */
export interface Route {
  /** The backend that handles the call. */
  readonly backend: BackendName;
  /**
   * The API base URL, with no trailing slash. It keeps the caller's query string, which may hold
   * a key, so it is for requests only: never log it or put it in an error.
   */
  readonly apiUrl: string;
  /** `apiUrl` with the query string replaced by `?REDACTED`. Safe to log (R-SEC-1). */
  readonly redactedApiUrl: string;
  /** The page that shows a verified contract. */
  readonly explorerUrl: (chainId: number, address: Hex) => string;
}

/**
 * The public Sourcify API, the default for every chain in this release.
 *
 * @example
 * ```ts
 * new URL(`${SOURCIFY_API_URL}/v2/contract/1/0x5FbDB2315678afecb367f032d93F642f64180aa3`);
 * ```
 */
export const SOURCIFY_API_URL = "https://sourcify.dev/server";

const SOURCIFY_REPO_URL = "https://repo.sourcify.dev";
// Hostnames as `URL` reports them: lowercase, IPv4 normalised, IPv6 compressed in brackets.
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];
const SUPPORTED_BACKEND: BackendName = "sourcify";

const SCHEME_MESSAGE = "must use https, or http on localhost, 127.0.0.1 or [::1]";
const BACKEND_MESSAGE = "must be sourcify; only sourcify is available in this version";
const BACKEND_HINT = "Only sourcify is available in this version. Remove route.backend.";
const API_URL_HINT =
  "Pass an absolute https URL, or an http URL on localhost, 127.0.0.1 or [::1], with no user name, password or fragment.";

function sourcifyExplorerUrl(chainId: number, address: Hex): string {
  return `${SOURCIFY_REPO_URL}/${String(chainId)}/${encodeURIComponent(address)}`;
}

/** The two override fields, or `undefined` when `value` is not an object whose fields can be read. */
function readOverride(value: unknown): { backend: unknown; apiUrl: unknown } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    if (Array.isArray(value)) {
      return undefined;
    }
    return { backend: Reflect.get(value, "backend"), apiUrl: Reflect.get(value, "apiUrl") };
  } catch {
    // A Proxy whose traps throw. The raw error is dropped: it may repeat a caller value.
    return undefined;
  }
}

/**
 * Checks an override API URL. Returns the request URL and its log form, or the issue message.
 * The `URL` parse error is dropped, never kept as a cause, because it carries the input.
 */
function checkApiUrl(value: unknown): { apiUrl: string; redactedApiUrl: string } | string {
  if (typeof value !== "string") {
    return "must be a string";
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
  const base = `${url.origin}${path}`;
  return {
    apiUrl: `${base}${url.search}`,
    redactedApiUrl: url.search === "" ? base : `${base}?REDACTED`,
  };
}

/**
 * Resolves where a call for `chainId` goes. In this release every chain resolves to Sourcify at
 * {@link SOURCIFY_API_URL}; `override` can name another Sourcify server, such as a self-hosted one
 * or a local fake in tests (R-RT-2). Hosts come only from here, never from a handle (R-SEC-2).
 *
 * `override.apiUrl` must be an absolute `https:` URL, or an `http:` URL on `localhost`,
 * `127.0.0.1` or `[::1]`. It must not hold a user name, a password or a fragment. Trailing slashes
 * of the path are removed. A query string is kept for requests and redacted in `redactedApiUrl`.
 * Error messages name the field and never repeat the value, which may hold a key.
 *
 * @param chainId - The EVM chain id, a positive safe integer.
 * @param override - The caller's `VerifyOptions.route`, if any. Fields other than `backend` and
 *   `apiUrl` are ignored.
 * @returns A frozen plain object. Later changes to `override` do not affect it.
 * @throws ExplorerVerifyError with code `invalid-input`, listing `chainId`, `route`,
 *   `route.backend` or `route.apiUrl` in `details.issues`.
 * @example
 * ```ts
 * const route = resolveRoute(31337, { apiUrl: "http://127.0.0.1:5555/" });
 * route.backend; // "sourcify"
 * route.apiUrl; // "http://127.0.0.1:5555"
 * route.explorerUrl(31337, "0x5FbDB2315678afecb367f032d93F642f64180aa3");
 * // "https://repo.sourcify.dev/31337/0x5FbDB2315678afecb367f032d93F642f64180aa3"
 * ```
 */
export function resolveRoute(chainId: number, override?: RouteOverride): Route {
  const issues: InputIssue[] = [];
  let hint: string | undefined;
  if (!(Number.isSafeInteger(chainId) && chainId > 0)) {
    issues.push({ field: "chainId", message: "must be a positive integer" });
  }

  let backend: BackendName = SUPPORTED_BACKEND;
  let urls = { apiUrl: SOURCIFY_API_URL, redactedApiUrl: SOURCIFY_API_URL };
  const raw: unknown = override;
  if (raw !== undefined) {
    const fields = readOverride(raw);
    if (fields === undefined) {
      issues.push({ field: "route", message: "must be a plain object" });
    } else {
      if (fields.backend !== undefined) {
        const named =
          typeof fields.backend === "string" ? toBackendName(fields.backend) : undefined;
        if (named === undefined) {
          issues.push({ field: "route.backend", message: "must name a known backend" });
        } else if (named === SUPPORTED_BACKEND) {
          backend = named;
        } else {
          issues.push({ field: "route.backend", message: BACKEND_MESSAGE });
          hint = BACKEND_HINT;
        }
      }
      if (fields.apiUrl !== undefined) {
        const checked = checkApiUrl(fields.apiUrl);
        if (typeof checked === "string") {
          issues.push({ field: "route.apiUrl", message: checked });
          hint ??= API_URL_HINT;
        } else {
          urls = checked;
        }
      }
    }
  }

  if (issues.length > 0) {
    const names = issues.map((issue) => issue.field).join(", ");
    throw new ExplorerVerifyError(
      { code: "invalid-input", issues },
      `The route is invalid: ${names}.`,
      hint === undefined ? {} : { hint },
    );
  }
  return Object.freeze({
    backend,
    apiUrl: urls.apiUrl,
    redactedApiUrl: urls.redactedApiUrl,
    explorerUrl: sourcifyExplorerUrl,
  });
}
