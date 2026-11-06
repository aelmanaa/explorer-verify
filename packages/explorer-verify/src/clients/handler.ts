/**
 * The `handlerUrl` code that the Etherscan v2 clients of `explorer-verify/clients/etherscan-v2`
 * bring, imported statically (decision 0052): `handlerUrl` sends only Etherscan v2 requests
 * through the caller's server handler (decision 0046).
 */
import type { HandlerLoader } from "../flow/verify.ts";
import { resolveHandler } from "../http/handler-url.ts";

/**
 * Gives the `handlerUrl` code. One object, so the engine keeps what it gave, as it does for the
 * default entry's loader.
 *
 * @returns The `handlerUrl` code.
 * @example
 * ```ts
 * export const etherscanV2 = defineClient({ backend: etherscan, derivation, handler });
 * ```
 */
export const handler: HandlerLoader = async () => await Promise.resolve({ resolveHandler });
