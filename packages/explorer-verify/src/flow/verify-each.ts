/**
 * `verifyEach()`: one call that verifies on several backends and returns one outcome per backend
 * (R-RT-4, decision 0034). Each backend runs the steps of `verify()` through the same helpers, in
 * parallel, with one shared time budget and the caller's signal. It is its own module, so a caller
 * who imports only `verify` does not bundle it (R-RUN-5).
 */
import { toBackendName } from "../backend-names.ts";
import type { BackendName } from "../backend-names.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { InputIssue } from "../errors.ts";
import { collisions, needsKey } from "../http/api-keys.ts";
import type { Budget } from "../http/fetch.ts";
import { validateInput } from "../input/validate.ts";
import { readOwn } from "../internal/read-fields.ts";
import { createObserver } from "../observe.ts";
import { checkApiUrl, readsTable, tableTarget, unsupported } from "../routing/resolve.ts";
import type { CheckedRoute, Route, RoutingTable } from "../routing/resolve.ts";
import type {
  BackendEntry,
  BackendOutcome,
  VerifyEachOptions,
  VerifyEachResult,
  VerifyInput,
  VerifyResult,
} from "../types.ts";
import {
  DEFAULT_DEPENDENCIES,
  abortWins,
  checkRouteOf,
  loadTable,
  routeWith,
  settingsOf,
  startBudget,
  tableFor,
  verifyOnRoute,
  withClient,
} from "./verify.ts";
import type { FlowDependencies, Settings } from "./verify.ts";

/** An entry of `backends`, read into a route override that names its backend. */
type Entry = Exclude<BackendEntry, BackendName>;

/** One backend of the call: its entry, and its route or the `unsupported-chain` it resolved to. */
interface Run {
  readonly entry: Entry;
  readonly route: Route | ExplorerVerifyError;
}

/** The most entries `backends` may hold. */
export const MAX_BACKENDS = 16;

const BACKENDS_HINT =
  'Pass backends as "all" or as an array of backend names or route overrides that name their backend, each backend and API URL once, no key in the address. Put each route in its backends entry, not in route.';

/**
 * Verifies a deployed contract's source on several backends in one call (R-RT-4), and returns
 * one outcome per entry of `options.backends`, in the same order.
 *
 * 1. Validates the input and the options, reads `backends` and resolves each entry's route.
 *    Nothing is sent before all of them pass. `"all"` stands for every backend the routing table
 *    lists for the chain that this version has a client for, less a backend that needs a key when
 *    none is set, as the routing table chooses for `verify()`. Two entries that resolve to the same
 *    backend and API URL, and a key found in the address or a handle's fixed part, throw
 *    `invalid-input`. An entry is known by its position: the same backend may appear twice on two
 *    hosts. Fields of an entry other than `backend`, `apiUrl` and `apiKey` are ignored, as in `route`.
 * 2. Runs the steps of `verify()` on every backend at once, with one time budget, `timeoutMs`,
 *    shared by all of them, and the caller's `signal`. Each backend gets only its own key: a key
 *    from `apiKeys` goes only to its backend's routing-table host, and `route.apiKey` only to its
 *    entry's `apiUrl` (decision 0016).
 * 3. Maps each backend's end to an outcome: `{ backend, ok: true, result }` for `verified` or
 *    `already-verified`, `{ backend, ok: false, result }` for `failed`, and
 *    `{ backend, ok: false, error }` with the `ExplorerVerifyError` for an error. A `not-confirmed`
 *    error keeps its handle, so `checkStatus()` with that entry's route resumes that backend alone.
 *    A backend the chain's row does not list is an `unsupported-chain` outcome, and a client
 *    module that fails to load a `network` outcome with the load's error as its cause; the other
 *    backends still run. The routing table loads only when an entry needs it, mostly one without
 *    `apiUrl`, or for `"all"` (decision 0040). When it fails to load, each entry that needs it
 *    gets that outcome too, as a client's load failure; for `"all"`, the call throws the load's
 *    error.
 *
 * It emits `verify.validated` once, then each backend's events as `verify()` emits them. Every
 * event after the first carries its `backend`, so the streams interleave.
 *
 * @param input - What to verify. It is checked with `validateInput` first.
 * @param options - The options of `verify()` without `route`, and `backends`.
 * @returns One outcome per backend.
 * @throws The caller's `signal.reason`, unchanged, when the signal aborts (R-FLOW-6). The
 *   `verify.submitted` event of every submission made before the abort was emitted.
 * @throws ExplorerVerifyError `invalid-input` for bad input, options or `backends`, and
 *   `unsupported-chain` for `"all"` on a chain the routing table does not list. Nothing was sent.
 * @throws Any error that is not an `ExplorerVerifyError` and does not come from a client load,
 *   which only a bug can cause.
 * @example
 * ```ts
 * import { verifyEach } from "explorer-verify";
 *
 * declare const etherscanKey: string;
 *
 * const { outcomes } = await verifyEach(input, {
 *   backends: ["sourcify", "etherscan-v2"],
 *   apiKeys: { "etherscan-v2": etherscanKey },
 * });
 * for (const outcome of outcomes) {
 *   console.log(outcome.backend, "error" in outcome ? outcome.error.code : outcome.result.status);
 * }
 * ```
 * @experimental
 */
export async function verifyEach(
  input: VerifyInput,
  options: VerifyEachOptions,
): Promise<VerifyEachResult> {
  return await runVerifyEach(input, options, DEFAULT_DEPENDENCIES);
}

/**
 * {@link verifyEach} with its dependencies passed in. Internal: the package entry point does not
 * export it.
 *
 * @param input - What to verify.
 * @param options - The caller's options.
 * @param dependencies - The backend clients, the jitter source and the routing table.
 * @returns One outcome per backend.
 * @example
 * ```ts
 * const result = await runVerifyEach(input, { backends: ["sourcify"] }, { backends: { sourcify } });
 * ```
 */
export async function runVerifyEach(
  input: VerifyInput,
  options: VerifyEachOptions | undefined,
  dependencies: FlowDependencies,
): Promise<VerifyEachResult> {
  const settings = settingsOf(options);
  const entries = entriesOf(options, settings);
  settings.signal?.throwIfAborted();
  return await abortWins(settings.signal, async () => {
    const checked = validateInput(input);
    const { chainId } = checked;
    const budget = startBudget(settings);
    const runs = await runsOf(chainId, entries, settings, dependencies, budget);
    // Every entry's key is a secret of every call, whether its route resolved or not, so no
    // output of one backend shows another's.
    const secrets = [
      ...settings.keySecrets(),
      ...runs.flatMap(({ entry }) => (entry.apiKey === undefined ? [] : [entry.apiKey])),
    ];
    const everySecret = [...secrets, ...settings.rpcSecrets];
    checkRuns(runs, settings, checked.address, chainId, everySecret);
    const shared: Settings = { ...settings, keySecrets: () => secrets };
    createObserver({
      logger: settings.logger,
      onEvent: settings.onEvent,
      secrets: everySecret,
    }).emit({ type: "verify.validated", chainId, address: checked.address });
    const settled = await Promise.allSettled(
      runs.map(async ({ entry, route }): Promise<BackendOutcome> => {
        const own: Settings = { ...shared, route: entry };
        try {
          if (route instanceof ExplorerVerifyError) {
            throw route;
          }
          const loaded = await loadClient(route, dependencies, own, budget, everySecret);
          const result = await verifyOnRoute(checked, route, own, loaded, budget, false);
          return outcomeOf(entry.backend, result);
        } catch (error: unknown) {
          if (settings.signal?.aborted === true || !(error instanceof ExplorerVerifyError)) {
            throw error;
          }
          return { backend: entry.backend, ok: false, error };
        }
      }),
    );
    settings.signal?.throwIfAborted();
    const outcomes: BackendOutcome[] = [];
    for (const each of settled) {
      if (each.status === "rejected") {
        const reason: unknown = each.reason;
        throw reason;
      }
      outcomes.push(each.value);
    }
    return { outcomes };
  });
}

/** The outcome of a result. */
function outcomeOf(backend: BackendName, result: VerifyResult): BackendOutcome {
  return result.status === "failed"
    ? { backend, ok: false, result }
    : { backend, ok: true, result };
}

/**
 * The dependencies with the route's client loaded, as `withClient` gives them. A client module
 * that fails to load, such as a chunk the page cannot fetch, becomes a `network` error with the
 * load's error as its cause, so it is that backend's outcome and the other backends go on. An
 * abort and a `timeout` pass through unchanged.
 */
async function loadClient(
  route: Route,
  dependencies: FlowDependencies,
  settings: Settings,
  budget: Budget,
  secrets: readonly string[],
): Promise<FlowDependencies> {
  try {
    return await withClient(route, dependencies, settings, budget);
  } catch (error: unknown) {
    if (settings.signal?.aborted === true || error instanceof ExplorerVerifyError) {
      throw error;
    }
    throw new ExplorerVerifyError(
      { code: "network", backend: route.backend, attempts: 1 },
      `Loading the ${route.backend} client failed.`,
      { secrets, cause: error },
    );
  }
}

/**
 * Checks every run against the others before any request, and throws `invalid-input` with every
 * issue:
 *
 * - Two entries that resolve to the same backend and API base, once the URL is normalised (host
 *   case, trailing slashes), are a duplicate. The same backend on two hosts is allowed.
 * - Every key, from `apiKeys` or an entry's `apiKey`, must not appear in the address or in the
 *   handle's fixed part of any backend: redaction would corrupt them (R-SEC-1).
 */
function checkRuns(
  runs: readonly Run[],
  settings: Settings,
  address: string,
  chainId: number,
  secrets: readonly string[],
): void {
  const issues: InputIssue[] = [];
  const seen = new Set<string>();
  runs.forEach(({ entry, route }, index) => {
    const target =
      route instanceof ExplorerVerifyError
        ? `${entry.backend} ${normalised(entry.apiUrl)}`
        : `${route.backend} ${route.apiBase}`;
    if (seen.has(target)) {
      issues.push({
        field: `backends[${String(index)}]`,
        message: "resolves to the backend and API URL of an earlier entry",
      });
    }
    seen.add(target);
  });
  const keys: [string, string][] = Object.entries(settings.apiKeys()).map(([name, key]) => [
    `apiKeys.${name}`,
    key,
  ]);
  runs.forEach(({ entry }, index) => {
    if (entry.apiKey !== undefined) {
      keys.push([`backends[${String(index)}].apiKey`, entry.apiKey]);
    }
  });
  const clashes = new Set<string>();
  for (const { entry } of runs) {
    for (const issue of collisions(keys, `ev1:${entry.backend}:${String(chainId)}:${address}`)) {
      if (!clashes.has(issue.field)) {
        clashes.add(issue.field);
        issues.push(issue);
      }
    }
  }
  if (issues.length > 0) {
    throw new ExplorerVerifyError(
      { code: "invalid-input", issues },
      `The options are invalid: ${issues.map((issue) => issue.field).join(", ")}.`,
      { hint: BACKENDS_HINT, secrets },
    );
  }
}

/**
 * An entry's `apiUrl` as `resolveRoute` would normalise it (host case, trailing slashes), or empty
 * when it is absent or does not parse, for the duplicate check of an entry with no route.
 */
function normalised(apiUrl: string | undefined): string {
  const checked = apiUrl === undefined ? "" : checkApiUrl(apiUrl);
  return typeof checked === "string" ? "" : checked.apiBase;
}

/**
 * The runs of the call: each entry with its route. Every entry is checked before the routing table
 * loads, and the table loads only when an entry needs it (`readsTable`), or for `"all"`, which
 * reads the chain's row (decision 0040). For `"all"`, a table that fails to load throws, as in `verify()`.
 * For a list, it is the outcome of each entry that reads the table, as a client's load failure is.
 */
async function runsOf(
  chainId: number,
  entries: readonly Entry[] | "all",
  settings: Settings,
  dependencies: FlowDependencies,
  budget: Budget,
): Promise<Run[]> {
  if (entries === "all") {
    const table = await loadTable(dependencies.table, "sourcify", settings, budget);
    return everyListed(chainId, settings, dependencies, table).map((entry, index) => ({
      entry,
      route: routeFor(chainId, settings, entry, index, dependencies, table),
    }));
  }
  const checked = entries.map((entry, index) => ({
    entry,
    checked: checkEntry(chainId, settings, entry, index, dependencies),
  }));
  const reading = checked.find((each) => readsTable(each.checked));
  let table: RoutingTable | undefined;
  let failure: { readonly error: unknown } | undefined;
  if (reading !== undefined) {
    try {
      table = await tableFor(reading.checked, dependencies.table, settings, budget);
    } catch (error: unknown) {
      if (settings.signal?.aborted === true) {
        throw error;
      }
      failure = { error };
    }
  }
  // As loadClient's: every key of the call, every entry's included, and the RPC secrets.
  const secrets = [
    ...settings.keySecrets(),
    ...entries.flatMap((entry) => (entry.apiKey === undefined ? [] : [entry.apiKey])),
    ...settings.rpcSecrets,
  ];
  return checked.map(({ entry, checked: each }, index) => ({
    entry,
    route:
      failure !== undefined && readsTable(each)
        ? tableFailure(entry, failure.error, secrets)
        : routeFor(chainId, settings, entry, index, dependencies, table, each),
  }));
}

/**
 * The outcome of an entry that reads a routing table that failed to load, as `loadClient` maps a
 * client's: a `timeout` names the entry's backend, another `ExplorerVerifyError` stays as it is,
 * and any other error becomes `network` with it as the cause.
 */
function tableFailure(
  entry: Entry,
  error: unknown,
  secrets: readonly string[],
): ExplorerVerifyError {
  if (!(error instanceof ExplorerVerifyError)) {
    return new ExplorerVerifyError(
      { code: "network", backend: entry.backend, attempts: 1 },
      "Loading the routing table failed.",
      { secrets, cause: error },
    );
  }
  const { details } = error;
  return details.code === "timeout"
    ? new ExplorerVerifyError({ ...details, backend: entry.backend }, error.message, {
        secrets: [],
      })
    : error;
}

/** `text` with `route` named after the entry, such as `backends[1].apiUrl`. */
function renamed(text: string, index: number): string {
  return text.replaceAll(/\broute\b(?=\.|$)/g, `backends[${String(index)}]`);
}

/**
 * Checks one entry as a route override. An `invalid-input` is thrown with its fields named after
 * the entry, such as `backends[1].apiUrl`.
 */
function checkEntry(
  chainId: number,
  settings: Settings,
  override: Entry,
  index: number,
  dependencies: FlowDependencies,
): CheckedRoute {
  try {
    return checkRouteOf(chainId, { ...settings, route: override }, dependencies);
  } catch (error: unknown) {
    throw entryError(error, override, index);
  }
}

/**
 * `error` with an `invalid-input`'s fields and hint named after the entry, such as
 * `backends[1].apiKey`; any other error unchanged, to be thrown.
 */
function entryError(error: unknown, override: Entry, index: number): unknown {
  if (!(error instanceof ExplorerVerifyError) || error.details.code !== "invalid-input") {
    return error;
  }
  const issues = error.details.issues.map((issue) => ({
    field: renamed(issue.field, index),
    message: issue.message,
  }));
  return new ExplorerVerifyError(
    { code: "invalid-input", issues },
    `The backends option is invalid: ${issues.map((issue) => issue.field).join(", ")}.`,
    {
      hint: renamed(error.hint, index),
      secrets: typeof override.apiKey === "string" ? [override.apiKey] : [],
    },
  );
}

/**
 * The route of one entry, checked with {@link checkEntry} unless `checked` is given. An
 * `unsupported-chain` is returned, as that backend's outcome, with its hint naming the entry. An
 * `invalid-input` that needs the row, a `route.apiKey` for a standalone explorer that takes none
 * (decision 0039), is thrown with its fields named after the entry.
 */
function routeFor(
  chainId: number,
  settings: Settings,
  override: Entry,
  index: number,
  dependencies: FlowDependencies,
  table: RoutingTable | undefined,
  checked: CheckedRoute = checkEntry(chainId, settings, override, index, dependencies),
): Route | ExplorerVerifyError {
  const own: Settings = { ...settings, route: override };
  try {
    return routeWith(chainId, checked, own, dependencies, table);
  } catch (error: unknown) {
    if (!(error instanceof ExplorerVerifyError) || error.details.code === "invalid-input") {
      throw entryError(error, override, index);
    }
    // `unsupported-chain`, the only other error routeWith throws: this backend's outcome.
    return new ExplorerVerifyError(error.details, error.message, {
      hint: renamed(error.hint, index),
      secrets: [],
    });
  }
}

/**
 * The entries of `"all"`: every backend the chain's row lists that this version has a client for,
 * in the row's order. A chain with no row gives Sourcify when `allowSourcifyFallback` is set, and
 * otherwise throws `unsupported-chain`, as `verify()` does.
 */
function everyListed(
  chainId: number,
  settings: Settings,
  dependencies: FlowDependencies,
  table: RoutingTable,
): Entry[] {
  const row = table.chains.find((each) => each.chainId === chainId);
  if (row === undefined) {
    if (settings.allowSourcifyFallback === true) {
      return [{ backend: "sourcify" }];
    }
    throw unsupported(chainId, "sourcify", "row");
  }
  const names: BackendName[] = [];
  // Backends whose table entry says its API refuses a request without a key (decision 0039).
  const keyed: BackendName[] = [];
  for (const entry of row.backends) {
    const name = toBackendName(entry.backend);
    if (name !== undefined && dependencies.backends[name] !== undefined && !names.includes(name)) {
      names.push(name);
      if (tableTarget(chainId, entry)?.needsKey === true) {
        keyed.push(name);
      }
    }
  }
  if (names.length === 0) {
    throw unsupported(
      chainId,
      toBackendName(row.backends[0]?.backend ?? "") ?? "sourcify",
      "client",
    );
  }
  // As the routing table chooses for verify(): a backend that needs a key is left out without
  // one, whether or not `fetch` is injected. When every listed backend needs a key and none is
  // set, they all stay, and each ends in `missing-api-key` unless `fetch` is injected.
  const keys = settings.apiKeys();
  const usable = names.filter(
    (name) => !(needsKey(name) || keyed.includes(name)) || readOwn(keys, name) !== undefined,
  );
  return (usable.length > 0 ? usable : names).map((backend) => ({ backend }));
}

/**
 * Reads `backends` and checks that `route` is absent. Each entry becomes a route override with its
 * backend named; `resolveRoute` checks the rest of it. Throws `invalid-input` with every issue.
 */
function entriesOf(options: VerifyEachOptions | undefined, settings: Settings): Entry[] | "all" {
  const issues: InputIssue[] = [];
  let raw: unknown;
  try {
    raw = options === undefined ? undefined : readOwn(options, "backends");
  } catch {
    // A getter or Proxy trap threw. Its error is dropped: it may repeat a caller value.
    raw = undefined;
  }
  if (settings.route !== undefined) {
    issues.push({
      field: "route",
      message: "is not used by verifyEach(); set it in an entry of backends",
    });
  }
  const entries = raw === "all" ? "all" : listOf(raw, issues);
  if (issues.length > 0) {
    throw new ExplorerVerifyError(
      { code: "invalid-input", issues },
      `The options are invalid: ${issues.map((issue) => issue.field).join(", ")}.`,
      { hint: BACKENDS_HINT, secrets: settings.keySecrets() },
    );
  }
  return entries;
}

/** The entries of a `backends` array, or an issue for each problem. */
function listOf(raw: unknown, issues: InputIssue[]): Entry[] {
  let items: readonly unknown[] | undefined;
  try {
    if (Array.isArray(raw)) {
      const list: readonly unknown[] = raw;
      items = [...list];
    }
  } catch {
    items = undefined;
  }
  if (items === undefined || items.length === 0 || items.length > MAX_BACKENDS) {
    issues.push({
      field: "backends",
      message: `must be "all" or an array of 1 to ${String(MAX_BACKENDS)} entries`,
    });
    return [];
  }
  const entries: Entry[] = [];
  items.forEach((item, index) => {
    const entry = entryOf(item, `backends[${String(index)}]`, issues);
    if (entry !== undefined) {
      entries.push(entry);
    }
  });
  return entries;
}

/** One entry: a backend name, or a plain object with `backend` and optional route fields. */
function entryOf(item: unknown, field: string, issues: InputIssue[]): Entry | undefined {
  if (typeof item === "string") {
    const backend = toBackendName(item);
    if (backend === undefined) {
      issues.push({ field, message: "must name a known backend" });
      return undefined;
    }
    return { backend };
  }
  const fields = readEntry(item);
  if (typeof fields === "string") {
    issues.push({ field, message: fields });
    return undefined;
  }
  const backend = typeof fields.backend === "string" ? toBackendName(fields.backend) : undefined;
  if (backend === undefined) {
    issues.push({ field: `${field}.backend`, message: "must name a known backend" });
    return undefined;
  }
  const entry: Entry = { backend };
  for (const name of ["apiUrl", "apiKey"] as const) {
    const value = fields[name];
    if (typeof value === "string") {
      entry[name] = value;
    } else if (value !== undefined) {
      issues.push({ field: `${field}.${name}`, message: "must be a string" });
    }
  }
  return entry;
}

/**
 * The three fields of an object entry, each an own property read once, as `resolveRoute` reads
 * `route`; or the issue message. Only a plain object (prototype `Object.prototype` or `null`) is
 * read, and no other field is touched, so a getter on an unknown field never runs. A getter or
 * Proxy trap that throws gives an issue without its text.
 */
function readEntry(item: unknown): { backend: unknown; apiUrl: unknown; apiKey: unknown } | string {
  if (typeof item !== "object" || item === null) {
    return "must be a backend name or a plain object whose backend names a known backend";
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      return "must be a plain object";
    }
    const fields: {
      readonly backend?: unknown;
      readonly apiUrl?: unknown;
      readonly apiKey?: unknown;
    } = item;
    return {
      backend: readOwn(fields, "backend"),
      apiUrl: readOwn(fields, "apiUrl"),
      apiKey: readOwn(fields, "apiKey"),
    };
  } catch {
    // A getter or Proxy trap threw. Its error is dropped: it may repeat a caller value.
    return "could not be read";
  }
}
