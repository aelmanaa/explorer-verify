// The browser side of the Next.js example: verify() with a fetch that sends each Etherscan request
// to the route in app/api/verify/route.ts. The browser holds no key.
// Guide: docs/user/guides/run-the-server-handler.md
import { verify } from "explorer-verify";
import type { VerifyInput, VerifyResult } from "explorer-verify";

/** The only origin whose requests go to the handler. Every other request is sent unchanged. */
const ETHERSCAN_API = "https://api.etherscan.io";

/**
 * A `fetch` that sends each Etherscan request to the handler at `handlerUrl`, with the same query,
 * method, headers and body, and every other request unchanged. It takes a URL and `init`, as
 * verify() calls it, or a `Request`. `init` is passed on as is, so the `redirect: "manual"` that
 * verify() sets is kept.
 * @param handlerUrl Where the handler runs: `/api/verify` in the dapp's own pages.
 * @returns The `fetch` to pass to verify().
 */
export function handlerFetch(handlerUrl: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== ETHERSCAN_API) {
      return await fetch(input, init);
    }
    const target = `${handlerUrl}${url.search}`;
    if (!(input instanceof Request)) {
      return await fetch(target, init);
    }
    // A Request carries its own method, headers, body, redirect mode and signal; `init` overrides
    // them, as it does in fetch().
    const request = new Request(input, init);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: hasBody ? await request.arrayBuffer() : null,
      redirect: request.redirect,
      signal: request.signal,
    });
  };
}

/**
 * Verifies a contract from the browser. Etherscan requests go through the route; Sourcify and
 * Blockscout requests go to the explorer directly.
 * @param input The contract and its compiler input.
 * @returns The verification result.
 */
export async function verifyFromBrowser(input: VerifyInput): Promise<VerifyResult> {
  return await verify(input, { fetch: handlerFetch("/api/verify") });
}
