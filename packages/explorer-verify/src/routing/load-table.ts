// References: decision 0040, decision 0052.
/**
 * The default entry's access to the routing table shipped with this version: `loadRoutingTable`,
 * which loads `routing/table.ts` with a dynamic `import()`, and the two public
 * functions that read it. `explorer-verify/core` never imports this module: its caller passes the
 * table from `explorer-verify/table`.
 */
import { routesWith } from "./resolve.ts";
import type { ChainRoutes, RoutesForOptions, TableLoader } from "./resolve.ts";

// References: decision 0040.
/**
 * Loads the routing table shipped with this version, `routing/table.ts`, with a dynamic
 * `import()`. A bundler that splits code puts the rows in a chunk of their own, which a page
 * downloads only when a call reads the table.
 *
 * @returns The table.
 * @example
 * ```ts
 * const table = await loadRoutingTable();
 * table.chains.length; // 325
 * ```
 */
export const loadRoutingTable: TableLoader = async () => (await import("./table.ts")).ROUTING_TABLE;

// References: R-RT-1, R-AX-11, decision 0040.
/**
 * The date of the routing table shipped with this version: when its rows were last checked
 * against their sources, as `YYYY-MM-DD`. The CLI prints it with `--version --json`. It loads the
 * table, which sits in a chunk of its own, so it returns
 * a promise.
 *
 * @returns The date.
 *
 * @example
 * ```ts
 * import { routingTableDate } from "explorer-verify";
 *
 * await routingTableDate(); // "YYYY-MM-DD"
 * ```
 */
export async function routingTableDate(): Promise<string> {
  return (await loadRoutingTable()).checked;
}

// References: R-RT-1, R-RT-3, R-IN-6.
/**
 * Tells where a call for `chainId` would go without `route`, and which backends `route.backend`
 * can name, from the routing table shipped with this version. It sends no
 * request and reads no key: only whether `apiKeys` has a key for a backend counts. Use it to show
 * a person the choice before a submit.
 *
 * @param chainId - The EVM chain id, a positive safe integer.
 * @param options - The keys the call would have, and whether a chain without a row falls back to
 *   Sourcify. A field set to `undefined` counts as absent; any other key throws `invalid-input`
 *   naming it.
 * @returns The row's backends and the pick.
 * @throws ExplorerVerifyError `invalid-input` for a chain id that is not a positive safe integer,
 *   or for options that are not a plain object or hold another key.
 * @example
 * ```ts
 * import { routesFor } from "explorer-verify";
 *
 * const { listed, pick } = await routesFor(11155111);
 * listed; // ["etherscan-v2", "sourcify", "blockscout", "routescan"]
 * if (!(pick instanceof Error)) {
 *   pick.backend; // "sourcify": etherscan-v2 is skipped without a key
 * }
 * ```
 * @experimental
 */
export async function routesFor(
  chainId: number,
  options: RoutesForOptions = {},
): Promise<ChainRoutes> {
  return await routesWith(chainId, options, loadRoutingTable);
}
