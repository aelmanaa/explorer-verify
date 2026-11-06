import { tryParseHandle } from "../flow/check-handle.ts";
/**
 * `explorer-verify/core`: the five flow functions of the default entry, which take the explorer
 * clients and the routing table from the caller instead of loading them (decision 0052). No module
 * this entry imports holds a dynamic `import()`, so a bundler that does not split code, or a
 * wrapper SDK that bundles this package, ships only the clients the caller imports, and the rows
 * only when the caller imports `explorer-verify/table`.
 *
 * Each function runs the same engine as the default entry and gives the same result for the same
 * explorer answers. It reads `clients` and `table`, and every other option as the default entry
 * does.
 */
import { runDryRun } from "../flow/dry-run.ts";
import { runLinkProxy } from "../flow/link-proxy.ts";
import { runCheckStatus } from "../flow/status.ts";
import { eachOptionKeys, runVerifyEach } from "../flow/verify-each.ts";
import { runVerify, verifyOptionKeys } from "../flow/verify.ts";
import type {
  CheckStatusOptions,
  DryRunOptions,
  DryRunResult,
  Handle,
  LinkProxyOptions,
  LinkProxyResult,
  LinkProxyTarget,
  VerifyEachOptions,
  VerifyEachResult,
  VerifyInput,
  VerifyOptions,
  VerifyResult,
} from "../types.ts";
import { flowParts, linkOptions, missingHandleClient } from "./options.ts";
import type { ClientOptions } from "./options.ts";
import type { ExplorerClient, ProxyLinkClient } from "./parts.ts";

export type { ClientList, ClientOptions } from "./options.ts";
export type { ExplorerClient, ProxyLinkClient, ShippedRoutingTable } from "./parts.ts";

/**
 * The options of {@link verify} from `explorer-verify/core`: those of the default entry's
 * `verify()`, plus `clients` and `table`.
 *
 * @experimental
 */
export type CoreVerifyOptions = VerifyOptions & ClientOptions<ExplorerClient>;

/**
 * The options of {@link dryRun} from `explorer-verify/core`.
 *
 * @experimental
 */
export type CoreDryRunOptions = DryRunOptions & ClientOptions<ExplorerClient>;

/**
 * The options of {@link checkStatus} from `explorer-verify/core`.
 *
 * @experimental
 */
export type CoreCheckStatusOptions = CheckStatusOptions & ClientOptions<ExplorerClient>;

/**
 * The options of {@link verifyEach} from `explorer-verify/core`. `backends: "all"` takes every
 * backend the chain's row lists that has a client in `clients`.
 *
 * @experimental
 */
export type CoreVerifyEachOptions = VerifyEachOptions & ClientOptions<ExplorerClient>;

/**
 * The options of {@link linkProxy} from `explorer-verify/core`: its `clients` are proxy-link
 * clients.
 *
 * @experimental
 */
export type CoreLinkProxyOptions = LinkProxyOptions & ClientOptions<ProxyLinkClient>;

/**
 * Verifies a deployed contract's source, as the default entry's `verify()` does, with the clients
 * and the routing table the caller passes (decision 0052). The steps, the result and the errors
 * are the same.
 *
 * - The routing table chooses among the backends of `clients`. A `route.backend` without a client
 *   in `clients` throws `invalid-input`; a chain whose listed backends all lack one throws
 *   `unsupported-chain`. Both happen before any request.
 * - Without `table`, a call without `route.apiUrl` throws `invalid-input` naming `table`, before
 *   any request. Requests go only to hosts from the passed table or the caller's route (R-SEC-2).
 * - `handlerUrl` needs the Etherscan v2 client in `clients`: it brings the handler code.
 *
 * @param input - What to verify. It is checked with `validateInput` first.
 * @param options - The default entry's options, plus `clients`, at least one, and `table`.
 * @returns As the default entry's `verify()` returns.
 * @throws The caller's `signal.reason`, unchanged, when the signal aborts (R-FLOW-6).
 * @throws ExplorerVerifyError `invalid-input` for a `clients` or `table` that this package did not
 *   export, and as the default entry's `verify()` throws.
 * @example
 * ```ts
 * import { verify } from "explorer-verify/core";
 * import { sourcify } from "explorer-verify/clients/sourcify";
 * import { routingTable } from "explorer-verify/table";
 *
 * // The routing table picks Sourcify among the clients passed.
 * const result = await verify(input, { clients: [sourcify()], table: routingTable });
 *
 * // No table: name the backend and its API, and the rows are not bundled.
 * await verify(input, {
 *   clients: [sourcify()],
 *   route: { backend: "sourcify", apiUrl: "https://sourcify.dev/server" },
 * });
 * ```
 * @experimental
 */
export async function verify(
  input: VerifyInput,
  options: CoreVerifyOptions,
): Promise<VerifyResult> {
  const { rest, dependencies } = flowParts(options, verifyOptionKeys());
  return await runVerify(input, rest, dependencies);
}

/**
 * Checks input, options and route without submitting, as the default entry's `dryRun()` does,
 * with the clients and the routing table the caller passes. {@link verify} says how they are read.
 *
 * @param input - What a `verify()` call would verify.
 * @param options - The default entry's options, plus `clients` and `table`.
 * @returns As the default entry's `dryRun()` returns.
 * @throws As {@link verify} throws before any submission.
 * @example
 * ```ts
 * import { dryRun } from "explorer-verify/core";
 * import { etherscanV2 } from "explorer-verify/clients/etherscan-v2";
 * import { sourcify } from "explorer-verify/clients/sourcify";
 * import { routingTable } from "explorer-verify/table";
 *
 * const plan = await dryRun(input, { clients: [etherscanV2(), sourcify()], table: routingTable });
 * console.log(plan.backend, plan.lookup);
 * ```
 * @experimental
 */
export async function dryRun(
  input: VerifyInput,
  options: CoreDryRunOptions,
): Promise<DryRunResult> {
  const { rest, dependencies } = flowParts(options, verifyOptionKeys());
  return await runDryRun(input, rest, dependencies);
}

/**
 * Resumes a submitted verification from its handle, as the default entry's `checkStatus()` does,
 * with the clients and the routing table the caller passes. Pass the client of the handle's
 * backend, and the options `verify()` had, so the route resolves to the same backend.
 *
 * @param handle - The handle, as an object or in its one-line form.
 * @param options - The default entry's options, plus `clients` and `table`.
 * @returns As the default entry's `checkStatus()` returns.
 * @throws As the default entry's `checkStatus()` throws, and as {@link verify} throws for
 *   `clients` and `table`.
 * @example
 * ```ts
 * import { checkStatus } from "explorer-verify/core";
 * import { sourcify } from "explorer-verify/clients/sourcify";
 * import { routingTable } from "explorer-verify/table";
 *
 * const result = await checkStatus(savedHandle, { clients: [sourcify()], table: routingTable });
 * ```
 * @experimental
 */
export async function checkStatus(
  handle: Handle | string,
  options: CoreCheckStatusOptions,
): Promise<VerifyResult> {
  const { rest, dependencies } = flowParts(options, verifyOptionKeys());
  // A handle whose backend has no client in clients is named before any route resolves.
  const named = tryParseHandle(handle)?.backend;
  if (named !== undefined && dependencies.backends[named] === undefined) {
    throw missingHandleClient(named);
  }
  // Without a table and a route, a backend with one public host for every chain is the route,
  // as route.backend would make it.
  if (
    dependencies.table === undefined &&
    !Object.hasOwn(rest, "route") &&
    (named === "sourcify" || named === "etherscan-v2" || named === "blockscout-hosted")
  ) {
    Object.defineProperty(rest, "route", { value: { backend: named }, enumerable: true });
  }
  return await runCheckStatus(handle, rest, dependencies);
}

/**
 * Verifies on several backends at once, as the default entry's `verifyEach()` does, with the
 * clients and the routing table the caller passes. `backends: "all"` takes every backend the
 * chain's row lists that has a client in `clients`, and reads the table.
 *
 * @param input - What to verify.
 * @param options - The default entry's options, plus `clients` and `table`.
 * @returns As the default entry's `verifyEach()` returns.
 * @throws As the default entry's `verifyEach()` throws, and as {@link verify} throws for
 *   `clients` and `table`.
 * @example
 * ```ts
 * import { verifyEach } from "explorer-verify/core";
 * import { blockscout } from "explorer-verify/clients/blockscout";
 * import { sourcify } from "explorer-verify/clients/sourcify";
 * import { routingTable } from "explorer-verify/table";
 *
 * const { outcomes } = await verifyEach(input, {
 *   backends: ["sourcify", "blockscout"],
 *   clients: [sourcify(), blockscout()],
 *   table: routingTable,
 * });
 * ```
 * @experimental
 */
export async function verifyEach(
  input: VerifyInput,
  options: CoreVerifyEachOptions,
): Promise<VerifyEachResult> {
  const { rest, dependencies } = flowParts(options, eachOptionKeys());
  return await runVerifyEach(input, rest, dependencies);
}

/**
 * Links a verified proxy to its implementation, as the default entry's `linkProxy()` does, with
 * the proxy-link clients and the routing table the caller passes. A route to a backend whose
 * proxy-link client is not in `clients` throws `invalid-input` naming `clients`, before any
 * request.
 *
 * @param target - The proxy's chain id and address, and the implementation it should point at.
 * @param options - The default entry's options, plus proxy-link `clients` and `table`.
 * @returns As the default entry's `linkProxy()` returns.
 * @throws As the default entry's `linkProxy()` throws, and as {@link verify} throws for
 *   `clients` and `table`.
 * @example
 * ```ts
 * import { linkProxy } from "explorer-verify/core";
 * import { etherscanV2ProxyLink } from "explorer-verify/clients/etherscan-v2";
 *
 * const result = await linkProxy(
 *   { chainId: 1, address: proxy, expectedImplementation: implementation },
 *   {
 *     clients: [etherscanV2ProxyLink()],
 *     route: { backend: "etherscan-v2", apiUrl: "https://api.etherscan.io/v2/api" },
 *     apiKeys: { "etherscan-v2": apiKey },
 *   },
 * );
 * ```
 * @experimental
 */
export async function linkProxy(
  target: LinkProxyTarget,
  options: CoreLinkProxyOptions,
): Promise<LinkProxyResult> {
  const { rest, dependencies } = linkOptions(options, verifyOptionKeys());
  return await runLinkProxy(target, rest, dependencies);
}
