// References: R-BE-5, decision 0016, R-SEC-1.
/**
 * The Routescan client. Routescan serves an Etherscan-compatible API, so this client is
 * the Etherscan one with three differences. The evidence is in
 * docs/contributor/research/2026-11-04-routescan-client.md and
 * docs/contributor/research/2026-11-03-routescan-zksync.md.
 *
 * - The API base is the routing row's full URL, network and chain id in the path, such as
 *   `https://api.routescan.io/v2/network/testnet/evm/43113/etherscan/api`. No request sends a
 *   `chainid` parameter.
 * - A key is optional: the free tier needs none. When one is set, `withKey` puts it in the
 *   `apikey` request header, never in the URL or the body. A real key
 *   there is read: the answer carries the keyed tier's `x-ratelimit-*` headers (live,
 *   2026-11-05, docs/contributor/research/2026-11-05-routescan-key.md).
 * - A lookup or a status request is a GET with its fields in the query, plus a random `nocache`
 *   parameter that the HTTP layer draws again for every attempt, retries included. Routescan
 *   answers `getsourcecode` sent as a form POST with `Invalid querystring request`, and its CDN
 *   serves a repeated GET URL from its cache: a cached `Pending in queue` was still served 51
 *   minutes after the job had finished (live, 2026-11-03 and 2026-11-04).
 *
 * Over its limit Routescan answers HTTP 429 with a JSON body, `code` `rate-limit`, keyless and
 * keyed. The HTTP layer retries a 429 as for every backend. A keyed 429 holds the wait in
 * `x-ratelimit-rpm-retry-after`, in seconds, and no `Retry-After`, so every request names that
 * header as `retryAfterHeader`: a wait above 30 s ends the retries at once with `rate-limited` and
 * `retryAfterMs`, in place of four more requests that the limit would refuse (live, 2026-11-05).
 *
 * Routescan-specific answers, all with HTTP 200: `chain not supported` in `message` throws
 * `unsupported-chain`; `Verification not found` throws `job-not-found`, after which the flow looks
 * the contract up once, because Routescan has forgotten a job 51 minutes after its submit while
 * the contract stayed verified; `Missing guid` throws `unexpected-response`; a status of
 * `Error: Compilation successful, but bytecode does not match with deployed bytecode for address
 * <address>, please check your parameters` gives `failed` with that text as the reason (live on
 * Avalanche Fuji and Sepolia, 2026-11-04). Etherscan has not been recorded giving this text, so
 * only this client maps it.
 */
import type { BackendName } from "../backend-names.ts";
import { withKey } from "../http/api-keys.ts";
import type { HttpRequest } from "../http/fetch.ts";
import type { Backend, Context } from "./backend.ts";
import { etherscanStyle, rateLimited } from "./etherscan.ts";

/** The header of a keyed 429 that holds the wait in seconds (live, 2026-11-05). */
const RETRY_AFTER_HEADER = "x-ratelimit-rpm-retry-after";

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
    retryAfterHeader: RETRY_AFTER_HEADER,
    freshQuery: () => `nocache=${Math.random().toString(36).slice(2)}`,
  });
}

// References: decision 0063; docs/contributor/research/2026-11-10-foreign-matches.md and
// 2026-11-10-no-metadata-hash-grades.md.
/**
 * The Routescan client.
 *
 * | Call   | Request                                                                          |
 * | ------ | -------------------------------------------------------------------------------- |
 * | lookup | `GET <base>?module=contract&action=getsourcecode&address=<address>&nocache=<n>`  |
 * | submit | `POST <base>`, form body as for Etherscan: `verifysourcecode` and its fields     |
 * | poll   | `GET <base>?module=contract&action=checkverifystatus&guid=<guid>&nocache=<n>`    |
 *
 * Every match is `partial`, from a lookup or from `Pass - Verified`: Routescan states no grade.
 * Its `getsourcecode` has no `SimilarMatch` field, it passed a build without a metadata hash that
 * Sourcify and Blockscout grade partial, and it takes copies forwarded from Sourcify and Blockscout
 * (live, 2026-11-10). Within two minutes of a deployment it can hold another contract's source
 * under another `ContractName` (live, 2026-11-10); `verify()` compares the name and the compiler
 * version with the input.
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
export const routescan: Backend = /* @__PURE__ */ etherscanStyle({
  name: "routescan",
  label: "Routescan",
  read: unique,
  retryAfterHeader: RETRY_AFTER_HEADER,
  ungraded: true,
  // The part before the address, which differs per contract.
  rejections: ["Error: Compilation successful, but bytecode does not match with deployed bytecode"],
});
