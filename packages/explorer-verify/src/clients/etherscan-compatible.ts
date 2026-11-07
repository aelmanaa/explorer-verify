// References: decision 0052.
/**
 * `explorer-verify/clients/etherscan-compatible`: the clients of a standalone
 * Etherscan-compatible explorer for `explorer-verify/core`.
 */
import { etherscanCompatible as compatibleBackend } from "../backends/etherscan-compatible.ts";
import { compatibleProxyLinker } from "../backends/proxy-etherscan.ts";
import { defineClient, defineProxyLink } from "../core/parts.ts";
import type { ExplorerClient, ProxyLinkClient } from "../core/parts.ts";
import { derivation } from "./derivation.ts";

/**
 * The client of a standalone Etherscan-compatible explorer, for `verify()`, `dryRun()`,
 * `checkStatus()` and `verifyEach()` from `explorer-verify/core`. It brings the constructor
 * argument derivation.
 *
 * @example
 * ```ts
 * import { verify } from "explorer-verify/core";
 * import { etherscanCompatible } from "explorer-verify/clients/etherscan-compatible";
 *
 * await verify(input, {
 *   clients: [etherscanCompatible()],
 *   route: { backend: "etherscan-compatible", apiUrl: "https://explorer.example/api" },
 * });
 * ```
 * @returns A new client; each call gives a new object.
 * @experimental
 */
export function etherscanCompatible(): ExplorerClient {
  return defineClient({
    backend: compatibleBackend,
    derivation,
  });
}

/**
 * The proxy-link client of a standalone Etherscan-compatible explorer, for `linkProxy()` from
 * `explorer-verify/core`. It links only on a route with `route.apiUrl`.
 *
 * @example
 * ```ts
 * import { linkProxy } from "explorer-verify/core";
 * import { etherscanCompatibleProxyLink } from "explorer-verify/clients/etherscan-compatible";
 *
 * await linkProxy(target, {
 *   clients: [etherscanCompatibleProxyLink()],
 *   route: { backend: "etherscan-compatible", apiUrl: "https://explorer.example/api" },
 * });
 * ```
 * @returns A new client; each call gives a new object.
 * @experimental
 */
export function etherscanCompatibleProxyLink(): ProxyLinkClient {
  return defineProxyLink({
    backends: ["etherscan-compatible"],
    linker: compatibleProxyLinker,
  });
}
