# Verify from an edge function

Version: explorer-verify 0.1.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

For: developers who call `verify()` from an edge function, such as a Cloudflare Worker.

You need: a Cloudflare account and Wrangler, or another edge runtime with `fetch` and
`crypto.subtle`. An Etherscan key, stored as a Worker secret.

An edge function answers one request at a time, and the platform, a proxy or the client may end a
request before an explorer finishes. So the Worker below submits in one request and returns the
handle, and later requests resume the job with `checkStatus()`.

## Install

Add the package to the Worker project:

```sh
npm install explorer-verify
```

## Run a dry run on the sample contract

Save [greeter-sepolia.json](../start/greeter-sepolia.json) next to your module. It is a verify
request for a Greeter contract on Sepolia. A dry run checks the input, picks the explorer and
looks the contract up once. It submits nothing and needs no key:

```ts [dry-run.ts]
import { dryRun, validateInput } from "explorer-verify";

import greeter from "./greeter-sepolia.json" with { type: "json" };

// validateInput() checks the parsed JSON and returns a typed VerifyInput.
const input = validateInput(greeter);
const plan = await dryRun(input);
console.log(plan.status, plan.backend, plan.apiHost, plan.lookup);
```

It prints:

```text
dry-run sourcify sourcify.dev exact
```

With no key, the routing table picks Sourcify. The Worker below passes an Etherscan key, so the
same input goes to Etherscan v2.

## Limits to plan for

Cloudflare's limits for a Worker that answers HTTP requests:

| Limit             | Free plan       | Paid plan                          |
| ----------------- | --------------- | ---------------------------------- |
| Duration          | No hard limit   | No hard limit                      |
| CPU time          | 10 ms a request | 30 seconds by default, up to 5 min |
| Subrequests       | 50 a request    | 10,000 a request                   |
| `ctx.waitUntil()` | 30 seconds      | 30 seconds                         |

The client, or a proxy before the Worker, may still give up first. Each lookup, submit, poll and
retry is one subrequest. `ctx.waitUntil()` runs at most 30 seconds after the response, so it
cannot replace `checkStatus()`. Other platforms set their own limits. In every case, give each call
a budget (`timeoutMs`) well below the shortest limit, and keep the handle.

## Bundle and store the secrets

Wrangler bundles the Worker with esbuild, which reads the library's JSON routing table. It puts a
dynamic `import()` into the Worker's one file unless you configure extra modules. To keep unused
clients out of that file, import from `explorer-verify/core` and pass the clients the Worker uses
([ship only the clients your tool uses](wrap-explorer-verify-in-your-tool.md#ship-only-the-clients-your-tool-uses)).

Store the Etherscan key and the token your own backend sends as Worker secrets. Wrangler prompts
for each value, so neither appears in the command:

```sh
npx wrangler secret put ETHERSCAN_API_KEY
npx wrangler secret put VERIFY_TOKEN
```

> [!WARNING]
> Never put a key in `vars` in `wrangler.jsonc`: Wrangler stores `vars` in plain text.

[Run the server handler](run-the-server-handler.md#cloudflare-workers) covers `.dev.vars` for
`wrangler dev`, and the `enable_request_signal` flag that makes `request.signal` fire when the
client disconnects.

## Guard the Worker with a token

The key verifies any contract that a caller sends, so the Worker answers only requests that carry
`VERIFY_TOKEN` as a bearer token. Generate it as a random string of at least 32 characters, such as
the output of `openssl rand -hex 32`. Use your own sign-in in place of the token if you have one.

The Worker fails closed:

- secret missing or shorter than 32 characters: 500 to every request;
- no `Authorization: Bearer` header: 401 before any comparison;
- wrong token: 401.

The Worker compares SHA-256 digests of the tokens, so the time taken does not depend on how much of
the token matches. It uses only standard Web Crypto, so it also runs on Node.js. It sets no CORS
headers: it is for your own backend, not for a browser.

## Write the Worker

The Worker has two routes:

- `POST /verify` takes the `VerifyInput` as JSON, checks it with `validateInput()` and calls
  `verify()` with a 20-second budget.
- `GET /status?handle=…` calls `checkStatus()` with a 10-second budget.

Both answer with the [JSON envelope](../reference/json-output.md#the-envelope). The status is 400
for [`invalid-input`](../reference/errors/invalid-input.md), such as a body that is not JSON, and
200 for every other outcome. The caller reads `ok`, `error.code` and `error.handle`.

The test code at the end of the block, below the line `Test code`, calls the Worker's `fetch`
for each case. Leave it out of the Worker:

```ts [worker.ts]
import {
  ExplorerVerifyError,
  checkStatus,
  validateInput,
  verify,
} from "explorer-verify";
import type { VerifyOptions, VerifyResult } from "explorer-verify";
import { exitCodeOf, toEnvelope } from "explorer-verify/envelope";
import type { VerifyOutcome } from "explorer-verify/envelope";

import greeter from "./greeter-sepolia.json" with { type: "json" };

export interface Env {
  /** A secret: `npx wrangler secret put ETHERSCAN_API_KEY`. */
  readonly ETHERSCAN_API_KEY: string;
  /**
   * A secret your backend sends as `Authorization: Bearer <token>`: 32
   * characters or more.
   */
  readonly VERIFY_TOKEN?: string;
}

/**
 * Each budget stays well below the time a client or proxy waits for an answer.
 */
const SUBMIT_BUDGET_MS = 20_000;
const STATUS_BUDGET_MS = 10_000;
const MIN_TOKEN_LENGTH = 32;

/**
 * Compares the SHA-256 digests of two strings, so the time taken does not
 * depend on the token.
 */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [given, expected].map(
      async (text) =>
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", encoder.encode(text)),
        ),
    ),
  );
  let difference = 0;
  for (let index = 0; index < 32; index += 1) {
    difference |= (a?.[index] ?? 0) ^ (b?.[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Whether the request carries the token. Fails closed when the secret is
 * missing or short.
 */
async function authorized(request: Request, secret: string): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    return false;
  }
  return await sameSecret(header.slice("Bearer ".length), secret);
}

function options(env: Env, request: Request, timeoutMs: number): VerifyOptions {
  // request.signal stops the call when the client disconnects.
  return {
    apiKeys: { "etherscan-v2": env.ETHERSCAN_API_KEY },
    signal: request.signal,
    timeoutMs,
  };
}

/**
 * The result, or the library's error as an outcome. Any other error is thrown.
 */
async function outcomeOf(
  call: () => Promise<VerifyResult>,
): Promise<VerifyOutcome> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ExplorerVerifyError) {
      return error;
    }
    throw error;
  }
}

/**
 * The envelope, with status 400 for invalid-input (exit code 2) and 200
 * otherwise.
 */
function answer(outcome: VerifyOutcome, env: Env): Response {
  return Response.json(
    toEnvelope(outcome, { secrets: [env.ETHERSCAN_API_KEY] }),
    {
      status: exitCodeOf(outcome) === 2 ? 400 : 200,
    },
  );
}

/**
 * The parsed body, or `undefined` when it is not JSON, which validateInput()
 * then refuses.
 */
async function jsonBody(request: Request): Promise<unknown> {
  try {
    const body: unknown = await request.json();
    return body;
  } catch {
    return undefined;
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const secret = env.VERIFY_TOKEN;
    if (secret === undefined || secret.length < MIN_TOKEN_LENGTH) {
      return new Response("The Worker is not configured.", { status: 500 });
    }
    if (!(await authorized(request, secret))) {
      return new Response("Unauthorized", { status: 401 });
    }
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/verify") {
      const body = await jsonBody(request);
      const outcome = await outcomeOf(async () =>
        verify(validateInput(body), options(env, request, SUBMIT_BUDGET_MS)),
      );
      return answer(outcome, env);
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const handle = url.searchParams.get("handle") ?? "";
      const outcome = await outcomeOf(async () =>
        checkStatus(handle, options(env, request, STATUS_BUDGET_MS)),
      );
      return answer(outcome, env);
    }
    return new Response("Not found", { status: 404 });
  },
};

export default worker;

// ---- Test code: runs each case once, without a Worker runtime. Leave it out
// of the Worker. ---- `apiKey` and `etherscanKey` stand for your secrets; the
// token repeats `apiKey` to reach 32 characters.
const token = apiKey.repeat(2);
const env: Env = { ETHERSCAN_API_KEY: etherscanKey, VERIFY_TOKEN: token };
const headers = { authorization: `Bearer ${token}` };
const show = async (response: Response): Promise<void> => {
  console.log(response.status, await response.text());
};
const verifyRequest = (init: RequestInit): Request =>
  new Request("https://verify.example/verify", { method: "POST", ...init });

// No Authorization header: 401.
await show(
  await worker.fetch(verifyRequest({ body: JSON.stringify(greeter) }), env),
);
// VERIFY_TOKEN not set: 500, whatever the request carries.
await show(
  await worker.fetch(verifyRequest({ headers: { authorization: "Bearer " } }), {
    ETHERSCAN_API_KEY: etherscanKey,
  }),
);
// A body that is not JSON: 400 with an invalid-input envelope.
await show(await worker.fetch(verifyRequest({ headers, body: "{" }), env));
// The sample request, already verified on Etherscan: 200.
await show(
  await worker.fetch(
    verifyRequest({ headers, body: JSON.stringify(greeter) }),
    env,
  ),
);
// A passed Arbitrum Sepolia job: 200.
const handle =
  "ev1:etherscan-v2:421614:0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc:" +
  "ctzxlls4kl2yziafqgangtjk3hgdbd3xhnzbg5d3tgla9wgsb3";
await show(
  await worker.fetch(
    new Request(`https://verify.example/status?handle=${handle}`, { headers }),
    env,
  ),
);
```

The test code prints each status and answer. The Sepolia contract is already verified on Etherscan,
and the Arbitrum Sepolia job has passed:

```text
401 Unauthorized
500 The Worker is not configured.
400 {"schemaVersion":1,"ok":false,"error":{"code":"invalid-input","message":"The input is invalid: input must be a plain object whose fields can be read.","hint":"Fix the fields that the issues list (details.issues), then call again.","docsUrl":"https://aelmanaa.github.io/explorer-verify/reference/errors/invalid-input","retryable":false,"details":{"code":"invalid-input","issues":[{"field":"input","message":"must be a plain object whose fields can be read"}]}}}
200 {"schemaVersion":1,"ok":true,"result":{"status":"already-verified","backend":"etherscan-v2","match":"exact","explorerUrl":"https://sepolia.etherscan.io/address/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc#code"}}
200 {"schemaVersion":1,"ok":true,"result":{"status":"verified","backend":"etherscan-v2","match":"exact","explorerUrl":"https://sepolia.arbiscan.io/address/0x8275d36f64f047d2d8a1f42c79bf80caea39d7cc#code"}}
```

When the submit outlives its budget, the first answer is a `not-confirmed` error with the handle in
`error.handle`. The caller then sends `GET /status` with that handle, a few seconds apart, until
the envelope holds a result or another error.

## Resume

The handle is all a later request needs. Keep it where the caller can find it again: in the
caller's own storage, in a Workers KV namespace, or in a database. `checkStatus()` never submits,
so a repeated status request is safe. Each one costs a few subrequests: one per poll, plus retries.

When the client disconnects, `request.signal` aborts the call, which rejects with no handle. If
the submit was accepted by then, the caller never sees its handle. To keep it, save the handle from
the `verify.submitted` event in an `onEvent` callback, keyed by chain and address
([Abort and resume](../reference/verify.md#abort-and-resume)).

Pass the same `apiKeys` and `route` in both routes. A Sourcify handle polled with a route that
resolves to Etherscan throws `invalid-input` before any request.

## Errors

| Code                                                        | What the caller does                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| [`not-confirmed`](../reference/errors/not-confirmed.md)     | Send `GET /status` with `error.handle` later                    |
| [`invalid-input`](../reference/errors/invalid-input.md)     | Fix the input or the handle the message names; nothing was sent |
| [`missing-api-key`](../reference/errors/missing-api-key.md) | The secret is not set. Set it with `wrangler secret put`        |
| [`timeout`](../reference/errors/timeout.md)                 | The explorer did not accept the submit in time. Send it again   |
| [`rate-limited`](../reference/errors/rate-limited.md)       | Retries ran out. Slow down                                      |

[Errors](../reference/errors/index.md) lists every code. The error's `hint` says what to do, and
`retryable` says whether trying again may help.

## Keys and Etherscan's terms

The key lives in the Worker's secrets and reaches the code through `env`. The envelope, the log
lines and the errors never hold it: the library removes it, and `toEnvelope` gets it in `secrets`
as well.

To let a browser call `verify()` while the key stays on your server, run the
[server handler](run-the-server-handler.md) instead. It forwards only the browser's Etherscan
requests. Do not offer this Worker to other applications as a relay; see
[Run the server handler](run-the-server-handler.md#etherscans-terms).

A public dapp, or any use by a business, protocol, foundation or DAO, needs an Etherscan Advanced
plan or higher and its own key. It must show "Powered by Etherscan.io APIs" when it displays
Etherscan data. [Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md)
explains the rule.

## What is tested

The repository's tests run the Worker block on Node.js, test code included, with recorded Etherscan
answers, and check every line it prints. No test runs it in the Workers runtime or deploys it.

## Sources

- Cloudflare, [Workers limits](https://developers.cloudflare.com/workers/platform/limits/):
  duration, CPU time and subrequests per plan. Read on 2026-11-04 (page updated 2026-10-29).
- Cloudflare, [Context](https://developers.cloudflare.com/workers/runtime-apis/context/):
  `ctx.waitUntil()` extends the work by at most 30 seconds. Read on 2026-11-04 (page updated
  2026-10-12).
- Cloudflare, [Bundling](https://developers.cloudflare.com/workers/wrangler/bundling/): Wrangler
  bundles a dynamic `import()` into the Worker's file. Read on 2026-11-04 (page updated 2026-11-02).
- Cloudflare,
  [Protect against timing attacks](https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/):
  `crypto.subtle.timingSafeEqual` on Workers. Read on 2026-11-04 (page updated 2026-04-23).

## Next steps

- [Run the server handler](run-the-server-handler.md): keep the key on your server for a browser.
- [Resume from a job queue](../advanced/resume-from-a-job-queue.md): finish a handle in a backend
  job.
- [JSON output and exit codes](../reference/json-output.md): every field of the envelope.
- [checkStatus()](../reference/check-status.md): the handle and its one-line form.
