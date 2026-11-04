/**
 * The Routescan client (R-BE-5). Routescan serves an Etherscan-compatible API, so this client is
 * the Etherscan one with three differences. The evidence is in
 * docs/contributor/research/2026-11-04-routescan-client.md and
 * docs/contributor/research/2026-11-03-routescan-zksync.md.
 *
 * - The API base is the routing row's full URL, network and chain id in the path, such as
 *   `https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api`. No request sends a
 *   `chainid` parameter.
 * - A key is optional: the free tier needs none. When one is set, `withKey` puts it in the
 *   `apikey` request header, never in the URL or the body (decision 0016, R-SEC-1).
 * - A lookup or a status request is a GET with its fields in the query, plus a random `nocache`
 *   parameter that the HTTP layer draws again for every attempt, retries included. Routescan
 *   answers `getsourcecode` sent as a form POST with `Invalid querystring request`, and its CDN
 *   serves a repeated GET URL from its cache: a cached `Pending in queue` was still served 51
 *   minutes after the job had finished (live, 2026-11-03 and 2026-11-04).
 *
 * Routescan-specific answers, all with HTTP 200: `chain not supported` in `message` throws
 * `unsupported-chain`; `Verification not found` throws `job-not-found`, after which the flow looks
 * the contract up once, because Routescan has forgotten a job 51 minutes after its submit while
 * the contract stayed verified; `Missing guid` throws `unexpected-response`.
 */
import type { BackendName } from "../backend-names.ts";
import { withKey } from "../http/api-keys.ts";
import type { HttpRequest } from "../http/fetch.ts";
import type { Backend, Context } from "./backend.ts";
import { etherscanStyle, rateLimited } from "./etherscan.ts";

/**
 * A GET to `route.requestUrl("")` with `module=contract` and `fields` in the query. Each attempt
 * adds `nocache` with new random characters, which keeps the CDN from answering with a cached
 * copy.
 */
function unique(ctx: Context, backend: BackendName, fields: Record<string, string>): HttpRequest {
  const url = ctx.route.requestUrl("");
  const query = new URLSearchParams({ module: "contract", ...fields });
  return withKey(ctx, backend, {
    url: `${url}${url.includes("?") ? "&" : "?"}${query.toString()}`,
    method: "GET",
    retry: "safe",
    rateLimited,
    freshQuery: () => `nocache=${Math.random().toString(36).slice(2)}`,
  });
}

/**
 * The Routescan client.
 *
 * | Call   | Request                                                                          |
 * | ------ | -------------------------------------------------------------------------------- |
 * | lookup | `GET <base>?module=contract&action=getsourcecode&address=<address>&nocache=<n>`  |
 * | submit | `POST <base>`, form body as for Etherscan: `verifysourcecode` and its fields     |
 * | poll   | `GET <base>?module=contract&action=checkverifystatus&guid=<guid>&nocache=<n>`    |
 *
 * A lookup never reports `partial`: Routescan's `getsourcecode` has no `SimilarMatch` field.
 *
 * @example
 * ```ts
 * const route = resolveRoute(43113, {
 *   backend: "routescan",
 *   apiUrl: "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api",
 * });
 * const match = await routescan.lookup({ chainId: 43113, address }, { route, http });
 * ```
 */
export const routescan: Backend = etherscanStyle({
  name: "routescan",
  label: "Routescan",
  read: unique,
});
