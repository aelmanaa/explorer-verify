// References: R-FLOW-6, R-SRV-5, decision 0002, R-RUN-1.
/**
 * The HTTP layer every backend client uses. It sends each request through the
 * caller's `fetch`, retries transient failures with backoff, enforces a per-request timeout and
 * the call's time budget, and stops at once on abort.
 *
 * Only web-platform globals are used: `fetch`, `Response`, `Headers`, `TextDecoder`,
 * `AbortController`, `AbortSignal`, `DOMException`, `URL`, `Date` and `setTimeout`. Two newer
 * helpers are avoided on purpose:
 *
 * - `AbortSignal.timeout()`: in Node its timer does not keep the process alive, so a script that
 *   waits only on it exits with neither a result nor an error. The `node:test` mock timers do not
 *   drive it either. A `setTimeout` and an `AbortController` do both.
 * - `AbortSignal.any()`: missing before Safari 17.4. One `AbortController` per attempt, with a
 *   listener on the caller's signal that is removed when the attempt ends, does the same.
 */
import type { BackendName } from "../backend-names.ts";
import { newError } from "../error-hints.ts";
import type { ErrorDetails, ExplorerVerifyError } from "../errors.ts";
import { budgetText } from "../internal/duration.ts";
import { readOwn } from "../internal/read-fields.ts";
import { SILENT_OBSERVER } from "../observe.ts";
import type { Observer } from "../observe.ts";

/** The most requests one {@link request} call sends, the first one included. */
export const MAX_ATTEMPTS = 5;
/** The backoff before the second attempt, before jitter, in milliseconds. */
export const BASE_DELAY_MS = 1_000;
/** The longest wait between two attempts, in milliseconds. A longer `Retry-After` ends the retries. */
export const MAX_DELAY_MS = 30_000;
/** The default limit for one request, body included, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** The default limit for one response body, in bytes as received: 16 MiB. */
export const MAX_RESPONSE_BYTES: number = 16 * 1024 * 1024;
/** The largest `retryAfterMs` an error reports: one hour. */
export const MAX_RETRY_AFTER_MS = 3_600_000;
/**
 * The longest delay `setTimeout` takes, in milliseconds. A longer one overflows and fires at once
 * in browsers and Node, so every timer is clamped to it.
 */
export const MAX_TIMER_MS = 2_147_483_647;

// Sourcify's code for a 429 that means "a job for this contract is already running". It is not a
// rate limit, so it is returned to the backend, which maps it to `in-progress`. Source: the
// Sourcify OpenAPI spec, version 2.1.0 (docs/contributor/research/2026-11-02-explorer-apis.md).
const DUPLICATE_CODE = "duplicate_verification_request";
// Statuses whose body must be empty: `new Response` rejects a body with them. 304 is handled as
// a redirect, like every 3xx.
const NULL_BODY_STATUSES: readonly number[] = [204, 205];
// Headers that describe the body as it was sent. The returned response holds the decoded text, so
// they would be wrong on it.
const BODY_HEADERS: readonly string[] = ["content-encoding", "content-length", "transfer-encoding"];
// The day name that starts every HTTP date format: `Sun, 06 Nov 1994 08:49:37 GMT`,
// `Sunday, 06-Nov-94 08:49:37 GMT` and `Sun Nov  6 08:49:37 1994`.
// Case-insensitive on purpose: RFC 9110 dates are case-sensitive, but a recipient may be lenient,
// and reading `mon, ...` as a date costs nothing.
const HTTP_DATE_START = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i;
const REDIRECT_MESSAGE = "answered with a redirect, which is not followed";

// References: decision 0035.
/**
 * `globalThis.fetch`, read when each request starts and called as a plain function. It is the
 * default of {@link HttpContext.fetch}. A caller that fills its own default passes this function,
 * so a request through it gets the same-origin check of the default.
 */
export const platformFetch: typeof fetch = async (input, init) =>
  await globalThis.fetch(input, init);

/**
 * What a request is allowed to retry.
 *
 * - `safe`: a read, or a write the explorer treats as idempotent. Retries network errors,
 *   timeouts, 429, 502, 503 and 504.
 * - `submit`: a verification submit. Retries only 429 and 503, the answers that refuse a request
 *   before processing it. A network error, a timeout, a 500, a 502 or a 504 is not retried: the
 *   explorer may have received the submit, so the backend checks the contract's state (a lookup)
 *   before it submits again.
 */
export type RetryMode = "safe" | "submit";

/**
 * What a request goes to when it is not a backend: `rpc` for the caller's JSON-RPC endpoint and
 * `ipfs` for the caller's IPFS gateway.
 */
export type RequestLabel = "rpc" | "ipfs";

/**
 * The time budget of the whole call, polling included. A request never runs past `deadline`.
 *
 * @example
 * ```ts
 * const timeoutMs = 120_000;
 * const budget: Budget = { deadline: Date.now() + timeoutMs, timeoutMs };
 * ```
 */
export interface Budget {
  /** When the budget runs out, as a `Date.now()` value. */
  readonly deadline: number;
  /** The budget's length, reported in a `timeout` error. */
  readonly timeoutMs: number;
}

/**
 * What every request of one call shares.
 *
 * @example
 * ```ts
 * const controller = new AbortController();
 * const ctx: HttpContext = {
 *   backend: "sourcify",
 *   signal: controller.signal,
 *   secrets: [],
 *   budget: { deadline: Date.now() + 120_000, timeoutMs: 120_000 },
 * };
 * ```
 */
export interface HttpContext {
  /**
   * The backend named in errors. For a request that does not go to a backend, the backend of the
   * call it serves, set together with {@link HttpContext.label}.
   */
  readonly backend: BackendName;
  /**
   * Set when the requests go to an endpoint the caller configured, not to a backend. Log lines
   * then carry this `label` field in place of `backend`, and no `verify.retry` event is emitted:
   * that event names the backend a request goes to. The retry is still logged at `warn`.
   */
  readonly label?: RequestLabel;
  // References: R-SRV-5, decision 0035.
  /**
   * The caller's `fetch`, the only way out to the network. Defaults to
   * {@link platformFetch}, which reads `globalThis.fetch` when each request starts. With the
   * default, a response whose URL has another origin than the request is refused as a redirect.
   * Any other `fetch` may send the request to another URL on purpose, such as a server handler,
   * so its response URL is not checked; its redirects are still refused.
   */
  readonly fetch?: typeof fetch | undefined;
  /** The caller's signal. On abort, every request and wait stops and rejects with its reason. */
  readonly signal?: AbortSignal | undefined;
  // References: R-DX-5, R-DX-6.
  /**
   * The call's observer from `createObserver`, shared by every request of the call. Its `log` gets
   * debug and retry lines; its `emit` gets a `verify.retry` event before
   * each retry wait. It redacts with the keys it was created with and never throws. Taking the
   * observer, not a raw logger and callback, keeps one observer per call, so a broken `onEvent` is
   * reported once per call. Without it, nothing is logged or emitted. Its `log` and `emit` must be
   * own properties, so an observer whose methods live on a class prototype is `invalid-input`.
   */
  readonly observer?: Observer;
  /** Key values to remove from errors. Pass `[]` when the call has no key. */
  readonly secrets: readonly string[];
  /**
   * The limit for one request, body included, in milliseconds. A positive number; values above
   * {@link MAX_TIMER_MS} are clamped. Defaults to {@link REQUEST_TIMEOUT_MS}.
   */
  readonly requestTimeoutMs?: number;
  /**
   * The largest response body read, in bytes as received. A positive number. Defaults to
   * {@link MAX_RESPONSE_BYTES}.
   */
  readonly maxResponseBytes?: number;
  /** The call's time budget. Without it, only the per-request timeout applies. */
  readonly budget?: Budget | undefined;
  /** A number in `[0, 1)` for the backoff jitter. Defaults to `Math.random`. Tests fix it. */
  readonly random?: (() => number) | undefined;
  /**
   * The most requests one {@link request} call sends, the first one included: an integer from 1
   * to {@link MAX_ATTEMPTS}. Defaults to {@link MAX_ATTEMPTS}. The server handler sends at most
   * two, so its retries and the client's do not multiply.
   */
  readonly maxAttempts?: number;
  // References: decision 0046.
  /**
   * For a route through the caller's server handler: the URL a request is sent
   * to, the handler's for a request to Etherscan's API. Log lines and errors name that URL.
   */
  readonly sendTo?: ((url: string) => string) | undefined;
}

/**
 * One request. Build `body` with `JSON.stringify`, `URLSearchParams` or `FormData`, never by
 * joining strings, so a caller-chosen value cannot add a parameter.
 *
 * @example
 * ```ts
 * const req: HttpRequest = {
 *   url: route.requestUrl("/v2/verify/11155111/0x5FbDB2315678afecb367f032d93F642f64180aa3"),
 *   method: "POST",
 *   body: JSON.stringify(payload),
 *   headers: { "content-type": "application/json" },
 *   retry: "submit",
 * };
 * ```
 */
export interface HttpRequest {
  /** The full URL. It can hold a key in its query, so it is never logged. */
  readonly url: string;
  /** The HTTP method. */
  readonly method: "GET" | "POST";
  /** The request body. Sent again unchanged on each retry. */
  readonly body?: string | URLSearchParams | FormData;
  /** Request headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** What may be retried. */
  readonly retry: RetryMode;
  /**
   * Whether a body that came with a status other than 429 is a rate-limit answer, as Etherscan's
   * `Max calls per sec rate limit reached` with HTTP 200. Such an answer is retried as a 429 is:
   * the same backoff, attempt cap, budget, abort and `verify.retry` event, and `rate-limited` once
   * the retries stop.
   */
  readonly rateLimited?: (body: string) => boolean;
  /**
   * A response header that holds the wait before the next attempt in whole seconds, read on a
   * rate-limit answer when `Retry-After` is absent. Routescan sends its wait only in
   * `x-ratelimit-rpm-retry-after` (recorded 2026-11-05). The value is read as `Retry-After` is.
   */
  readonly retryAfterHeader?: string;
  /**
   * Returns a query parameter, such as `nocache=k3x9`, added to `url` on each attempt, retries
   * included. Routescan uses it so that no attempt repeats a URL its CDN may have cached. Only the
   * query changes, never the host.
   */
  readonly freshQuery?: () => string;
  // References: R-RUN-1, issue #356.
  /**
   * When `true`, each attempt asks the runtime's own HTTP cache neither to serve nor to store the
   * answer: `cache: "no-store"` on the fetch. Only the platform's fetch gets the field: an
   * injected fetch handles caching itself, and may refuse a field it does not know. A runtime whose
   * `Request` refuses or ignores the field, as some edge runtimes do, gets none either. It does not
   * reach a shared cache in front of the server.
   */
  readonly noStore?: boolean;
}

/**
 * The fields of one {@link request} call, each read once from its context and request as an own
 * property, with the defaults filled in.
 */
interface Call {
  readonly backend: BackendName;
  readonly label: RequestLabel | undefined;
  readonly send: typeof fetch;
  /** True when `send` is the platform's fetch, whose response must come from the request's origin. */
  readonly sameOrigin: boolean;
  readonly signal: AbortSignal | undefined;
  readonly log: Observer["log"];
  readonly emit: Observer["emit"];
  readonly secrets: readonly string[];
  readonly requestTimeoutMs: number | undefined;
  readonly maxResponseBytes: number | undefined;
  readonly budget: Budget | undefined;
  readonly random: () => number;
  readonly maxAttempts: number | undefined;
  readonly url: string;
  readonly method: HttpRequest["method"];
  readonly body: HttpRequest["body"];
  readonly headers: Record<string, string> | undefined;
  readonly retry: RetryMode;
  readonly rateLimited: ((body: string) => boolean) | undefined;
  readonly retryAfterHeader: string | undefined;
  readonly freshQuery: (() => string) | undefined;
  readonly noStore: boolean | undefined;
}

/** The result of one attempt. */
type Attempt =
  | { kind: "response"; response: Response }
  | { kind: "retry"; reason: "network"; cause: unknown }
  | {
      kind: "retry";
      reason: "rate-limited" | "server-error";
      status: number;
      body: string;
      retryAfterMs: number | undefined;
    }
  | Fatal
  | { kind: "budget"; timeoutMs: number };

/** A response that arrived but cannot be used. It is never retried. */
interface Fatal {
  kind: "fatal";
  status: number;
  excerpt: string;
  message: string;
  cause?: unknown;
}

type Failure = Extract<Attempt, { kind: "retry" }>;

/** What one attempt has seen so far, shared between the exchange and its timer. */
interface Progress {
  status?: number;
}

// References: R-FLOW-6, R-SEC-2, R-SEC-1, R-DX-5, R-DX-6, decision 0010.
/**
 * Sends one request through the caller's `fetch`, with retries, a per-request timeout, the call's
 * time budget and abort.
 *
 * - Retries with exponential backoff and jitter: base 1 s, doubled per attempt, at most 5
 *   attempts. The jitter keeps between half and all of each step.
 * - For `safe`, retries network errors, timeouts, 429, 502, 503 and 504. For `submit`, retries
 *   only 429 and 503. Every other status is returned to the caller.
 * - Waits at least as long as `Retry-After` asks, in seconds or as an HTTP date. A `Retry-After`
 *   above 30 s, or a wait that would pass the budget's deadline, ends the retries at once. On a
 *   rate-limit answer without `Retry-After`, `req.retryAfterHeader` names a header read in its
 *   place.
 * - Returns a 429 whose JSON body has `customCode` `duplicate_verification_request` without a
 *   retry: a job for this contract is already running, and the backend maps it to `in-progress`.
 * - Retries a response whose body `req.rateLimited` reads as a rate-limit answer, as a 429.
 * - Never follows a redirect, and sends every attempt to the same URL, so a request never reaches
 *   a host the caller did not configure.
 * - Reads at most `maxResponseBytes` of a body. Once the headers arrived, a body that is too large,
 *   fails or stalls past the timeout is `unexpected-response`, never retried.
 * - Logs only the URL's origin and path, with `?REDACTED` in place of a query string, through the
 *   redacting logger, with the backend, method, URL and attempt as fields. A
 *   retry is logged at `warn`; a failure the call throws is never logged at `error`.
 * - Emits a `verify.retry` event before each retry wait, unless `ctx.label` is set. With
 *   a label, log lines carry `label` in place of `backend`.
 * - A logger or `onEvent` callback that throws does not change the request.
 * - Reads each field of `ctx`, of its budget and observer, and of `req` once, as an own property,
 *   so this layer never uses a value added to `Object.prototype`. The `RequestInit` it
 *   passes to `fetch` has no prototype; a platform fetch may still read inherited members of its
 *   own objects.
 *
 * The returned response's body is already read into memory, inside the timeout and the abort, so
 * reading it cannot hang. It has no `content-encoding`, `content-length` or `transfer-encoding`
 * header.
 *
 * @param ctx - What the call's requests share: `fetch`, signal, observer, keys and budget.
 * @param req - The request.
 * @returns The first response that is not retried.
 * @throws The caller's `signal.reason`, unchanged, when the signal aborts.
 * @throws ExplorerVerifyError `invalid-input` when a field of `ctx` or `req` cannot be read or a
 *   required one is missing, or when `requestTimeoutMs` or `maxResponseBytes` is not a positive
 *   number; `network` when no attempt got a response; `rate-limited` when the last one got a 429,
 *   or a body that `req.rateLimited` reads as a rate-limit answer, whatever its status;
 *   `unexpected-response` when it got a 5xx, a redirect or a body that cannot be read; and
 *   `timeout` when the budget ran out.
 * @example
 * ```ts
 * const response = await request(
 *   { backend: "sourcify", fetch: options.fetch, signal: options.signal, secrets: [] },
 *   { url: route.requestUrl(`/v2/verify/${jobId}`), method: "GET", retry: "safe" },
 * );
 * const body: unknown = await response.json();
 * ```
 */
export async function request(ctx: HttpContext, req: HttpRequest): Promise<Response> {
  const call = readCall(ctx, req);
  checkLimits(call);
  const { log, emit, budget } = call;
  const maxAttempts = call.maxAttempts ?? MAX_ATTEMPTS;
  const url = loggableUrl(call.url);
  const target = `${call.method} ${url}`;
  const { label } = call;
  const where =
    label === undefined
      ? { backend: call.backend, method: call.method, url }
      : { label, method: call.method, url };

  let attempt = 0;
  // Set once an attempt failed: its failure, and the wait before the next attempt.
  let retry: { readonly failure: Failure; readonly delayMs: number } | undefined;
  for (;;) {
    if (retry !== undefined) {
      const { failure, delayMs } = retry;
      const next = attempt + 1;
      log.warn(
        `${target}: ${describe(failure)}; retrying in ${String(delayMs)} ms (attempt ${String(next)} of ${String(maxAttempts)})`,
        {
          ...where,
          attempt: next,
          reason: failure.reason,
          status: failure.reason === "network" ? null : failure.status,
          delayMs,
        },
      );
      if (label === undefined) {
        emit({
          type: "verify.retry",
          backend: call.backend,
          attempt: next,
          reason: failure.reason,
          delayMs,
        });
      }
      await sleep(delayMs, call.signal);
    }
    attempt += 1;
    if (budget !== undefined && budget.deadline - Date.now() <= 0) {
      throw timeoutError(call, target, budget.timeoutMs);
    }
    log.debug(`${target}: attempt ${String(attempt)} of ${String(maxAttempts)}`, {
      ...where,
      attempt,
    });
    // The logger or onEvent may have aborted the signal; an attempt must not start after that.
    call.signal?.throwIfAborted();
    const result = await attemptOnce(call);
    if (result.kind === "response") {
      return result.response;
    }
    if (result.kind === "budget") {
      throw timeoutError(call, target, result.timeoutMs);
    }
    if (result.kind === "fatal") {
      const options =
        result.cause === undefined
          ? { secrets: call.secrets }
          : { secrets: call.secrets, cause: result.cause };
      throw newError(
        {
          code: "unexpected-response",
          backend: call.backend,
          status: result.status,
          excerpt: result.excerpt,
        },
        `${target} ${result.message} (status ${String(result.status)}).`,
        options,
      );
    }
    const delayMs =
      attempt < maxAttempts
        ? retryDelay(budget, call.retry, attempt, result, call.random)
        : undefined;
    if (delayMs === undefined) {
      throw giveUp(call, target, attempt, result);
    }
    retry = { failure: result, delayMs };
  }
}

/**
 * Waits `ms` milliseconds, or rejects with `signal.reason` as soon as the signal aborts. It uses
 * `setTimeout`, whose timer keeps a Node process alive while it waits; a timer that does not, such
 * as the one behind `AbortSignal.timeout()`, let the process exit mid-poll with neither a result
 * nor an error. The abort listener is removed on both paths, so a long-lived signal collects none.
 * A wait above {@link MAX_TIMER_MS} is clamped to it, because a longer `setTimeout` fires at once.
 *
 * @param ms - How long to wait, in milliseconds.
 * @param signal - Stops the wait.
 * @returns A promise that resolves after the wait.
 * @throws The signal's reason, unchanged, when it aborts before or during the wait.
 * @example
 * ```ts
 * await sleep(options.pollIntervalMs ?? 3_000, options.signal);
 * ```
 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(reasonOf(signal));
    };
    // The listener goes on before the timer: if `addEventListener` throws, no timer is left
    // running whose `removeEventListener` call could throw later, outside any promise.
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, timerMs(ms));
  });
}

/** `ms` clamped to what `setTimeout` takes without overflowing. */
function timerMs(ms: number): number {
  return Math.min(ms, MAX_TIMER_MS);
}

/**
 * The fields of `ctx` and `req`, each read once as an own property, with the defaults filled in.
 * `fetch` is read once and then called as a plain function: a browser's fetch called as a method
 * of another object throws "Illegal invocation". Without it, {@link platformFetch} reads
 * `globalThis.fetch` when the request is sent. The headers are copied, so a getter on them runs
 * here and only once.
 * `signal` is read first: once it has aborted, its reason wins over any problem in another field.
 *
 * @throws The caller's `signal.reason`, unchanged, when the signal has aborted.
 * @throws ExplorerVerifyError `invalid-input` when a getter or Proxy trap throws, or when a
 *   required field is missing.
 */
function readCall(ctx: HttpContext, req: HttpRequest): Call {
  const signal = optional(ctx, "signal", "context");
  signal?.throwIfAborted();
  const observer = optional(ctx, "observer", "context") ?? SILENT_OBSERVER;
  const budget = optional(ctx, "budget", "context");
  const headers = optional(req, "headers", "request");
  const injected = optional(ctx, "fetch", "context");
  const sendTo = optional(ctx, "sendTo", "context");
  const requestUrl = required(req, "url", "request");
  return {
    backend: required(ctx, "backend", "context"),
    label: optional(ctx, "label", "context"),
    send: injected ?? platformFetch,
    sameOrigin: injected === undefined || injected === platformFetch,
    signal,
    log: required(observer, "log", "context.observer"),
    emit: required(observer, "emit", "context.observer"),
    secrets: required(ctx, "secrets", "context"),
    requestTimeoutMs: optional(ctx, "requestTimeoutMs", "context"),
    maxResponseBytes: optional(ctx, "maxResponseBytes", "context"),
    budget:
      budget === undefined
        ? undefined
        : {
            deadline: required(budget, "deadline", "context.budget"),
            timeoutMs: required(budget, "timeoutMs", "context.budget"),
          },
    random: optional(ctx, "random", "context") ?? Math.random,
    maxAttempts: optional(ctx, "maxAttempts", "context"),
    url: sendTo === undefined ? requestUrl : sendTo(requestUrl),
    method: required(req, "method", "request"),
    body: optional(req, "body", "request"),
    headers: headers === undefined ? undefined : copyHeaders(headers),
    retry: required(req, "retry", "request"),
    rateLimited: optional(req, "rateLimited", "request"),
    retryAfterHeader: optional(req, "retryAfterHeader", "request"),
    freshQuery: optional(req, "freshQuery", "request"),
    noStore: optional(req, "noStore", "request"),
  };
}

// References: R-SEC-1.
/**
 * The own property `name` of `value`, read once, or `undefined` when `value` does not have it.
 *
 * @throws ExplorerVerifyError `invalid-input`, without the thrown error, when a getter or Proxy
 *   trap throws: the error may repeat a caller value.
 */
function optional<T extends object, K extends keyof T & string>(
  value: T,
  name: K,
  path: string,
): T[K] | undefined {
  try {
    return readOwn(value, name);
  } catch {
    throw invalidField(`${path}.${name}`, "could not be read");
  }
}

/** Like {@link optional}, for a field that must be set: a missing one is `invalid-input`. */
function required<T extends object, K extends keyof T & string>(
  value: T,
  name: K,
  path: string,
): NonNullable<T[K]> {
  const read = optional(value, name, path);
  if (read === undefined || read === null) {
    throw invalidField(`${path}.${name}`, "is missing");
  }
  return read;
}

/** A copy of the request headers, own enumerable fields only, each read once. */
function copyHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  try {
    return { ...headers };
  } catch {
    throw invalidField("request.headers", "could not be read");
  }
}

/** The `invalid-input` error for one field of the context or request. */
function invalidField(field: string, message: string): ExplorerVerifyError {
  return newError(
    { code: "invalid-input", issues: [{ field, message }] },
    `The HTTP request is invalid: ${field} ${message}.`,
    // Stryker disable next-line ObjectLiteral,ArrayDeclaration: equivalent. The message names only a field of the context or the request, never its value.
    { secrets: [] },
  );
}

/** Throws `invalid-input` when a limit in the context is not a positive number. */
function checkLimits(call: Call): void {
  const issues = [
    { field: "requestTimeoutMs", value: call.requestTimeoutMs },
    { field: "maxResponseBytes", value: call.maxResponseBytes },
  ]
    .filter(({ value }) => value !== undefined && !(Number.isFinite(value) && value > 0))
    .map(({ field }) => ({ field, message: "must be a positive finite number" }));
  const attempts = call.maxAttempts;
  if (
    attempts !== undefined &&
    !(Number.isInteger(attempts) && attempts >= 1 && attempts <= MAX_ATTEMPTS)
  ) {
    issues.push({
      field: "maxAttempts",
      message: `must be an integer from 1 to ${String(MAX_ATTEMPTS)}`,
    });
  }
  if (issues.length > 0) {
    throw newError(
      { code: "invalid-input", issues },
      `The HTTP limits are invalid: ${issues.map((issue) => issue.field).join(", ")}.`,
      { secrets: call.secrets },
    );
  }
}

/**
 * One attempt: the fetch and the body read, raced against the caller's abort and a timer set to
 * the per-request timeout or the budget's deadline, whichever comes first. The race settles even
 * when the caller's `fetch` ignores the signal.
 */
async function attemptOnce(call: Call): Promise<Attempt> {
  const requestTimeoutMs = call.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const budget = call.budget;
  let budgetLeft = Infinity;
  // Set when the budget ends before the per-request timeout: the timer then means `timeout`.
  let budgetTimeoutMs: number | undefined;
  if (budget !== undefined) {
    budgetLeft = budget.deadline - Date.now();
    if (budgetLeft <= requestTimeoutMs) {
      budgetTimeoutMs = budget.timeoutMs;
    }
  }
  const limitMs = timerMs(Math.min(requestTimeoutMs, budgetLeft));
  const controller = new AbortController();
  const caller = call.signal;
  const progress: Progress = {};

  return await new Promise<Attempt>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
      return true;
    };
    const onAbort = (): void => {
      if (settle()) {
        const reason = reasonOf(caller);
        controller.abort(reason);
        reject(reason);
      }
    };
    // The listener goes on before the timer, so a signal whose `addEventListener` throws leaves
    // no timer behind. settle() removes it.
    caller?.addEventListener("abort", onAbort);
    timer = setTimeout(() => {
      // settle() clears this timer, so it never fires after the attempt settled.
      settle();
      // Only a per-request timeout uses this message; a budget timeout becomes `timeout`.
      const cause = new DOMException(
        `The request took longer than ${String(timerMs(requestTimeoutMs))} ms.`,
        "TimeoutError",
      );
      controller.abort(cause);
      resolve(timedOut(budgetTimeoutMs, progress, cause));
    }, limitMs);

    const run = async (): Promise<void> => {
      let result: Attempt;
      try {
        result = await exchange(call, controller.signal, progress);
      } catch (error: unknown) {
        result = networkFailure(error);
      }
      if (settle()) {
        resolve(result);
      }
    };
    void run();
  });
}

/**
 * What a fired timer means: `timeout` when the budget ran out, `unexpected-response` when the
 * headers had arrived (the body stalled), and a network failure when nothing arrived.
 */
function timedOut(budgetTimeoutMs: number | undefined, progress: Progress, cause: Error): Attempt {
  if (budgetTimeoutMs !== undefined) {
    return { kind: "budget", timeoutMs: budgetTimeoutMs };
  }
  if (progress.status !== undefined) {
    return {
      kind: "fatal",
      status: progress.status,
      excerpt: "",
      message: "sent its headers but not its whole body in time",
      cause,
    };
  }
  return networkFailure(cause);
}

/** An attempt that got no response, retried as `network`. */
function networkFailure(cause: unknown): Failure {
  return {
    // Stryker disable next-line StringLiteral: equivalent. request() retries every attempt that is not a response, a budget timeout or a fatal answer, so it never reads this kind.
    kind: "retry",
    reason: "network",
    cause,
  };
}

// References: R-RUN-1, issue #356.
/**
 * Whether this runtime's `Request` keeps `cache: "no-store"` for `url`. A runtime without
 * `Request`, one that throws on the field, as Cloudflare Workers did before compatibility date
 * 2024-11-11, or one that drops it gets `false`, and the request goes without the field.
 */
function takesNoStore(url: string): boolean {
  let kept = false;
  try {
    kept = new Request(url, { cache: "no-store" }).cache === "no-store";
  } catch {
    // The runtime refuses the field: the request goes without it.
  }
  return kept;
}

/**
 * The fetch and the body read, classified. Throws only when no response arrived; once the
 * headers arrived, every problem is a {@link Fatal}.
 */
async function exchange(call: Call, signal: AbortSignal, progress: Progress): Promise<Attempt> {
  const limit = call.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  // "manual": a redirect is not followed, so the request never reaches a host the caller did not
  // configure (R-SEC-2). A browser then returns an "opaqueredirect" response with status 0.
  const init: RequestInit = { method: call.method, signal, redirect: "manual" };
  // No prototype, so an injected fetch or a browser's fetch cannot read a `body`, `headers` or
  // other member from `Object.prototype`. A platform fetch may still read inherited members of
  // its own internal objects; Node's fetch does.
  Object.setPrototypeOf(init, null);
  if (call.body !== undefined) {
    init.body = call.body;
  }
  if (call.headers !== undefined) {
    init.headers = { ...call.headers };
  }
  // Called as a plain function, never as a method of `call` (see readCall).
  const { send, freshQuery } = call;
  const url =
    freshQuery === undefined
      ? call.url
      : `${call.url}${call.url.includes("?") ? "&" : "?"}${freshQuery()}`;
  // Only the platform fetch gets the field: an injected fetch may refuse fields it does not know.
  if (call.noStore === true && call.sameOrigin && takesNoStore(url)) {
    init.cache = "no-store";
  }
  const response = await send(url, init);
  const { status } = response;
  progress.status = status;

  if (isRedirect(response) || (call.sameOrigin && !sameOrigin(response, url))) {
    discard(response);
    return { kind: "fatal", status, excerpt: "", message: REDIRECT_MESSAGE };
  }
  // A missing header is null, which Number reads as 0.
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit) {
    discard(response);
    return { kind: "fatal", status, excerpt: "", message: tooLarge(limit) };
  }
  let body: string | undefined;
  try {
    body = await readBody(response, limit);
  } catch (error: unknown) {
    return {
      kind: "fatal",
      status,
      excerpt: "",
      message: "sent a body that could not be read",
      cause: error,
    };
  }
  if (body === undefined) {
    return { kind: "fatal", status, excerpt: "", message: tooLarge(limit) };
  }

  // Read into a local first, so the check is called as a plain function (see readCall).
  const { rateLimited } = call;
  if ((status === 429 && !isDuplicate(body)) || rateLimited?.(body) === true) {
    return {
      // Stryker disable next-line StringLiteral: equivalent. request() retries every attempt that is not a response, a budget timeout or a fatal answer, so it never reads this kind.
      kind: "retry",
      reason: "rate-limited",
      status,
      body,
      retryAfterMs: retryAfter(response, call.retryAfterHeader),
    };
  }
  if (isRetriedServerError(status, call.retry)) {
    return {
      // Stryker disable next-line StringLiteral: equivalent. request() retries every attempt that is not a response, a budget timeout or a fatal answer, so it never reads this kind.
      kind: "retry",
      reason: "server-error",
      status,
      body,
      retryAfterMs: retryAfter(response, undefined),
    };
  }
  // `new Response` accepts only 200 to 599. A fetch answers with another status only for an
  // error or opaque response, such as `Response.error()`, which holds no usable answer.
  if (status < 200 || status > 599) {
    return {
      kind: "fatal",
      status,
      excerpt: body,
      message: "returned a response that cannot be read",
    };
  }
  const headers = new Headers(response.headers);
  for (const name of BODY_HEADERS) {
    headers.delete(name);
  }
  return {
    kind: "response",
    response: new Response(NULL_BODY_STATUSES.includes(status) ? null : body, {
      status,
      statusText: response.statusText,
      headers,
    }),
  };
}

/**
 * Whether the response is a redirect: an opaque redirect, a 3xx, or a response that says it was
 * redirected. The last one catches a `fetch` that ignores `redirect: "manual"` and follows the
 * redirect: a platform `fetch` marks such a response `redirected`, whatever URL it was sent to.
 * The `Location` header is never read.
 */
function isRedirect(response: Response): boolean {
  const { status } = response;
  return (
    response.type === "opaqueredirect" || response.redirected || (status >= 300 && status < 400)
  );
}

// References: decision 0035.
/**
 * Whether the response came from the request's origin, or does not say where it came from (an
 * empty `url`). Checked only for the platform's fetch, which sends the request to `url` and
 * nowhere else, so another origin there can only mean a redirect that was followed. An injected
 * `fetch` may send the request to another URL on purpose, such as a server handler on the page's
 * own origin, so its response URL is not checked.
 */
function sameOrigin(response: Response, url: string): boolean {
  if (response.url === "") {
    return true;
  }
  try {
    return new URL(response.url).origin === new URL(url).origin;
  } catch {
    // A URL that does not parse has no origin to compare.
  }
  return false;
}

/** Cancels a body that will not be read, so the connection is released. Never throws. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => {});
}

function tooLarge(limit: number): string {
  return `sent a body larger than ${String(limit)} bytes`;
}

/**
 * The body as text, read chunk by chunk. Returns `undefined`, after cancelling the stream, as soon
 * as more than `limit` bytes arrived, so a huge or endless body never fills memory.
 */
async function readBody(response: Response, limit: number): Promise<string | undefined> {
  const stream = response.body;
  if (stream === null) {
    return "";
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      return text + decoder.decode();
    }
    received += chunk.value.byteLength;
    if (received > limit) {
      reader.cancel().catch(() => {});
      return undefined;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

/** Whether a 5xx status is retried in this mode. A 500 never is. */
function isRetriedServerError(status: number, mode: RetryMode): boolean {
  return mode === "safe" ? status === 502 || status === 503 || status === 504 : status === 503;
}

/** Whether a 429 body is Sourcify's "already being verified" answer. */
function isDuplicate(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON: parsed stays undefined, which the check below refuses.
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "customCode" in parsed &&
    parsed.customCode === DUPLICATE_CODE
  );
}

/**
 * `Retry-After` in milliseconds: whole seconds, or an HTTP date relative to `Date.now()`, from 0
 * to {@link MAX_RETRY_AFTER_MS}. When `Retry-After` is absent, the `fallback` header, if named, is
 * read the same way. `undefined` when both are absent or the one read cannot be read.
 */
function retryAfter(response: Response, fallback: string | undefined): number | undefined {
  const { headers } = response;
  const header =
    // Stryker disable next-line ConditionalExpression: equivalent when always false. No response has a header named undefined.
    headers.get("retry-after") ?? (fallback === undefined ? null : headers.get(fallback));
  // Stryker disable next-line StringLiteral: equivalent. Neither form below matches the text that stands in for a missing header.
  const value = header?.trim() ?? "";
  // A value that is neither form, an empty one included, stays NaN and is ignored.
  let ms = Number.NaN;
  if (/^\d+$/.test(value)) {
    ms = Number(value) * 1_000;
  } else if (HTTP_DATE_START.test(value)) {
    // An HTTP date starts with the day name in all three formats of RFC 9110, section 5.6.7. The
    // check keeps `Date.parse` from reading a value such as `1.5` or `-1` as a date.
    ms = Math.max(0, Date.parse(value) - Date.now());
  }
  return Number.isFinite(ms) ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

/**
 * The wait before the next attempt: exponential backoff with jitter, at least `Retry-After`.
 * `undefined` when the retries must stop: a `submit` got no response, `Retry-After` is above
 * {@link MAX_DELAY_MS}, or the wait would end at or after the budget's deadline.
 */
function retryDelay(
  budget: Budget | undefined,
  mode: RetryMode,
  attempt: number,
  failure: Failure,
  random: () => number,
): number | undefined {
  // The cap is a guard: with 5 attempts the largest step is 8 s. It keeps the wait bounded if
  // MAX_ATTEMPTS grows.
  const step = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  let delayMs = Math.round(step / 2 + (random() * step) / 2);
  if (failure.reason === "network") {
    // The explorer may have received a submit that got no response: never send it blindly again.
    if (mode === "submit") {
      return undefined;
    }
  } else if (failure.retryAfterMs !== undefined) {
    if (failure.retryAfterMs > MAX_DELAY_MS) {
      return undefined;
    }
    delayMs = Math.max(delayMs, failure.retryAfterMs);
  }
  if (budget !== undefined && Date.now() + delayMs >= budget.deadline) {
    return undefined;
  }
  return delayMs;
}

/** The last failure as an error, once the retries stop. */
function giveUp(
  call: Call,
  target: string,
  attempts: number,
  failure: Failure,
): ExplorerVerifyError {
  const tries = `${String(attempts)} ${attempts === 1 ? "attempt" : "attempts"}`;
  const options = { secrets: call.secrets };
  let error: ExplorerVerifyError;
  switch (failure.reason) {
    case "network":
      error = newError(
        { code: "network", backend: call.backend, attempts },
        `${target} got no response after ${tries}.`,
        { ...options, cause: failure.cause },
      );
      break;
    case "rate-limited": {
      const details: ErrorDetails = { code: "rate-limited", backend: call.backend, attempts };
      // Stryker disable next-line ConditionalExpression: equivalent when always true. The error copies its details and leaves out a retryAfterMs that is undefined.
      if (failure.retryAfterMs !== undefined) {
        details.retryAfterMs = failure.retryAfterMs;
      }
      error = newError(
        details,
        `${target} answered ${String(failure.status)} (rate limited) after ${tries}.`,
        options,
      );
      break;
    }
    case "server-error": {
      const details: ErrorDetails = {
        code: "unexpected-response",
        backend: call.backend,
        status: failure.status,
        excerpt: failure.body,
        attempts,
      };
      // Stryker disable next-line ConditionalExpression: equivalent when always true. The error copies its details and leaves out a retryAfterMs that is undefined.
      if (failure.retryAfterMs !== undefined) {
        details.retryAfterMs = failure.retryAfterMs;
      }
      error = newError(
        details,
        `${target} answered ${String(failure.status)} after ${tries}.`,
        options,
      );
      break;
    }
  }
  return error;
}

/** The `timeout` error for a budget that ran out. */
function timeoutError(call: Call, target: string, timeoutMs: number): ExplorerVerifyError {
  return newError(
    { code: "timeout", backend: call.backend, timeoutMs },
    `${target} did not finish within the ${budgetText(timeoutMs)} budget.`,
    { secrets: call.secrets },
  );
}

/** A short reason for the retry log line. */
function describe(failure: Failure): string {
  return failure.reason === "network" ? "no response" : `answered ${String(failure.status)}`;
}

// References: decision 0010.
/**
 * The URL as a log line may show it: origin and path, then `?REDACTED` when there is a query
 * string, as `Route.redactedApiUrl` does. User name, password and fragment are
 * dropped. A URL that does not parse is shown as `[invalid URL]`, never as given.
 */
function loggableUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "[invalid URL]";
  }
  return `${parsed.origin}${parsed.pathname}${parsed.search === "" ? "" : "?REDACTED"}`;
}

/** The signal's reason, typed as `unknown`. Only called once the signal has aborted. */
function reasonOf(signal: AbortSignal | undefined): unknown {
  // Stryker disable next-line OptionalChaining: equivalent. Only an abort listener calls it, and only a signal that exists has one.
  const reason: unknown = signal?.reason;
  return reason;
}
