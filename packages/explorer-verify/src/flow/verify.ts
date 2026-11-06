/**
 * The flow engine (R-FLOW-1 to R-FLOW-6): validate, route, look up, submit, poll and map the
 * outcome to one of three results or a typed error. It never branches on the backend: every
 * explorer call goes through the {@link Backend} interface.
 */
import { BACKEND_NAMES } from "../backend-names.ts";
import type { BackendName } from "../backend-names.ts";
import type { Backend, Context, Match, PollOutcome, Target } from "../backends/backend.ts";
import { newError } from "../error-hints.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import { collisions, keyFor, readApiKeys, requireKey } from "../http/api-keys.ts";
import type { CheckedKeys, ApiKeysReader } from "../http/api-keys.ts";
import { MAX_TIMER_MS, platformFetch, REQUEST_TIMEOUT_MS, sleep } from "../http/fetch.ts";
import type { Budget, HttpContext } from "../http/fetch.ts";
import type { ResolvedHandler } from "../http/handler-url.ts";
import { endpointSecrets } from "../http/rpc.ts";
import type { Endpoint } from "../http/rpc.ts";
import type { withDerivedArgs as WithDerivedArgs } from "../input/constructor-args.ts";
import { validateInput } from "../input/validate.ts";
import { unknownKeys } from "../internal/known-keys.ts";
import { createObserver } from "../observe.ts";
import type { Observer } from "../observe.ts";
import {
  checkApiUrl,
  checkRoute,
  loadRoutingTable,
  readsTable,
  ETHERSCAN_API_URL,
  HANDLER_KEY,
  routeFrom,
  unsupported,
} from "../routing/resolve.ts";
import type { CheckedRoute, Route, RoutingTable, TableLoader } from "../routing/resolve.ts";
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

// The keys of `VerifyOptions`, as a record so that a field added to the type and not here fails
// to compile. `verify()`, `dryRun()`, `checkStatus()` and `linkProxy()` all accept every one of
// them at run time, so one options object can go to each (decision 0047); their types are narrower
// so that a misplaced key in an object literal fails to compile.
function verifyOptionKeys(): readonly string[] {
  return Object.keys({
    fetch: true,
    handlerUrl: true,
    signal: true,
    timeoutMs: true,
    pollIntervalMs: true,
    logger: true,
    onEvent: true,
    route: true,
    allowSourcifyFallback: true,
    apiKeys: true,
    rpcUrl: true,
  } satisfies Record<keyof VerifyOptions, true>);
}
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
 * Loads a backend's client. Each shipped client sits behind a dynamic `import()`, so a bundler
 * that splits code puts it in its own chunk, and a call loads only the client its route names
 * (decision 0031).
 */
export type ClientLoader = () => Promise<Backend>;

/** A backend's client, loaded, or the function that loads it. */
export type Client = Backend | ClientLoader;

/**
 * Loads the constructor argument derivation (R-IN-3). It sits behind a dynamic `import()`, so a
 * call that derives nothing does not load it (decisions 0031 and 0032).
 */
export type DeriveLoader = () => Promise<typeof WithDerivedArgs>;

/** The shipped derivation, loaded with a dynamic `import()` the first time a call derives. */
const loadDerivation: DeriveLoader = async () =>
  (await import("../input/constructor-args.ts")).withDerivedArgs;

/**
 * What the flow engine takes besides the caller's input and options. `verify()` passes the
 * defaults; the tests pass a fixed `random` for the backoff jitter, a backend table without a
 * client to reach the error for it, or a routing table with rows for clients to come.
 */
export interface FlowDependencies {
  /** The client of each backend, or the function that loads it. */
  readonly backends: Readonly<Partial<Record<BackendName, Client>>>;
  /** A number in `[0, 1)` for the backoff jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
  /**
   * The routing table, or the function that loads it. Defaults to {@link loadRoutingTable}, the
   * shipped one; the tests pass rows for clients to come.
   */
  readonly table?: RoutingTable | TableLoader;
  /** Loads the constructor argument derivation. Defaults to the shipped one; tests pass others. */
  readonly derivation?: DeriveLoader;
}

/**
 * The backend clients `verify()`, `checkStatus()` and `dryRun()` use. Each one loads through a
 * dynamic `import()` with a literal path, so a bundler that splits code puts it in a chunk of its
 * own, and a call loads only the client its route names (decision 0031).
 */
export const DEFAULT_DEPENDENCIES: FlowDependencies = {
  backends: {
    /** Loads the Sourcify client. */
    sourcify: async () => (await import("../backends/sourcify.ts")).sourcify,
    /** Loads the Etherscan v2 client. */
    "etherscan-v2": async () => (await import("../backends/etherscan.ts")).etherscan,
    /** Loads the standalone Etherscan-compatible client, which imports the Etherscan v2 client's request code. */
    "etherscan-compatible": async () =>
      (await import("../backends/etherscan-compatible.ts")).etherscanCompatible,
    /** Loads the Routescan client, which imports the Etherscan v2 client's request code. */
    routescan: async () => (await import("../backends/routescan.ts")).routescan,
    /** Loads the Blockscout client. */
    blockscout: async () => (await import("../backends/blockscout.ts")).blockscout,
    /** Loads the client for Blockscout's hosted API, from the same module (decision 0041). */
    "blockscout-hosted": async () => (await import("../backends/blockscout.ts")).blockscoutHosted,
  },
  /** Loads the routing table, only for a call without `route.apiUrl` (decision 0040). */
  table: loadRoutingTable,
};

/**
 * Starts a call's time budget: `settings.timeoutMs` from now. Each call takes it before it loads
 * its client, so the load counts against the budget too.
 *
 * @param settings - The options from {@link settingsOf}.
 * @returns The budget.
 * @example
 * ```ts
 * const budget = startBudget(settingsOf({ timeoutMs: 60_000 }));
 * ```
 */
export function startBudget(settings: Settings): Budget {
  return { deadline: Date.now() + settings.timeoutMs, timeoutMs: settings.timeoutMs };
}

/**
 * Loads the client of the route's backend when it is a {@link ClientLoader}, and returns the
 * dependencies with that client in place, ready for {@link openCall}. No other client loads. A
 * client already loaded, or missing, leaves the dependencies as they are: `openCall` throws
 * `unsupported-chain` for a missing one.
 *
 * The load ends when the caller's signal aborts, with `signal.reason`, or when the budget runs
 * out, with `timeout` (R-FLOW-6): a chunk that never arrives cannot hold the call.
 *
 * @param route - The resolved route.
 * @param dependencies - The backend clients, loaded or not.
 * @param settings - The options from {@link settingsOf}: the signal.
 * @param budget - The call's budget, from {@link startBudget}.
 * @returns The dependencies with the route's client loaded.
 * @throws The caller's `signal.reason` when the signal aborts; ExplorerVerifyError `timeout` when
 *   the budget runs out; what the loader throws, such as the error of a chunk that fails to load.
 * @example
 * ```ts
 * const budget = startBudget(settings);
 * const loaded = await withClient(route, DEFAULT_DEPENDENCIES, settings, budget);
 * const call = openCall(settings, route, target, loaded, true, budget);
 * ```
 */
export async function withClient(
  route: Route,
  dependencies: FlowDependencies,
  settings: Settings,
  budget: Budget,
): Promise<FlowDependencies> {
  const client = dependencies.backends[route.backend];
  if (typeof client !== "function") {
    return dependencies;
  }
  const backend = await bounded(
    client,
    LOADED,
    `the ${route.backend} client`,
    route.backend,
    settings.signal,
    budget,
  );
  return { ...dependencies, backends: { ...dependencies.backends, [route.backend]: backend } };
}

/**
 * Runs `load`, and rejects first when `signal` aborts or the budget runs out. `memo` keeps what
 * each loader gave, so a later call takes it at once. `what` names the code in the `timeout`
 * message, and `name` is the backend the `timeout` details name. `linkProxy()` loads its explorer
 * code through it too.
 *
 * @param load - Loads the module's export.
 * @param memo - What each loader gave.
 * @param what - The code, as `the sourcify client`.
 * @param name - The backend.
 * @param signal - The caller's signal.
 * @param budget - The call's budget.
 * @returns What `load` gives.
 * @throws The caller's `signal.reason` when the signal aborts; ExplorerVerifyError `timeout` when
 *   the budget runs out; what the loader throws.
 * @example
 * ```ts
 * const linker = await bounded(load, LINKERS, "the sourcify proxy-link code", "sourcify", signal, budget);
 * ```
 */
export async function bounded<T extends object>(
  load: () => Promise<T>,
  memo: WeakMap<() => Promise<T>, T>,
  what: string,
  name: BackendName,
  signal: AbortSignal | undefined,
  budget: Budget,
): Promise<T> {
  signal?.throwIfAborted();
  const cached = memo.get(load);
  if (cached !== undefined) {
    return cached;
  }
  // The deadline runs on AbortSignal.timeout, not setTimeout: a test or an app that fakes
  // setTimeout and Date and runs every timer at once cannot end a load that is about to settle.
  // Node's MockTimers does not drive it (checked on Node 22.18.0, 24.0.0 and 24.21.0). The load
  // itself is awaited directly: nothing here waits on a timer or a macrotask.
  // No setTimeout runs beside it, not even one that only keeps Node alive: a faked one would let
  // the fake clock jump to the deadline and spend the budget of every request after the load.
  const deadline = AbortSignal.timeout(
    Math.min(Math.max(0, budget.deadline - Date.now()), MAX_TIMER_MS),
  );
  // What removes the listeners once the load settled, so a long-lived signal does not collect them.
  const releases: (() => void)[] = [];
  try {
    const loaded = await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        // Stryker disable next-line OptionalChaining: equivalent. The listener is only added to a signal that exists.
        const reason: unknown = signal?.reason;
        reject(reason);
      };
      const onDeadline = (): void => {
        reject(
          newError(
            { code: "timeout", backend: name, timeoutMs: budget.timeoutMs },
            `Loading ${what} did not finish within the ${String(budget.timeoutMs)} ms budget.`,
            // Stryker disable next-line ObjectLiteral,ArrayDeclaration: equivalent. The message holds only the code's name and the budget, never a key.
            { secrets: [] },
          ),
        );
      };
      signal?.addEventListener("abort", onAbort);
      deadline.addEventListener("abort", onDeadline);
      releases.push(() => {
        signal?.removeEventListener("abort", onAbort);
        deadline.removeEventListener("abort", onDeadline);
      });
      load().then(resolve, reject);
    });
    memo.set(load, loaded);
    return loaded;
  } finally {
    for (const release of releases) {
      release();
    }
  }
}

/**
 * Each client a loader has given, by loader: a later call takes it at once, with no wait and no
 * timer. A loader that failed is not kept, so the next call tries again.
 */
const LOADED = new WeakMap<ClientLoader, Backend>();

/** The derivation each loader has given, by loader, as {@link LOADED} keeps clients. */
const DERIVATIONS = new WeakMap<DeriveLoader, typeof WithDerivedArgs>();

/** The table each loader has given, by loader, as {@link LOADED} keeps clients (decision 0040). */
const TABLES = new WeakMap<TableLoader, RoutingTable>();

/** The caller's options, each read once, with the defaults applied and the durations checked. */
export interface Settings {
  readonly fetch: typeof fetch | undefined;
  /**
   * The caller's `handlerUrl`, unchecked: the caller's server handler, which adds the Etherscan
   * key (decision 0046). {@link withHandler} checks it.
   */
  readonly handlerUrl?: unknown;
  /** The checked handler, set by {@link withHandler}; `undefined` until then or without one. */
  readonly handler?: ResolvedHandler | undefined;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly logger: Logger | undefined;
  readonly onEvent: VerifyOptions["onEvent"];
  readonly route: RouteOverride | undefined;
  /** Whether a chain missing from the routing table falls back to Sourcify (R-RT-3). */
  readonly allowSourcifyFallback: boolean | undefined;
  /**
   * Returns the checked `apiKeys`: only valid keys of backends that take one. A function, so
   * `JSON.stringify` of the settings never prints a key.
   */
  readonly apiKeys: ApiKeysReader;
  /** Returns every string value of `apiKeys`, valid or not, removed from all the call outputs. */
  readonly keySecrets: () => readonly string[];
  /** The checked `rpcUrl`, for the constructor argument derivation (R-IN-3). */
  readonly rpcUrl: Endpoint | undefined;
  /** The parts of `rpcUrl` that may hold a key, removed from all the call outputs. */
  readonly rpcSecrets: readonly string[];
}

/** The options read in one pass, before the keys and `rpcUrl` are checked. */
type ReadSettings = Omit<Settings, "apiKeys" | "keySecrets" | "rpcUrl" | "rpcSecrets" | "handler">;

/** Everything one call shares once the route is known. */
export interface Call {
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
 * 7. When a poll answers that the explorer no longer knows the job, it looks the contract up once,
 *    within the same window. A match returns `verified`; otherwise it throws `job-not-found` with
 *    the handle.
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
 * @throws The error of the explorer client module, unchanged, when it fails to load, such as a
 *   chunk the page cannot fetch (decision 0031).
 * @throws ExplorerVerifyError with `invalid-input` for bad input or options; `unsupported-chain`;
 *   `timeout` when the budget runs out before the explorer accepts the submission;
 *   `not-confirmed`, with the handle, when it runs out while the job is pending;
 *   `verification-inconclusive` when the job ends without a verdict; `unknown-state` for a final
 *   state the library cannot classify; `job-not-found`, with the handle, when the explorer no
 *   longer knows the job and a lookup finds no match or fails; `in-progress`, `network`,
 *   `rate-limited` and `unexpected-response`. See the error reference for each.
 * @example
 * ```ts
 * import { ExplorerVerifyError, formatHandle, verify } from "explorer-verify";
 *
 * try {
 *   const result = await verify(input, { timeoutMs: 60_000 });
 *   if (result.status === "failed") {
 *     console.error(`Rejected: ${result.reason}`);
 *   } else {
 *     console.log(`${result.status} (${result.match}) ${result.explorerUrl ?? ""}`);
 *   }
 * } catch (error) {
 *   if (error instanceof ExplorerVerifyError && error.code === "not-confirmed") {
 *     localStorage.setItem("pending-verification", formatHandle(error.details.handle));
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
  return await abortWins(
    settings.signal,
    async () => await verifyWith(input, settings, dependencies),
  );
}

/** Steps 1 to 7 of {@link verify}, once the options are read. */
async function verifyWith(
  input: VerifyInput,
  read: Settings,
  dependencies: FlowDependencies,
): Promise<VerifyResult> {
  const checked = validateInput(input);
  const budget = startBudget(read);
  const settings = await withHandler(read, budget);
  const route = await routeOf(checked.chainId, settings, dependencies, budget);
  return await verifyOnRoute(checked, route, settings, dependencies, budget, true);
}

/**
 * Steps 2 to 7 of {@link verify} on a resolved route, for input that `validateInput` returned.
 * `verifyEach()` runs it once per backend, with one shared budget.
 *
 * @param checked - The input, as `validateInput` returned it.
 * @param route - The resolved route.
 * @param settings - The options from {@link settingsOf}.
 * @param dependencies - The backend clients and the jitter source.
 * @param budget - The call's budget, from {@link startBudget}.
 * @param validated - Whether to emit `verify.validated`: `verifyEach()` emits it once itself.
 * @returns The result.
 * @example
 * ```ts
 * const result = await verifyOnRoute(checked, route, settings, DEFAULT_DEPENDENCIES, budget, true);
 * ```
 */
export async function verifyOnRoute(
  checked: VerifyInput,
  route: Route,
  settings: Settings,
  dependencies: FlowDependencies,
  budget: Budget,
  validated: boolean,
): Promise<VerifyResult> {
  const target: Target = { chainId: checked.chainId, address: checked.address };
  const loaded = await withClient(route, dependencies, settings, budget);
  const call = openCall(settings, route, target, loaded, true, budget);
  const { backend } = call;
  const { emit, log } = call.observer;
  if (validated) {
    emit({ type: "verify.validated", chainId: checked.chainId, address: checked.address });
  }
  announceRoute(call, `Verifying ${checked.address} on chain ${String(checked.chainId)}`);

  const found = await backend.lookup(call.target, call.ctx);
  emit({ type: "verify.lookup", backend: backend.name, match: found ?? "none" });
  if (found !== undefined) {
    return finish(call, "already-verified", found);
  }

  const submitted = await backend.submit(
    await withArgs(call, checked, dependencies.derivation ?? loadDerivation),
    call.ctx,
  );
  if (submitted.state === "already-verified") {
    return finish(call, "already-verified", submitted.match);
  }
  const { handle } = submitted;
  const { secrets } = call.ctx.http;
  const line = formatHandle(handle);
  emit({ type: "verify.submitted", backend: backend.name, handle: line });
  // The same rule as the event: a job id shaped like a key stays, so the line still resumes.
  const logged = redactHandleLine(line, secrets);
  log.info(`${backend.name} accepted the submission. Resume it with this handle: ${logged}`, {
    backend: backend.name,
    handle: logged,
  });

  return await settle(call, handle, settings.pollIntervalMs);
}

/**
 * `input` with the constructor arguments derived from the creation code (R-IN-3), when the caller
 * passed none, the backend sends arguments and the input has `creationBytecode`; otherwise `input`
 * unchanged. The derivation code loads with `load` only then, so a call that derives nothing does
 * not load it; the load ends on abort or when the budget runs out, as a client's does (decision
 * 0031). See `withDerivedArgs` for what it logs and throws (decision 0032).
 */
async function withArgs(call: Call, input: VerifyInput, load: DeriveLoader): Promise<VerifyInput> {
  const { creationBytecode } = input;
  if (
    input.constructorArgs !== undefined ||
    call.backend.takesConstructorArgs !== true ||
    creationBytecode === undefined
  ) {
    return input;
  }
  const { backend, settings, budget } = call;
  const derive = await bounded(
    load,
    DERIVATIONS,
    "the constructor argument code",
    backend.name,
    settings.signal,
    budget,
  );
  return await derive(call, input, creationBytecode);
}

/**
 * Runs `work` and, when it throws after the signal aborted, throws `signal.reason` instead, whatever
 * the error (R-FLOW-6). `verify()` and `checkStatus()` both run their requests through it, so a
 * cancelled call always rejects with the reason, unchanged, even when a lookup or a poll threw
 * another error as the signal aborted.
 *
 * @param signal - The caller's signal, if any.
 * @param work - The part of the call that sends requests.
 * @returns What `work` returns.
 * @throws `signal.reason` once the signal aborted; otherwise what `work` throws.
 * @example
 * ```ts
 * return await abortWins(settings.signal, async () => await settle(call, handle, 0));
 * ```
 */
export async function abortWins<T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      const reason: unknown = signal.reason;
      throw reason;
    }
    throw error;
  }
}

/**
 * Builds what one call shares once its route is known: the backend client, the keys from the
 * route's query, the one observer, the budget and the HTTP context. `verify()` and `checkStatus()`
 * both start here, so they derive the keys and the budget the same way.
 *
 * @param settings - The options from {@link settingsOf}.
 * @param route - The resolved route.
 * @param target - The contract the call is about.
 * @param dependencies - The backend clients and the jitter source.
 * @param checkKey - Whether a backend that needs a key and has none throws `missing-api-key`. A
 *   dry run passes `false` and skips its lookup instead.
 * @param budget - The call's budget. Defaults to one that starts now; the flows pass the one they
 *   started before loading the client.
 * @returns The call.
 * @throws ExplorerVerifyError `unsupported-chain` when this version has no client for the route.
 * @example
 * ```ts
 * const call = openCall(settingsOf(options), resolveRoute(11155111), target, DEFAULT_DEPENDENCIES);
 * ```
 */
export function openCall(
  settings: Settings,
  route: Route,
  target: Target,
  dependencies: FlowDependencies,
  checkKey = true,
  budget: Budget = startBudget(settings),
): Call {
  const backend = backendOf(route, target.chainId, dependencies);
  const { ctx, observer } = openContext(
    settings,
    route,
    target,
    dependencies.random,
    checkKey,
    budget,
  );
  return { backend, ctx, budget, target, settings, observer };
}

/**
 * The part of {@link openCall} that needs no backend client: the keys from the route's query, the
 * key checks, the one observer and the HTTP context. `linkProxy()` starts here, with its own
 * explorer code in place of a client.
 *
 * @param settings - The options from {@link settingsOf}.
 * @param route - The resolved route.
 * @param target - The contract the call is about.
 * @param random - The backoff jitter source, or `undefined` for `Math.random`.
 * @param checkKey - Whether a backend that needs a key and has none throws `missing-api-key`.
 * @param budget - The call's budget.
 * @returns The context and the observer.
 * @throws ExplorerVerifyError `invalid-input` when a key sits in the handle's fixed part, and
 *   `missing-api-key` when `checkKey` is set and the route's backend has no key.
 * @example
 * ```ts
 * const { ctx, observer } = openContext(settings, route, target, undefined, true, budget);
 * ```
 */
export function openContext(
  settings: Settings,
  route: Route,
  target: Target,
  random: (() => number) | undefined,
  checkKey: boolean,
  budget: Budget,
): { readonly ctx: Context; readonly observer: Observer } {
  const routeKey = route.apiKey();
  const keySecrets = settings.keySecrets();
  const secrets = [
    ...routeSecrets(route, target.chainId, target.address, route.backend),
    ...keySecrets,
    ...settings.rpcSecrets,
  ];
  const { apiKeys } = settings;
  // Before any request: a key found in the handle's fixed part would corrupt the address and the
  // handle once redacted, and show where the key sits (R-SEC-1).
  const named: [string, string][] = Object.entries(apiKeys()).map(([name, key]) => [
    `apiKeys.${name}`,
    key,
  ]);
  if (routeKey !== undefined) {
    secrets.push(routeKey);
    named.push(["route.apiKey", routeKey]);
  }
  const clashes = collisions(named, visiblePart(route.backend, target.chainId, target.address));
  if (clashes.length > 0) {
    throw invalidOptions(clashes, secrets);
  }
  // Before any request, in every flow, a dry run included: a key bound to a route that goes to
  // the caller's server handler would reach the handler (decision 0046).
  const { handler } = settings;
  const serverAddsKey = handler?.serves(route) === true;
  if (serverAddsKey) {
    if (keyFor({ route, apiKeys }, route.backend, route.apiBase) !== undefined) {
      handler?.refuseKey(secrets);
    }
  }
  // Before any request: a keyed backend with no key bound to its host (R-AX-7), unless the
  // caller's server handler adds it.
  if (checkKey) {
    requireKey({ route, apiKeys }, serverAddsKey, secrets);
  }
  // The one observer of this call: every request, retry and stage goes through it, so a broken
  // `onEvent` is reported once per call (decision 0010).
  const observer = createObserver({
    logger: settings.logger,
    onEvent: settings.onEvent,
    secrets,
  });
  return {
    ctx: {
      route,
      apiKeys,
      pollIntervalMs: settings.pollIntervalMs,
      http: httpContext(route, settings, observer, secrets, budget, random),
      handler: serverAddsKey ? handler : undefined,
    },
    observer,
  };
}

/**
 * Emits `verify.routed`, with how the backend was chosen and the backends the table passed over,
 * and logs `message` at `debug` with the backend, the chain id and the API URL, its query redacted.
 *
 * @param call - The call from {@link openCall}.
 * @param message - The log line.
 * @example
 * ```ts
 * announceRoute(call, `Verifying ${address} on chain ${String(chainId)}`);
 * ```
 */
export function announceRoute(call: Call, message: string): void {
  const { backend, observer, target, ctx } = call;
  const { routedBy, skipped } = ctx.route;
  observer.emit({
    type: "verify.routed",
    backend: backend.name,
    apiHost: apiHostOf(ctx),
    routedBy,
    ...(skipped.length === 0 ? {} : { skipped: skipped.join(",") }),
  });
  observer.log.debug(message, {
    backend: backend.name,
    chainId: target.chainId,
    api: ctx.handler?.url ?? ctx.route.redactedApiUrl,
  });
}

/**
 * The host the call's requests go to: the server handler's for a route that goes through it
 * (decision 0046), the route's API host otherwise.
 *
 * @param ctx - The call's context.
 * @returns The host, as events and dry-run results name it.
 * @example
 * ```ts
 * observer.emit({ type: "verify.routed", backend, apiHost: apiHostOf(ctx) });
 * ```
 */
export function apiHostOf(ctx: Context): string {
  return new URL(ctx.handler?.url ?? ctx.route.apiBase).host;
}

/**
 * Polls a submitted job and maps how it ends to a result or an error: steps 4 to 7 of `verify()`.
 * `checkStatus()` runs the same steps, so a resumed job ends as it would have in `verify()`.
 * When a poll answers that the explorer no longer knows the job, one lookup decides: see
 * {@link forgottenJob}.
 *
 * @param call - The call from {@link openCall}.
 * @param handle - The job to poll.
 * @param firstWaitMs - The wait before the first poll: `pollIntervalMs` right after a submit, 0
 *   for a resumed job, which may have ended long ago.
 * @returns `verified`, `already-verified` or `failed`.
 * @throws ExplorerVerifyError `not-confirmed` with the handle; `job-not-found` with the handle
 *   when the explorer no longer knows the job and the lookup finds no match or fails; and every
 *   error a poll throws that does not mean "no answer this time".
 * @example
 * ```ts
 * const result = await settle(call, handle, 0);
 * ```
 */
export async function settle(
  call: Call,
  handle: Handle,
  firstWaitMs: number,
): Promise<VerifyResult> {
  let polled: Polled;
  try {
    polled = await pollUntilDone(call, handle, firstWaitMs);
  } catch (error: unknown) {
    // After an abort, no lookup: abortWins() turns the error into the caller's reason.
    if (
      call.settings.signal?.aborted === true ||
      !(error instanceof ExplorerVerifyError) ||
      error.code !== "job-not-found"
    ) {
      throw error;
    }
    return await forgottenJob(call, handle, error);
  }
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
 * An own enumerable key outside `known` is an issue that names the key and the closest known
 * name, never its value (R-IN-6). An option set to `undefined`
 * counts as absent.
 *
 * - `timeoutMs` must be a positive finite number; one above {@link MAX_TIMER_MS} is clamped to it,
 *   because a longer `setTimeout` fires at once.
 * - `pollIntervalMs` must be a positive finite number; it is clamped to between
 *   {@link MIN_POLL_INTERVAL_MS} and {@link MAX_TIMER_MS}.
 * - `signal` must be an `AbortSignal`, `fetch` and `onEvent` functions, and `logger` an object.
 */
export function settingsOf(
  options: VerifyOptions | undefined,
  known: readonly string[] = verifyOptionKeys(),
): Settings {
  if (options === undefined) {
    return {
      fetch: undefined,
      signal: undefined,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      logger: undefined,
      onEvent: undefined,
      route: undefined,
      allowSourcifyFallback: undefined,
      apiKeys: () => ({}),
      keySecrets: () => [],
      rpcUrl: undefined,
      // Stryker disable next-line ArrayDeclaration: equivalent. Without options there is no rpcUrl, and no output holds the text Stryker puts here.
      rpcSecrets: [],
    };
  }
  const raw: unknown = options;
  if (typeof raw !== "object" || raw === null) {
    throw invalidOptions([{ field: "options", message: "must be an object" }]);
  }
  if (Array.isArray(raw)) {
    throw invalidOptions([{ field: "options", message: "must be a plain object" }]);
  }
  let read: ReadSettings;
  let rawKeys: unknown;
  let rawRpcUrl: unknown;
  const issues: InputIssue[] = [];
  try {
    // Keys first: a getter on an unknown key never runs, since Object.keys reads no value.
    issues.push(...unknownKeys(Object.keys(options), known, "", "options"));
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
      // Checked by withHandler(), which loads the check only when the option is set.
      handlerUrl: own(options, "handlerUrl"),
      allowSourcifyFallback: own(options, "allowSourcifyFallback"),
      timeoutMs: duration(own(options, "timeoutMs"), DEFAULT_TIMEOUT_MS, 1, "timeoutMs", issues),
      pollIntervalMs: duration(
        own(options, "pollIntervalMs"),
        DEFAULT_POLL_INTERVAL_MS,
        MIN_POLL_INTERVAL_MS,
        "pollIntervalMs",
        issues,
      ),
    };
    rawKeys = own(options, "apiKeys");
    rawRpcUrl = own(options, "rpcUrl");
  } catch {
    // A getter or Proxy trap threw. Its error is dropped: it may repeat a caller value.
    throw invalidOptions([{ field: "options", message: "could not be read" }]);
  }
  checkKinds(read, issues);
  // Read after the other options, so a bad key value never hides an issue in them.
  const keys = readApiKeys(rawKeys);
  issues.push(...keys.issues);
  const rpc = rawRpcUrl === undefined ? undefined : checkApiUrl(rawRpcUrl);
  if (typeof rpc === "string") {
    issues.push({ field: "rpcUrl", message: rpc });
  }
  const rpcUrl = typeof rpc === "string" ? undefined : rpc;
  // Stryker disable next-line ArrayDeclaration: equivalent. Without an rpcUrl, no output holds the text Stryker puts here.
  const rpcSecrets = rpcUrl === undefined ? [] : endpointSecrets(rpcUrl);
  if (issues.length > 0) {
    throw invalidOptions(issues, [...keys.secrets, ...rpcSecrets]);
  }
  const { keys: checked, secrets } = keys;
  return {
    ...read,
    apiKeys: () => checked,
    keySecrets: () => secrets,
    rpcUrl,
    rpcSecrets,
  };
}

/** An own option, read once, or `undefined` when `options` does not have it. */
function own<K extends keyof VerifyOptions>(
  options: VerifyOptions,
  name: K,
): VerifyOptions[K] | undefined {
  return Object.hasOwn(options, name) ? options[name] : undefined;
}

/** Adds an issue for each of `signal`, `fetch`, `logger` and `onEvent` of the wrong kind. */
function checkKinds(settings: ReadSettings, issues: InputIssue[]): void {
  const signal: unknown = settings.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    issues.push({ field: "signal", message: "must be an AbortSignal" });
  }
  const fallback: unknown = settings.allowSourcifyFallback;
  if (fallback !== undefined && typeof fallback !== "boolean") {
    issues.push({ field: "allowSourcifyFallback", message: "must be a boolean" });
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
  // `!(value > 0)` also refuses NaN.
  if (typeof value !== "number" || !(value > 0) || value === Number.POSITIVE_INFINITY) {
    issues.push({ field, message: "must be a positive finite number of milliseconds" });
    return fallback;
  }
  return Math.min(Math.max(value, floor), MAX_TIMER_MS);
}

function invalidOptions(
  issues: InputIssue[],
  // Stryker disable next-line ArrayDeclaration: equivalent. Without the keys, the message and the issues name only fields, never the text Stryker puts here.
  secrets: readonly string[] = [],
): ExplorerVerifyError {
  return newError(
    { code: "invalid-input", issues },
    `The options are invalid: ${issues.map((issue) => issue.field).join(", ")}.`,
    {
      hint: "Pass options as a plain object: timeoutMs and pollIntervalMs as positive numbers of milliseconds, signal as an AbortSignal, fetch and onEvent as functions, logger as an object, apiKeys as an object of key strings by backend name. Leave out any you do not need.",
      secrets,
    },
  );
}

/**
 * Resolves the route of a call from the routing table and the caller's options: the route
 * override, the keys and the Sourcify fallback (R-RT-1 to R-RT-3). `verify()` and `checkStatus()`
 * both resolve through it, so a resumed job resolves the same route from the same options.
 *
 * It checks the override first, then loads the routing table only when the route needs it: a
 * call whose `route.apiUrl` cannot be a URL the table lists loads no table (decision 0040). The
 * load counts against the budget and ends on an abort, as a client's load does (decision 0031).
 *
 * @param chainId - The chain of the call.
 * @param settings - The options from {@link settingsOf}.
 * @param dependencies - The backend clients: `route.backend` must name one of them.
 * @param budget - The call's budget, from {@link startBudget}.
 * @returns The route.
 * @throws ExplorerVerifyError `invalid-input` or `unsupported-chain`, as `resolveRoute` throws
 *   them; what {@link tableFor} throws.
 * @example
 * ```ts
 * const route = await routeOf(11155111, settingsOf(options), DEFAULT_DEPENDENCIES, budget);
 * ```
 */
export async function routeOf(
  chainId: number,
  settings: Settings,
  dependencies: FlowDependencies,
  budget: Budget,
): Promise<Route> {
  const checked = checkRouteOf(chainId, settings, dependencies);
  const table = await tableFor(checked, dependencies.table, settings, budget);
  return routeWith(chainId, checked, settings, dependencies, table);
}

/**
 * The first step of {@link routeOf}: checks the call's route override. It loads nothing.
 *
 * @param chainId - The chain of the call.
 * @param settings - The options from {@link settingsOf}: the route override.
 * @param dependencies - The backend clients: `route.backend` must name one of them.
 * @returns The checked override.
 * @throws ExplorerVerifyError `invalid-input`, as `resolveRoute` throws it.
 * @example
 * ```ts
 * const checked = checkRouteOf(11155111, settingsOf(options), DEFAULT_DEPENDENCIES);
 * ```
 */
export function checkRouteOf(
  chainId: number,
  settings: Settings,
  dependencies: FlowDependencies,
): CheckedRoute {
  return checkRoute(chainId, settings.route, clientsOf(dependencies));
}

/**
 * The keys the routing table chooses a backend with. With `handlerUrl`, `etherscan-v2` counts as
 * keyed, as with `apiKeys["etherscan-v2"]`: the server handler adds its key (decision 0046). The
 * value marks the backend only; it is never sent, because no route that uses it gets a key from
 * `apiKeys`.
 *
 * @param settings - The options from {@link settingsOf}.
 * @returns The keys by backend, for `RouteChoice.apiKeys`.
 * @example
 * ```ts
 * const route = routeFrom(1, checked, { apiKeys: choiceKeys(settings), table });
 * ```
 */
export function choiceKeys(settings: Settings): CheckedKeys {
  const keys = settings.apiKeys();
  return settings.handler === undefined ? keys : { ...keys, "etherscan-v2": HANDLER_KEY };
}

/** The `handlerUrl` code: its check, and the refusal of a key bound to the handler's route. */
interface HandlerCode {
  readonly resolveHandler: (settings: Settings, etherscanApi: string) => ResolvedHandler;
}

/** Loads the `handlerUrl` code, in a chunk of its own (decision 0046). */
const loadHandlerCode = async (): Promise<HandlerCode> => await import("../http/handler-url.ts");

/** The `handlerUrl` code each loader has given, as {@link LOADED} keeps clients. */
const HANDLER_CODE = new WeakMap<() => Promise<HandlerCode>, HandlerCode>();

/**
 * `settings` with `handlerUrl` checked, when the caller set it. The check loads with a dynamic
 * `import()`, through {@link bounded}, so a caller who never sets `handlerUrl` never downloads it
 * (decision 0046). Every flow calls it before it resolves the route.
 *
 * @param settings - The options from {@link settingsOf}.
 * @param budget - The call's budget, from {@link startBudget}.
 * @returns The settings, with `handler` set when `handlerUrl` is.
 * @throws ExplorerVerifyError `invalid-input` naming `handlerUrl`; what {@link bounded} throws.
 * @example
 * ```ts
 * const checked = await withHandler(settingsOf(options), budget);
 * ```
 */
export async function withHandler(settings: Settings, budget: Budget): Promise<Settings> {
  if (settings.handlerUrl === undefined) {
    return settings;
  }
  const code = await bounded(
    loadHandlerCode,
    HANDLER_CODE,
    "handlerUrl",
    "etherscan-v2",
    settings.signal,
    budget,
  );
  return { ...settings, handler: code.resolveHandler(settings, ETHERSCAN_API_URL) };
}

/**
 * The routing table a checked route reads, loaded, or `undefined` for a route that `readsTable`
 * says needs none (decision 0040). A loader runs once per page or process: what
 * it gave is kept, and a load that failed is tried again by the next call. The load ends when the
 * caller's signal aborts, with `signal.reason`, or when the budget runs out, with `timeout`
 * naming the backend of `route.backend`, or `sourcify`, the fallback, when none is named.
 *
 * @param checked - The checked override, from {@link checkRouteOf}.
 * @param source - The routing table, or the function that loads it; {@link loadRoutingTable}
 *   when absent.
 * @param settings - The options from {@link settingsOf}: the signal.
 * @param budget - The call's budget, from {@link startBudget}.
 * @returns The table, or `undefined` when the route reads none.
 * @throws The caller's `signal.reason` when the signal aborts; ExplorerVerifyError `timeout` when
 *   the budget runs out; what the loader throws, such as the error of a chunk that fails to load.
 * @example
 * ```ts
 * const table = await tableFor(checked, DEFAULT_DEPENDENCIES.table, settings, budget);
 * ```
 */
export async function tableFor(
  checked: CheckedRoute,
  source: RoutingTable | TableLoader | undefined,
  settings: Settings,
  budget: Budget,
): Promise<RoutingTable | undefined> {
  return readsTable(checked)
    ? await loadTable(source, checked.named ?? "sourcify", settings, budget)
    : undefined;
}

/**
 * Loads the routing table, as {@link tableFor} does, whatever the route.
 *
 * @param source - The routing table, or the function that loads it; {@link loadRoutingTable}
 *   when absent.
 * @param name - The backend a `timeout` names.
 * @param settings - The options from {@link settingsOf}: the signal.
 * @param budget - The call's budget, from {@link startBudget}.
 * @returns The table.
 * @throws As {@link tableFor} throws.
 * @example
 * ```ts
 * const table = await loadTable(DEFAULT_DEPENDENCIES.table, "sourcify", settings, budget);
 * ```
 */
export async function loadTable(
  source: RoutingTable | TableLoader | undefined,
  name: BackendName,
  settings: Settings,
  budget: Budget,
): Promise<RoutingTable> {
  const table = source ?? loadRoutingTable;
  return typeof table === "function"
    ? await bounded(table, TABLES, "the routing table", name, settings.signal, budget)
    : table;
}

/**
 * The last step of {@link routeOf}: the route of a checked override, with the table it reads.
 *
 * @param chainId - The chain of the call.
 * @param checked - The checked override, from {@link checkRouteOf}.
 * @param settings - The options from {@link settingsOf}: the keys and the fallback option.
 * @param dependencies - The backend clients.
 * @param table - The table, from {@link tableFor}.
 * @returns The route.
 * @throws ExplorerVerifyError `unsupported-chain`, as `resolveRoute` throws it.
 * @example
 * ```ts
 * const route = routeWith(11155111, checked, settings, DEFAULT_DEPENDENCIES, table);
 * ```
 */
export function routeWith(
  chainId: number,
  checked: CheckedRoute,
  settings: Settings,
  dependencies: FlowDependencies,
  table: RoutingTable | undefined,
): Route {
  return routeFrom(chainId, checked, {
    apiKeys: choiceKeys(settings),
    allowSourcifyFallback: settings.allowSourcifyFallback === true,
    clients: clientsOf(dependencies),
    table,
  });
}

/** The backends with a client in `dependencies`, loaded or not. */
function clientsOf(dependencies: FlowDependencies): BackendName[] {
  return BACKEND_NAMES.filter((name) => dependencies.backends[name] !== undefined);
}

/**
 * The client for the route's backend. `route.backend` names only a backend with a client, but the
 * routing table may choose one this version has no client for: that throws `unsupported-chain`.
 */
function backendOf(route: Route, chainId: number, dependencies: FlowDependencies): Backend {
  const backend = dependencies.backends[route.backend];
  if (backend === undefined) {
    // Stryker disable next-line StringLiteral: equivalent. unsupported() gives the client message and hint to any reason other than "row" and "listed".
    throw unsupported(chainId, route.backend, "client");
  }
  if (typeof backend === "function") {
    throw new TypeError(
      `The ${route.backend} client is not loaded: pass the dependencies through withClient() first.`,
    );
  }
  return backend;
}

/**
 * The values of the route's query string, as secrets of the call. A caller who puts a key in
 * `route.apiUrl`'s query gets it removed from errors, logs, events and results, even where an
 * explorer repeats it in an answer (R-SEC-1). Left out:
 *
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
  const visible = visiblePart(backend, chainId, address).toLowerCase();
  // Stryker disable next-line ArrayDeclaration: equivalent. No output holds the text Stryker puts here, so an extra secret redacts nothing.
  const secrets: string[] = [];
  // A value shorter than MIN_SECRET_LENGTH is kept too: redaction ignores it.
  // Stryker disable next-line StringLiteral: equivalent. Any path gives the same query.
  for (const value of new URL(route.requestUrl("/")).searchParams.values()) {
    if (!/^\d+$/.test(value) && !visible.includes(value.toLowerCase())) {
      secrets.push(value);
    }
  }
  return secrets;
}

/** The handle's fixed part, `ev1:<backend>:<chainId>:<address>`: public text of the call. */
function visiblePart(backend: BackendName, chainId: number, address: string): string {
  return `ev1:${backend}:${String(chainId)}:${address}`;
}

/** The HTTP context every request of the call shares. */
function httpContext(
  route: Route,
  settings: Settings,
  observer: Observer,
  secrets: readonly string[],
  budget: Budget,
  random: (() => number) | undefined,
): HttpContext {
  return {
    backend: route.backend,
    secrets,
    observer,
    budget,
    // Always set, so a `fetch` added to `Object.prototype` can never stand in for the default.
    fetch: settings.fetch ?? platformFetch,
    // A route through the caller's server handler sends Etherscan requests there (decision 0046).
    sendTo: settings.handler?.serves(route) === true ? settings.handler.sentUrl : undefined,
    signal: settings.signal,
    random,
  };
}

/**
 * Polls the job until it ends, waiting `firstWaitMs` before the first poll and `pollIntervalMs`
 * before each later one.
 *
 * A poll that fails with `network`, `rate-limited` or `unexpected-response`, after the HTTP
 * layer's own retries, is logged at `warn` and polling goes on: the job exists, and the next poll
 * may answer. Polling stops when the budget runs out, including during a poll's request, or after
 * {@link MAX_POLL_FAILURES} failed polls in a row. The job id exists, so the call then ends with
 * `not-confirmed`, never `timeout`.
 */
async function pollUntilDone(call: Call, handle: Handle, firstWaitMs: number): Promise<Polled> {
  const { backend, ctx, settings, observer } = call;
  const { deadline } = call.budget;
  let attempt = 0;
  let failures = 0;
  let cause: ExplorerVerifyError | undefined;
  let wait = firstWaitMs;
  for (;;) {
    // A wait never passes the deadline. When the deadline has passed, it waits no time and the
    // check below ends polling.
    await sleep(Math.max(0, Math.min(wait, deadline - Date.now())), settings.signal);
    wait = settings.pollIntervalMs;
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
      // Stryker disable next-line StringLiteral: equivalent. settle() reads only whether the kind is "stopped".
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
    throw notConfirmed(call, handle, stopped.why, stopped.cause ?? error, "failed");
  }
  if (match !== undefined) {
    return finish(call, "verified", match);
  }
  throw notConfirmed(call, handle, stopped.why, stopped.cause, "found no match");
}

/**
 * The explorer no longer knows the job, as Routescan forgets a job id within an hour. One lookup
 * in the grace window decides: a match means the job verified the contract, so the result is
 * `verified`. Otherwise it throws `job-not-found` with the handle, whose hint says to call
 * `verify()` again. When the lookup fails, the error keeps the catalogue hint, which says to check
 * the contract first, and the lookup error as its cause. It emits no `verify.lookup`.
 */
async function forgottenJob(
  call: Call,
  handle: Handle,
  notFound: ExplorerVerifyError,
): Promise<VerifyResult> {
  const { backend, settings, observer, ctx } = call;
  observer.log.debug(
    `${backend.name} does not know job ${handle.jobId}; looking the contract up instead`,
    { backend: backend.name },
  );
  let match: Match | undefined;
  try {
    match = await backend.lookup(call.target, graceContext(call));
  } catch (error: unknown) {
    if (mustRethrow(error, settings.signal)) {
      throw error;
    }
    throw newError(
      { code: "job-not-found", handle },
      `${backend.name} does not know job ${handle.jobId}, and the lookup of the contract failed.`,
      { secrets: ctx.http.secrets, cause: error },
    );
  }
  if (match !== undefined) {
    return finish(call, "verified", match);
  }
  throw newError(
    { code: "job-not-found", handle },
    `${backend.name} does not know job ${handle.jobId}, and a lookup found the contract not verified.`,
    {
      hint: "Call verify() again: the job is gone and the contract is not verified, so a new submission is needed.",
      secrets: ctx.http.secrets,
      cause: notFound,
    },
  );
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
  throw newError(
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
  return { ...ctx, http: { ...ctx.http, budget: { ...budget, deadline } } };
}

/**
 * `not-confirmed`: the job may still be running, and `checkStatus` with the handle continues.
 * The message says why polling stopped, the budget ran out or the status polls kept failing, and
 * whether the last lookup failed or found no match.
 */
function notConfirmed(
  call: Call,
  handle: Handle,
  why: "budget" | "failures",
  cause: unknown,
  lookup: "failed" | "found no match",
): ExplorerVerifyError {
  const { backend, settings, ctx } = call;
  const reason =
    why === "budget"
      ? `the ${String(settings.timeoutMs)} ms budget ran out`
      : `${String(MAX_POLL_FAILURES)} status polls in a row failed`;
  const message = `The verification of job ${handle.jobId} on ${backend.name} is not confirmed: ${reason} before the job ended, and a last lookup ${lookup}.`;
  return newError(
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
