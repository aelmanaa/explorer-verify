/**
 * The routing table shipped with this version (R-RT-1). The default entry loads this module with a
 * dynamic `import()`, through `loadRoutingTable`, so a bundler that splits code puts the rows in a
 * chunk of their own, and a call that passes `route.apiUrl` does not load them (decision 0040).
 * Only `explorer-verify/table` imports it statically, for callers of `explorer-verify/core`
 * (decision 0052); no module the default entry reaches does.
 */
import type { RoutingTable } from "./resolve.ts";
import table from "./table.json" with { type: "json" };

/**
 * The routing table shipped with this version. The unit tests check every row (R-RT-1, R-SEC-2).
 *
 * @example
 * ```ts
 * ROUTING_TABLE.chains.find((row) => row.chainId === 11155111)?.backends[1]?.backend; // "sourcify"
 * ```
 */
export const ROUTING_TABLE: RoutingTable = table;
