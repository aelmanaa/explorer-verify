// References: R-RT-1, decision 0040, decision 0052.
/**
 * The routing table shipped with this version. The default entry loads this module with a
 * dynamic `import()`, through `loadRoutingTable`, so a bundler that splits code puts the rows in a
 * chunk of their own, and a call that passes `route.apiUrl` does not load them.
 * Only `explorer-verify/table` imports it statically, for callers of `explorer-verify/core`; no
 * module the default entry reaches does.
 */
import type { RoutingTable } from "./resolve.ts";
import table from "./table.json" with { type: "json" };

// References: R-RT-1, R-SEC-2.
/**
 * The routing table shipped with this version. The unit tests check every row.
 *
 * @example
 * ```ts
 * ROUTING_TABLE.chains.find((row) => row.chainId === 11155111)?.backends[1]?.backend; // "sourcify"
 * ```
 */
export const ROUTING_TABLE: RoutingTable = table;
