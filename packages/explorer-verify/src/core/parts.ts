/**
 * The objects `explorer-verify/clients/*` and `explorer-verify/table` export, and what each one
 * holds (decision 0052). A caller of `explorer-verify/core` sees only a backend name and a kind:
 * the code behind each object stays internal, kept here by object, so the client interface can
 * change without a breaking release and a plain object cannot pose as a client.
 *
 * Each client holds what its calls need beyond the engine: a client that takes constructor
 * arguments brings the derivation, and the Etherscan v2 clients bring the `handlerUrl` code. A
 * caller who passes only the Sourcify client bundles neither.
 */
import type { BackendName } from "../backend-names.ts";
import type { Backend, ProxyLinker } from "../backends/backend.ts";
import type { LinkerLoader } from "../flow/link-proxy.ts";
import type { DeriveLoader, HandlerLoader } from "../flow/verify.ts";
import type { RoutingTable } from "../routing/resolve.ts";

/**
 * A backend client for `verify()`, `dryRun()`, `checkStatus()` and `verifyEach()` from
 * `explorer-verify/core`. Import one from `explorer-verify/clients/<name>`; only those objects
 * work, and an object built by hand throws `invalid-input`.
 *
 * @example
 * ```ts
 * import { verify } from "explorer-verify/core";
 * import { sourcify } from "explorer-verify/clients/sourcify";
 *
 * sourcify().backend; // "sourcify"
 * await verify(input, { clients: [sourcify()], route: { backend: "sourcify" } });
 * ```
 * @experimental
 */
export interface ExplorerClient {
  /** Tells a backend client from a proxy-link client. */
  readonly kind: "client";
  /** The backend the client sends requests to. */
  readonly backend: BackendName;
}

/**
 * A proxy-link client for `linkProxy()` from `explorer-verify/core`. Import one from
 * `explorer-verify/clients/<name>`; only those objects work.
 *
 * @example
 * ```ts
 * import { linkProxy } from "explorer-verify/core";
 * import { sourcifyProxyLink } from "explorer-verify/clients/sourcify";
 *
 * sourcifyProxyLink().backends; // ["sourcify"]
 * await linkProxy(target, { clients: [sourcifyProxyLink()], route: { backend: "sourcify" } });
 * ```
 * @experimental
 */
export interface ProxyLinkClient {
  /** Tells a proxy-link client from a backend client. */
  readonly kind: "proxy-link";
  /** The backends the client links a proxy on. */
  readonly backends: readonly BackendName[];
}

/**
 * The routing table shipped with this version, as `explorer-verify/table` exports it, for the
 * `table` option of `explorer-verify/core`. Only that object works.
 *
 * @example
 * ```ts
 * import { routingTable } from "explorer-verify/table";
 *
 * routingTable.date; // "YYYY-MM-DD"
 * ```
 * @experimental
 */
export interface ShippedRoutingTable {
  /** Tells the table from a client. */
  readonly kind: "routing-table";
  /** When the rows were last checked against their sources, as `YYYY-MM-DD` (R-RT-1). */
  readonly date: string;
}

/** What an {@link ExplorerClient} holds. */
export interface ClientParts {
  /** The client. */
  readonly backend: Backend;
  /** Loads the constructor argument derivation, for a client that takes constructor arguments. */
  readonly derivation?: DeriveLoader;
  /** Loads the `handlerUrl` code, for the Etherscan v2 client. */
  readonly handler?: HandlerLoader;
}

/** What a {@link ProxyLinkClient} holds. */
export interface LinkParts {
  /** The backends the linker serves. */
  readonly backends: readonly BackendName[];
  /** The proxy-link code. */
  readonly linker: ProxyLinker | LinkerLoader;
  /** Loads the `handlerUrl` code, for the Etherscan v2 proxy-link client. */
  readonly handler?: HandlerLoader;
}

/** What each exported object holds, by object. */
const CLIENTS = new WeakMap<object, ClientParts>();
const LINKS = new WeakMap<object, LinkParts>();
const TABLES = new WeakMap<object, RoutingTable>();

/**
 * A backend client for `explorer-verify/clients/*`, with what it holds kept apart.
 *
 * @param parts - The client and the code it brings.
 * @returns The frozen client.
 * @example
 * ```ts
 * export const sourcify: ExplorerClient = defineClient({ backend: sourcifyBackend });
 * ```
 */
export function defineClient(parts: ClientParts): ExplorerClient {
  const client: ExplorerClient = Object.freeze({ kind: "client", backend: parts.backend.name });
  CLIENTS.set(client, parts);
  return client;
}

/**
 * A proxy-link client for `explorer-verify/clients/*`, with what it holds kept apart.
 *
 * @param parts - The backends, the proxy-link code and the code it brings.
 * @returns The frozen client.
 * @example
 * ```ts
 * export const sourcifyProxyLink = defineProxyLink({ backends: ["sourcify"], linker });
 * ```
 */
export function defineProxyLink(parts: LinkParts): ProxyLinkClient {
  const client: ProxyLinkClient = Object.freeze({
    kind: "proxy-link",
    backends: Object.freeze([...parts.backends]),
  });
  LINKS.set(client, parts);
  return client;
}

/**
 * The routing table for `explorer-verify/table`, with its rows kept apart.
 *
 * @param table - The rows.
 * @returns The frozen table.
 * @example
 * ```ts
 * export const routingTable = defineTable(ROUTING_TABLE);
 * ```
 */
export function defineTable(table: RoutingTable): ShippedRoutingTable {
  const shipped: ShippedRoutingTable = Object.freeze({
    kind: "routing-table",
    date: table.checked,
  });
  TABLES.set(shipped, table);
  return shipped;
}

/**
 * What a backend client holds, or `undefined` for any other value.
 *
 * @param value - Any value, such as an entry of `clients`.
 * @returns What it holds.
 * @example
 * ```ts
 * clientParts(sourcify)?.backend.name; // "sourcify"
 * ```
 */
export function clientParts(value: unknown): ClientParts | undefined {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent. WeakMap.get gives undefined for a value it does not hold; the check only narrows the type.
  return typeof value === "object" && value !== null ? CLIENTS.get(value) : undefined;
}

/**
 * What a proxy-link client holds, or `undefined` for any other value.
 *
 * @param value - Any value, such as an entry of `clients`.
 * @returns What it holds.
 * @example
 * ```ts
 * linkParts(sourcifyProxyLink)?.backends; // ["sourcify"]
 * ```
 */
export function linkParts(value: unknown): LinkParts | undefined {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent. WeakMap.get gives undefined for a value it does not hold; the check only narrows the type.
  return typeof value === "object" && value !== null ? LINKS.get(value) : undefined;
}

/**
 * The rows of the shipped table, or `undefined` for any other value.
 *
 * @param value - Any value, such as the `table` option.
 * @returns The rows.
 * @example
 * ```ts
 * tableRows(routingTable)?.chains.length; // 325
 * ```
 */
export function tableRows(value: unknown): RoutingTable | undefined {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent. WeakMap.get gives undefined for a value it does not hold; the check only narrows the type.
  return typeof value === "object" && value !== null ? TABLES.get(value) : undefined;
}
