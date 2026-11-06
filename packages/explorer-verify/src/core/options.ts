/**
 * Reads the `clients` and `table` options of `explorer-verify/core` into the engine's
 * dependencies, and hands the engine the other options untouched (decision 0052).
 */
import type { BackendName } from "../backend-names.ts";
import type { Backend, ProxyLinker } from "../backends/backend.ts";
import { newError } from "../error-hints.ts";
import type { ExplorerVerifyError, InputIssue } from "../errors.ts";
import type { LinkDependencies, LinkerLoader } from "../flow/link-proxy.ts";
import type {
  DeriveLoader,
  FlowDependencies,
  HandlerLoader,
  LinkMissing,
  Missing,
} from "../flow/verify.ts";
import { unknownKeys } from "../internal/known-keys.ts";
import type { RoutingTable } from "../routing/resolve.ts";
import { clientParts, linkParts, tableRows } from "./parts.ts";
import type { ExplorerClient, ShippedRoutingTable } from "./parts.ts";

/**
 * The options `explorer-verify/core` adds to those of the default entry.
 *
 * @experimental
 */
export interface ClientOptions<C> {
  /**
   * The clients the call may use, from `explorer-verify/clients/<name>`, such as `[sourcify()]`.
   * At least one. The routing table chooses only among the backends these serve, and a backend
   * with no client here is never called: naming it in `route.backend` throws `invalid-input`, and
   * a chain whose listed backends all lack one throws `unsupported-chain`, both before any request.
   */
  readonly clients: readonly [C, ...C[]];
  /**
   * The routing table, from `explorer-verify/table`. Leave it out when every call sets
   * `route.apiUrl`, or names `sourcify`, `etherscan-v2` or `blockscout-hosted` in `route.backend`:
   * those have one public host for every chain. The rows are then not bundled, and no row is read,
   * so a result has no explorer page from one, and a standalone Etherscan-compatible row's early
   * `missing-api-key` check does not apply. Any other call throws `invalid-input` naming `table`.
   */
  readonly table?: ShippedRoutingTable | undefined;
}

/** The options a call through `explorer-verify/core` passes on, and the dependencies it built. */
interface Split<D> {
  /** The caller's options without `clients` and `table`, their getters still unread. */
  readonly rest: object;
  readonly dependencies: D;
}

/** The two keys `explorer-verify/core` reads itself, checked against {@link ClientOptions}. */
// Stryker disable next-line BooleanLiteral: equivalent. Object.keys reads only the keys, never the values.
const OWN_KEYS: readonly string[] = Object.keys({ clients: true, table: true } satisfies Record<
  keyof ClientOptions<ExplorerClient>,
  true
>);

const HINT =
  "Pass clients from explorer-verify/clients, such as [sourcify()], and table from explorer-verify/table, or leave table out.";

/** The factory of each backend's client, as `explorer-verify/clients/*` exports it. */
const FACTORY: Readonly<Record<BackendName, string>> = {
  sourcify: "sourcify",
  "etherscan-v2": "etherscanV2",
  "etherscan-compatible": "etherscanCompatible",
  routescan: "routescan",
  blockscout: "blockscout",
  "blockscout-hosted": "blockscoutHosted",
};

/** The factory of each proxy-link client; Routescan has none. */
const LINK_FACTORY: Readonly<Partial<Record<BackendName, string>>> = {
  sourcify: "sourcifyProxyLink",
  "etherscan-v2": "etherscanV2ProxyLink",
  "etherscan-compatible": "etherscanCompatibleProxyLink",
  blockscout: "blockscoutProxyLink",
  "blockscout-hosted": "blockscoutProxyLink",
};

/**
 * The errors the engine throws for what a caller of `explorer-verify/core` left out, before any
 * request. Their text lives here, so the default entry does not bundle it.
 *
 * @param rows - The table the call passed, to name every backend a chain lists.
 * @returns The errors.
 */
function missingFor(rows: RoutingTable | undefined): Missing {
  return {
    client: (backend, chainId) => {
      // Stryker disable next-line OptionalChaining: equivalent. The engine asks only for a route the table chose, so rows is set.
      const row = rows?.chains.find((each) => each.chainId === chainId);
      // Stryker disable next-line OptionalChaining,ArrayDeclaration: equivalent. A chain the table chose for has a row.
      const listed = [...new Set(row?.backends.map((entry) => entry.backend) ?? [backend])];
      return newError(
        { code: "unsupported-chain", chainId, backend },
        `No client in clients serves chain ${String(chainId)}, which the routing table routes to ${listed.join(", ")}.`,
        {
          hint: `Add one of their clients to clients, such as ${FACTORY[backend]}().`,
          // Stryker disable next-line ArrayDeclaration: equivalent. The message holds only the chain id and backend names.
          secrets: [],
        },
      );
    },
    backendHint: (named) => `Add ${FACTORY[named]}() to clients, or leave out route.backend.`,
    table: () =>
      invalid(
        [{ field: "table", message: "is needed: the route reads the routing table" }],
        "Add table from explorer-verify/table, or set route.apiUrl.",
      ),
    handler: () =>
      invalid(
        [{ field: "handlerUrl", message: "needs the etherscanV2() client in clients" }],
        "Add etherscanV2() to clients, or leave out handlerUrl.",
      ),
  };
}

/**
 * The error of `checkStatus()` for a handle whose backend has no client in `clients`, before any
 * route resolves (decision 0052).
 *
 * @param backend - The backend the handle names.
 * @returns The error.
 * @example
 * ```ts
 * throw missingHandleClient("etherscan-v2");
 * ```
 */
export function missingHandleClient(backend: BackendName): ExplorerVerifyError {
  return invalid(
    [{ field: "clients", message: `has no ${backend} client, the backend the handle names` }],
    `Add ${FACTORY[backend]}() to clients.`,
  );
}

/**
 * The error of `linkProxy()` for a backend whose proxy-link client the caller left out, or
 * `undefined` for Routescan, which cannot link in this version. Only `linkProxy()` bundles it.
 */
function missingLinker(
  backend: BackendName,
  secrets: readonly string[],
): ExplorerVerifyError | undefined {
  const factory = LINK_FACTORY[backend];
  return factory === undefined
    ? undefined
    : newError(
        {
          code: "invalid-input",
          issues: [{ field: "clients", message: `has no ${backend} proxy-link client` }],
        },
        `No ${backend} proxy-link client was passed in clients.`,
        { hint: `Add ${factory}() to clients, or set route.backend to another backend.`, secrets },
      );
}

/**
 * The dependencies of `verify()`, `dryRun()`, `checkStatus()` and `verifyEach()` from the
 * caller's `clients` and `table`, and the other options, for the engine to check.
 *
 * @param options - The caller's options.
 * @param known - The keys the engine accepts besides `clients` and `table`, so an unknown key is
 *   named with the core's own issues.
 * @returns The other options and the dependencies.
 * @throws ExplorerVerifyError `invalid-input` for options that are not a plain object, for a
 *   `clients` or `table` that is not one this package exported, and for unknown keys with them.
 * @example
 * ```ts
 * const { rest, dependencies } = flowParts({ clients: [sourcify()] }, verifyOptionKeys());
 * ```
 */
export function flowParts(options: unknown, known: readonly string[]): Split<FlowDependencies> {
  const { rest, list, table, issues } = read(options, known);
  const backends: Partial<Record<BackendName, Backend>> = {};
  let derivation: DeriveLoader | undefined;
  let handler: HandlerLoader | undefined;
  list.forEach((entry, index) => {
    const parts = clientParts(entry);
    if (parts === undefined) {
      issues.push({ field: `clients[${String(index)}]`, message: notOurs(entry, false) });
      return;
    }
    backends[parts.backend.name] = parts.backend;
    derivation ??= parts.derivation;
    handler ??= parts.handler;
  });
  const rows = tableOf(table, issues);
  throwIssues(issues);
  return {
    rest,
    dependencies: { backends, table: rows, derivation, handler, missing: missingFor(rows) },
  };
}

/**
 * The dependencies of `linkProxy()` from the caller's `clients` and `table`, as
 * {@link flowParts} reads them.
 *
 * @param options - The caller's options.
 * @param known - The keys the engine accepts besides `clients` and `table`.
 * @returns The other options and the dependencies.
 * @throws As {@link flowParts} throws.
 * @example
 * ```ts
 * const { rest, dependencies } = linkOptions({ clients: [sourcifyProxyLink()] }, keys);
 * ```
 */
export function linkOptions(options: unknown, known: readonly string[]): Split<LinkDependencies> {
  const { rest, list, table, issues } = read(options, known);
  const linkers: Partial<Record<BackendName, ProxyLinker | LinkerLoader>> = {};
  let handler: HandlerLoader | undefined;
  list.forEach((entry, index) => {
    const parts = linkParts(entry);
    if (parts === undefined) {
      issues.push({ field: `clients[${String(index)}]`, message: notOurs(entry, true) });
      return;
    }
    for (const backend of parts.backends) {
      linkers[backend] = parts.linker;
    }
    handler ??= parts.handler;
  });
  const rows = tableOf(table, issues);
  throwIssues(issues);
  const missing: LinkMissing = { ...missingFor(rows), linker: missingLinker };
  return { rest, dependencies: { linkers, table: rows, handler, missing } };
}

/** The issue text for an entry of `clients` that this package did not export. */
function notOurs(entry: unknown, link: boolean): string {
  // A client of the other kind is the likely mistake: say so.
  if (link ? clientParts(entry) !== undefined : linkParts(entry) !== undefined) {
    return link
      ? "is not a proxy-link client: pass one such as sourcifyProxyLink()"
      : "is a proxy-link client: pass it to linkProxy()";
  }
  // A frozen object of a client's shape comes from another copy of the package, whose clients
  // this copy does not know.
  const kind: unknown =
    typeof entry === "object" && entry !== null && Object.isFrozen(entry)
      ? Reflect.get(entry, "kind")
      : undefined;
  return kind === "client" || kind === "proxy-link"
    ? "is a client from another copy of explorer-verify: install explorer-verify once, as a peerDependency of your wrapper"
    : `must be a ${link ? "proxy-link " : ""}client from explorer-verify/clients`;
}

/** The shipped rows of `table`, or `undefined` when it is absent; an issue for anything else. */
function tableOf(table: unknown, issues: InputIssue[]): RoutingTable | undefined {
  if (table === undefined) {
    return undefined;
  }
  const rows = tableRows(table);
  if (rows === undefined) {
    issues.push({ field: "table", message: "must be routingTable from explorer-verify/table" });
  }
  return rows;
}

/**
 * The caller's `clients` and `table`, a copy of the options without them, and the issues found so
 * far: unknown keys and a `clients` that is not a non-empty array. The copy takes each property's
 * descriptor, so no getter runs here: the engine reads the keys before any value, as for the
 * default entry (decision 0047). Holes in `clients` are read as `undefined`.
 */
function read(
  options: unknown,
  known: readonly string[],
): { rest: object; list: readonly unknown[]; table: unknown; issues: InputIssue[] } {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw invalid([{ field: "options", message: "must be a plain object with clients" }]);
  }
  let rest: object;
  let clients: unknown;
  let table: unknown;
  const issues: InputIssue[] = [];
  try {
    issues.push(...unknownKeys(Object.keys(options), [...OWN_KEYS, ...known], "", "options"));
    const descriptors = Object.getOwnPropertyDescriptors(options);
    for (const key of OWN_KEYS) {
      // Stryker disable next-line ConditionalExpression: equivalent. Deleting a key that is not there changes nothing.
      if (Object.hasOwn(descriptors, key)) {
        Reflect.deleteProperty(descriptors, key);
      }
    }
    rest = Object.defineProperties({}, descriptors);
    clients = Object.hasOwn(options, "clients") ? Reflect.get(options, "clients") : undefined;
    table = Object.hasOwn(options, "table") ? Reflect.get(options, "table") : undefined;
  } catch {
    // A getter or Proxy trap threw. Its error is dropped: it may repeat a caller value.
    throw invalid([{ field: "options", message: "could not be read" }]);
  }
  const list: unknown[] = [];
  if (Array.isArray(clients) && clients.length > 0) {
    // By index, so a hole is an entry, which no client is.
    for (let index = 0; index < clients.length; index += 1) {
      const entry: unknown = clients[index];
      list.push(entry);
    }
  } else {
    issues.push({
      field: "clients",
      message:
        clients === undefined
          ? "is required: an array of clients, such as [sourcify()]"
          : "must be a non-empty array of clients, such as [sourcify()]",
    });
  }
  return { rest, list, table, issues };
}

function throwIssues(issues: InputIssue[]): void {
  if (issues.length > 0) {
    throw invalid(issues);
  }
}

function invalid(issues: InputIssue[], hint: string = HINT): ExplorerVerifyError {
  return newError(
    { code: "invalid-input", issues },
    `The options are invalid: ${issues.map((issue) => issue.field).join(", ")}.`,
    // Stryker disable next-line ArrayDeclaration: equivalent. The message and the issues name only fields.
    { hint, secrets: [] },
  );
}
