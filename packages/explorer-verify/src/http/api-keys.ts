// References: R-SEC-1, R-SEC-2, decision 0016.
/**
 * API keys: which ones the caller may pass, which request gets one, where in the request it goes,
 * and what an explorer's answer about a key means. Every keyed
 * client sends its requests through {@link withKey}, so one rule decides where a key may go.
 * Internal: the package entry point does not export it.
 */
import type { BackendName, KeyedBackendName } from "../backend-names.ts";
import { BACKEND_LABELS, toBackendName } from "../backend-names.ts";
import { newError } from "../error-hints.ts";
import type { ExplorerVerifyError, InputIssue } from "../errors.ts";
import { readFields, readOwn } from "../internal/read-fields.ts";
import { MIN_SECRET_LENGTH } from "../redact.ts";
import type { Route } from "../routing/resolve.ts";
import type { HttpRequest } from "./fetch.ts";

/** The caller's keys by backend, as `VerifyOptions.apiKeys` holds them once checked. */
export type CheckedKeys = Readonly<Partial<Record<BackendName, string>>>;

/**
 * Returns the checked keys. A function, not the keys themselves, so `JSON.stringify` of a context
 * or of the settings never prints a key.
 */
export type ApiKeysReader = () => CheckedKeys;

/** The longest key accepted, in characters. */
export const MAX_KEY_LENGTH = 1024;

// References: decision 0041.
/**
 * The host of Blockscout's hosted multichain API, the backend `blockscout-hosted`.
 *
 * @example
 * ```ts
 * `https://${HOSTED_BLOCKSCOUT_HOST}/11155111/api`; // the hosted route for Sepolia
 * ```
 */
export const HOSTED_BLOCKSCOUT_HOST = "api.blockscout.com";

// Each keyed backend once: a name missing here, or one that is not keyed, fails to compile.
const KEYED: { readonly [B in KeyedBackendName]: B } = {
  "etherscan-v2": "etherscan-v2",
  routescan: "routescan",
  "blockscout-hosted": "blockscout-hosted",
};

// References: decisions 0016, 0041 and 0046.
/**
 * The backends that take a key from `VerifyOptions.apiKeys`, built from {@link KeyedBackendName}.
 * The public type does not refer to this list.
 *
 * @example
 * ```ts
 * KEYED_BACKEND_NAMES.includes("routescan"); // true
 * ```
 */
export const KEYED_BACKEND_NAMES: readonly KeyedBackendName[] = Object.values(KEYED);

// Backends that take a key from `apiKeys`. Each key goes only to its backend's one API host.
const KEY_BACKENDS: readonly BackendName[] = KEYED_BACKEND_NAMES;
// Backends whose every request needs a key. Routescan has a keyless free tier; a standalone
// explorer may or may not need one, so only its answer can tell.
const KEY_REQUIRED: readonly BackendName[] = ["etherscan-v2", "blockscout-hosted"];

/**
 * Whether every request of `backend` needs a key. Only `etherscan-v2` and `blockscout-hosted` do:
 * Routescan has a keyless tier, and only a standalone explorer's answer can tell whether it needs
 * one.
 *
 * @param backend - A backend name.
 * @returns `true` for `etherscan-v2` and `blockscout-hosted`.
 * @example
 * ```ts
 * needsKey("etherscan-v2"); // true
 * needsKey("routescan"); // false
 * ```
 */
export function needsKey(backend: BackendName): boolean {
  return KEY_REQUIRED.includes(backend);
}

// Backends that take `route.apiKey`.
const ROUTE_KEY_BACKENDS: readonly BackendName[] = [
  "etherscan-v2",
  "etherscan-compatible",
  "routescan",
  "blockscout-hosted",
];
// The RFC 3986 unreserved characters. A key with any other character could reach an explorer's
// answer in an escaped form, such as an HTML entity or `\/` in JSON, that redaction does not
// match (R-SEC-1). Etherscan keys are letters and digits, and UUID-style keys fit.
const ALLOWED = /^[A-Za-z0-9._~-]+$/;
const ALLOWED_MESSAGE = "must hold only letters, digits, '.', '_', '~' and '-'";
// Etherscan's daily limit answers, lower-cased: `Max daily rate limit reached. 100000 (100%) of
// 100000 day/limit` and `Daily limit of 500 source code submissions reached` (live, 2026-11-02).
const DAILY_LIMIT = /\bdaily\b[^]{0,64}\blimit\b/;
// Etherscan's answer for a free-plan key on a chain its chainlist marks "Paid Plan required":
// `Free API access is not supported for this chain. Please upgrade your api plan for full chain
// coverage.` (live, 2026-11-04, to `account` calls on chain 8453). Lower-cased.
const PAID_PLAN = "free api access is not supported for this chain";
const PAID_PLAN_HINT =
  'This chain needs a paid Etherscan API plan. Use a key on a paid plan, or verify on Sourcify, which needs no key: set route: { backend: "sourcify" }.';
const ISSUES_URL = "https://github.com/aelmanaa/explorer-verify/issues";

/**
 * Checks one key value. Returns the key, or the issue message, which never repeats the value.
 *
 * @param value - The caller's value.
 * @returns `{ key }` for a valid key, or what is wrong with it.
 * @example
 * ```ts
 * checkKey("ABCDEFGH12345678"); // { key: "ABCDEFGH12345678" }
 * checkKey("short"); // "must be at least 8 characters"
 * ```
 */
export function checkKey(value: unknown): { key: string } | string {
  if (typeof value !== "string") {
    return "must be a string";
  }
  if (value.length < MIN_SECRET_LENGTH) {
    // A shorter value would not be redacted (R-SEC-1).
    return `must be at least ${String(MIN_SECRET_LENGTH)} characters`;
  }
  if (value.length > MAX_KEY_LENGTH) {
    return `must be at most ${String(MAX_KEY_LENGTH)} characters`;
  }
  if (!ALLOWED.test(value)) {
    return ALLOWED_MESSAGE;
  }
  if (/^\d+$/.test(value)) {
    // Redaction would hide numbers such as a chain id.
    return "must not be all digits";
  }
  return { key: value };
}

/**
 * Checks `route.apiKey` for a route of `backend`. Only `etherscan-v2`, `etherscan-compatible` and
 * `routescan` take one, and only when the key has a host to be bound to: `route.apiUrl`, or for
 * `route.backend` `etherscan-compatible`, the standalone host the chain's row lists (decision
 * 0039). Otherwise a key could reach a host it was not meant for. The issue message never repeats
 * the value.
 *
 * @param backend - The route's backend.
 * @param value - The caller's `route.apiKey`.
 * @param hasApiUrl - Whether the key has a host: the override sets `apiUrl`, or names
 *   `etherscan-compatible`.
 * @returns `{}` when `value` is `undefined`, `{ key }` for a valid key, or `{ issue }`.
 * @example
 * ```ts
 * checkRouteKey("etherscan-compatible", "ABCDEFGH12345678", true); // { key: "ABCDEFGH12345678" }
 * checkRouteKey("sourcify", "ABCDEFGH12345678", true); // { issue: "is not accepted: ..." }
 * ```
 */
export function checkRouteKey(
  backend: BackendName,
  value: unknown,
  hasApiUrl: boolean,
): { readonly key?: string; readonly issue?: string } {
  if (value === undefined) {
    return {};
  }
  const checked = checkKey(value);
  if (typeof checked === "string") {
    return { issue: checked };
  }
  if (!hasApiUrl) {
    return { issue: "needs route.apiUrl: the key is sent only to that host" };
  }
  if (!ROUTE_KEY_BACKENDS.includes(backend)) {
    return { issue: `is not accepted: ${backend} takes no API key` };
  }
  return { key: checked.key };
}

/**
 * Finds keys that would hide public text of the call when redacted: a key found, in any case, in
 * the handle's fixed part `ev1:<backend>:<chainId>:<address>`. Redacting such a key would corrupt
 * the address in events and the handle, and show where the key sits.
 *
 * @param keys - Each key with the field it came from, such as `apiKeys.etherscan-v2`.
 * @param visible - The handle's fixed part.
 * @returns One issue per colliding key.
 * @example
 * ```ts
 * collisions([["apiKeys.routescan", "8275d36f"]], "ev1:sourcify:1:0x8275d36f...");
 * ```
 */
export function collisions(
  keys: readonly (readonly [field: string, key: string])[],
  visible: string,
): InputIssue[] {
  const text = visible.toLowerCase();
  return keys
    .filter(([, key]) => text.includes(key.toLowerCase()))
    .map(([field]) => ({
      field,
      message: "must not appear in the contract address or the handle",
    }));
}

/** What {@link readApiKeys} found. */
export interface ReadKeys {
  /** The valid keys. */
  readonly keys: CheckedKeys;
  /** One issue per bad entry, naming `apiKeys` or `apiKeys.<backend>`. */
  readonly issues: InputIssue[];
  /** Every string value found, valid or not, for redaction. */
  readonly secrets: string[];
}

// References: decision 0041.
/**
 * Reads and checks `VerifyOptions.apiKeys`. Only own enumerable string-keyed properties are read,
 * each once, and only from a plain object (prototype `Object.prototype` or `null`). A
 * non-enumerable property and a Symbol key are ignored.
 *
 * - `etherscan-v2`, `routescan` and `blockscout-hosted` take a key.
 *   `etherscan-compatible` is refused: each standalone explorer has its own host, so its key goes
 *   in `route.apiKey`. `sourcify` and `blockscout`, whose instances need none, take no key.
 * - A name that is not a backend is counted, never named: the name could be a key.
 * - An `undefined` value counts as absent.
 *
 * @param value - The caller's `apiKeys`.
 * @returns The valid keys, the issues and every string value seen.
 * @example
 * ```ts
 * const { keys, issues } = readApiKeys({ "etherscan-v2": "ABCDEFGH12345678" });
 * ```
 */
export function readApiKeys(value: unknown): ReadKeys {
  const keys: Partial<Record<BackendName, string>> = {};
  const issues: InputIssue[] = [];
  const secrets: string[] = [];
  if (value === undefined) {
    return { keys, issues, secrets };
  }
  const entries = plainEntries(value);
  if (entries === undefined) {
    issues.push({ field: "apiKeys", message: "must be a plain object" });
    return { keys, issues, secrets };
  }
  let unknown = 0;
  for (const [name, entry] of entries) {
    if (typeof entry === "string") {
      secrets.push(entry);
    }
    const backend = toBackendName(name);
    if (backend === undefined) {
      unknown += 1;
      continue;
    }
    if (entry === undefined) {
      continue;
    }
    const field = `apiKeys.${backend}`;
    const refused = refusal(backend);
    if (refused !== undefined) {
      issues.push({ field, message: refused });
      continue;
    }
    const checked = checkKey(entry);
    if (typeof checked === "string") {
      issues.push({ field, message: checked });
    } else {
      keys[backend] = checked.key;
    }
  }
  if (unknown > 0) {
    issues.unshift({
      field: "apiKeys",
      message: `has ${String(unknown)} ${unknown === 1 ? "field that is not a backend name" : "fields that are not backend names"}`,
    });
  }
  return { keys, issues, secrets };
}

/** Why `apiKeys` refuses a key for `backend`, or `undefined` when it takes one. */
function refusal(backend: BackendName): string | undefined {
  if (KEY_BACKENDS.includes(backend)) {
    return undefined;
  }
  if (backend === "etherscan-compatible") {
    return "is not accepted: pass a standalone explorer's key as route.apiKey with its apiUrl";
  }
  return `is not accepted: ${backend} takes no API key in this version`;
}

/**
 * The own enumerable entries of a plain object, each value read once, or `undefined` when `value`
 * is not a plain object or cannot be read. The thrown error is dropped: it may repeat a value.
 */
function plainEntries(value: unknown): [string, unknown][] | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    return Object.entries(value);
  } catch {
    return undefined;
  }
}

/**
 * What decides whether a request gets a key: the call's route and the caller's keys.
 *
 * @example
 * ```ts
 * const keyed: KeyContext = { route: resolveRoute(1), apiKeys: () => ({ "etherscan-v2": key }) };
 * ```
 */
export interface KeyContext {
  /** The call's route, resolved from the routing table and `VerifyOptions.route`. */
  readonly route: Route;
  /** Returns the caller's checked keys. Absent means none. */
  readonly apiKeys?: ApiKeysReader;
}

// References: R-SEC-2, decision 0053.
/**
 * The key a request may carry, or `undefined`. This is the one rule for every client.
 * A key is returned only when all of these hold:
 *
 * - `backend`, the backend the request is for, equals the route's backend. For a status poll it is
 *   the handle's backend, so a handle that names another backend never gets a key.
 * - `url` has the origin of the route's API base, so a request never carries a key off the route.
 * - The key is `route.apiKey`, which is bound to the route's host; or it is `apiKeys[backend]`
 *   and `url` is `https://` on the route's `tableHost`, the host the routing table lists for the
 *   backend and chain (`api.blockscout.com` for `blockscout-hosted`), on the default port, with a
 *   trailing dot on the host ignored. The route must not be `overridden`, except for
 *   `etherscan-v2`: a `route.apiUrl` on Etherscan's own API host takes `apiKeys["etherscan-v2"]`,
 *   because the key still goes only to that host. Any other route whose `apiUrl`
 *   the caller set gets no key from `apiKeys`.
 *
 * @param ctx - The route and the caller's keys.
 * @param backend - The backend the request is for.
 * @param url - The request URL.
 * @returns The key to attach, or `undefined`.
 * @example
 * ```ts
 * keyFor(ctx, "etherscan-v2", "https://api.etherscan.io/v2/api?chainid=1"); // the key
 * keyFor(ctx, "etherscan-v2", "https://attacker.example/v2/api?chainid=1"); // undefined
 * ```
 */
export function keyFor(ctx: KeyContext, backend: BackendName, url: string): string | undefined {
  const { route } = ctx;
  if (backend !== route.backend) {
    return undefined;
  }
  const origin = originOf(url);
  if (origin === undefined || origin !== originOf(route.apiBase)) {
    return undefined;
  }
  const routeKey = route.apiKey();
  if (routeKey !== undefined) {
    return routeKey;
  }
  const key = ctx.apiKeys === undefined ? undefined : readOwn(ctx.apiKeys(), backend);
  return onTableHost(route, origin) ? key : undefined;
}

// References: decision 0053.
/**
 * Whether `origin`, the origin of a request on `route`, may carry a key from `apiKeys`: it is
 * `https://` on the route's `tableHost` on the default port, a trailing dot on the host ignored,
 * and the route is the table's, or an `etherscan-v2` route whose `apiUrl` is Etherscan's own API.
 * `URL` has already lower-cased the host and dropped `:443`.
 */
function onTableHost(route: Route, origin: string): boolean {
  const { overridden, tableHost } = route;
  return (
    (!overridden || route.backend === "etherscan-v2") &&
    tableHost !== undefined &&
    origin.replace(/\.+$/, "") === `https://${tableHost}`
  );
}

/** The origin of `url`, or `undefined` when it does not parse. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

// References: R-SEC-1.
/**
 * `req` with the key {@link keyFor} allows, placed where the explorer reads it and never in the
 * URL:
 *
 * - `etherscan-v2` and `etherscan-compatible`: the `apikey` field of the form body. The request
 *   must be a `POST` with a `URLSearchParams` body, `chainid` in the query. Etherscan ignores a key
 *   in a header (live, 2026-11-03).
 * - `routescan`: the `apikey` request header, as Routescan's docs show. Not confirmed live: a
 *   made-up key in the header was answered without a refusal (2026-11-03).
 * - `blockscout-hosted`: the `authorization` request header, as `Bearer <key>`, for every request
 * to the
 *   hosted API: the REST lookup is a GET, so a form body cannot hold it (live, 2026-11-05).
 *
 * Without a key, `req` is returned unchanged. The caller adds the key to the call's secrets; the
 * flow engine does so for every key in `apiKeys` and `route.apiKey`.
 *
 * @param ctx - The route and the caller's keys.
 * @param backend - The backend the request is for: the client's own, or the handle's for a poll.
 * @param req - The request without a key.
 * @returns A new request with the key, or `req`.
 * @throws Error, not an `ExplorerVerifyError`, when an Etherscan-style request that gets a key is
 *   not a `POST` with a `URLSearchParams` body: that is a bug in a client, which the caller cannot
 *   fix. The CLI reports such an error as `internal-error`. The message holds no key.
 * @example
 * ```ts
 * const body = new URLSearchParams({ module: "contract", action: "checkverifystatus", guid });
 * const req = withKey(ctx, handle.backend, {
 *   url: ctx.route.requestUrl("/v2/api") + "?chainid=1",
 *   method: "POST",
 *   body,
 *   retry: "safe",
 * });
 * ```
 */
export function withKey(ctx: KeyContext, backend: BackendName, req: HttpRequest): HttpRequest {
  const key = keyFor(ctx, backend, req.url);
  if (key === undefined) {
    return req;
  }
  if (backend === "routescan") {
    return { ...req, headers: { ...req.headers, apikey: key } };
  }
  if (backend === "blockscout-hosted") {
    return { ...req, headers: { ...req.headers, authorization: `Bearer ${key}` } };
  }
  if (backend !== "etherscan-v2" && backend !== "etherscan-compatible") {
    // No placement is known for this backend, so the key is not sent.
    return req;
  }
  const { body } = req;
  if (req.method !== "POST" || !(body instanceof URLSearchParams)) {
    throw new Error(
      `explorer-verify bug: a keyed ${backend} request must be a POST with a URLSearchParams body, so the key stays out of the URL. Report it at ${ISSUES_URL}.`,
    );
  }
  const keyed = new URLSearchParams(body);
  keyed.set("apikey", key);
  return { ...req, body: keyed };
}

// References: decision 0046.
/**
 * Whether the route needs a key (its backend always does, or its table entry says so), none is
 * bound to the route's host, and no server handler adds it. {@link requireKey} throws in that
 * case; a dry run skips its lookup instead. An injected `fetch` does not count as a server that
 * adds the key: only `VerifyOptions.handlerUrl` does.
 *
 * @param ctx - The route and the caller's keys.
 * @param serverAddsKey - Whether the route's requests go to the caller's server handler, which
 *   adds the key.
 * @returns `true` when a request would go out without the key it needs.
 * @example
 * ```ts
 * if (keyMissing({ route, apiKeys: settings.apiKeys }, settings.handler?.serves(route) === true)) {
 *   // The dry run skips the lookup.
 * }
 * ```
 */
export function keyMissing(ctx: KeyContext, serverAddsKey: boolean): boolean {
  const { route } = ctx;
  return (
    !serverAddsKey &&
    (needsKey(route.backend) || route.needsKey === true) &&
    keyFor(ctx, route.backend, route.apiBase) === undefined
  );
}

// References: decision 0046.
/**
 * Throws `missing-api-key` before any request when the route needs a key (its backend always
 * does, or its table entry says so), none is bound to the route's host, and the caller's server
 * handler does not add it. An injected `fetch` does not change this. Only the
 * error for `etherscan-v2` names `handlerUrl`: the server handler serves Etherscan alone.
 *
 * @param ctx - The route and the caller's keys.
 * @param serverAddsKey - Whether the route's requests go to the caller's server handler.
 * @param secrets - The call's keys, removed from the error.
 * @throws ExplorerVerifyError `missing-api-key` naming the backend.
 * @example
 * ```ts
 * requireKey({ route, apiKeys: settings.apiKeys }, false, secrets);
 * ```
 */
export function requireKey(
  ctx: KeyContext,
  serverAddsKey: boolean,
  secrets: readonly string[],
): void {
  const { route } = ctx;
  if (!keyMissing(ctx, serverAddsKey)) {
    return;
  }
  const { backend, overridden } = route;
  const url = new URL(route.apiBase);
  const { host } = url;
  // `apiKeys` never holds a standalone explorer's key (decision 0016), so only route.apiKey helps.
  // A route.apiUrl on Etherscan's own API takes apiKeys, as a table route does (decision 0053).
  // For any other route.apiUrl, the message does not give the host it is on as the reason.
  const where =
    backend === "etherscan-compatible"
      ? "set route.apiKey"
      : !overridden || onTableHost(route, url.origin)
        ? `set apiKeys.${backend}${backend === "etherscan-v2" && !overridden ? ", or handlerUrl" : ""}`
        : backend === "etherscan-v2"
          ? "apiKeys.etherscan-v2 goes only to Etherscan's own API; set route.apiKey for this route.apiUrl"
          : `a route with route.apiUrl takes no key from apiKeys.${backend}; set route.apiKey`;
  throw newError(
    { code: "missing-api-key", backend },
    `${BACKEND_LABELS[backend]} needs an API key and none is set for ${host}: ${where}.`,
    { secrets },
  );
}

/**
 * The key error an Etherscan-style answer reports, or `undefined` when it reports none. Only an
 * answer whose `status` is `"0"` is read; its `result` text decides (live, 2026-11-02 and
 * 2026-11-03):
 *
 * - `Missing/Invalid API Key`: `missing-api-key`. Etherscan gives it for no key and for a key
 *   sent where it does not read one, such as a header.
 * - `Invalid API Key (#err2)`, or any other `Invalid API Key`: `api-key-rejected`.
 * - `Free API access is not supported for this chain`, Etherscan's answer for a free-plan key
 *   on a chain that needs a paid plan: `api-key-rejected`. For `etherscan-v2` the hint names the
 *   paid plan and Sourcify; other backends keep the default hint (live, 2026-11-04).
 * - A daily limit, as `Max daily rate limit reached` or `Daily limit of 500 source code
 *   submissions reached`: `quota-exceeded`.
 *
 * The error names the backend only, never the key or the explorer's text.
 *
 * @param backend - The backend that answered.
 * @param body - The parsed JSON answer.
 * @param secrets - The call's keys, removed from the error.
 * @returns The error to throw, or `undefined`.
 * @example
 * ```ts
 * const error = keyErrorOf("etherscan-v2", await response.json(), ctx.http.secrets);
 * if (error !== undefined) {
 *   throw error;
 * }
 * ```
 */
export function keyErrorOf(
  backend: BackendName,
  body: unknown,
  secrets: readonly string[],
): ExplorerVerifyError | undefined {
  const fields = readFields(body);
  const result = fields?.get("result");
  if (fields?.get("status") !== "0" || typeof result !== "string") {
    return undefined;
  }
  const text = result.toLowerCase();
  let code: "missing-api-key" | "api-key-rejected" | "quota-exceeded";
  let what: string;
  let hint: string | undefined;
  if (text.includes("missing/invalid api key")) {
    code = "missing-api-key";
    what = "that the API key is missing";
  } else if (text.includes("invalid api key")) {
    code = "api-key-rejected";
    what = "that the API key is not valid";
  } else if (text.startsWith(PAID_PLAN)) {
    code = "api-key-rejected";
    what = "that the API key's plan does not cover this chain";
    // The hint names Etherscan, so only the Etherscan v2 client gets it.
    hint = backend === "etherscan-v2" ? PAID_PLAN_HINT : undefined;
  } else if (DAILY_LIMIT.test(text)) {
    code = "quota-exceeded";
    what = "that the API key's daily limit is spent";
  } else {
    return undefined;
  }
  return newError({ code, backend }, `${BACKEND_LABELS[backend]} answered ${what}.`, {
    secrets,
    // Stryker disable next-line ConditionalExpression: equivalent when always false. An undefined hint takes the catalogue's hint, as an absent one does.
    ...(hint === undefined ? {} : { hint }),
  });
}
