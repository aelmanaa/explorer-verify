/**
 * `explorer-verify/table`: the routing table shipped with this version, for the `table` option of
 * `explorer-verify/core` (decision 0052). It imports the rows statically: a caller who imports it
 * bundles them, and one who does not, never does.
 */
import { ROUTING_TABLE } from "../routing/table.ts";
import { defineTable } from "./parts.ts";
import type { ShippedRoutingTable } from "./parts.ts";

/**
 * The routing table shipped with this version (R-RT-1). Pass it as `table` to the functions of
 * `explorer-verify/core` when a call leaves out `route.apiUrl`, so the table chooses the backend
 * and its API. `date` is when its rows were last checked, as `routingTableDate()` gives it.
 *
 * @example
 * ```ts
 * import { verify } from "explorer-verify/core";
 * import { sourcify } from "explorer-verify/clients/sourcify";
 * import { routingTable } from "explorer-verify/table";
 *
 * routingTable.date; // "YYYY-MM-DD"
 * await verify(input, { clients: [sourcify()], table: routingTable });
 * ```
 * @experimental
 */
export const routingTable: ShippedRoutingTable = /* @__PURE__ */ defineTable(ROUTING_TABLE);
