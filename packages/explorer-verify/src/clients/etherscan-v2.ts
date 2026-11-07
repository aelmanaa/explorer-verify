// References: decision 0052.
/**
 * `explorer-verify/clients/etherscan-v2`: the Etherscan v2 clients for `explorer-verify/core`.
 */
import { etherscan } from "../backends/etherscan.ts";
import { etherscanProxyLinker } from "../backends/proxy-etherscan.ts";
import { defineClient, defineProxyLink } from "../core/parts.ts";
import type { ExplorerClient, ProxyLinkClient } from "../core/parts.ts";
import { derivation } from "./derivation.ts";
import { handler } from "./handler.ts";

/**
 * The Etherscan v2 client, for `verify()`, `dryRun()`, `checkStatus()` and `verifyEach()` from
 * `explorer-verify/core`. It brings the constructor argument derivation and the `handlerUrl`
 * code. Etherscan needs `apiKeys["etherscan-v2"]` on a backend, or `handlerUrl` in a browser.
 *
 * @example
 * ```ts
 * import { verify } from "explorer-verify/core";
 * import { etherscanV2 } from "explorer-verify/clients/etherscan-v2";
 * import { routingTable } from "explorer-verify/table";
 *
 * await verify(input, {
 *   clients: [etherscanV2()],
 *   table: routingTable,
 *   apiKeys: { "etherscan-v2": apiKey },
 * });
 * ```
 * @returns A new client; each call gives a new object.
 * @experimental
 */
export function etherscanV2(): ExplorerClient {
  return defineClient({
    backend: etherscan,
    derivation,
    handler,
  });
}

/**
 * The Etherscan v2 proxy-link client, for `linkProxy()` from `explorer-verify/core`. It brings
 * the `handlerUrl` code.
 *
 * @example
 * ```ts
 * import { linkProxy } from "explorer-verify/core";
 * import { etherscanV2ProxyLink } from "explorer-verify/clients/etherscan-v2";
 * import { routingTable } from "explorer-verify/table";
 *
 * await linkProxy(target, {
 *   clients: [etherscanV2ProxyLink()],
 *   table: routingTable,
 *   apiKeys: { "etherscan-v2": apiKey },
 * });
 * ```
 * @returns A new client; each call gives a new object.
 * @experimental
 */
export function etherscanV2ProxyLink(): ProxyLinkClient {
  return defineProxyLink({
    backends: ["etherscan-v2"],
    linker: etherscanProxyLinker,
    handler,
  });
}
