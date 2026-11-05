// `resolveRoute` with the shipped routing table as its default `choice.table`. The core's
// `resolveRoute` reads no table it is not given: the flow engine loads the table first, and only
// for a route without `route.apiUrl` (decision 0040). The unit tests resolve routes against the
// shipped table, so they import it from here.
import { resolveRoute as resolveWith } from "../../src/routing/resolve.ts";
import type { Route, RouteChoice } from "../../src/routing/resolve.ts";
import { ROUTING_TABLE } from "../../src/routing/table.ts";
import type { RouteOverride } from "../../src/types.ts";

/**
 * Resolves a route as the core's `resolveRoute` does, with the shipped table unless `choice`
 * names another.
 *
 * @param chainId - The chain id.
 * @param override - The route override.
 * @param choice - The keys, the fallback option, the backends with a client, the table.
 * @returns The route.
 */
export function resolveRoute(
  chainId: number,
  override?: RouteOverride,
  choice: RouteChoice = {},
): Route {
  return resolveWith(chainId, override, { table: ROUTING_TABLE, ...choice });
}
