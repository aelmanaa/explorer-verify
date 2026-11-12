// The explorer-verify server handler as a Next.js App Router route handler:
// POST /api/verify. Guide: docs/user/guides/run-the-server-handler.md
//
// The Etherscan key comes from the server's environment, ETHERSCAN_API_KEY.
// Next.js exposes a variable to the browser only when its name starts with
// NEXT_PUBLIC_, so never give the key that prefix.
import { createVerifyHandler } from "explorer-verify/server";
import type {
  RateLimit,
  VerifyHandler,
  VerifyHandlerOptions,
} from "explorer-verify/server";

// Node.js is the default runtime of a route handler; Next.js marks `edge` as
// deprecated.
export const runtime = "nodejs";

/** The chains the dapp verifies on. A request for another chain gets 403. */
const CHAINS: readonly number[] = [1, 11155111, 421614];

/**
 * The largest request body, in bytes. 8 MiB is the handler's default; raise it
 * if a contract's Standard JSON input, form-encoded, is larger.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The `rateLimit` hook: returns `false`, so the handler answers 429
 * `rate-limited`, for a request that a browser marks as sent from another site.
 * The dapp's pages call this route from their own origin. CORS does not stop
 * another site's page from sending a form POST; this check does, but only in a
 * browser. A script outside a browser can send any header, so `deployers` and
 * your own sign-in are what limit use of the key.
 */
const sameOrigin: RateLimit = (request) => {
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
};

/**
 * The addresses whose contracts this route may verify, from VERIFY_DEPLOYERS,
 * comma-separated. Unset, any contract on `CHAINS` may be verified with your
 * key.
 */
function deployers(
  value: string | undefined,
): Pick<VerifyHandlerOptions, "deployers"> {
  const list = (value ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");
  return list.length === 0 ? {} : { deployers: list };
}

let handler: VerifyHandler | undefined;

/**
 * Creates the handler on the first request. Next.js loads the module during
 * `next build`, where the key may be absent; created then, the handler would
 * throw `invalid-input` and fail the build.
 */
function verifyHandler(): VerifyHandler {
  handler ??= createVerifyHandler({
    apiKey: process.env.ETHERSCAN_API_KEY ?? "",
    chains: CHAINS,
    ...deployers(process.env.VERIFY_DEPLOYERS),
    rateLimit: sameOrigin,
    maxBodyBytes: MAX_BODY_BYTES,
    // The handler removes the key from every line it logs.
    logger: console,
  });
  return handler;
}

/** Forwards the browser's Etherscan request through the handler. */
export async function POST(request: Request): Promise<Response> {
  return await verifyHandler()(request);
}
