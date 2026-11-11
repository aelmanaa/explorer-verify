// References: R-FLOW-1, R-FLOW-6.
/**
 * The flow engine: validate, route, look up, submit, poll and map the
 * outcome to one of three results or a typed error. It never branches on the backend: every
 * explorer call goes through the {@link Backend} interface.
 */
import { BACKEND_NAMES } from "../backend-names.ts";
import type { BackendName } from "../backend-names.ts";
import type { Backend, Context, Found, PollOutcome, Target } from "../backends/backend.ts";
import { kindCheck } from "../compiler-kinds.ts";
import type { KindCheck, ZksolcRoutes } from "../compiler-kinds.ts";
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
import { budgetText } from "../internal/duration.ts";
import { unknownKeys } from "../internal/known-keys.ts";
import { createObserver } from "../observe.ts";
import type { Observer } from "../observe.ts";
import {
  checkApiUrl,
  checkRoute,
  readsTable,
  servesWithoutTable,
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
  StoredContract,
  VerifyEvent,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../types.ts";
import { formatHandle, redactHandleLine } from "./format-handle.ts";
import { heldText, otherContract } from "./stored.ts";

/** The default time budget of one call, polling included, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** The default wait between two status polls, in milliseconds. */
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
/** The shortest wait between two status polls, in milliseconds. A shorter `pollIntervalMs` is raised to it. */
export const MIN_POLL_INTERVAL_MS = 1_000;

// References: decision 0047, decision 0052.
/**
 * The keys of `VerifyOptions`, as a record so that a field added to the type and not here fails
 * to compile. `verify()`, `dryRun()`, `checkStatus()` and `linkProxy()` all accept every one of
 * them at run time, so one options object can go to each; their types are narrower
 * so that a misplaced key in an object literal fails to compile. `explorer-verify/core` checks
 * them with its own keys, so an unknown key is named with its issues.
 *
 * @returns The keys.
 * @example
 * ```ts
 * verifyOptionKeys().includes("timeoutMs"); // true
 * ```
 */
export function verifyOptionKeys(): readonly string[] {
  return Object.keys({
    fetch: true,
    handlerUrl: true,
    signal: true,
    timeoutMs: true,
    pollIntervalMs: true,
    indexWaitMs: true,
    logger: true,
    onEvent: true,
    route: true,
    allowSourcifyFallback: true,
    apiKeys: true,
    rpcUrl: true,
    submitOverPartial: true,
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

// References: decision 0031.
/**
 * Loads a backend's client. Each shipped client sits behind a dynamic `import()`, so a bundler
 * that splits code puts it in its own chunk, and a call loads only the client its route names.
 */
export type ClientLoader = () => Promise<Backend>;

/** A backend's client, loaded, or the function that loads it. */
export type Client = Backend | ClientLoader;

// References: R-IN-3, decisions 0031 and 0032.
/**
 * Loads the constructor argument derivation. The default entry's sits behind a dynamic
 * `import()`, so a call that derives nothing does not load it.
 */
export type DeriveLoader = () => Promise<typeof WithDerivedArgs>;

/** The `handlerUrl` code: its check, and the refusal of a key bound to the handler's route. */
export interface HandlerCode {
  readonly resolveHandler: (settings: Settings, etherscanApi: string) => ResolvedHandler;
}

// References: decision 0046.
/** Loads the `handlerUrl` code. The default entry's sits in a chunk of its own. */
export type HandlerLoader = () => Promise<HandlerCode>;

// References: decision 0052.
/**
 * What the flow engine takes besides the caller's input and options. This module holds no dynamic
 * `import()`, so `explorer-verify/core` bundles the engine without any client.
 * The default entry passes `DEFAULT_DEPENDENCIES`, whose loaders do; `explorer-verify/core` passes
 * the clients and the table its caller gave. The tests pass a fixed `random` for the backoff
 * jitter, a backend table without a client to reach the error for it, or a routing table with rows
 * for clients to come.
 * @internal
 */
export interface FlowDependencies {
  /** The client of each backend, or the function that loads it. */
  readonly backends: Readonly<Partial<Record<BackendName, Client>>>;
  /** A number in `[0, 1)` for the backoff jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
  // References: decision 0052.
  /**
   * The routing table, or the function that loads it. Absent, a route that reads the table throws
   * `missing.table()`.
   */
  readonly table?: RoutingTable | TableLoader | undefined;
  /** Loads the constructor argument derivation; absent, a call that must derive throws. */
  readonly derivation?: DeriveLoader | undefined;
  /** Loads the `handlerUrl` code; absent, a call with `handlerUrl` throws `missing.handler()`. */
  readonly handler?: HandlerLoader | undefined;
  /** Set by `explorer-verify/core`: the errors for what its caller left out. */
  readonly missing?: Missing | undefined;
  // References: decision 0057.
  /**
   * The backends whose client maps zksolc input, each with its chains. Absent
   * means `ZKSOLC_ROUTES`, as both entries leave it; the tests pass a list to reach the steps of a
   * backend that maps it.
   */
  readonly zksolc?: ZksolcRoutes | undefined;
}

// References: decision 0052.
/**
 * The errors for what a caller of `explorer-verify/core` left out, each thrown before any request.
 * `explorer-verify/core` holds their text, so the default entry, which always
 * has every client, the table and the `handlerUrl` code, does not bundle it. Without them, as in
 * the default entry, the engine throws `unsupported-chain` for a backend without a client and a
 * `TypeError` for the rest.
 */
export interface Missing {
  /** For a backend the routing table chose and `clients` has no client for. */
  readonly client: (backend: BackendName, chainId: number) => ExplorerVerifyError;
  /** For a route that reads the routing table, without `table`. */
  readonly table: () => ExplorerVerifyError;
  /** For `handlerUrl` without the Etherscan v2 client, which brings its code. */
  readonly handler: () => ExplorerVerifyError;
  /** The hint for a `route.backend` with no client in `clients`. */
  readonly backendHint: (named: BackendName) => string;
}

/** {@link Missing} for `linkProxy()`, which also names a proxy-link client left out. */
export interface LinkMissing extends Missing {
  /**
   * For a backend whose proxy-link client is not in `clients`; `undefined` for a backend that
   * cannot link in this version, which gets the default entry's error.
   */
  readonly linker: (
    backend: BackendName,
    secrets: readonly string[],
  ) => ExplorerVerifyError | undefined;
}

/** What the engine throws when an internal caller left out a part `missing` has no error for. */
function notPassed(what: string): TypeError {
  return new TypeError(`No ${what} was passed to the flow engine.`);
}

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

// References: R-FLOW-6, decision 0054.
/**
 * Loads the client of the route's backend when it is a {@link ClientLoader}, and returns the
 * dependencies with that client in place, ready for {@link openCall}. No other client loads. A
 * client already loaded, or missing, leaves the dependencies as they are: `openCall` throws
 * `unsupported-chain` for a missing one.
 *
 * The load ends when the caller's signal aborts, with `signal.reason`, or when the budget runs
 * out, with `timeout`: a chunk that never arrives cannot hold the call.
 *
 * @param route - The resolved route.
 * @param dependencies - The backend clients, loaded or not.
 * @param settings - The options from {@link settingsOf}: the signal.
 * @param budget - The call's budget, from {@link startBudget}.
 * @returns The dependencies with the route's client loaded.
 * @throws The caller's `signal.reason` when the signal aborts; ExplorerVerifyError `timeout` when
 *   the budget runs out; ExplorerVerifyError `network` when the loader fails, such as a chunk
 *   that does not load.
 * @example
 * ```ts
 * const budget = startBudget(settings);
 * const loaded = await withClient(route, DEFAULT_DEPENDENCIES, settings, budget);
 * const call = openCall(settings, route, target, loaded, true, budget);
 * ```
 * @internal
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
    settings,
    budget,
  );
  return { ...dependencies, backends: { ...dependencies.backends, [route.backend]: backend } };
}

// References: decision 0054.
/**
 * Runs `load`, and rejects first when `settings.signal` aborts or the budget runs out. `memo`
 * keeps what each loader gave, so a later call takes it at once. `what` names the code in the
 * error message, and `name` is the backend the error details name. `linkProxy()` loads its
 * explorer code through it too.
 *
 * A load that fails, such as a chunk the page cannot fetch, rejects with `network`, retryable,
 * with the loader's error as its cause and a hint about the files the site serves.
 * No request was sent.
 *
 * @param load - Loads the module's export.
 * @param memo - What each loader gave.
 * @param what - The code, as `the sourcify client`.
 * @param name - The backend.
 * @param settings - The options from {@link settingsOf}: the signal, and the keys removed from
 *   the cause.
 * @param budget - The call's budget.
 * @returns What `load` gives.
 * @throws The caller's `signal.reason` when the signal aborts; ExplorerVerifyError `timeout` when
 *   the budget runs out; ExplorerVerifyError `network` when the load fails.
 * @example
 * ```ts
 * const linker = await bounded(load, LINKERS, "the sourcify proxy-link code", "sourcify", settings, budget);
 * ```
 */
export async function bounded<T extends object>(
  load: () => Promise<T>,
  memo: WeakMap<() => Promise<T>, T>,
  what: string,
  name: BackendName,
  settings: Settings,
  budget: Budget,
): Promise<T> {
  const { signal } = settings;
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
            `Loading ${what} did not finish within the ${budgetText(budget.timeoutMs)} budget.`,
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
      load().then(resolve, (error: unknown) => {
        // Every loader's failure, whatever its type: the default entry's loaders only import.
        reject(
          newError({ code: "network", backend: name, attempts: 1 }, `Loading ${what} failed.`, {
            secrets: [...settings.keySecrets(), ...settings.rpcSecrets],
            cause: error,
            hint: LOAD_HINT,
          }),
        );
      });
    });
    memo.set(load, loaded);
    return loaded;
  } finally {
    for (const release of releases) {
      release();
    }
  }
}

// References: decision 0054.
/** The hint of a load that failed. */
const LOAD_HINT =
  "Check the network connection and that the site serves every file of its build, then call again.";

/**
 * Each client a loader has given, by loader: a later call takes it at once, with no wait and no
 * timer. A loader that failed is not kept, so the next call tries again.
 */
const LOADED = new WeakMap<ClientLoader, Backend>();

/** The derivation each loader has given, by loader, as {@link LOADED} keeps clients. */
const DERIVATIONS = new WeakMap<DeriveLoader, typeof WithDerivedArgs>();

// References: decision 0040.
/** The table each loader has given, by loader, as {@link LOADED} keeps clients. */
const TABLES = new WeakMap<TableLoader, RoutingTable>();

/** The caller's options, each read once, with the defaults applied and the durations checked. */
export interface Settings {
  readonly fetch: typeof fetch | undefined;
  // References: decision 0046.
  /**
   * The caller's `handlerUrl`, unchecked: the caller's server handler, which adds the Etherscan
   * key. {@link withHandler} checks it.
   */
  readonly handlerUrl?: unknown;
  /** The checked handler, set by {@link withHandler}; `undefined` until then or without one. */
  readonly handler?: ResolvedHandler | undefined;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  // References: R-FLOW-7, decision 0066.
  /** The caller's `indexWaitMs`, checked; `undefined` when absent. */
  readonly indexWaitMs: number | undefined;
  readonly logger: Logger | undefined;
  readonly onEvent: VerifyOptions["onEvent"];
  readonly route: RouteOverride | undefined;
  // References: R-RT-3.
  /** Whether a chain missing from the routing table falls back to Sourcify. */
  readonly allowSourcifyFallback: boolean | undefined;
  // References: R-FLOW-1, decision 0067.
  /** Whether `verify()` submits over a partial match of the input's own source. */
  readonly submitOverPartial: boolean | undefined;
  /**
   * Returns the checked `apiKeys`: only valid keys of backends that take one. A function, so
   * `JSON.stringify` of the settings never prints a key.
   */
  readonly apiKeys: ApiKeysReader;
  /** Returns every string value of `apiKeys`, valid or not, removed from all the call outputs. */
  readonly keySecrets: () => readonly string[];
  // References: R-IN-3.
  /** The checked `rpcUrl`, for the constructor argument derivation. */
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
  // References: R-FLOW-1, decision 0063.
  /**
   * For a `verify()` call: the other contract a match comes from, logged at `warn`, or
   * `undefined` for a match of the input's source. Absent for `checkStatus()`, which has no input,
   * so its bundle holds none of the comparison.
   */
  readonly otherOf?: OtherOf;
  // References: R-FLOW-7, decision 0067.
  /**
   * The partial match of the input's source that `submitOverPartial` submitted over. A job that
   * fails then keeps it: the result is `already-verified` with this match, not `failed`.
   */
  readonly partial?: Found;
}

/**
 * The other contract that `found` comes from, for a result of `status`. See {@link Call.otherOf}.
 */
type OtherOf = (
  found: Found,
  status: "verified" | "already-verified",
) => StoredContract | undefined;

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
 * @internal
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
  const settings = await withHandler(read, budget, dependencies.handler, dependencies.missing);
  const route = await routeOf(
    checked.chainId,
    settings,
    dependencies,
    budget,
    kindsOf(checked, dependencies),
  );
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
 * @internal
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
  const opened = openCall(settings, route, target, loaded, true, budget);
  const { backend } = opened;
  const { emit, log } = opened.observer;
  const fields = { backend: backend.name };
  // The other contract the first lookup found, kept for an answer that names none (decision 0063).
  let first: StoredContract | undefined;
  // Whether the call submitted over a partial match of this source (decision 0067). That match was
  // there before the submit, so a partial match found after it does not show the job's work.
  let over = false;
  const call: Call = {
    ...opened,
    ctx: {
      ...opened.ctx,
      own: (found) =>
        otherContract(found, checked) === undefined && !(over && found.match === "partial"),
    },
    otherOf: (found, status) => {
      const named = found.name !== undefined || found.compilerVersion !== undefined;
      const other = named
        ? otherContract(found, checked)
        : status === "already-verified"
          ? first
          : undefined;
      if (other !== undefined) {
        log.warn(`${heldText(backend.name, other)}, not this one.`, fields);
      } else if (!named && status === "already-verified") {
        log.info(`${backend.name} names no contract; the match is taken as this source.`, fields);
      }
      return other;
    },
  };
  if (validated) {
    emit({ type: "verify.validated", chainId: checked.chainId, address: checked.address });
  }
  announceRoute(call, `Verifying ${checked.address} on chain ${String(checked.chainId)}`);

  const found = await backend.lookup(call.target, call.ctx);
  emit({ type: "verify.lookup", backend: backend.name, lookup: found?.match ?? "none" });
  let active = call;
  if (found !== undefined) {
    // A match of another contract's source does not verify this one: submit over it.
    first = otherContract(found, checked);
    if (first === undefined) {
      // A partial match of this source ends the call, unless the caller asked to submit over it.
      if (found.match === "exact" || settings.submitOverPartial !== true) {
        return finish(call, "already-verified", found);
      }
      over = true;
      active = { ...call, partial: found };
      log.info(
        `${backend.name} holds a partial match of this source; submitting over it (submitOverPartial).`,
        fields,
      );
    } else {
      log.info(`${heldText(backend.name, first)}; submitting this source.`, fields);
    }
  }

  const submitted = await backend.submit(
    await withArgs(active, checked, dependencies.derivation),
    call.ctx,
  );
  if (submitted.state === "already-verified") {
    return finish(active, "already-verified", submitted);
  }
  // The handle says the job is a submit over a partial match, so checkStatus() ends it the same
  // way (decision 0067).
  const handle: Handle =
    active.partial === undefined ? submitted.handle : { ...submitted.handle, overPartial: true };
  const { secrets } = call.ctx.http;
  const line = formatHandle(handle);
  emit({ type: "verify.submitted", backend: backend.name, handle: line });
  // The same rule as the event: a job id shaped like a key stays, so the line still resumes.
  const logged = redactHandleLine(line, secrets);
  log.info(`${backend.name} accepted the submission. Resume it with this handle: ${logged}`, {
    backend: backend.name,
    handle: logged,
  });

  return await settle(active, handle, settings.pollIntervalMs);
}

// References: R-IN-3, decision 0032.
/**
 * `input` with the constructor arguments derived from the creation code, when the caller
 * passed none, the backend sends arguments and the input has `creationBytecode`; otherwise `input`
 * unchanged. The derivation code loads with `load` only then, so a call that derives nothing does
 * not load it; the load ends on abort or when the budget runs out, as a client's does. See
 * `withDerivedArgs` for what it logs and throws.
 */
async function withArgs(
  call: Call,
  input: VerifyInput,
  load: DeriveLoader | undefined,
): Promise<VerifyInput> {
  const { creationBytecode } = input;
  if (
    input.constructorArgs !== undefined ||
    call.backend.takesConstructorArgs !== true ||
    creationBytecode === undefined
  ) {
    return input;
  }
  const { backend, settings, budget } = call;
  if (load === undefined) {
    // Each client that takes constructor arguments brings the derivation (decision 0052).
    throw new TypeError(`The ${backend.name} client came without the constructor argument code.`);
  }
  const derive = await bounded(
    load,
    DERIVATIONS,
    "the constructor argument code",
    backend.name,
    settings,
    budget,
  );
  return await derive(call, input, creationBytecode);
}

// References: R-FLOW-6.
/**
 * Runs `work` and, when it throws after the signal aborted, throws `signal.reason` instead,
 * whatever
 * the error. `verify()` and `checkStatus()` both run their requests through it, so a
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
 * @internal
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
      indexWaitMs: settings.indexWaitMs,
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

// References: decision 0046.
/**
 * The host the call's requests go to: the server handler's for a route that goes through it, the
 * route's API host otherwise.
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
    return finish(call, "verified", outcome);
  }
  if (outcome.state === "already-verified") {
    const { match, reason } = outcome;
    if (reason !== undefined) {
      rejectedOver(call, reason, "; the partial match stays");
    }
    return finish(
      call,
      "already-verified",
      match === undefined ? await gradeOf(call, handle) : { ...outcome, match },
    );
  }
  const { partial } = call;
  const { reason } = outcome;
  if (outcome.notVerified === true) {
    rejectedOver(call, reason, ", and a lookup then found the contract not verified");
  } else if (partial !== undefined) {
    rejectedOver(call, reason, "; the partial match stays");
    return finish(call, "already-verified", partial);
  }
  return failed(call, reason);
}

// References: R-FLOW-7, decision 0067.
/**
 * Logs at `warn` that the explorer rejected the source submitted over a partial match of the
 * input's source, with its reason. Logs nothing for a call that submitted over no partial match.
 */
function rejectedOver(call: Call, reason: string, after: string): void {
  if (call.partial !== undefined) {
    call.observer.log.warn(
      `${call.backend.name} rejected the submit over the partial match (${reason})${after}.`,
      { backend: call.backend.name },
    );
  }
}

// References: R-IN-6.
/**
 * Reads each option once, applies the defaults and checks every option but `route`, which
 * `resolveRoute` checks. Only own properties are read, each once, so a polluted `Object.prototype`
 * cannot add an option, and a getter or Proxy that throws gives `invalid-input` without its text.
 * An own enumerable key outside `known` is an issue that names the key and the closest known
 * name, never its value. An option set to `undefined`
 * counts as absent.
 *
 * - `timeoutMs` must be a positive number; one above {@link MAX_TIMER_MS}, `Infinity` included, is
 *   clamped to it, because a longer `setTimeout` fires at once.
 * - `pollIntervalMs` must be a positive finite number; it is clamped to between
 *   {@link MIN_POLL_INTERVAL_MS} and {@link MAX_TIMER_MS}.
 * - `indexWaitMs` must be a positive number; one above {@link MAX_TIMER_MS}, `Infinity` included,
 *   is clamped to it.
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
      indexWaitMs: undefined,
      logger: undefined,
      onEvent: undefined,
      route: undefined,
      allowSourcifyFallback: undefined,
      submitOverPartial: undefined,
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
      submitOverPartial: own(options, "submitOverPartial"),
      timeoutMs: duration(
        own(options, "timeoutMs"),
        DEFAULT_TIMEOUT_MS,
        1,
        "timeoutMs",
        issues,
        true,
      ),
      pollIntervalMs: duration(
        own(options, "pollIntervalMs"),
        DEFAULT_POLL_INTERVAL_MS,
        MIN_POLL_INTERVAL_MS,
        "pollIntervalMs",
        issues,
      ),
      indexWaitMs: duration(own(options, "indexWaitMs"), undefined, 1, "indexWaitMs", issues, true),
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

/**
 * Adds an issue for each of `signal`, `fetch`, `logger`, `onEvent`, `allowSourcifyFallback` and
 * `submitOverPartial` of the wrong kind.
 */
function checkKinds(settings: ReadSettings, issues: InputIssue[]): void {
  const signal: unknown = settings.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    issues.push({ field: "signal", message: "must be an AbortSignal" });
  }
  const flags: [field: string, value: unknown][] = [
    ["allowSourcifyFallback", settings.allowSourcifyFallback],
    ["submitOverPartial", settings.submitOverPartial],
  ];
  for (const [field, value] of flags) {
    if (value !== undefined && typeof value !== "boolean") {
      issues.push({ field, message: "must be a boolean" });
    }
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
 * issue when it is not a positive number. `Infinity` is clamped like any value above
 * {@link MAX_TIMER_MS} when `unbounded` is set, and is an issue otherwise.
 */
function duration<F extends number | undefined>(
  value: unknown,
  fallback: F,
  floor: number,
  field: string,
  issues: InputIssue[],
  unbounded = false,
): number | F {
  if (value === undefined) {
    return fallback;
  }
  // `!(value > 0)` also refuses NaN and -Infinity.
  if (
    typeof value !== "number" ||
    !(value > 0) ||
    (!unbounded && value === Number.POSITIVE_INFINITY)
  ) {
    issues.push({
      field,
      message: unbounded
        ? "must be a positive number of milliseconds"
        : "must be a positive finite number of milliseconds",
    });
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
      hint: `Pass options as a plain object: timeoutMs, pollIntervalMs and indexWaitMs as positive numbers of milliseconds, signal as an AbortSignal, fetch and onEvent as functions, logger as an object, apiKeys as an object of key strings by backend name. Leave out any you do not need.${issues.some(({ field }) => field === "clients" || field === "table") ? " Use explorer-verify/core for clients and table." : ""}`,
      secrets,
    },
  );
}

// References: R-RT-1, R-RT-3, decision 0040, decision 0031.
/**
 * Resolves the route of a call from the routing table and the caller's options: the route
 * override, the keys and the Sourcify fallback. `verify()` and `checkStatus()`
 * both resolve through it, so a resumed job resolves the same route from the same options.
 *
 * It checks the override first, then loads the routing table only when the route needs it: a
 * call whose `route.apiUrl` cannot be a URL the table lists loads no table. The
 * load counts against the budget and ends on an abort, as a client's load does.
 *
 * @param chainId - The chain of the call.
 * @param settings - The options from {@link settingsOf}.
 * @param dependencies - The backend clients: `route.backend` must name one of them.
 * @param budget - The call's budget, from {@link startBudget}.
 * @param kinds - The input's compiler kind, from {@link kindsOf}, for a call that looks up or
 *   submits input; absent for `checkStatus()`, whose job was accepted already.
 * @returns The route.
 * @throws ExplorerVerifyError `invalid-input` or `unsupported-chain`, as `resolveRoute` throws
 *   them; what {@link tableFor} throws; `unsupported-compiler` as {@link routeWith} throws it.
 * @example
 * ```ts
 * const kinds = kindsOf(checked, DEFAULT_DEPENDENCIES);
 * const route = await routeOf(11155111, settingsOf(options), DEFAULT_DEPENDENCIES, budget, kinds);
 * ```
 * @internal
 */
export async function routeOf(
  chainId: number,
  settings: Settings,
  dependencies: FlowDependencies,
  budget: Budget,
  kinds?: KindCheck,
): Promise<Route> {
  const checked = checkRouteOf(chainId, settings, dependencies);
  const table = await tableFor(checked, dependencies.table, settings, budget, dependencies.missing);
  return routeWith(chainId, checked, settings, dependencies, table, kinds);
}

// References: decision 0057.
/**
 * The kind check of checked input, with the backends that map zksolc from `dependencies`.
 * `checkStatus()` does not call it, so its bundle does not hold the check. Each
 * flow that takes input calls it before it resolves the route, so no route hint comes first.
 *
 * @param input - The input, as `validateInput` returned it.
 * @param dependencies - The flow dependencies: `zksolc`, when a test sets it.
 * @returns The check.
 * @throws ExplorerVerifyError `unsupported-compiler` when no backend verifies the input's kind on
 *   its chain.
 * @example
 * ```ts
 * const kinds = kindsOf(checked, DEFAULT_DEPENDENCIES);
 * ```
 * @internal
 */
export function kindsOf(input: VerifyInput, dependencies: FlowDependencies): KindCheck {
  return kindCheck(input.compiler.kind, input.chainId, dependencies.zksolc);
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
 * @internal
 */
export function checkRouteOf(
  chainId: number,
  settings: Settings,
  dependencies: FlowDependencies,
): CheckedRoute {
  return checkRoute(
    chainId,
    settings.route,
    clientsOf(dependencies),
    dependencies.missing?.backendHint,
  );
}

// References: decision 0046.
/**
 * The keys the routing table chooses a backend with. With `handlerUrl`, `etherscan-v2` counts as
 * keyed, as with `apiKeys["etherscan-v2"]`: the server handler adds its key. The
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

/** The `handlerUrl` code each loader has given, as {@link LOADED} keeps clients. */
const HANDLER_CODE = new WeakMap<HandlerLoader, HandlerCode>();

// References: decision 0046, decision 0052.
/**
 * `settings` with `handlerUrl` checked, when the caller set it. The check loads with `load`,
 * through {@link bounded}: the default entry's loader runs a dynamic `import()`, so a caller who
 * never sets `handlerUrl` never downloads it. Every flow calls it before it
 * resolves the route.
 *
 * @param settings - The options from {@link settingsOf}.
 * @param budget - The call's budget, from {@link startBudget}.
 * @param load - Loads the `handlerUrl` code. Through `explorer-verify/core`, it comes with the
 *   Etherscan v2 client, and is absent without it.
 * @param missing - The errors of `explorer-verify/core`, for a `load` that is absent.
 * @returns The settings, with `handler` set when `handlerUrl` is.
 * @throws ExplorerVerifyError `invalid-input` naming `handlerUrl`; `missing.handler()` when
 *   `load` is absent; what {@link bounded} throws.
 * @example
 * ```ts
 * const checked = await withHandler(settingsOf(options), budget, DEFAULT_DEPENDENCIES.handler);
 * ```
 */
export async function withHandler(
  settings: Settings,
  budget: Budget,
  load: HandlerLoader | undefined,
  missing?: Missing,
): Promise<Settings> {
  if (settings.handlerUrl === undefined) {
    return settings;
  }
  if (load === undefined) {
    throw missing?.handler() ?? notPassed("handlerUrl code");
  }
  const code = await bounded(load, HANDLER_CODE, "handlerUrl", "etherscan-v2", settings, budget);
  return { ...settings, handler: code.resolveHandler(settings, ETHERSCAN_API_URL) };
}

// References: decision 0040, decision 0052, decision 0054.
/**
 * The routing table a checked route reads, loaded, or `undefined` for a route that `readsTable`
 * says needs none. A loader runs once per page or process: what
 * it gave is kept, and a load that failed is tried again by the next call. The load ends when the
 * caller's signal aborts, with `signal.reason`, or when the budget runs out, with `timeout`
 * naming the backend of `route.backend`, or `sourcify`, the fallback, when none is named.
 *
 * Without a table, which only `explorer-verify/core` allows, a route with `route.apiUrl` reads
 * none: it goes where the caller says, and gets no explorer page from a row. A route without
 * `route.apiUrl` throws `missing.table()`.
 *
 * @param checked - The checked override, from {@link checkRouteOf}.
 * @param source - The routing table, or the function that loads it; absent through
 *   `explorer-verify/core` without `table`.
 * @param settings - The options from {@link settingsOf}: the signal.
 * @param budget - The call's budget, from {@link startBudget}.
 * @param missing - The errors of `explorer-verify/core`, for a `source` that is absent.
 * @returns The table, or `undefined` when the route reads none.
 * @throws The caller's `signal.reason` when the signal aborts; ExplorerVerifyError `timeout` when
 *   the budget runs out; `missing.table()` for a route without `route.apiUrl` and no `source`;
 *   ExplorerVerifyError `network` when the loader fails.
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
  missing?: Missing,
): Promise<RoutingTable | undefined> {
  return readsTable(checked) && (source !== undefined || !servesWithoutTable(checked))
    ? await loadTable(source, checked.named ?? "sourcify", settings, budget, missing)
    : undefined;
}

/**
 * Loads the routing table, as {@link tableFor} does, whatever the route.
 *
 * @param source - The routing table, or the function that loads it; absent through
 *   `explorer-verify/core` without `table`.
 * @param name - The backend a `timeout` names.
 * @param settings - The options from {@link settingsOf}: the signal.
 * @param budget - The call's budget, from {@link startBudget}.
 * @param missing - The errors of `explorer-verify/core`, for a `source` that is absent.
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
  missing?: Missing,
): Promise<RoutingTable> {
  if (source === undefined) {
    throw missing?.table() ?? notPassed("routing table");
  }
  return typeof source === "function"
    ? await bounded(source, TABLES, "the routing table", name, settings, budget)
    : source;
}

// References: decision 0057.
/**
 * The last step of {@link routeOf}: the route of a checked override, with the table it reads.
 *
 * @param chainId - The chain of the call.
 * @param checked - The checked override, from {@link checkRouteOf}.
 * @param settings - The options from {@link settingsOf}: the keys and the fallback option.
 * @param dependencies - The backend clients.
 * @param table - The table, from {@link tableFor}.
 * @param kinds - The input's compiler kind, from `kindCheck`: the table passes over a backend
 *   whose client does not map it. Absent for `checkStatus()`.
 * @returns The route.
 * @throws ExplorerVerifyError `unsupported-chain`, as `resolveRoute` throws it;
 *   `unsupported-compiler` when the route's backend does not map the kind, before any request.
 * @example
 * ```ts
 * const kinds = kindCheck("solc", 11155111);
 * const route = routeWith(11155111, checked, settings, DEFAULT_DEPENDENCIES, table, kinds);
 * ```
 * @internal
 */
export function routeWith(
  chainId: number,
  checked: CheckedRoute,
  settings: Settings,
  dependencies: FlowDependencies,
  table: RoutingTable | undefined,
  kinds?: KindCheck,
): Route {
  if (checked.named !== undefined && kinds?.verifies(checked.named) === false) {
    throw kinds.refused(checked.named);
  }
  const route = routeFrom(chainId, checked, {
    apiKeys: choiceKeys(settings),
    allowSourcifyFallback: settings.allowSourcifyFallback === true,
    clients: clientsOf(dependencies),
    verifies: kinds?.verifies,
    table,
  });
  if (kinds?.verifies(route.backend) === false) {
    throw kinds.refused(route.backend);
  }
  return route;
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
    throw (
      dependencies.missing?.client(route.backend, chainId) ??
      // Stryker disable next-line StringLiteral: equivalent. unsupported() gives the client message and hint to any reason other than "row" and "listed".
      unsupported(chainId, route.backend, "client")
    );
  }
  if (typeof backend === "function") {
    throw new TypeError(
      `The ${route.backend} client is not loaded: pass the dependencies through withClient() first.`,
    );
  }
  return backend;
}

// References: R-SEC-1.
/**
 * The values of the route's query string, as secrets of the call. A caller who puts a key in
 * `route.apiUrl`'s query gets it removed from errors, logs, events and results, even where an
 * explorer repeats it in an answer. Left out:
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
    // A wait never passes the deadline. A wait cut to the deadline ends polling when it ends:
    // timers and `Date.now()` use different clocks, so an on-time timer can read 1 ms early.
    const remaining = deadline - Date.now();
    const clamped = wait >= remaining;
    await sleep(Math.max(0, Math.min(wait, remaining)), settings.signal);
    wait = settings.pollIntervalMs;
    if (clamped || deadline - Date.now() <= 0) {
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
  let found: Found | undefined;
  try {
    found = await backend.lookup(call.target, graceContext(call));
  } catch (error: unknown) {
    if (mustRethrow(error, settings.signal)) {
      throw error;
    }
    throw notConfirmed(call, handle, stopped.why, stopped.cause ?? error, "failed");
  }
  const confirming = confirmed(call, found, "found no match");
  if (typeof confirming !== "string") {
    return finish(call, "verified", confirming);
  }
  throw notConfirmed(call, handle, stopped.why, stopped.cause, confirming);
}

// References: R-FLOW-4, decisions 0063 and 0067.
/**
 * The match of a lookup after polling when it shows the job's work, or else why not: any match
 * does, but for a `verify()` call only one of the input's contract, and not the partial match
 * that `submitOverPartial` submitted over.
 *
 * @param none - The text for no match.
 */
function confirmed(call: Call, found: Found | undefined, none: string): Found | string {
  if (found === undefined) {
    return none;
  }
  // Stryker disable next-line StringLiteral: equivalent. Only "already-verified" changes what otherOf does with a match that names nothing.
  if (call.otherOf?.(found, "verified") !== undefined) {
    return "found only another contract's source";
  }
  return call.ctx.own?.(found) === false
    ? "found only the partial match that was there before the submit"
    : found;
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
  let found: Found | undefined;
  try {
    found = await backend.lookup(call.target, graceContext(call));
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
  const confirming = confirmed(call, found, "found the contract not verified");
  if (typeof confirming !== "string") {
    return finish(call, "verified", confirming);
  }
  throw newError(
    { code: "job-not-found", handle },
    `${backend.name} does not know job ${handle.jobId}, and a lookup ${confirming}.`,
    {
      hint: "Call verify() again: the job is gone and the contract is not verified, so a new submission is needed.",
      secrets: ctx.http.secrets,
      cause: notFound,
    },
  );
}

/**
 * The match of a job that found the contract already verified without saying the grade: one
 * lookup, which also names the stored contract. A lookup that fails or says "not verified" throws
 * `unknown-state`, never a guess.
 */
async function gradeOf(call: Call, handle: Handle): Promise<Found> {
  const { backend, settings, ctx } = call;
  let found: Found | undefined;
  let cause: unknown;
  try {
    found = await backend.lookup(call.target, graceContext(call));
  } catch (error: unknown) {
    if (mustRethrow(error, settings.signal)) {
      throw error;
    }
    cause = error;
  }
  if (found !== undefined) {
    return found;
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
  lookup: string,
): ExplorerVerifyError {
  const { backend, settings, ctx } = call;
  const reason =
    why === "budget"
      ? `the ${budgetText(settings.timeoutMs)} budget ran out`
      : `${String(MAX_POLL_FAILURES)} status polls in a row failed`;
  const message = `The verification of job ${handle.jobId} on ${backend.name} is not confirmed: ${reason} before the job ended, and a last lookup ${lookup}.`;
  return newError(
    { code: "not-confirmed", handle },
    message,
    cause === undefined ? { secrets: ctx.http.secrets } : { secrets: ctx.http.secrets, cause },
  );
}

// References: R-FLOW-3, R-FLOW-4, decision 0063.
/**
 * A success result, with the public page when the library knows one. Emits `verify.result`.
 *
 * For a `verify()` call, a match whose stored contract is not the input's gives `already-verified`
 * with `storedContract` and a `partial` match, never `verified` or `exact`, and logs at `warn`.
 * An `already-verified` answer that names no contract keeps the other contract the first lookup
 * found, if any.
 */
function finish(call: Call, status: "verified" | "already-verified", found: Found): VerifyResult {
  const { backend, ctx, target, observer } = call;
  const other = call.otherOf?.(found, status);
  const explorerUrl = backend.explorerUrl(target, ctx);
  const page = explorerUrl === undefined ? {} : { explorerUrl };
  const result: Exclude<VerifyResult, { status: "failed" }> =
    other === undefined
      ? { status, backend: backend.name, match: found.match, ...page }
      : {
          status: "already-verified",
          backend: backend.name,
          match: "partial",
          ...page,
          storedContract: other,
        };
  report(observer, {
    type: "verify.result",
    backend: result.backend,
    status: result.status,
    match: result.match,
    ...page,
  });
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
