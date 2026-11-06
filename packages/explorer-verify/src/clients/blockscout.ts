/**
 * `explorer-verify/clients/blockscout`: the Blockscout clients for `explorer-verify/core`
 * (decision 0052): one for a Blockscout instance's own API, one for Blockscout's hosted API
 * (decision 0041), and one proxy-link client for both.
 */
import {
  blockscout as instanceBackend,
  blockscoutHosted as hostedBackend,
} from "../backends/blockscout.ts";
import { blockscoutProxyLinker } from "../backends/proxy-blockscout.ts";
import { defineClient, defineProxyLink } from "../core/parts.ts";
import type { ExplorerClient, ProxyLinkClient } from "../core/parts.ts";
import { derivation } from "./derivation.ts";

/**
 * The client of a Blockscout instance's own API (`blockscout`), for `verify()`, `dryRun()`,
 * `checkStatus()` and `verifyEach()` from `explorer-verify/core`. It brings the constructor
 * argument derivation.
 *
 * @example
 * ```ts
 * import { verify } from "explorer-verify/core";
 * import { blockscout } from "explorer-verify/clients/blockscout";
 *
 * await verify(input, {
 *   clients: [blockscout()],
 *   route: { backend: "blockscout", apiUrl: "https://eth-sepolia.blockscout.com/api" },
 * });
 * ```
 * @returns A new client; each call gives a new object.
 * @experimental
 */
export function blockscout(): ExplorerClient {
  return defineClient({
    backend: instanceBackend,
    derivation,
  });
}

/**
 * The client of Blockscout's hosted API (`blockscout-hosted`), which takes
 * `apiKeys["blockscout-hosted"]`. It brings the constructor argument derivation.
 *
 * @example
 * ```ts
 * import { verify } from "explorer-verify/core";
 * import { blockscoutHosted } from "explorer-verify/clients/blockscout";
 * import { routingTable } from "explorer-verify/table";
 *
 * await verify(input, {
 *   clients: [blockscoutHosted()],
 *   table: routingTable,
 *   route: { backend: "blockscout-hosted" },
 *   apiKeys: { "blockscout-hosted": apiKey },
 * });
 * ```
 * @returns A new client; each call gives a new object.
 * @experimental
 */
export function blockscoutHosted(): ExplorerClient {
  return defineClient({
    backend: hostedBackend,
    derivation,
  });
}

/**
 * The Blockscout proxy-link client, for `linkProxy()` from `explorer-verify/core`, on an
 * instance's own API and on the hosted API.
 *
 * @example
 * ```ts
 * import { linkProxy } from "explorer-verify/core";
 * import { blockscoutProxyLink } from "explorer-verify/clients/blockscout";
 *
 * await linkProxy(target, {
 *   clients: [blockscoutProxyLink()],
 *   route: { backend: "blockscout", apiUrl: "https://eth-sepolia.blockscout.com/api" },
 * });
 * ```
 * @returns A new client; each call gives a new object.
 * @experimental
 */
export function blockscoutProxyLink(): ProxyLinkClient {
  return defineProxyLink({
    backends: ["blockscout", "blockscout-hosted"],
    linker: blockscoutProxyLinker,
  });
}
