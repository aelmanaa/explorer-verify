/**
 * The client for standalone Etherscan-compatible explorers (R-BE-2): an explorer that serves
 * Etherscan's API on its own host, for one chain, outside Etherscan's multichain API. It is the
 * Etherscan client, built by `etherscanStyle`, with these differences. The evidence is in
 * docs/contributor/research/2026-11-04-etherscan-compatible-client.md and
 * docs/contributor/research/2026-11-05-etherscan-compatible-hosts.md.
 *
 * - The API base is the routing table's entry for the chain (decision 0039), or the caller's
 *   `route.apiUrl`. A result has an `explorerUrl` only when the table's entry names an explorer
 *   host and the route is the table's (R-FLOW-3).
 * - No request sends a `chainid` parameter: each host serves one chain.
 * - A key comes only from `route.apiKey`, which is bound to the host of `route.apiUrl`, or to the
 *   table's host for the chain when its entry has `needsKey`. `apiKeys["etherscan-compatible"]`
 *   throws `invalid-input` (decisions 0016 and 0039, R-SEC-2). The key goes in the `apikey` field
 *   of the form body, never in the URL (R-SEC-1).
 * - A lookup or a status request without a key is a GET with its fields in the query: Bitlayer's
 *   API answers `getsourcecode` sent as a POST with `Request method 'POST' not supported` (live,
 *   2026-11-05). With a key, it is a form POST, so the key stays out of the URL.
 *
 * Every answer is read as the Etherscan client reads it, except that a lookup answered with an
 * empty `result` list means "not verified", as Bitlayer answers (live, 2026-11-05). A retired
 * Etherscan host, such as `api-sepolia.basescan.org/api`, answers `You are using a deprecated V1
 * endpoint` with HTTP 200; that throws `unexpected-response`, never `failed` (R-FLOW-4).
 */
import type { BackendName } from "../backend-names.ts";
import { keyFor, withKey } from "../http/api-keys.ts";
import type { HttpRequest } from "../http/fetch.ts";
import type { Backend, Context } from "./backend.ts";
import { etherscanStyle, post, rateLimited } from "./etherscan.ts";

/**
 * A lookup or a status request: a GET with `module=contract` and `fields` in the query when no key
 * is bound to the route, else the form POST of the Etherscan client, with the key in the body.
 */
function read(ctx: Context, backend: BackendName, fields: Record<string, string>): HttpRequest {
  const url = ctx.route.requestUrl("");
  if (keyFor(ctx, backend, url) !== undefined) {
    return post(ctx, backend, fields);
  }
  const query = new URLSearchParams({ module: "contract", ...fields });
  return withKey(ctx, backend, {
    url: `${url}${url.includes("?") ? "&" : "?"}${query.toString()}`,
    method: "GET",
    retry: "safe",
    rateLimited,
  });
}

/**
 * The standalone Etherscan-compatible explorer client. Every request goes to the route's API
 * base:
 *
 * | Call   | Request                                                                    |
 * | ------ | -------------------------------------------------------------------------- |
 * | lookup | `GET <base>?module=contract&action=getsourcecode&address=<address>`        |
 * | submit | `POST <base>`, form `module=contract&action=verifysourcecode` and fields   |
 * | poll   | `GET <base>?module=contract&action=checkverifystatus&guid=<guid>`          |
 *
 * With `route.apiKey`, the lookup and the poll are form POSTs too, and each body holds `apikey`.
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
  read,
  emptyLookup: true,
});
