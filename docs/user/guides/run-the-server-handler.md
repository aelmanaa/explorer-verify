# Run the server handler

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who run a dapp and want its users to verify contracts on Etherscan without
shipping an Etherscan key to the browser. Nothing is released yet. The package `explorer-verify`
exists in the repository and is not published to npm.

This guide runs [`createVerifyHandler`](../reference/server-handler.md) in two places: a Next.js
App Router route and a Cloudflare Worker. In both, the key comes from the platform's secret store,
the guards are set, and the browser sends its Etherscan requests to the handler through the `fetch`
it passes to `verify()`. The full examples are in the repository under
[`examples/server-nextjs/`](../../../examples/server-nextjs/app/api/verify/route.ts) and
[`examples/server-cloudflare/`](../../../examples/server-cloudflare/src/index.ts). Each code block
on this page is a file from those folders, unchanged.

The browser calls `verify()` with `route: { backend: "etherscan-v2" }` and a `fetch` that sends
the Etherscan requests to the handler, as
[Point the client at it](../reference/server-handler.md#point-the-client-at-it) shows. Sourcify
requests go out unchanged.

## Etherscan's terms

Read [Etherscan's API terms](https://etherscan.io/apiterms) before you deploy the handler. This
project read them on 2026-11-04 (the page said "Last updated: 1 October 2026"). In this project's
reading:

- You use your own key, on your own server.
- The handler is part of your application. Do not offer it as a relay to other applications.
- The terms forbid exposing a key in client code: they forbid "embedding them in publicly
  accessible code or client-side applications". They also forbid operating "an API proxy,
  gateway, relay or data feed that passes API Data through to third parties".
- The handler forwards only the verify-submit action, `verifysourcecode`, the status action,
  `checkverifystatus`, and a read-only lookup, `getsourcecode`, whose answer it reduces so that no
  source code and no ABI is passed on. Whether a handler limited to these counts as such a proxy is
  this project's reading, not legal advice. Confirm with Etherscan.
- A public dapp, or any use by a business, protocol, foundation or DAO, needs an Advanced plan or
  higher, and must show "Powered by Etherscan.io APIs" when it displays Etherscan data. See
  [Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md).

## Install

Install the core package in the server project, and in the dapp if it is a separate project:

```sh
npm install explorer-verify
```

The handler is the `explorer-verify/server` entry point. It imports no Node built-in and uses
only web-platform globals. `explorer-verify` depends on neither `next` nor `wrangler`; your
project brings the one it runs on.

## Configure the guards

Both examples set the same options. The [reference](../reference/server-handler.md) lists every
option and every refusal.

| Setting        | Example value                     | Why                                                                                   |
| -------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| `apiKey`       | From the platform's secret store  | The only place the key lives. Never from the request, never in client code            |
| `chains`       | `[1, 11155111, 421614]`           | The chains your dapp verifies on. Any other chain gets 403 `chain-not-allowed`        |
| `maxBodyBytes` | 8 MiB                             | Refuses a larger body with 413 before parsing it. Raise it for very large inputs      |
| `deployers`    | From `VERIFY_DEPLOYERS`, when set | Forwards a submit or a lookup only for contracts these addresses created              |
| `rateLimit`    | An origin check                   | Refuses a browser request from another site with 429. Add a per-client limit here too |
| `logger`       | `console`                         | Logs each refusal and failure, with the key removed                                   |

CORS is not access control. A form-encoded POST needs no preflight, so any page can make its
visitors' browsers send one to your handler, and a script outside a browser sends any header it
wants. The origin check stops other sites' pages; `deployers` limits which contracts your key
verifies; your own sign-in, in front of the handler, limits who verifies. See
[Who may verify](../reference/server-handler.md#who-may-verify).

## Next.js

The route runs on the same origin as the dapp's pages, at `POST /api/verify`. Next.js passes the
route a standard `Request` and sends the `Response` it returns.

1. Add the route below as `app/api/verify/route.ts`.
2. Set `ETHERSCAN_API_KEY` in the server's environment: in `.env.local` for `next dev`, and in your
   host's environment settings for production. Keep `.env*` files out of git.
3. Optional: set `VERIFY_DEPLOYERS` to your deployer addresses, comma-separated.

Never name the key `NEXT_PUBLIC_ETHERSCAN_API_KEY`. Next.js copies a variable with that prefix into
the JavaScript it sends to the browser, at build time; a variable without the prefix stays on the
server.

```ts
// The explorer-verify server handler as a Next.js App Router route handler: POST /api/verify.
// Guide: docs/user/guides/run-the-server-handler.md
//
// The Etherscan key comes from the server's environment, ETHERSCAN_API_KEY. Next.js exposes a
// variable to the browser only when its name starts with NEXT_PUBLIC_, so never give the key that
// prefix.
import { createVerifyHandler } from "explorer-verify/server";
import type { RateLimit, VerifyHandler, VerifyHandlerOptions } from "explorer-verify/server";

// Node.js is the default runtime of a route handler; Next.js marks `edge` as deprecated.
export const runtime = "nodejs";

/** The chains the dapp verifies on. A request for another chain gets 403. */
const CHAINS: readonly number[] = [1, 11155111, 421614];

/**
 * The largest request body, in bytes. 8 MiB is the handler's default; raise it if a contract's
 * Standard JSON input, form-encoded, is larger.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The `rateLimit` hook: returns `false`, so the handler answers 429 `rate-limited`, for a request
 * that a browser marks as sent from another site. The dapp's pages call this route from their own
 * origin. CORS does not stop another site's page from sending a form POST; this check does, but
 * only in a browser. A script outside a browser can send any header, so `deployers` and your own
 * sign-in are what limit use of the key.
 */
const sameOrigin: RateLimit = (request) => {
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
};

/**
 * The addresses whose contracts this route may verify, from VERIFY_DEPLOYERS, comma-separated.
 * Unset, any contract on `CHAINS` may be verified with your key.
 */
function deployers(value: string | undefined): Pick<VerifyHandlerOptions, "deployers"> {
  const list = (value ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");
  return list.length === 0 ? {} : { deployers: list };
}

let handler: VerifyHandler | undefined;

/**
 * Creates the handler on the first request. Next.js loads the module during `next build`, where
 * the key may be absent; created then, the handler would throw `invalid-input` and fail the build.
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
```

The route exports only `runtime` and `POST`, because Next.js accepts only HTTP methods and segment
options as exports of a route file. It uses the default Node.js runtime: Next.js marks the `edge`
runtime as deprecated. It creates the handler on the first request, because `next build` loads the
module where the key may be absent; created at load time, the handler would throw
[`invalid-input`](../reference/errors/invalid-input.md) and fail the build. A deployment without
the key answers 500 and logs that error, which names the `apiKey` option and no value.

The dapp and the route share an origin, so the route needs no CORS header. Next.js answers an
`OPTIONS` request to the route itself, with an `Allow` header.

## Cloudflare Workers

The Worker runs on its own origin, such as `https://verify.your-dapp.example`, and answers
`POST /api/verify`. The dapp runs on another origin, so the Worker answers CORS for the dapp's
origin only.

1. Add `wrangler.jsonc` and `src/index.ts` below to a Worker project. Set `ALLOWED_ORIGIN` to your
   dapp's origin. Optional: add `VERIFY_DEPLOYERS` to `vars`, with your deployer addresses,
   comma-separated.
2. Deploy with `npx wrangler deploy`. Until the next step, the Worker has no key and fails every
   request to `/api/verify`.
3. Store the key as a secret. Wrangler prompts for the value, so it never appears in the command:

   ```sh
   npx wrangler secret put ETHERSCAN_API_KEY
   ```

   The command deploys a new version of the Worker with the secret. With gradual deployments, use
   `npx wrangler versions secret put ETHERSCAN_API_KEY` instead, which creates a version without
   deploying it.

For `wrangler dev`, put `ETHERSCAN_API_KEY=<your key>` in a `.dev.vars` file or a `.env` file next
to `wrangler.jsonc`, not both, and keep the file out of git.

Never put the key in `vars`: Wrangler stores `vars` in the configuration file, in plain text.

```jsonc
// Wrangler configuration of the verify handler Worker.
// The Etherscan key is a secret, never a var: `npx wrangler secret put ETHERSCAN_API_KEY`.
// For `wrangler dev`, put it in a .dev.vars file next to this one, and keep that file out of git.
{
  "name": "explorer-verify-handler",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-04",
  // request.signal fires when the client disconnects, so the handler stops its upstream request.
  // The default from compatibility date 2026-11-17 on.
  "compatibility_flags": ["enable_request_signal"],
  "vars": {
    "ALLOWED_ORIGIN": "https://your-dapp.example",
  },
}
```

The `enable_request_signal` flag makes `request.signal` fire when the browser disconnects, so the
handler stops its upstream request. From compatibility date 2026-11-17 this is the default
([Request](https://developers.cloudflare.com/workers/runtime-apis/request/), read on 2026-11-04,
page updated 2026-11-02).

```ts
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
```

The Worker reads the key from `env`, the bindings argument of `fetch`. It creates one handler per
`env` object, because the runtime may pass the same object to many requests. It types `Env` by hand
so the example needs no Cloudflare package; `npx wrangler types` generates the same interface from
`wrangler.jsonc`. A Worker without the secret throws `invalid-input` on its first request.

The CORS settings the handler expects you to add:

| Request                         | The Worker answers                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` from `ALLOWED_ORIGIN`    | The handler's answer, plus `Access-Control-Allow-Origin: <ALLOWED_ORIGIN>`, `Access-Control-Expose-Headers: retry-after` and `Vary: Origin` |
| `POST` from another origin      | 429 `rate-limited` from the origin check, with no `Access-Control-Allow-Origin`, so the page cannot read it                                 |
| `OPTIONS` from `ALLOWED_ORIGIN` | 204 with `Access-Control-Allow-Methods: POST` and `Access-Control-Allow-Headers: content-type`                                              |
| `OPTIONS` from another origin   | 204 with no `Access-Control-Allow-Origin`, so the browser stops                                                                             |
| Another path                    | 404                                                                                                                                         |

The handler adds no CORS header and answers `OPTIONS` with 405, so the Worker answers the preflight
before it calls the handler. `Access-Control-Expose-Headers` lets the dapp read `Retry-After`,
which comes with a 503 `address-not-indexed` and a 429 `upstream-rate-limited`. A form-encoded POST is a simple request and needs no preflight; the
Worker answers one in case a browser sends it.

## Point the browser at the handler

The browser keeps no key. It passes `verify()` a `fetch` that sends each Etherscan request to the
handler, with the same query, method and body, and sends every other request unchanged. No other
code changes between direct and proxied use. With `fetch` set, `verify()` sends an Etherscan
request without a key and leaves the key to the server.

For the Next.js route, the handler URL is the path `/api/verify`:

```ts
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
```

For the Worker, it is the Worker's full URL:

```ts
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
```

## What the repository checks

CI type-checks both examples, the Worker a second time without Node types, and runs their tests on
Node.js. The tests call the route's `POST` and the Worker's `fetch` with the request the browser
sends through `handlerFetch`, against recorded Etherscan answers. They check that the answer has
the shape the client reads, that the key goes to Etherscan only in the form body, and that no
response and no log line holds the key, even when Etherscan echoes it. The examples are not
deployed, and the tests do not run in the Workers runtime.

## Sources

- Next.js, [route.js](https://nextjs.org/docs/app/api-reference/file-conventions/route): route
  handlers take a Web `Request`, export HTTP methods, and get an automatic `OPTIONS`. Read on
  2026-11-04 (page updated 2026-04-30).
- Next.js, [Route Segment Config](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config):
  `runtime` defaults to `nodejs`, and `edge` is deprecated. Read on 2026-11-04 (page updated
  2026-10-01).
- Next.js, [Environment variables](https://nextjs.org/docs/app/guides/environment-variables):
  `.env*` loading and the `NEXT_PUBLIC_` prefix. Read on 2026-11-04 (page updated 2026-08-25).
- Cloudflare, [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/):
  `wrangler secret put`, `wrangler versions secret put`, `env`, and `.dev.vars` or `.env` but not
  both. Read on 2026-11-04 (page updated 2026-10-15).
- Cloudflare, [Request](https://developers.cloudflare.com/workers/runtime-apis/request/):
  `request.signal` on disconnect and `enable_request_signal`. Read on 2026-11-04 (page updated
  2026-11-02).
- Cloudflare, [Fetch handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/):
  `fetch(request, env, ctx)`, and the same `env` for many requests. Read on 2026-11-04 (page
  updated 2026-04-23).
- Cloudflare, [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/):
  `wrangler.jsonc`, `vars`, and no secrets in `vars`. Read on 2026-11-04 (page updated
  2026-10-29).
- Cloudflare, [TypeScript](https://developers.cloudflare.com/workers/languages/typescript/):
  `wrangler types` generates `Env`. Read on 2026-11-04 (page updated 2026-10-27).
- MDN, [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS): a form-encoded POST
  is a simple request without preflight, and `Vary: Origin` with a listed origin. Read on
  2026-11-04 (page updated 2026-10-28).
- Etherscan, [API terms](https://etherscan.io/apiterms). Read on 2026-11-04 (page updated
  2026-10-01).
