// The browser side of the Cloudflare example: verify() in the dapp, with a fetch that sends each
// Etherscan request to the Worker on its own origin. The browser holds no key.
// Guide: docs/user/guides/run-the-server-handler.md
import { verify } from "explorer-verify";
import type { VerifyInput, VerifyResult } from "explorer-verify";

/** The only origin whose requests go to the handler. Every other request is sent unchanged. */
const ETHERSCAN_API = "https://api.etherscan.io";

/** Where the Worker runs. Replace it with your Worker's URL. */
export const WORKER_URL = "https://verify.your-dapp.example/api/verify";

/**
 * A `fetch` that sends each Etherscan request to the handler at `handlerUrl`, with the same query,
 * method, headers and body, and every other request unchanged. It takes a URL and `init`, as
 * verify() calls it, or a `Request`. `init` is passed on as is, so the `redirect: "manual"` that
 * verify() sets is kept.
 * @param handlerUrl The Worker's full URL, such as {@link WORKER_URL}.
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
 * Verifies a contract from the browser. Etherscan requests go through the Worker; Sourcify and
 * Blockscout requests go to the explorer directly.
 * @param input The contract and its compiler input.
 * @returns The verification result.
 */
export async function verifyFromBrowser(input: VerifyInput): Promise<VerifyResult> {
  return await verify(input, { fetch: handlerFetch(WORKER_URL) });
}
