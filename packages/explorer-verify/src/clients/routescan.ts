/**
 * `explorer-verify/clients/routescan`: the Routescan client for `explorer-verify/core`
 * (decision 0052). Routescan has no proxy-link client: what its `verifyproxycontract` does is not
 * known.
 */
import { routescan as routescanBackend } from "../backends/routescan.ts";
import { defineClient } from "../core/parts.ts";
import type { ExplorerClient } from "../core/parts.ts";
import { derivation } from "./derivation.ts";

/**
 * The Routescan client, for `verify()`, `dryRun()`, `checkStatus()` and `verifyEach()` from
 * `explorer-verify/core`. It brings the constructor argument derivation.
 *
 * @example
 * ```ts
 * import { verify } from "explorer-verify/core";
 * import { routescan } from "explorer-verify/clients/routescan";
 * import { routingTable } from "explorer-verify/table";
 *
 * await verify(input, {
 *   clients: [routescan()],
 *   table: routingTable,
 *   route: { backend: "routescan" },
 * });
 * ```
 * @returns A new client; each call gives a new object.
 * @experimental
 */
export function routescan(): ExplorerClient {
  return defineClient({
    backend: routescanBackend,
    derivation,
  });
}
