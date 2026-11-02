/**
 * The HTTP layer every backend client uses (R-FLOW-6, R-SRV-5). It sends each request through the
 * caller's `fetch`, retries transient failures with backoff, enforces a per-request timeout and
 * the call's time budget, and stops at once on abort.
 *
 * Only web-platform globals are used: `fetch`, `Response`, `AbortController`, `AbortSignal`,
 * `DOMException`, `URL`, `Date` and `setTimeout` (decision 0002, R-RUN-1). Two newer helpers are
 * avoided on purpose:
 *
 * - `AbortSignal.timeout()`: in Node its timer does not keep the process alive, so a script that
 *   waits only on it exits with neither a result nor an error. The `node:test` mock timers do not
 *   drive it either. A `setTimeout` and an `AbortController` do both.
 * - `AbortSignal.any()`: missing before Safari 17.4. One `AbortController` per attempt, with a
 *   listener on the caller's signal that is removed when the attempt ends, does the same.
 */
import type { BackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import { redactingLogger } from "../redact.ts";
import type { Logger } from "../types.ts";

/** The most requests one {@link request} call sends, the first one included. */
export const MAX_ATTEMPTS = 5;
/** The backoff before the second attempt, before jitter, in milliseconds. */
export const BASE_DELAY_MS = 1_000;
/** The longest wait between two attempts, in milliseconds. A longer `Retry-After` ends the retries. */
export const MAX_DELAY_MS = 30_000;
/** The default limit for one request, body included, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 30_000;

// Sourcify's code for a 429 that means "a job for this contract is already running". It is not a
// rate limit, so it is returned to the backend, which maps it to `in-progress`. Source: the
// Sourcify OpenAPI spec, version 2.1.0 (docs/contributor/research/2026-11-02-explorer-apis.md).
const DUPLICATE_CODE = "duplicate_verification_request";
// Statuses whose body must be empty: `new Response` rejects a body with them.
const NULL_BODY_STATUSES: readonly number[] = [204, 205, 304];
// The day name that starts every HTTP date format: `Sun, 06 Nov 1994 08:49:37 GMT`,
// `Sunday, 06-Nov-94 08:49:37 GMT` and `Sun Nov  6 08:49:37 1994`.
const HTTP_DATE_START = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i;

/**
 * What a request is allowed to retry.
 *
 * - `safe`: a read, or a write the explorer treats as idempotent. Retries network errors,
 *   timeouts, 429, 502, 503 and 504.
 * - `submit`: a verification submit. Retries only when no response arrived (a network error or a
 *   timeout), 429 and 503. Never a 500, 502 or 504, so a submit the explorer may have processed is
 *   not repeated blindly.
 */
export type RetryMode = "safe" | "submit";

/** Why a request is retried. The values match the `reason` of decision 0010's `verify.retry`. */
export type RetryReason = "rate-limited" | "network" | "server-error";

/**
 * One retry, reported to {@link HttpContext.onRetry} before the wait starts.
 *
 * @example
 * ```ts
 * const notice: RetryNotice = { attempt: 2, reason: "server-error", delayMs: 1_000 };
 * ```
 */
export interface RetryNotice {
  /** The number of the attempt that follows the wait: 2 for the first retry. */
  readonly attempt: number;
  /** Why the previous attempt failed. */
  readonly reason: RetryReason;
  /** The wait before that attempt, in milliseconds. */
  readonly delayMs: number;
}

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
  /** Receives debug and retry lines. Every line passes the key redaction first (R-SEC-1). */
  readonly logger?: Logger;
  /** Key values to remove from log lines and errors. Pass `[]` when the call has no key. */
  readonly secrets: readonly string[];
  /** The limit for one request, body included. Defaults to {@link REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number;
  /** The call's time budget. Without it, only the per-request timeout applies. */
  readonly budget?: Budget;
  /** A number in `[0, 1)` for the backoff jitter. Defaults to `Math.random`. Tests fix it. */
  readonly random?: () => number;
  /** Called before each retry wait, so the caller can emit a `verify.retry` event. */
  readonly onRetry?: (notice: RetryNotice) => void;
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
  | { kind: "unreadable"; status: number; body: string }
  | { kind: "budget"; timeoutMs: number };

type Failure = Extract<Attempt, { kind: "retry" }>;

/**
 * Sends one request through the caller's `fetch`, with retries, a per-request timeout, the call's
 * time budget and abort (R-FLOW-6).
 *
 * - Retries with exponential backoff and jitter: base 1 s, doubled per attempt, capped at 30 s,
 *   at most 5 attempts. The jitter keeps between half and all of each step.
 * - Retries network errors, timeouts, 429 and, for `safe`, 502, 503 and 504; for `submit`, only
 *   network errors, timeouts, 429 and 503. Every other status is returned to the caller.
 * - Waits at least as long as `Retry-After` asks, in seconds or as an HTTP date. A `Retry-After`
 *   above 30 s, or a wait that would pass the budget's deadline, ends the retries at once.
 * - Returns a 429 whose JSON body has `customCode` `duplicate_verification_request` without a
 *   retry: a job for this contract is already running, and the backend maps it to `in-progress`.
 * - Sends every attempt to the same URL, so a retry never changes the host (R-SEC-2).
 * - Logs only the URL's origin and path, with `?REDACTED` in place of a query string, through the
 *   redacting logger (R-SEC-1, decision 0010).
 *
 * The returned response's body is already read into memory, inside the timeout and the abort, so
 * reading it cannot hang.
 *
 * @param ctx - What the call's requests share: `fetch`, signal, logger, keys and budget.
 * @param req - The request.
 * @returns The first response that is not retried.
 * @throws The caller's `signal.reason`, unchanged, when the signal aborts.
 * @throws ExplorerVerifyError `network` when no attempt got a response, `rate-limited` when the
 *   last one got a 429, `unexpected-response` when it got a 5xx or a response that cannot be read,
 *   and `timeout` when the budget ran out.
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
  ctx.signal?.throwIfAborted();
  // Read once, then called as a plain function: a browser's fetch called as a method of another
  // object throws "Illegal invocation".
  const send = ctx.fetch ?? globalThis.fetch;
  const log = ctx.logger === undefined ? undefined : redactingLogger(ctx.logger, ctx.secrets);
  const target = `${req.method} ${loggableUrl(req.url)}`;
  const random = ctx.random ?? Math.random;

  const budget = ctx.budget;
  let attempt = 0;
  let failure: Failure | undefined;
  let delayMs: number | undefined;
  do {
    if (failure !== undefined && delayMs !== undefined) {
      log?.warn(
        `${target}: ${describe(failure)}; retrying in ${String(delayMs)} ms (attempt ${String(attempt + 1)} of ${String(MAX_ATTEMPTS)})`,
      );
      ctx.onRetry?.({ attempt: attempt + 1, reason: failure.reason, delayMs });
      await sleep(delayMs, ctx.signal);
    }
    attempt += 1;
    if (budget !== undefined && budget.deadline - Date.now() <= 0) {
      throw timeoutError(ctx, target, budget.timeoutMs);
    }
    log?.debug(`${target}: attempt ${String(attempt)} of ${String(MAX_ATTEMPTS)}`);
    const result = await attemptOnce(send, ctx, req);
    if (result.kind === "response") {
      return result.response;
    }
    if (result.kind === "budget") {
      throw timeoutError(ctx, target, result.timeoutMs);
    }
    if (result.kind === "unreadable") {
      throw new ExplorerVerifyError(
        {
          code: "unexpected-response",
          backend: ctx.backend,
          status: result.status,
          excerpt: result.body,
        },
        `${target} returned a response with status ${String(result.status)}, which cannot be read.`,
        { secrets: ctx.secrets },
      );
    }
    failure = result;
    delayMs = attempt < MAX_ATTEMPTS ? retryDelay(budget, attempt, result, random) : undefined;
  } while (delayMs !== undefined);
  throw giveUp(ctx, target, attempt, failure);
}

/**
 * Waits `ms` milliseconds, or rejects with `signal.reason` as soon as the signal aborts. It uses
 * `setTimeout`, whose timer keeps a Node process alive while it waits; a timer that does not, such
 * as the one behind `AbortSignal.timeout()`, let the process exit mid-poll with neither a result
 * nor an error. The abort listener is removed on both paths, so a long-lived signal collects none.
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
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(reasonOf(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One attempt: the fetch and the body read, raced against the caller's abort and a timer set to
 * the per-request timeout or the budget's deadline, whichever comes first. The race settles even
 * when the caller's `fetch` ignores the signal.
 */
async function attemptOnce(
  send: typeof fetch,
  ctx: HttpContext,
  req: HttpRequest,
): Promise<Attempt> {
  const requestTimeoutMs = ctx.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const budget = ctx.budget;
  const budgetLeft = budget === undefined ? Infinity : budget.deadline - Date.now();
  // Set when the budget ends before the per-request timeout: the timer then means `timeout`.
  const budgetTimeoutMs =
    budget !== undefined && budgetLeft <= requestTimeoutMs ? budget.timeoutMs : undefined;
  const controller = new AbortController();
  const caller = ctx.signal;

  return await new Promise<Attempt>((resolve, reject) => {
    let settled = false;
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
    const timer = setTimeout(
      () => {
        if (settle()) {
          const ms = Math.min(requestTimeoutMs, budgetLeft);
          const cause = new DOMException(
            `The request took longer than ${String(ms)} ms.`,
            "TimeoutError",
          );
          controller.abort(cause);
          resolve(
            budgetTimeoutMs === undefined
              ? { kind: "retry", reason: "network", cause }
              : { kind: "budget", timeoutMs: budgetTimeoutMs },
          );
        }
      },
      Math.min(requestTimeoutMs, budgetLeft),
    );
    caller?.addEventListener("abort", onAbort, { once: true });

    const run = async (): Promise<void> => {
      let result: Attempt;
      try {
        result = await exchange(send, req, controller.signal);
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

/** The fetch and the body read, classified. Throws when no complete response arrived. */
async function exchange(
  send: typeof fetch,
  req: HttpRequest,
  signal: AbortSignal,
): Promise<Attempt> {
  const init: RequestInit = { method: req.method, signal };
  if (req.body !== undefined) {
    init.body = req.body;
  }
  if (req.headers !== undefined) {
    init.headers = { ...req.headers };
  }
  const response = await send(req.url, init);
  const body = await response.text();
  const { status } = response;

  if (status === 429 && !isDuplicate(body)) {
    return {
      kind: "retry",
      reason: "rate-limited",
      status,
      body,
      retryAfterMs: retryAfter(response),
    };
  }
  if (isRetriedServerError(status, req.retry)) {
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
    return { kind: "unreadable", status, body };
  }
  return {
    kind: "response",
    response: new Response(NULL_BODY_STATUSES.includes(status) ? null : body, {
      status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
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
 * `Retry-After` in milliseconds: whole seconds, or an HTTP date relative to `Date.now()`, at
 * least 0. `undefined` when the header is absent or cannot be read.
 */
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (value === undefined || value === "") {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value) * 1_000;
  }
  // An HTTP date starts with the day name in all three formats of RFC 9110, section 5.6.7. The
  // check keeps `Date.parse` from reading a value such as `1.5` or `-1` as a date.
  const at = HTTP_DATE_START.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * The wait before the next attempt: exponential backoff with jitter, at least `Retry-After`.
 * `undefined` when the retries must stop: `Retry-After` is above {@link MAX_DELAY_MS}, or the wait
 * would end at or after the budget's deadline.
 */
function retryDelay(
  budget: Budget | undefined,
  attempt: number,
  failure: Failure,
  random: () => number,
): number | undefined {
  const step = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  let delayMs = Math.round(step / 2 + (random() * step) / 2);
  if (failure.reason !== "network" && failure.retryAfterMs !== undefined) {
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
  ctx: HttpContext,
  target: string,
  attempts: number,
  failure: Failure,
): ExplorerVerifyError {
  const tries = `${String(attempts)} ${attempts === 1 ? "attempt" : "attempts"}`;
  const options = { secrets: ctx.secrets };
  let error: ExplorerVerifyError;
  switch (failure.reason) {
    case "network":
      error = new ExplorerVerifyError(
        { code: "network", backend: ctx.backend, attempts },
        `${target} got no response after ${tries}.`,
        { ...options, cause: failure.cause },
      );
      break;
    case "rate-limited": {
      const details: ExplorerVerifyError["details"] = {
        code: "rate-limited",
        backend: ctx.backend,
        attempts,
      };
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
    case "server-error":
      error = new ExplorerVerifyError(
        {
          code: "unexpected-response",
          backend: ctx.backend,
          status: failure.status,
          excerpt: failure.body,
        },
        `${target} answered ${String(failure.status)} after ${tries}.`,
        options,
      );
      break;
  }
  return error;
}

/** The `timeout` error for a budget that ran out. */
function timeoutError(ctx: HttpContext, target: string, timeoutMs: number): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "timeout", backend: ctx.backend, timeoutMs },
    `${target} did not finish within the ${String(timeoutMs)} ms budget.`,
    { secrets: ctx.secrets },
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
