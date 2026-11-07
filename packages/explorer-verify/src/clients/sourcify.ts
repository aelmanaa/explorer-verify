// References: decision 0052.
/**
 * `explorer-verify/clients/sourcify`: the Sourcify clients for `explorer-verify/core`.
 */
import { sourcifyProxyLinker } from "../backends/proxy-sourcify.ts";
import { sourcify as sourcifyBackend } from "../backends/sourcify.ts";
import { defineClient, defineProxyLink } from "../core/parts.ts";
import type { ExplorerClient, ProxyLinkClient } from "../core/parts.ts";

/**
 * The Sourcify client, for `verify()`, `dryRun()`, `checkStatus()` and `verifyEach()` from
 * `explorer-verify/core`. Sourcify takes no API key and derives no constructor arguments, so this
 * client brings no other code.
 *
 * @example
 * ```ts
 * import { verify } from "explorer-verify/core";
 * import { sourcify } from "explorer-verify/clients/sourcify";
 *
 * await verify(input, {
 *   clients: [sourcify()],
 *   route: { backend: "sourcify", apiUrl: "https://sourcify.dev/server" },
 * });
 * ```
 * @returns A new client; each call gives a new object.
 * @experimental
 */
export function sourcify(): ExplorerClient {
  return defineClient({ backend: sourcifyBackend });
}

/**
 * The Sourcify proxy-link client, for `linkProxy()` from `explorer-verify/core`. It changes
 * nothing on Sourcify: it reads the implementation Sourcify recorded.
 *
 * @example
 * ```ts
 * import { linkProxy } from "explorer-verify/core";
 * import { sourcifyProxyLink } from "explorer-verify/clients/sourcify";
 *
 * await linkProxy(target, {
 *   clients: [sourcifyProxyLink()],
 *   route: { backend: "sourcify", apiUrl: "https://sourcify.dev/server" },
 * });
 * ```
 * @returns A new client; each call gives a new object.
 * @experimental
 */
export function sourcifyProxyLink(): ProxyLinkClient {
  return defineProxyLink({
    backends: ["sourcify"],
    linker: sourcifyProxyLinker,
  });
}
