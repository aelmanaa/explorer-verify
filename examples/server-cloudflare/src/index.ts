// The explorer-verify server handler as a Cloudflare Worker: POST /api/verify.
// Guide: docs/user/guides/run-the-server-handler.md
//
// The Etherscan key is a Worker secret: `npx wrangler secret put ETHERSCAN_API_KEY`. The dapp runs
// on another origin, ALLOWED_ORIGIN in wrangler.jsonc, so this Worker answers CORS for that origin
// only.
import { createVerifyHandler } from "explorer-verify/server";
import type { RateLimit, VerifyHandler, VerifyHandlerOptions } from "explorer-verify/server";

/** The bindings this Worker reads. `npx wrangler types` can generate this interface. */
export interface Env {
  /** A secret, set with `wrangler secret put`. Never in `vars`. */
  readonly ETHERSCAN_API_KEY: string;
  /** The dapp's origin, such as `https://your-dapp.example`. A plain var in wrangler.jsonc. */
  readonly ALLOWED_ORIGIN: string;
  /** Optional: comma-separated addresses whose contracts may be verified. */
  readonly VERIFY_DEPLOYERS?: string;
}

/** The path the handler answers on. */
const ROUTE = "/api/verify";
/** The chains the dapp verifies on. A request for another chain gets 403. */
const CHAINS: readonly number[] = [1, 11155111, 421614];
/** The largest request body, in bytes: the handler's default, set here to show the option. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The `rateLimit` hook: returns `false`, so the handler answers 429 `rate-limited`, for a request
 * that a browser sends from any origin but the dapp's. CORS does not stop another site's page from
 * sending a form POST; this check does, but only in a browser. A script outside a browser can send
 * any `Origin` header, so `deployers` and your own sign-in are what limit use of the key.
 * @param allowedOrigin The dapp's origin.
 * @returns The `rateLimit` hook.
 */
function fromDapp(allowedOrigin: string): RateLimit {
  return (request) => {
    const origin = request.headers.get("origin");
    return origin === null
      ? request.headers.get("sec-fetch-site") !== "cross-site"
      : origin === allowedOrigin;
  };
}

/**
 * The `deployers` option from a comma-separated list; none when the list is empty.
 * @param value The VERIFY_DEPLOYERS binding.
 * @returns The option, or no option.
 */
function deployers(value: string | undefined): Pick<VerifyHandlerOptions, "deployers"> {
  const list = (value ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");
  return list.length === 0 ? {} : { deployers: list };
}

/**
 * One handler per `env` object. The runtime may pass the same `env` to many requests, so the
 * handler and its checked options are reused.
 */
const handlers = new WeakMap<Env, VerifyHandler>();

/**
 * The handler for these bindings, created on first use.
 * @param env The Worker's bindings.
 * @returns The handler.
 */
function handlerFor(env: Env): VerifyHandler {
  let handler = handlers.get(env);
  if (handler === undefined) {
    handler = createVerifyHandler({
      apiKey: env.ETHERSCAN_API_KEY,
      chains: CHAINS,
      ...deployers(env.VERIFY_DEPLOYERS),
      rateLimit: fromDapp(env.ALLOWED_ORIGIN),
      maxBodyBytes: MAX_BODY_BYTES,
      // The handler removes the key from every line it logs.
      logger: console,
    });
    handlers.set(env, handler);
  }
  return handler;
}

/**
 * The CORS headers for a request from the dapp's origin, or none for any other origin. The dapp
 * may read `Retry-After`, which the handler sets on a 503 `address-not-indexed` and passes on with
 * a 429 `upstream-rate-limited`.
 * @param request The request.
 * @param allowedOrigin The dapp's origin.
 * @returns The headers to add.
 */
function corsHeaders(request: Request, allowedOrigin: string): Record<string, string> {
  return request.headers.get("origin") === allowedOrigin
    ? {
        "access-control-allow-origin": allowedOrigin,
        "access-control-expose-headers": "retry-after",
        vary: "Origin",
      }
    : { vary: "Origin" };
}

export default {
  /**
   * Answers the CORS preflight itself, passes POST /api/verify to the handler, and adds the CORS
   * headers to its answer.
   * @param request The incoming request.
   * @param env The Worker's bindings.
   * @returns The response.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== ROUTE) {
      return new Response("Not found", { status: 404 });
    }
    const cors = corsHeaders(request, env.ALLOWED_ORIGIN);
    if (request.method === "OPTIONS") {
      // A form POST needs no preflight; this answers one if a browser sends it anyway.
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": "POST",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }
    const answer = await handlerFor(env)(request);
    const response = new Response(answer.body, answer);
    for (const [name, value] of Object.entries(cors)) {
      response.headers.set(name, value);
    }
    return response;
  },
};
