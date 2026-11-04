/**
 * The HTTP layer every backend client uses (R-FLOW-6, R-SRV-5). It sends each request through the
 * caller's `fetch`, retries transient failures with backoff, enforces a per-request timeout and
 * the call's time budget, and stops at once on abort.
 *
 * Only web-platform globals are used: `fetch`, `Response`, `Headers`, `TextDecoder`,
 * `AbortController`, `AbortSignal`, `DOMException`, `URL`, `Date` and `setTimeout` (decision 0002,
 * R-RUN-1). Two newer helpers are avoided on purpose:
 *
 * - `AbortSignal.timeout()`: in Node its timer does not keep the process alive, so a script that
 *   waits only on it exits with neither a result nor an error. The `node:test` mock timers do not
 *   drive it either. A `setTimeout` and an `AbortController` do both.
 * - `AbortSignal.any()`: missing before Safari 17.4. One `AbortController` per attempt, with a
 *   listener on the caller's signal that is removed when the attempt ends, does the same.
 */
import type { BackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { ErrorDetails } from "../errors.ts";
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
  /** The backend the requests go to, named in errors. */
  readonly backend: BackendName;
  /**
   * The caller's `fetch`, the only way out to the network (R-SRV-5). Defaults to
   * `globalThis.fetch`, read when each request starts.
   */
  readonly fetch?: typeof fetch;
  /** The caller's signal. On abort, every request and wait stops and rejects with its reason. */
  readonly signal?: AbortSignal;
  /**
   * The call's observer from `createObserver`, shared by every request of the call (R-DX-5,
   * R-DX-6). Its `log` gets debug and retry lines; its `emit` gets a `verify.retry` event before
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
  readonly budget?: Budget;
  /** A number in `[0, 1)` for the backoff jitter. Defaults to `Math.random`. Tests fix it. */
  readonly random?: () => number;
  /**
   * The most requests one {@link request} call sends, the first one included: an integer from 1
   * to {@link MAX_ATTEMPTS}. Defaults to {@link MAX_ATTEMPTS}. The server handler sends at most
   * two, so its retries and the client's do not multiply.
   */
  readonly maxAttempts?: number;
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
}

/**
 * The fields of one {@link request} call, each read once from its context and request as an own
 * property, with the defaults filled in.
 */
interface Call {
  readonly backend: BackendName;
  readonly send: typeof fetch;
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
  status: number | undefined;
}

/**
 * Sends one request through the caller's `fetch`, with retries, a per-request timeout, the call's
 * time budget and abort (R-FLOW-6).
 *
 * - Retries with exponential backoff and jitter: base 1 s, doubled per attempt, at most 5
 *   attempts. The jitter keeps between half and all of each step.
 * - For `safe`, retries network errors, timeouts, 429, 502, 503 and 504. For `submit`, retries
 *   only 429 and 503. Every other status is returned to the caller.
 * - Waits at least as long as `Retry-After` asks, in seconds or as an HTTP date. A `Retry-After`
 *   above 30 s, or a wait that would pass the budget's deadline, ends the retries at once.
 * - Returns a 429 whose JSON body has `customCode` `duplicate_verification_request` without a
 *   retry: a job for this contract is already running, and the backend maps it to `in-progress`.
 * - Never follows a redirect, and sends every attempt to the same URL, so a request never reaches
 *   a host the caller did not configure (R-SEC-2).
 * - Reads at most `maxResponseBytes` of a body. Once the headers arrived, a body that is too large,
 *   fails or stalls past the timeout is `unexpected-response`, never retried.
 * - Logs only the URL's origin and path, with `?REDACTED` in place of a query string, through the
 *   redacting logger, with the backend, method, URL and attempt as fields (R-SEC-1, R-DX-5). A
 *   retry is logged at `warn`; a failure the call throws is never logged at `error`.
 * - Emits a `verify.retry` event before each retry wait (R-DX-6).
 * - A logger or `onEvent` callback that throws does not change the request (decision 0010).
 * - Reads each field of `ctx`, of its budget and observer, and of `req` once, as an own property,
 *   so this layer never uses a value added to `Object.prototype` (R-SEC-2). The `RequestInit` it
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
 *   number; `network` when no attempt got a response; `rate-limited` when the last one got a 429;
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
  const where = { backend: call.backend, method: call.method, url };

  let attempt = 0;
  let failure: Failure | undefined;
  let delayMs: number | undefined;
  do {
    if (failure !== undefined && delayMs !== undefined) {
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
      emit({
        type: "verify.retry",
        backend: call.backend,
        attempt: next,
        reason: failure.reason,
        delayMs,
      });
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
      throw new ExplorerVerifyError(
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
    failure = result;
    delayMs =
      attempt < maxAttempts
        ? retryDelay(budget, call.retry, attempt, result, call.random)
        : undefined;
  } while (delayMs !== undefined);
  throw giveUp(call, target, attempt, failure);
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
 * of another object throws "Illegal invocation". Without it, `globalThis.fetch` is read now, when
 * the request starts. The headers are copied, so a getter on them runs here and only once.
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
  return {
    backend: required(ctx, "backend", "context"),
    send: optional(ctx, "fetch", "context") ?? globalThis.fetch,
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
    url: required(req, "url", "request"),
    method: required(req, "method", "request"),
    body: optional(req, "body", "request"),
    headers: headers === undefined ? undefined : copyHeaders(headers),
    retry: required(req, "retry", "request"),
  };
}

/**
 * The own property `name` of `value`, read once, or `undefined` when `value` does not have it.
 *
 * @throws ExplorerVerifyError `invalid-input`, without the thrown error, when a getter or Proxy
 *   trap throws: the error may repeat a caller value (R-SEC-1).
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
  return new ExplorerVerifyError(
    { code: "invalid-input", issues: [{ field, message }] },
    `The HTTP request is invalid: ${field} ${message}.`,
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
    throw new ExplorerVerifyError(
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
  const budgetLeft = budget === undefined ? Infinity : budget.deadline - Date.now();
  const limitMs = timerMs(Math.min(requestTimeoutMs, budgetLeft));
  // Set when the budget ends before the per-request timeout: the timer then means `timeout`.
  const budgetTimeoutMs =
    budget !== undefined && budgetLeft <= requestTimeoutMs ? budget.timeoutMs : undefined;
  const controller = new AbortController();
  const caller = call.signal;
  const progress: Progress = { status: undefined };

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
    // no timer behind.
    caller?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      if (settle()) {
        // Only a per-request timeout uses this message; a budget timeout becomes `timeout`.
        const cause = new DOMException(
          `The request took longer than ${String(timerMs(requestTimeoutMs))} ms.`,
          "TimeoutError",
        );
        controller.abort(cause);
        resolve(timedOut(budgetTimeoutMs, progress, cause));
      }
    }, limitMs);

    const run = async (): Promise<void> => {
      let result: Attempt;
      try {
        result = await exchange(call, controller.signal, progress);
      } catch (error: unknown) {
        result = { kind: "retry", reason: "network", cause: error };
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
  return { kind: "retry", reason: "network", cause };
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
  const { send } = call;
  const response = await send(call.url, init);
  const { status } = response;
  progress.status = status;

  if (isRedirect(response, call.url)) {
    discard(response);
    return { kind: "fatal", status, excerpt: "", message: REDIRECT_MESSAGE };
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
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

  if (status === 429 && !isDuplicate(body)) {
    return {
      kind: "retry",
      reason: "rate-limited",
      status,
      body,
      retryAfterMs: retryAfter(response),
    };
  }
  if (isRetriedServerError(status, call.retry)) {
    return {
      kind: "retry",
      reason: "server-error",
      status,
      body,
      retryAfterMs: retryAfter(response),
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
 * Whether the response is a redirect or came from somewhere else: an opaque redirect, a 3xx, a
 * response that says it was redirected, or one whose URL has another origin. The last two catch an
 * injected `fetch` that ignores `redirect: "manual"`. The `Location` header is never read.
 */
function isRedirect(response: Response, url: string): boolean {
  const { status } = response;
  if (
    response.type === "opaqueredirect" ||
    response.redirected ||
    (status >= 300 && status < 400)
  ) {
    return true;
  }
  if (response.url === "") {
    return false;
  }
  try {
    return new URL(response.url).origin !== new URL(url).origin;
  } catch {
    return true;
  }
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
    return false;
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
 * to {@link MAX_RETRY_AFTER_MS}. `undefined` when the header is absent or cannot be read.
 */
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (value === undefined || value === "") {
    return undefined;
  }
  let ms: number;
  if (/^\d+$/.test(value)) {
    ms = Number(value) * 1_000;
  } else if (HTTP_DATE_START.test(value)) {
    // An HTTP date starts with the day name in all three formats of RFC 9110, section 5.6.7. The
    // check keeps `Date.parse` from reading a value such as `1.5` or `-1` as a date.
    ms = Math.max(0, Date.parse(value) - Date.now());
  } else {
    return undefined;
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
      error = new ExplorerVerifyError(
        { code: "network", backend: call.backend, attempts },
        `${target} got no response after ${tries}.`,
        { ...options, cause: failure.cause },
      );
      break;
    case "rate-limited": {
      const details: ErrorDetails = { code: "rate-limited", backend: call.backend, attempts };
      if (failure.retryAfterMs !== undefined) {
        details.retryAfterMs = failure.retryAfterMs;
      }
      error = new ExplorerVerifyError(
        details,
        `${target} answered 429 (rate limited) after ${tries}.`,
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
      };
      if (failure.retryAfterMs !== undefined) {
        details.retryAfterMs = failure.retryAfterMs;
      }
      error = new ExplorerVerifyError(
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
  return new ExplorerVerifyError(
    { code: "timeout", backend: call.backend, timeoutMs },
    `${target} did not finish within the ${String(timeoutMs)} ms budget.`,
    { secrets: call.secrets },
  );
}

/** A short reason for the retry log line. */
function describe(failure: Failure): string {
  return failure.reason === "network" ? "no response" : `answered ${String(failure.status)}`;
}

/**
 * The URL as a log line may show it: origin and path, then `?REDACTED` when there is a query
 * string, as `Route.redactedApiUrl` does (decision 0010). User name, password and fragment are
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
  const reason: unknown = signal?.reason;
  return reason;
}
