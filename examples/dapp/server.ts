// The dapp's server: it serves `public/` and forwards the browser's Etherscan requests at
// POST /api/verify through the explorer-verify server handler, which adds the key (step 5 of the
// tutorial docs/user/tutorials/deploy-and-verify-from-a-dapp.md). Any server works; this one uses
// only Node's `http` module, so the example needs no framework.
//
// It is for loopback only (scripts/serve.ts binds 127.0.0.1). Before you bind it to another
// address, add a real rate limit (`rateLimit`), a check of `Origin` and `Host` against your own
// origin, and your own sign-in: the `Sec-Fetch-Site` check below stops only browsers.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { buffer } from "node:stream/consumers";

import { createVerifyHandler } from "explorer-verify/server";
import type { VerifyHandler } from "explorer-verify/server";

/** Sepolia, the only chain the dapp deploys on. */
const CHAINS: readonly number[] = [11155111];

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** The options of the dapp's server. */
export interface DappServerOptions {
  /** The Etherscan key, from the server's environment. Empty: /api/verify answers 503. */
  readonly apiKey: string;
  /** The folder of the static files. Defaults to `public/` next to this file. */
  readonly root?: URL;
  /** The `fetch` the handler sends to Etherscan with. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * Whether a browser marks the request as sent from another site. The handler's `rateLimit` hook
 * can only answer 429, so the routes check this first and answer 403.
 */
function fromAnotherSite(request: Request): boolean {
  return request.headers.get("sec-fetch-site") === "cross-site";
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function serveFile(root: URL, pathname: string): Promise<Response> {
  // `pathname` comes from a parsed URL, which has no `..` segment left, so the file is under root.
  const file = new URL(`.${pathname === "/" ? "/index.html" : pathname}`, root);
  const type = CONTENT_TYPES[/\.[a-z]+$/.exec(file.pathname)?.[0] ?? ""];
  if (type === undefined) {
    return text(404, "Not found");
  }
  try {
    return new Response(await readFile(file), { headers: { "content-type": type } });
  } catch {
    return text(404, "Not found");
  }
}

/**
 * The dapp's routes as a web `Request` handler: GET for the static files, POST /api/verify for
 * the server handler.
 * @param options The key and, for tests, the folder and the `fetch` to Etherscan.
 * @returns The handler.
 */
export function dappRoutes(options: DappServerOptions): (request: Request) => Promise<Response> {
  const root = options.root ?? new URL("public/", import.meta.url);
  const verifyHandler: VerifyHandler | undefined =
    options.apiKey === ""
      ? undefined
      : createVerifyHandler({
          apiKey: options.apiKey,
          chains: CHAINS,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/verify") {
      if (fromAnotherSite(request)) {
        return text(403, "Forbidden");
      }
      return verifyHandler === undefined
        ? text(503, "Set ETHERSCAN_API_KEY on the server to verify on Etherscan.")
        : await verifyHandler(request);
    }
    if (request.method !== "GET") {
      return text(405, "Method not allowed");
    }
    return await serveFile(root, pathname);
  };
}

/**
 * The web `Request` for a Node request. The routes read only the path, the query, the method, the
 * headers and the body, so the origin is fixed. A server's request always has `method` and `url`.
 */
async function toRequest(message: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    for (const item of [value].flat()) {
      if (item !== undefined) {
        headers.append(name, item);
      }
    }
  }
  const url = new URL(String(message.url), "http://localhost");
  const body = await buffer(message);
  return new Request(url, {
    method: String(message.method),
    headers,
    ...(body.length === 0 ? {} : { body }),
  });
}

/**
 * The dapp's routes on a Node HTTP server. Call `listen` on it.
 * @param options The options of `dappRoutes`.
 * @returns The server.
 */
export function createDappServer(options: DappServerOptions): Server {
  const routes = dappRoutes(options);
  const answer = async (message: IncomingMessage): Promise<Response> => {
    try {
      return await routes(await toRequest(message));
    } catch {
      return text(400, "Bad request");
    }
  };
  return createServer((message, reply) => {
    // A failure while writing the answer closes the connection.
    void answer(message)
      .then(async (response) => {
        const body = Buffer.from(await response.arrayBuffer());
        reply.writeHead(response.status, Object.fromEntries(response.headers)).end(body);
        return undefined;
      })
      .catch(reply.destroy.bind(reply));
  });
}
