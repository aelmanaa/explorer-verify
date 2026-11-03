/**
 * The flow engine (R-FLOW-1 to R-FLOW-6): validate, route, look up, submit, poll and map the
 * outcome to one of three results or a typed error. It never branches on the backend: every
 * explorer call goes through the {@link Backend} interface.
 */
import type { BackendName } from "../backend-names.ts";
import type { Backend, Context, Match, PollOutcome, Target } from "../backends/backend.ts";
import { sourcify } from "../backends/sourcify.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import { MAX_TIMER_MS, REQUEST_TIMEOUT_MS, sleep } from "../http/fetch.ts";
import type { Budget, HttpContext } from "../http/fetch.ts";
import { validateInput } from "../input/validate.ts";
import { createObserver } from "../observe.ts";
import type { Observer } from "../observe.ts";
import { MIN_SECRET_LENGTH } from "../redact.ts";
import { resolveRoute } from "../routing/resolve.ts";
import type { Route } from "../routing/resolve.ts";
import type {
  Handle,
  Logger,
  RouteOverride,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../types.ts";
import { formatHandle, redactHandleLine } from "./format-handle.ts";

/** The default time budget of one call, polling included, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** The default wait between two status polls, in milliseconds. */
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
/** The shortest wait between two status polls, in milliseconds. A shorter `pollIntervalMs` is raised to it. */
export const MIN_POLL_INTERVAL_MS = 1_000;
/**
 * How many status polls in a row may fail with `network`, `rate-limited` or
 * `unexpected-response` before the call stops polling and ends with `not-confirmed`.
 */
export const MAX_POLL_FAILURES = 3;
// The poll errors that mean "no answer this time": polling goes on after them.
const POLL_FAILURES: readonly ExplorerVerifyError["code"][] = [
  "network",
  "rate-limited",
  "unexpected-response",
];

/**
 * What the flow engine takes besides the caller's input and options. `verify()` passes the
 * defaults; the tests pass a fixed `random` for the backoff jitter, or a backend table without a
 * client to reach the error for it.
 */
export interface FlowDependencies {
  /** The client of each backend. */
  readonly backends: Readonly<Partial<Record<BackendName, Backend>>>;
  /** A number in `[0, 1)` for the backoff jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
}

const DEFAULT_DEPENDENCIES: FlowDependencies = { backends: { sourcify } };

/** The caller's options, each read once, with the defaults applied and the durations checked. */
interface Settings {
  readonly fetch: typeof fetch | undefined;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly logger: Logger | undefined;
  readonly onEvent: VerifyOptions["onEvent"];
  readonly route: RouteOverride | undefined;
}

/** Everything one call shares once the route is known. */
interface Call {
  readonly backend: Backend;
  readonly ctx: Context;
  readonly budget: Budget;
  readonly target: Target;
  readonly settings: Settings;
  readonly observer: Observer;
}

/**
 * How polling ended: a final outcome, or no answer in time. `budget` means the time budget ran
 * out; `failures` means {@link MAX_POLL_FAILURES} polls in a row failed. `cause` is the last poll
 * error, when there was one.
 */
type Polled =
  | { readonly kind: "done"; readonly outcome: Final }
  | {
      readonly kind: "stopped";
      readonly why: "budget" | "failures";
      readonly cause: ExplorerVerifyError | undefined;
    };

/** A poll outcome that ends polling. */
type Final = Exclude<PollOutcome, { readonly state: "pending" }>;

/**
 * Verifies a deployed contract's source on the explorer the route names (R-FLOW-1 to R-FLOW-6).
 *
 * 1. Validates the input and the options, and resolves the route. Nothing is sent before both
 *    pass (R-IN-6).
 * 2. Looks the contract up. When the explorer already holds an `exact` or `partial` match, it
 *    returns `already-verified` with that match and sends no submission (R-FLOW-1).
 * 3. Submits the source. This is outward and permanent: the explorer publishes it. When the
 *    explorer answers that the contract is already verified, it returns `already-verified`.
 * 4. Polls the job every `pollIntervalMs` until it ends or `timeoutMs` is spent (R-FLOW-2). The
 *    budget covers every request, the submit and its retries included.
 * 5. Maps the outcome (R-FLOW-3, R-FLOW-4): `verified` with the match, `already-verified` when
 *    the job found the contract verified, or `failed` with the explorer's reason, only for a
 *    definitive rejection. Any other final state throws.
 * 6. When the budget runs out while the job is still pending, it looks the contract up once more,
 *    within one more `pollIntervalMs`: some explorers finish before their status endpoint says so.
 *    A match returns `verified`; otherwise it throws `not-confirmed` with the handle.
 *
 * So the call ends within `timeoutMs` plus one `pollIntervalMs`.
 *
 * `already-verified` can describe a verification this call caused. When the submit got no clear
 * answer, the client looks the contract up before it submits again; if the first submit was
 * accepted and has finished, that lookup finds the contract verified.
 *
 * The handle is passed to `onEvent` in a `verify.submitted` event, and logged at `info`, as soon as
 * the explorer accepts the submission, so a call that is aborted or that crashes after that point
 * can still be resumed (R-FLOW-5).
 *
 * @param input - What to verify. It is checked with `validateInput` first.
 * @param options - Fetch, abort signal, time budget, poll interval, logger, event callback and
 *   route. Every field is optional.
 * @returns `verified` or `already-verified` with the match and, when the library knows one, the
 *   public page of the contract; or `failed` with the explorer's reason, API keys removed.
 * @throws The caller's `signal.reason`, unchanged, when the signal aborts (R-FLOW-6).
 * @throws ExplorerVerifyError with `invalid-input` for bad input or options; `unsupported-chain`;
 *   `timeout` when the budget runs out before the explorer accepts the submission;
 *   `not-confirmed`, with the handle, when it runs out while the job is pending;
 *   `verification-inconclusive` when the job ends without a verdict; `unknown-state` for a final
 *   state the library cannot classify; `in-progress`, `job-not-found`, `network`, `rate-limited`
 *   and `unexpected-response`. See the error reference for each.
 * @example
 * ```ts
 * import { ExplorerVerifyError, verify } from "explorer-verify";
 *
 * try {
 *   const result = await verify(input, { timeoutMs: 60_000 });
 *   if (result.status === "failed") {
 *     console.error(`Rejected: ${result.reason}`);
 *   } else {
 *     console.log(`${result.status} (${result.match}) ${result.explorerUrl ?? ""}`);
 *   }
 * } catch (error) {
 *   if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
 *     localStorage.setItem("pending-verification", JSON.stringify(error.details.handle));
 *   } else {
 *     throw error;
 *   }
 * }
 * ```
 * @experimental
 */
export async function verify(input: VerifyInput, options?: VerifyOptions): Promise<VerifyResult> {
  return await runVerify(input, options, DEFAULT_DEPENDENCIES);
}

/**
 * {@link verify} with its dependencies passed in. Internal: the package entry point does not
 * export it.
 *
 * @param input - What to verify.
 * @param options - The caller's options.
 * @param dependencies - The backend clients and the jitter source.
 * @returns The result.
 * @example
 * ```ts
 * const result = await runVerify(input, { fetch }, { backends: { sourcify }, random: () => 0 });
 * ```
 */
export async function runVerify(
  input: VerifyInput,
  options: VerifyOptions | undefined,
  dependencies: FlowDependencies,
): Promise<VerifyResult> {
  const settings = settingsOf(options);
  settings.signal?.throwIfAborted();
  const checked = validateInput(input);
  const route = resolveRoute(checked.chainId, settings.route);
  const backend = backendOf(route, dependencies);
  const secrets = routeSecrets(route, checked.chainId, checked.address, backend.name);
  // The one observer of this call: every request, retry and stage goes through it, so a broken
  // `onEvent` is reported once per call (decision 0010).
  const observer = createObserver({
    logger: settings.logger,
    onEvent: settings.onEvent,
    secrets,
  });
  const budget: Budget = {
    deadline: Date.now() + settings.timeoutMs,
    timeoutMs: settings.timeoutMs,
  };
  const call: Call = {
    backend,
    ctx: { route, http: httpContext(route, settings, observer, secrets, budget, dependencies) },
    budget,
    target: { chainId: checked.chainId, address: checked.address },
    settings,
    observer,
  };
  const { emit, log } = observer;
  emit({ type: "verify.validated", chainId: checked.chainId, address: checked.address });
  emit({ type: "verify.routed", backend: backend.name, apiHost: new URL(route.apiBase).host });
  log.debug(`Verifying ${checked.address} on chain ${String(checked.chainId)}`, {
    backend: backend.name,
    chainId: checked.chainId,
    api: route.redactedApiUrl,
  });

  const found = await backend.lookup(call.target, call.ctx);
  emit({ type: "verify.lookup", backend: backend.name, match: found ?? "none" });
  if (found !== undefined) {
    return finish(call, "already-verified", found);
  }

  const submitted = await backend.submit(checked, call.ctx);
  if (submitted.state === "already-verified") {
    return finish(call, "already-verified", submitted.match);
  }
  const { handle } = submitted;
  const line = formatHandle(handle);
  emit({ type: "verify.submitted", backend: backend.name, handle: line });
  // The same rule as the event: a job id shaped like a key stays, so the line still resumes.
  const logged = redactHandleLine(line, secrets);
  log.info(`${backend.name} accepted the submission. Resume it with this handle: ${logged}`, {
    backend: backend.name,
    handle: logged,
  });

  const polled = await pollUntilDone(call, handle);
  if (polled.kind === "stopped") {
    return await lastLookup(call, handle, polled);
  }
  const { outcome } = polled;
  if (outcome.state === "verified") {
    return finish(call, "verified", outcome.match);
  }
  if (outcome.state === "already-verified") {
    return finish(call, "already-verified", outcome.match ?? (await gradeOf(call, handle)));
  }
  return failed(call, outcome.reason);
}

/**
 * Reads each option once, applies the defaults and checks every option but `route`, which
 * `resolveRoute` checks. Only own properties are read, each once, so a polluted `Object.prototype`
 * cannot add an option, and a getter or Proxy that throws gives `invalid-input` without its text.
 *
 * - `timeoutMs` must be a positive finite number; one above {@link MAX_TIMER_MS} is clamped to it,
 *   because a longer `setTimeout` fires at once.
 * - `pollIntervalMs` must be a positive finite number; it is clamped to between
 *   {@link MIN_POLL_INTERVAL_MS} and {@link MAX_TIMER_MS}.
 * - `signal` must be an `AbortSignal`, `fetch` and `onEvent` functions, and `logger` an object.
 */
function settingsOf(options: VerifyOptions | undefined): Settings {
  if (options === undefined) {
    return {
      fetch: undefined,
      signal: undefined,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      logger: undefined,
      onEvent: undefined,
      route: undefined,
    };
  }
  const raw: unknown = options;
  if (typeof raw !== "object" || raw === null) {
    throw invalidOptions([{ field: "options", message: "must be an object" }]);
  }
  let read: Settings;
  const issues: InputIssue[] = [];
  try {
    const signal = own(options, "signal");
    const fetchOption = own(options, "fetch");
    // The only place the caller's logger is read. createObserver wraps it with the redacting
    // logger, and every later step gets only the wrapped one (R-SEC-1).
    const logger = own(options, "logger");
    const onEvent = own(options, "onEvent");
    read = {
      signal,
      fetch: fetchOption,
      logger,
      onEvent,
      route: own(options, "route"),
      timeoutMs: duration(own(options, "timeoutMs"), DEFAULT_TIMEOUT_MS, 1, "timeoutMs", issues),
      pollIntervalMs: duration(
        own(options, "pollIntervalMs"),
        DEFAULT_POLL_INTERVAL_MS,
        MIN_POLL_INTERVAL_MS,
        "pollIntervalMs",
        issues,
      ),
    };
  } catch {
    // A getter or Proxy trap threw. Its error is dropped: it may repeat a caller value.
    throw invalidOptions([{ field: "options", message: "could not be read" }]);
  }
  checkKinds(read, issues);
  if (issues.length > 0) {
    throw invalidOptions(issues);
  }
  return read;
}

/** An own option, read once, or `undefined` when `options` does not have it. */
function own<K extends keyof VerifyOptions>(
  options: VerifyOptions,
  name: K,
): VerifyOptions[K] | undefined {
  return Object.hasOwn(options, name) ? options[name] : undefined;
}

/** Adds an issue for each of `signal`, `fetch`, `logger` and `onEvent` of the wrong kind. */
function checkKinds(settings: Settings, issues: InputIssue[]): void {
  const signal: unknown = settings.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    issues.push({ field: "signal", message: "must be an AbortSignal" });
  }
  const checks: [field: string, value: unknown, kinds: readonly string[]][] = [
    ["fetch", settings.fetch, ["function"]],
    ["logger", settings.logger, ["object", "function"]],
    ["onEvent", settings.onEvent, ["function"]],
  ];
  for (const [field, value, kinds] of checks) {
    if (value !== undefined && (value === null || !kinds.includes(typeof value))) {
      issues.push({
        field,
        message: kinds.length === 1 ? "must be a function" : "must be an object",
      });
    }
  }
}

/**
 * A duration option clamped to `[floor, MAX_TIMER_MS]`, the fallback when it is absent, or an
 * issue when it is not a positive finite number.
 */
function duration(
  value: unknown,
  fallback: number,
  floor: number,
  field: string,
  issues: InputIssue[],
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    issues.push({ field, message: "must be a positive finite number of milliseconds" });
    return fallback;
  }
  return Math.min(Math.max(value, floor), MAX_TIMER_MS);
}

function invalidOptions(issues: InputIssue[]): ExplorerVerifyError {
  return new ExplorerVerifyError(
    { code: "invalid-input", issues },
    `The options are invalid: ${issues.map((issue) => issue.field).join(", ")}.`,
    {
      hint: "Pass options as a plain object: timeoutMs and pollIntervalMs as positive numbers of milliseconds, signal as an AbortSignal, fetch and onEvent as functions, logger as an object. Leave out any you do not need.",
      secrets: [],
    },
  );
}

/** The client for the route's backend, or `invalid-input` when this version has none. */
function backendOf(route: Route, dependencies: FlowDependencies): Backend {
  const backend = dependencies.backends[route.backend];
  if (backend === undefined) {
    throw new ExplorerVerifyError(
      {
        code: "invalid-input",
        issues: [{ field: "route.backend", message: "has no client in this version" }],
      },
      `There is no ${route.backend} client in this version.`,
      { secrets: [] },
    );
  }
  return backend;
}

/**
 * The values of the route's query string, as secrets of the call. A caller who puts a key in
 * `route.apiUrl`'s query gets it removed from errors, logs, events and results, even where an
 * explorer repeats it in an answer (R-SEC-1). Left out:
 *
 * - values shorter than {@link MIN_SECRET_LENGTH}, which redaction ignores;
 * - values of digits only, which would hide numbers such as a chain id;
 * - values found in the handle's fixed part, `ev1:<backend>:<chainId>:<address>`, so the handle,
 *   the address and the chain id stay readable and the handle still resumes.
 */
function routeSecrets(
  route: Route,
  chainId: number,
  address: string,
  backend: BackendName,
): string[] {
  const visible = `ev1:${backend}:${String(chainId)}:${address}`.toLowerCase();
  const secrets: string[] = [];
  for (const value of new URL(route.requestUrl("/")).searchParams.values()) {
    if (
      value.length >= MIN_SECRET_LENGTH &&
      !/^\d+$/.test(value) &&
      !visible.includes(value.toLowerCase())
    ) {
      secrets.push(value);
    }
  }
  return secrets;
}

/** `globalThis.fetch`, read when each request starts and called as a plain function. */
const defaultFetch: typeof fetch = async (request, init) => await globalThis.fetch(request, init);

/** The HTTP context every request of the call shares. */
function httpContext(
  route: Route,
  settings: Settings,
  observer: Observer,
  secrets: readonly string[],
  budget: Budget,
  dependencies: FlowDependencies,
): HttpContext {
  return {
    backend: route.backend,
    secrets,
    observer,
    budget,
    // Always set, so a `fetch` added to `Object.prototype` can never stand in for the default.
    fetch: settings.fetch ?? defaultFetch,
    ...(settings.signal === undefined ? {} : { signal: settings.signal }),
    ...(dependencies.random === undefined ? {} : { random: dependencies.random }),
  };
}

/**
 * Polls the job until it ends, waiting `pollIntervalMs` before each poll.
 *
 * A poll that fails with `network`, `rate-limited` or `unexpected-response`, after the HTTP
 * layer's own retries, is logged at `warn` and polling goes on: the job exists, and the next poll
 * may answer. Polling stops when the budget runs out, including during a poll's request, or after
 * {@link MAX_POLL_FAILURES} failed polls in a row. The job id exists, so the call then ends with
 * `not-confirmed`, never `timeout`.
 */
async function pollUntilDone(call: Call, handle: Handle): Promise<Polled> {
  const { backend, ctx, settings, observer } = call;
  const { deadline } = call.budget;
  let attempt = 0;
  let failures = 0;
  let cause: ExplorerVerifyError | undefined;
  for (;;) {
    // A wait never passes the deadline. When the deadline has passed, it waits no time and the
    // check below ends polling.
    await sleep(
      Math.max(0, Math.min(settings.pollIntervalMs, deadline - Date.now())),
      settings.signal,
    );
    if (deadline - Date.now() <= 0) {
      return { kind: "stopped", why: "budget", cause };
    }
    attempt += 1;
    let outcome: PollOutcome;
    try {
      outcome = await backend.poll(handle, ctx);
    } catch (error: unknown) {
      if (settings.signal?.aborted === true || !(error instanceof ExplorerVerifyError)) {
        throw error;
      }
      if (error.code === "timeout") {
        return { kind: "stopped", why: "budget", cause: error };
      }
      if (!POLL_FAILURES.includes(error.code)) {
        throw error;
      }
      failures += 1;
      cause = error;
      observer.log.warn(
        `${backend.name} status poll ${String(attempt)} for job ${handle.jobId} failed (${error.code}); ${failures < MAX_POLL_FAILURES ? "polling again" : "giving up polling"}`,
        { backend: backend.name, attempt, code: error.code, failures },
      );
      if (failures >= MAX_POLL_FAILURES) {
        return { kind: "stopped", why: "failures", cause };
      }
      continue;
    }
    failures = 0;
    if (outcome.state !== "pending") {
      return { kind: "done", outcome };
    }
    observer.emit({ type: "verify.poll", backend: backend.name, attempt, state: "pending" });
    observer.log.debug(`${backend.name} job ${handle.jobId} is pending (poll ${String(attempt)})`, {
      backend: backend.name,
      attempt,
    });
  }
}

/**
 * The lookup after polling stopped with no verdict. A match means the explorer verified the
 * contract and its status endpoint lags behind or failed: the result is `verified`. Anything else,
 * a failed lookup included, throws `not-confirmed` with the handle. Its cause is the last poll
 * error, or else the lookup's error.
 */
async function lastLookup(
  call: Call,
  handle: Handle,
  stopped: Extract<Polled, { kind: "stopped" }>,
): Promise<VerifyResult> {
  const { backend, settings, observer } = call;
  observer.log.debug(
    `Polling ${backend.name} job ${handle.jobId} stopped (${stopped.why}); looking the contract up once more`,
    { backend: backend.name },
  );
  let match: Match | undefined;
  try {
    match = await backend.lookup(call.target, graceContext(call));
  } catch (error: unknown) {
    if (mustRethrow(error, settings.signal)) {
      throw error;
    }
    throw notConfirmed(call, handle, stopped.why, stopped.cause ?? error);
  }
  if (match !== undefined) {
    return finish(call, "verified", match);
  }
  throw notConfirmed(call, handle, stopped.why, stopped.cause);
}

/**
 * The match of a job that found the contract already verified without saying the grade: one
 * lookup. A lookup that fails or says "not verified" throws `unknown-state`, never a guess.
 */
async function gradeOf(call: Call, handle: Handle): Promise<Match> {
  const { backend, settings, ctx } = call;
  let match: Match | undefined;
  let cause: unknown;
  try {
    match = await backend.lookup(call.target, graceContext(call));
  } catch (error: unknown) {
    if (mustRethrow(error, settings.signal)) {
      throw error;
    }
    cause = error;
  }
  if (match !== undefined) {
    return match;
  }
  const excerpt =
    cause instanceof ExplorerVerifyError && cause.details.code === "unexpected-response"
      ? cause.details.excerpt
      : "";
  const what =
    cause === undefined
      ? "the lookup says it is not verified"
      : "the lookup to read its match failed";
  throw new ExplorerVerifyError(
    { code: "unknown-state", handle, excerpt },
    `${backend.name} job ${handle.jobId} found the contract already verified, but ${what}; the match is not known.`,
    cause === undefined ? { secrets: ctx.http.secrets } : { secrets: ctx.http.secrets, cause },
  );
}

/**
 * Whether `error` must reach the caller unchanged: the abort reason once the signal aborted, or
 * anything that is not an `ExplorerVerifyError`. Otherwise the flow maps it to its own error.
 */
function mustRethrow(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || !(error instanceof ExplorerVerifyError);
}

/**
 * The call's context with a budget that lasts at least one grace window from now, for the lookups
 * after polling. The window is `pollIntervalMs`, at most {@link REQUEST_TIMEOUT_MS}, so a server
 * that never answers cannot hold the call much past its budget: the call ends by `timeoutMs`
 * plus `min(pollIntervalMs, 30000)`.
 */
function graceContext(call: Call): Context {
  const { ctx, settings, budget } = call;
  const grace = Math.min(settings.pollIntervalMs, REQUEST_TIMEOUT_MS);
  const deadline = Math.max(budget.deadline, Date.now() + grace);
  return { route: ctx.route, http: { ...ctx.http, budget: { ...budget, deadline } } };
}

/**
 * `not-confirmed`: the job may still be running, and `checkStatus` with the handle continues.
 * The message says why polling stopped: the budget ran out, or the status polls kept failing.
 */
function notConfirmed(
  call: Call,
  handle: Handle,
  why: "budget" | "failures",
  cause: unknown,
): ExplorerVerifyError {
  const { backend, settings, ctx } = call;
  const reason =
    why === "budget"
      ? `the ${String(settings.timeoutMs)} ms budget ran out`
      : `${String(MAX_POLL_FAILURES)} status polls in a row failed`;
  const message = `The verification of job ${handle.jobId} on ${backend.name} is not confirmed: ${reason} before the job ended, and a last lookup found no match.`;
  return new ExplorerVerifyError(
    { code: "not-confirmed", handle },
    message,
    cause === undefined ? { secrets: ctx.http.secrets } : { secrets: ctx.http.secrets, cause },
  );
}

/** A success result, with the public page when the library knows one. Emits `verify.result`. */
function finish(call: Call, status: "verified" | "already-verified", match: Match): VerifyResult {
  const { backend, ctx, target, observer } = call;
  const explorerUrl = backend.explorerUrl(target, ctx);
  const result: VerifyResult =
    explorerUrl === undefined
      ? { status, backend: backend.name, match }
      : { status, backend: backend.name, match, explorerUrl };
  report(observer, { type: "verify.result", backend: backend.name, status, match });
  return result;
}

/**
 * A `failed` result. `reason` comes from the client, already redacted with the call's keys and cut
 * to 300 characters. Emits `verify.result`.
 */
function failed(call: Call, reason: string): VerifyResult {
  const { backend, observer } = call;
  report(observer, { type: "verify.result", backend: backend.name, status: "failed" });
  return { status: "failed", backend: backend.name, reason };
}

/** Emits the result event and logs it at `info`. */
function report(observer: Observer, event: Extract<VerifyEvent, { type: "verify.result" }>): void {
  observer.emit(event);
  observer.log.info(
    `Result: ${event.status}${event.status === "failed" ? "" : ` (${event.match})`} on ${event.backend}`,
    { backend: event.backend, status: event.status },
  );
}
