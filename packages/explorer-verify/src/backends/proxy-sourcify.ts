// References: R-FLOW-8.
/**
 * Reads a proxy's link on Sourcify. Sourcify detects proxies on its own when it
 * verifies a contract and takes no request to link one: one lookup with `fields=proxyResolution`
 * says what it found. `linkProxy()` loads this module with a dynamic `import()`, so `verify()`
 * never bundles it.
 *
 * Sourcify records the implementation when it verifies the proxy, so after an upgrade it may name
 * the earlier one; `expectedImplementation` then gives `mismatch`. The evidence is in
 * docs/contributor/research/2026-11-04-proxy-linking.md.
 */
import { readFields } from "../internal/read-fields.ts";
import type { Hex } from "../types.ts";
import type { Context, LinkEnd, LinkTarget, LinkVerdict, ProxyLinker } from "./backend.ts";
import { send, unexpected } from "./common.ts";
import { implementationOf, unknownLink } from "./proxy-common.ts";
import { sourcify } from "./sourcify.ts";

/**
 * The Sourcify proxy-link code.
 *
 * | Step     | Request                                                              |
 * | -------- | -------------------------------------------------------------------- |
 * | request  | `GET <apiBase>/v2/contract/{chainId}/{address}?fields=proxyResolution` |
 * | verified | `GET <apiBase>/v2/contract/{chainId}/{implementation}`               |
 *
 * A 404 with a `null` match is `not-linked`: the proxy is not verified on Sourcify. `isProxy`
 * `false` is `not-linked`: Sourcify detects no proxy. Every other answer throws.
 *
 * @example
 * ```ts
 * const step = await sourcifyProxyLinker.request({ chainId: 11155111, address }, ctx);
 * ```
 */
export const sourcifyProxyLinker: ProxyLinker = {
  request,
  check,
  verified,
};

/** Reads the link again. Sourcify starts no job, so `linkProxy()` never calls it. */
async function check(_jobId: string, target: LinkTarget, ctx: Context): Promise<LinkVerdict> {
  return await request(target, ctx);
}

/** One lookup with `fields=proxyResolution`. */
async function request(target: LinkTarget, ctx: Context): Promise<LinkEnd> {
  const url = new URL(
    ctx.route.requestUrl(
      `/v2/contract/${String(target.chainId)}/${encodeURIComponent(target.address)}`,
    ),
  );
  url.searchParams.set("fields", "proxyResolution");
  const answer = await send(ctx, { url: url.href, method: "GET", retry: "safe" });
  const { status, fields } = answer;
  if (status === 404 && fields?.has("match") === true && fields.get("match") === null) {
    return {
      state: "not-linked",
      reason: "Sourcify has not verified the proxy: verify it there first.",
    };
  }
  const resolution = readFields(fields?.get("proxyResolution"));
  const isProxy = resolution?.get("isProxy");
  if (status === 200 && typeof fields?.get("match") === "string" && resolution !== undefined) {
    if (isProxy === false) {
      return { state: "not-linked", reason: "Sourcify does not detect a proxy at the address." };
    }
    const listed = resolution.get("implementations");
    if (isProxy === true && Array.isArray(listed)) {
      if (listed.length === 0) {
        return { state: "not-linked", reason: "Sourcify detects no implementation for the proxy." };
      }
      // One address, exactly: several, or one that is not an address, is not a link.
      const implementation =
        listed.length === 1 ? implementationOf(readFields(listed[0])?.get("address")) : undefined;
      if (implementation === undefined) {
        throw unknownLink(ctx, "sourcify", "Sourcify", answer);
      }
      return { state: "linked", implementation };
    }
  }
  throw unexpected(ctx, "sourcify", "Sourcify", answer, "the proxy lookup");
}

/** Whether Sourcify holds the implementation's verified source: one lookup. */
async function verified(implementation: Hex, chainId: number, ctx: Context): Promise<boolean> {
  return (await sourcify.lookup({ chainId, address: implementation }, ctx)) !== undefined;
}
