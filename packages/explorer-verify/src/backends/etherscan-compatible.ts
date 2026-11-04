/**
 * The client for standalone Etherscan-compatible explorers (R-BE-2): an explorer that serves
 * Etherscan's API on its own host, for one chain, outside Etherscan's multichain API. It is the
 * Etherscan client, built by `etherscanStyle`, with three differences. The evidence is in
 * docs/contributor/research/2026-11-04-etherscan-compatible-client.md.
 *
 * - The API base is the route's `apiUrl`. The routing table lists no standalone explorer yet, so
 *   the caller sets it with `route.apiUrl`, and a result has no `explorerUrl` (R-FLOW-3).
 * - No request sends a `chainid` parameter: each host serves one chain.
 * - A key comes only from `route.apiKey`, which is bound to the host of `route.apiUrl`.
 *   `apiKeys["etherscan-compatible"]` throws `invalid-input` (decision 0016, R-SEC-2). The key goes
 *   in the `apikey` field of the form body, never in the URL (R-SEC-1).
 *
 * Every answer is read as the Etherscan client reads it. A retired Etherscan host, such as
 * `api-sepolia.basescan.org/api`, answers `You are using a deprecated V1 endpoint` with HTTP 200;
 * that throws `unexpected-response`, never `failed` (R-FLOW-4).
 */
import type { Backend } from "./backend.ts";
import { etherscanStyle, post } from "./etherscan.ts";

/**
 * The standalone Etherscan-compatible explorer client. Every request is a form-encoded POST to
 * the route's `apiUrl`:
 *
 * | Call   | Form body                                                                        |
 * | ------ | -------------------------------------------------------------------------------- |
 * | lookup | `module=contract&action=getsourcecode&address=<address>`                         |
 * | submit | `module=contract&action=verifysourcecode` and the fields Etherscan's submit takes |
 * | poll   | `module=contract&action=checkverifystatus&guid=<guid>`                           |
 *
 * With `route.apiKey`, each body also holds `apikey`.
 *
 * @example
 * ```ts
 * const route = resolveRoute(296, {
 *   backend: "etherscan-compatible",
 *   apiUrl: "https://explorer.example.org/api",
 *   apiKey,
 * });
 * const match = await etherscanCompatible.lookup({ chainId: 296, address }, { route, http });
 * ```
 */
export const etherscanCompatible: Backend = etherscanStyle({
  name: "etherscan-compatible",
  label: "Etherscan-compatible explorer",
  read: post,
});
