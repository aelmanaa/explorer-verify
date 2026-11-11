// References: R-RT-4, decision 0034, R-RUN-5.
/**
 * `verifyEach()`: one call that verifies on several backends and returns one outcome per backend.
 * Each backend runs the steps of `verify()` through the same helpers, in
 * parallel, with one shared time budget and the caller's signal. It is its own module, so a caller
 * who imports only `verify` does not bundle it.
 */
import { toBackendName } from "../backend-names.ts";
import type { BackendName } from "../backend-names.ts";
import type { KindCheck } from "../compiler-kinds.ts";
import { newError } from "../error-hints.ts";
import { ExplorerVerifyError } from "../errors.ts";
import type { DetailsOf, InputIssue } from "../errors.ts";
import { collisions, needsKey } from "../http/api-keys.ts";
import type { Budget } from "../http/fetch.ts";
import { validateInput } from "../input/validate.ts";
import { unknownKeys } from "../internal/known-keys.ts";
import { readOwn } from "../internal/read-fields.ts";
import { createObserver } from "../observe.ts";
import {
  routeKeys,
  checkApiUrl,
  readsTable,
  servesWithoutTable,
  tableTarget,
  unsupported,
} from "../routing/resolve.ts";
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
  abortWins,
  checkRouteOf,
  choiceKeys,
  kindsOf,
  loadTable,
  routeWith,
  settingsOf,
  startBudget,
  tableFor,
  verifyOnRoute,
  withClient,
  withHandler,
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

/**
 * The keys of `VerifyEachOptions`, as a record so that a field added to the type and not here
 * fails to compile. `route` stays in the list so that it gets its own issue, which points at the
 * entries of `backends`.
 */
export function eachOptionKeys(): readonly string[] {
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
    backends: true,
  } satisfies Record<keyof VerifyEachOptions | "route", true>);
}

const BACKENDS_HINT =
  'Pass backends as "all" or as an array of backend names or route overrides that name their backend, each backend and API URL once, no key in the address. Put each route in its backends entry, not in route.';

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
 * @internal
 */
export async function runVerifyEach(
  input: VerifyInput,
  options: Partial<VerifyEachOptions> | undefined,
  dependencies: FlowDependencies,
): Promise<VerifyEachResult> {
  const read = settingsOf(options, eachOptionKeys());
  const entries = entriesOf(options, read);
  read.signal?.throwIfAborted();
  return await abortWins(read.signal, async () => {
    const checked = validateInput(input);
    const { chainId } = checked;
    const budget = startBudget(read);
    const settings = await withHandler(read, budget, dependencies.handler, dependencies.missing);
    const runs = await runsOf(
      chainId,
      kindsOf(checked, dependencies),
      entries,
      settings,
      dependencies,
      budget,
    );
    // Every entry's key is a secret of every call, whether its route resolved or not, so no
    // output of one backend shows another's.
    const secrets = [
      ...settings.keySecrets(),
      ...runs.flatMap(({ entry }) => (entry.apiKey === undefined ? [] : [entry.apiKey])),
    ];
    const everySecret = [...secrets, ...settings.rpcSecrets];
    checkRuns(runs, settings, checked.address, chainId, everySecret);
    const shared: Settings = { ...settings, keySecrets: () => secrets };
    const settled = await Promise.allSettled(
      runs.map(async ({ entry, route }, index): Promise<BackendOutcome> => {
        const own: Settings = {
          ...shared,
          route: entry,
          onEvent:
            settings.onEvent === undefined
              ? undefined
              : (event) => settings.onEvent?.({ ...event, entry: index }),
        };
        createObserver({
          logger: settings.logger,
          onEvent: own.onEvent,
          secrets: everySecret,
        }).emit({ type: "verify.validated", chainId, address: checked.address });
        try {
          if (route instanceof ExplorerVerifyError) {
            throw route;
          }
          // A client that fails to load is a network error, so that backend's outcome, and the
          // other backends go on (decision 0054).
          const loaded = await withClient(route, dependencies, own, budget);
          const result = await verifyOnRoute(checked, route, own, loaded, budget, false);
          return outcomeOf(entry.backend, result);
        } catch (error: unknown) {
          // An abort needs no check here: abortWins rejects with the reason, and the call throws
          // it again once every backend has settled.
          if (!(error instanceof ExplorerVerifyError)) {
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

// References: R-SEC-1.
/**
 * Checks every run against the others before any request, and throws `invalid-input` with every
 * issue:
 *
 * - Two entries that resolve to the same backend and API base, once the URL is normalised (host
 *   case, trailing slashes), are a duplicate. The same backend on two hosts is allowed.
 * - Every key, from `apiKeys` or an entry's `apiKey`, must not appear in the address or in the
 *   handle's fixed part of any backend: redaction would corrupt them.
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
    throw newError(
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
  const checked = checkApiUrl(apiUrl);
  // Stryker disable next-line StringLiteral: equivalent. Every entry without a usable apiUrl gets the same text, whatever it is.
  return typeof checked === "string" ? "" : checked.apiBase;
}

// References: decision 0040, decision 0057.
/**
 * The runs of the call: each entry with its route. Every entry is checked before the routing table
 * loads, and the table loads only when an entry needs it (`readsTable`), or for `"all"`, which
 * reads the chain's row. For `"all"`, a table that fails to load throws `network`, as in
 * `verify()`.
 * For a list, it is the outcome of each entry that reads the table, as a client's load failure is.
 * An entry whose backend does not map the input's compiler kind ends in `unsupported-compiler`,
 * before any request.
 */
async function runsOf(
  chainId: number,
  kinds: KindCheck,
  entries: readonly Entry[] | "all",
  settings: Settings,
  dependencies: FlowDependencies,
  budget: Budget,
): Promise<Run[]> {
  if (entries === "all") {
    const table = await loadTable(
      dependencies.table,
      "sourcify",
      settings,
      budget,
      dependencies.missing,
    );
    return everyListed(chainId, kinds, settings, dependencies, table).map((entry, index) => ({
      entry,
      route: routeFor(chainId, kinds, settings, entry, index, dependencies, table),
    }));
  }
  const checked = entries.map((entry, index) => ({
    entry,
    checked: checkEntry(chainId, settings, entry, index, dependencies),
  }));
  // Without a table, which only explorer-verify/core allows, only an entry without apiUrl reads
  // one, and it throws invalid-input naming table (decision 0052).
  const reading = checked.find(
    (each) =>
      readsTable(each.checked) &&
      (dependencies.table !== undefined || !servesWithoutTable(each.checked)),
  );
  let table: RoutingTable | undefined;
  let failure: TableFailure | undefined;
  // Stryker disable next-line ConditionalExpression: equivalent when always true. Without an entry that reads the table, the failure of reading.checked is never used.
  if (reading !== undefined) {
    try {
      table = await tableFor(
        reading.checked,
        dependencies.table,
        settings,
        budget,
        dependencies.missing,
      );
    } catch (error: unknown) {
      // A table the caller of explorer-verify/core left out is an error in the options, thrown
      // before any request, not the outcome of the entries that read it (decision 0052).
      // Only a load that failed or ran out of time is the entries' outcome (decision 0054).
      if (
        settings.signal?.aborted === true ||
        !(error instanceof ExplorerVerifyError) ||
        (error.details.code !== "timeout" && error.details.code !== "network")
      ) {
        throw error;
      }
      failure = { error, details: error.details };
    }
  }
  // Every key of the call, every entry's included, and the RPC secrets.
  const secrets = [
    ...settings.keySecrets(),
    ...entries.flatMap((entry) => (entry.apiKey === undefined ? [] : [entry.apiKey])),
    ...settings.rpcSecrets,
  ];
  return checked.map(({ entry, checked: each }, index) => ({
    entry,
    route:
      failure !== undefined && readsTable(each)
        ? tableFailure(entry, failure, secrets)
        : routeFor(chainId, kinds, settings, entry, index, dependencies, table, each),
  }));
}

/** A routing table load that failed or ran out of time, with its details narrowed. */
interface TableFailure {
  readonly error: ExplorerVerifyError;
  readonly details: DetailsOf<"timeout" | "network">;
}

/**
 * The outcome of an entry that reads a routing table that failed to load: the `timeout` or
 * `network` error of the load, naming the entry's backend, its cause redacted with every key of
 * the call.
 */
function tableFailure(
  entry: Entry,
  { error, details }: TableFailure,
  secrets: readonly string[],
): ExplorerVerifyError {
  return newError({ ...details, backend: entry.backend }, error.message, {
    secrets,
    cause: error.cause,
    hint: error.hint,
  });
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
  return newError(
    { code: "invalid-input", issues },
    `The backends option is invalid: ${issues.map((issue) => issue.field).join(", ")}.`,
    {
      hint: renamed(error.hint, index),
      // Stryker disable next-line StringLiteral,ArrayDeclaration: equivalent. The message and the issues name only fields, and the hint is fixed text.
      secrets: typeof override.apiKey === "string" ? [override.apiKey] : [],
    },
  );
}

// References: decision 0039.
/**
 * The route of one entry, checked with {@link checkEntry} unless `checked` is given. An
 * `unsupported-chain` is returned, as that backend's outcome, with its hint naming the entry. An
 * `invalid-input` that needs the row, a `route.apiKey` for a standalone explorer that takes none,
 * is thrown with its fields named after the entry.
 */
function routeFor(
  chainId: number,
  kinds: KindCheck,
  settings: Settings,
  override: Entry,
  index: number,
  dependencies: FlowDependencies,
  table: RoutingTable | undefined,
  checked: CheckedRoute = checkEntry(chainId, settings, override, index, dependencies),
): Route | ExplorerVerifyError {
  const own: Settings = { ...settings, route: override };
  try {
    return routeWith(chainId, checked, own, dependencies, table, kinds);
  } catch (error: unknown) {
    if (!(error instanceof ExplorerVerifyError) || error.details.code === "invalid-input") {
      throw entryError(error, override, index);
    }
    // `unsupported-chain` or `unsupported-compiler`, the only other errors routeWith throws:
    // this backend's outcome.
    return newError(error.details, error.message, {
      hint: renamed(error.hint, index),
      // Stryker disable next-line ArrayDeclaration: equivalent. The message holds only the chain id and the backend name.
      secrets: [],
    });
  }
}

/**
 * The entries of `"all"`: every backend the chain's row lists that this version has a client for,
 * in the row's order. A chain with no row gives Sourcify when `allowSourcifyFallback` is set, and
 * otherwise throws `unsupported-chain`, as `verify()` does. Backends that do not map the input's
 * compiler kind are left out, unless none maps it: then each ends in `unsupported-compiler`.
 */
function everyListed(
  chainId: number,
  kinds: KindCheck,
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
  // Stryker disable next-line ArrayDeclaration: equivalent. keyed is only searched for backend names.
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
    const first = toBackendName(row.backends[0]?.backend) ?? "sourcify";
    throw (
      dependencies.missing?.client(first, chainId) ??
      // Stryker disable next-line StringLiteral: equivalent. unsupported() gives the client message and hint to any reason other than "row" and "listed".
      unsupported(chainId, first, "client")
    );
  }
  // As the routing table chooses for verify(): a backend that needs a key is left out without
  // one, whether or not `fetch` is set. `handlerUrl` counts as an Etherscan key, as it does for
  // verify() (decision 0046). When every listed backend needs a key and none is set, they all
  // stay, and each ends in `missing-api-key`. The compiler kind is checked first (decision 0057).
  const capable = names.filter((name) => kinds.verifies(name));
  const listed = capable.length > 0 ? capable : names;
  const keys = choiceKeys(settings);
  const usable = listed.filter(
    (name) => !(needsKey(name) || keyed.includes(name)) || readOwn(keys, name) !== undefined,
  );
  return (usable.length > 0 ? usable : listed).map((backend) => ({ backend }));
}

/**
 * Reads `backends` and checks that `route` is absent. Each entry becomes a route override with its
 * backend named; `resolveRoute` checks the rest of it. Throws `invalid-input` with every issue.
 */
function entriesOf(
  options: Partial<VerifyEachOptions> | undefined,
  settings: Settings,
): Entry[] | "all" {
  const issues: InputIssue[] = [];
  let raw: unknown;
  try {
    // Stryker disable next-line ConditionalExpression: equivalent when always false. readOwn throws on undefined, and the catch block leaves raw undefined.
    raw = options === undefined ? undefined : readOwn(options, "backends");
  } catch {
    // A getter or Proxy trap threw. Its error is dropped: it may repeat a caller value. raw stays
    // undefined.
  }
  if (settings.route !== undefined) {
    issues.push({
      field: "route",
      message: "is not used by verifyEach(); set it in an entry of backends",
    });
  }
  const entries = raw === "all" ? "all" : listOf(raw, issues);
  if (issues.length > 0) {
    throw newError(
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
    // Reading the array threw: items stays undefined.
  }
  if (items === undefined || items.length === 0 || items.length > MAX_BACKENDS) {
    issues.push({
      field: "backends",
      message: `must be "all" or an array of 1 to ${String(MAX_BACKENDS)} entries`,
    });
    // Stryker disable next-line ArrayDeclaration: equivalent. An issue makes entriesOf throw, so the entries are never read.
    return [];
  }
  const entries: Entry[] = [];
  items.forEach((item, index) => {
    const entry = entryOf(item, `backends[${String(index)}]`, issues);
    // Stryker disable next-line ConditionalExpression: equivalent when always true. An undefined entry comes with an issue, which makes entriesOf throw.
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
  const fields = readEntry(item, field);
  if (typeof fields === "string") {
    issues.push({ field, message: fields });
    return undefined;
  }
  issues.push(...fields.unknown);
  const backend = toBackendName(fields.backend);
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
 * `route`, and an issue for each other own enumerable key; or the issue message. Only a plain
 * object (prototype `Object.prototype` or `null`) is read, and no other field is touched, so a
 * getter on an unknown field never runs. A getter or Proxy trap that throws gives an issue
 * without its text.
 */
function readEntry(
  item: unknown,
  field: string,
): { backend: unknown; apiUrl: unknown; apiKey: unknown; unknown: readonly InputIssue[] } | string {
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
      unknown: unknownKeys(Object.keys(item), routeKeys(), `${field}.`, field),
      backend: readOwn(fields, "backend"),
      apiUrl: readOwn(fields, "apiUrl"),
      apiKey: readOwn(fields, "apiKey"),
    };
  } catch {
    // A getter or Proxy trap threw. Its error is dropped: it may repeat a caller value.
    return "could not be read";
  }
}
