/**
 * The check of `VerifyOptions.handlerUrl`, the caller's server handler, which adds the Etherscan
 * key (R-SRV-5, decision 0046), and the refusal of a key bound to a route through it. A call loads
 * this module with a dynamic `import()` only when `handlerUrl` is set, so a caller who never sets
 * it does not download it. Internal: the package entry point does not export it.
 */
import type { BackendName } from "../backend-names.ts";
import type { Answer } from "../backends/common.ts";
import { newError } from "../error-hints.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import type { Route } from "../routing/resolve.ts";
import type { ApiKeysReader } from "./api-keys.ts";

/** The longest `handlerUrl` accepted, in characters. */
const MAX_LENGTH = 2048;
// The hosts an absolute `http:` handler may be on: a server on the caller's own machine.
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
// Whitespace, Unicode spaces included, and a backslash. A URL parser drops or rewrites them, as it
// does C0 controls and DEL, so `/\t/evil.example` would become a URL on another host (R-SEC-2).
const SPACE_OR_BACKSLASH = /[\s\\]/u;
const SHAPE = "must be a path such as /api/verify, or a URL that starts with https://";

/**
 * The checked handler of a call: its absolute URL, the refusal of a key bound to it, and the
 * wording of the errors of its answers. It lives in this chunk, so a caller who never sets
 * `handlerUrl` does not download it.
 */
export interface ResolvedHandler {
  /** The absolute, normalised handler URL. */
  readonly url: string;
  /** Whether the requests of a route go to the handler; see {@link throughHandler}. */
  readonly serves: (route: Route) => boolean;
  /** The URL a request is sent to; see {@link sentUrl}. */
  readonly sentUrl: (url: string) => string;
  /** Throws `invalid-input`: a key is bound to a route through the handler. */
  readonly refuseKey: (secrets: readonly string[]) => never;
  /** The `unexpected-response` of an answer of the handler that the client does not read. */
  readonly unexpected: (
    backend: BackendName,
    answer: Answer,
    what: string,
    secrets: readonly string[],
  ) => ExplorerVerifyError<"unexpected-response">;
  /** `error` with the handler's refusal code in its message, when its excerpt holds one. */
  readonly annotate: (error: unknown, secrets: readonly string[]) => unknown;
}

// A refusal code of `createVerifyHandler`, such as `chain-not-allowed`.
const CODE = /^[a-z][a-z-]{0,39}$/;
const CODE_IN_TEXT = /"code":"([a-z][a-z-]{0,39})"/;
const CONFIG_HINT =
  "Your server handler refused the request: check its createVerifyHandler options, such as chains and deployers.";

/**
 * The `unexpected-response` of an answer of the handler. A 4xx refusal with the handler's `code`
 * holds until the handler's options change, so it is not retryable; a 408 and a 429 may pass
 * later, and a 5xx stays retryable.
 */
function unexpected(
  backend: BackendName,
  answer: Answer,
  what: string,
  secrets: readonly string[],
): ExplorerVerifyError<"unexpected-response"> {
  const raw = answer.fields?.get("code");
  const code = typeof raw === "string" && CODE.test(raw) ? raw : undefined;
  const { status } = answer;
  const config =
    code !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
  return newError(
    { code: "unexpected-response", backend, status, excerpt: answer.text },
    code === undefined
      ? `Your server handler gave an answer to ${what} that this client does not recognise (status ${String(status)}).`
      : `Your server handler refused ${what} with ${code} (status ${String(status)}).`,
    { secrets, ...(config ? { retryable: false, hint: CONFIG_HINT } : {}) },
  );
}

/** `error` with the handler's refusal code, such as `upstream-error` on a 502, in its message. */
function annotate(error: unknown, secrets: readonly string[]): unknown {
  if (!ExplorerVerifyError.is(error, "unexpected-response")) {
    return error;
  }
  const code = CODE_IN_TEXT.exec(error.details.excerpt)?.[1];
  return code === undefined
    ? error
    : newError(error.details, `${error.message} The handler's code: ${code}.`, {
        hint: error.hint,
        secrets,
        cause: error.cause,
      });
}

/** Whether `value` holds a C0 control, DEL, whitespace or a backslash. */
function unsafe(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return SPACE_OR_BACKSLASH.test(value);
}

/**
 * The URL of the page this code runs in, or `undefined` outside a browser page, or when reading
 * `location` throws. A path such as `/api/verify` resolves against it.
 */
function pageUrl(): string | undefined {
  try {
    const location: unknown = Reflect.get(globalThis, "location");
    const href: unknown =
      typeof location === "object" && location !== null ? Reflect.get(location, "href") : undefined;
    return typeof href === "string" ? href : undefined;
  } catch {
    // A getter that throws: its error is dropped, and the path is refused as outside a page.
    return undefined;
  }
}

/**
 * Checks a `handlerUrl` string and returns it as an absolute URL.
 *
 * - A path on the page's origin, such as `/api/verify`, resolves against the page, with the
 *   page's scheme. Outside a browser page there is none, so a path is refused.
 * - An absolute URL starts with `https://`, or `http://` on `localhost`, `127.0.0.1` or `[::1]`.
 * - No user name, password, query, fragment, control character, whitespace or backslash, and not
 *   on Etherscan's API host, whatever its port or trailing dot.
 *
 * @param value - The caller's string.
 * @param etherscan - Etherscan's API origin, which the handler URL must not be on.
 * @returns The normalised absolute URL, or what is wrong with the value.
 * @example
 * ```ts
 * checkHandlerUrl("https://verify.example/api", "https://api.etherscan.io"); // { url: ... }
 * ```
 */
export function checkHandlerUrl(
  value: string,
  etherscan: string,
): { readonly url: string } | string {
  if (value.length > MAX_LENGTH) {
    return `must be at most ${String(MAX_LENGTH)} characters`;
  }
  if (unsafe(value)) {
    return "must not contain whitespace, a control character or a backslash";
  }
  if (value.includes("?") || value.includes("#")) {
    return "must not contain a query or a fragment";
  }
  let base: string | undefined;
  if (value.startsWith("/")) {
    if (value.startsWith("//")) {
      return SHAPE;
    }
    base = pageUrl();
    if (base === undefined) {
      return "is a path, which needs a browser page: pass an absolute URL";
    }
  } else if (!/^https?:\/\//i.test(value)) {
    return SHAPE;
  }
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return SHAPE;
  }
  const scheme = url.protocol;
  const local = scheme === "http:" && LOOPBACK.includes(url.hostname);
  // A path takes the page's scheme, which may be http on a development server.
  if (!(scheme === "https:" || local || (base !== undefined && scheme === "http:"))) {
    return "must use https, or http on localhost, 127.0.0.1 or [::1]";
  }
  if (url.username !== "" || url.password !== "") {
    return "must not contain a user name or password";
  }
  if (url.hostname.replace(/\.+$/, "") === new URL(etherscan).hostname) {
    return "must be your server handler, not Etherscan's API";
  }
  return { url: url.href };
}

/**
 * Throws `invalid-input` naming `route.apiKey`: a key is bound to a route whose requests go to
 * the caller's server handler, and it would reach the handler, which adds its own. Every flow
 * calls it before any request, a dry run included, when `keyFor` finds such a key.
 *
 * @param secrets - The call's keys, removed from the error.
 * @throws ExplorerVerifyError `invalid-input`, always.
 * @example
 * ```ts
 * refuseHandlerKey(secrets);
 * ```
 */
export function refuseHandlerKey(secrets: readonly string[]): never {
  throw newError(
    {
      code: "invalid-input",
      issues: [{ field: "route.apiKey", message: "must not be set with handlerUrl" }],
    },
    "The options are invalid: route.apiKey.",
    { hint: "Leave the Etherscan key out: your server handler adds it.", secrets },
  );
}

/**
 * Checks `handlerUrl` for a call, and refuses an Etherscan key in `apiKeys` next to it: the
 * server handler adds its own key, and one in the options would reach the handler.
 *
 * @param options - The call's options: `handlerUrl`, the checked keys, and every key value,
 *   removed from the error.
 * @param etherscanApi - Etherscan's API URL, passed in so that this chunk does not import the
 *   routing module.
 * @returns The absolute URL and the handler's code.
 * @throws ExplorerVerifyError `invalid-input` naming `handlerUrl` or `apiKeys.etherscan-v2`,
 *   without the value.
 * @example
 * ```ts
 * const handler = resolveHandler(settings, ETHERSCAN_API_URL);
 * ```
 */
export function resolveHandler(
  options: {
    readonly handlerUrl?: unknown;
    readonly apiKeys: ApiKeysReader;
    readonly keySecrets: () => readonly string[];
  },
  etherscanApi: string,
): ResolvedHandler {
  const value = options.handlerUrl;
  const secrets = options.keySecrets();
  const etherscan = new URL(etherscanApi).origin;
  const checked =
    typeof value === "string" ? checkHandlerUrl(value, etherscan) : "must be a string";
  const issues: InputIssue[] = [];
  if (typeof checked === "string") {
    issues.push({ field: "handlerUrl", message: checked });
  }
  if (options.apiKeys()["etherscan-v2"] !== undefined) {
    issues.push({ field: "apiKeys.etherscan-v2", message: "must not be set with handlerUrl" });
  }
  if (typeof checked === "string" || issues.length > 0) {
    throw newError(
      { code: "invalid-input", issues },
      `The options are invalid: ${issues.map((issue) => issue.field).join(", ")}.`,
      {
        hint: "Pass handlerUrl as /api/verify in a browser page, or as an https:// URL, and leave the Etherscan key to your server handler.",
        secrets,
      },
    );
  }
  const { url } = checked;
  return {
    url,
    serves: (route) => throughHandler(route, url, etherscan),
    sentUrl: (request) => sentUrl(request, url, etherscan),
    refuseKey: refuseHandlerKey,
    unexpected,
    annotate,
  };
}

/**
 * Whether the requests of `route` go to the handler: a checked `handlerUrl` is set, the route's
 * backend is `etherscan-v2` and its API is Etherscan's own. A route that moves `apiUrl` to another
 * host keeps its host and its own key rules.
 *
 * @param route - The call's route.
 * @param handlerUrl - The checked handler URL, or `undefined`.
 * @param etherscan - Etherscan's API origin, from the routing module.
 * @returns `true` when the handler adds the key for this route.
 * @example
 * ```ts
 * throughHandler(resolveRoute(1, { backend: "etherscan-v2" }), "https://dapp.example/api", origin);
 * ```
 */
export function throughHandler(
  route: Route,
  handlerUrl: string | undefined,
  etherscan: string,
): boolean {
  return (
    handlerUrl !== undefined &&
    route.backend === "etherscan-v2" &&
    new URL(route.apiBase).origin === etherscan
  );
}

/**
 * The URL a request is sent to: `handlerUrl` with the request's query when the request goes to
 * Etherscan's API, and `url` itself otherwise. The HTTP layer sends to it and names it in log
 * lines and errors.
 *
 * @param url - The request URL, as the client built it.
 * @param handlerUrl - The checked handler URL of a route that goes through the handler, or
 *   `undefined`.
 * @param etherscan - Etherscan's API origin, from the routing module.
 * @returns The URL to send to.
 * @example
 * ```ts
 * sentUrl("https://api.etherscan.io/v2/api?chainid=1", "https://dapp.example/api/verify", origin);
 * // "https://dapp.example/api/verify?chainid=1"
 * ```
 */
export function sentUrl(url: string, handlerUrl: string | undefined, etherscan: string): string {
  if (handlerUrl === undefined || !url.startsWith(`${etherscan}/`)) {
    return url;
  }
  const query = url.indexOf("?");
  return query < 0 ? handlerUrl : `${handlerUrl}${url.slice(query)}`;
}
