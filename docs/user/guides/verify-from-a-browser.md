# Verify from a browser

Version: explorer-verify 0.0.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who call `verify()` from a web page, with a bundler or from a CDN. Nothing is
published to npm yet.

This guide covers what changes in a browser: how the library reaches the page, which explorers the
page calls directly, where the Etherscan key lives, how to keep a handle across a reload, and what
the library adds to your bundle. For a full walk-through, from a wallet deployment to a verified
contract, follow the tutorial
[Deploy a contract from a dapp and verify it](../tutorials/deploy-and-verify-from-a-dapp.md).

## Setup

The core package uses only web-platform globals (`fetch`, `URL`, `AbortSignal`, `TextEncoder`,
`crypto.subtle`) and imports no Node built-in. It is ESM only.

### With a bundler

Install it in the web project:

```sh
npm install explorer-verify
```

Import it from your code. Any bundler that handles ES modules works, such as Vite, Rollup, esbuild
or webpack. The routing table is a JSON file that the library imports with
`with { type: "json" }`. esbuild reads `.json` files by default and accepts that attribute
([esbuild content types](https://esbuild.github.io/content-types/), read on 2026-11-04), and Vite
imports JSON files directly ([Vite features](https://vite.dev/guide/features), v8.3.4, read on
2026-11-04).

### From a CDN, without a bundler

Map the bare name `explorer-verify` to a CDN URL with an import map, before any module script
that imports it ([MDN, `importmap`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap),
read on 2026-11-04, page modified 2026-10-12). Pin the exact version you tested with:

```html
<script type="importmap">
  {
    "imports": {
      "explorer-verify": "https://esm.sh/explorer-verify@<version>"
    }
  }
</script>
<script type="module" src="/src/verify.js"></script>
```

esm.sh builds each npm package as ES modules and rewrites the package's imports to its own URLs
([esm.sh](https://esm.sh/), read on 2026-11-04). The module scripts of the page then import
`explorer-verify` as they would with a bundler.

To serve the package's own files instead, copy `node_modules/explorer-verify/dist/src/` to your
site and map `explorer-verify` to its `index.js`. The browser then loads each module file on its
own, and loads the routing table as a JSON module. A JSON module needs the file served as
`application/json`; browsers support JSON modules since 2025
([MDN, import attributes](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import/with),
read on 2026-11-04, page modified 2026-09-11).

Not tested: the package is not on npm yet, so no CDN serves it, and the repository's tests load
neither of these setups in a browser. The browser smoke test runs the library bundled with esbuild
in headless Chromium.

## Verify

Sourcify and Blockscout need no key, and Routescan takes one only optionally, so the page calls
them directly. With no key, a call goes to the first backend of the chain's row that needs none,
such as Sourcify ([Routing](../reference/routing.md#how-a-chain-resolves)). Blockscout is reached
only when you pass `route.backend` and `route.apiUrl`, and so is Routescan, because the routing
table of this version lists no Routescan entry ([Routing](../reference/routing.md#route)). The
module below loads the
library with a dynamic `import()` on first use, so a page that never verifies does not download it.
It saves the handle as soon as the explorer accepts the submission, and `resumeOnLoad` picks the
job up again after a reload. The last line runs the module once on its own; leave it out of the
page, and call `verifyFromPage(input)` from your button and `resumeOnLoad()` when the page loads.

```ts
import type { VerifyInput } from "explorer-verify";

const PENDING_KEY = "pending-verification";

/** Verifies `input`, loading the library on first use. Returns a line to show the user. */
export async function verifyFromPage(input: VerifyInput): Promise<string> {
  const { ExplorerVerifyError, verify } = await import("explorer-verify");
  try {
    const result = await verify(input, {
      onEvent: (event) => {
        if (event.type === "verify.submitted") {
          // Saved before the first poll, so a reload can resume the job.
          localStorage.setItem(PENDING_KEY, event.handle);
        }
      },
    });
    localStorage.removeItem(PENDING_KEY);
    return result.status === "failed"
      ? `rejected: ${result.reason}`
      : `${result.status} on ${result.backend}`;
  } catch (error) {
    if (error instanceof ExplorerVerifyError && error.details.code === "not-confirmed") {
      return "still checking: the handle stays saved";
    }
    localStorage.removeItem(PENDING_KEY);
    throw error;
  }
}

/** On page load: polls the saved job with checkStatus(), which never submits. */
export async function resumeOnLoad(): Promise<string | undefined> {
  const handle = localStorage.getItem(PENDING_KEY);
  if (handle === null) {
    return undefined;
  }
  const { checkStatus } = await import("explorer-verify");
  const result = await checkStatus(handle, { timeoutMs: 60_000 });
  localStorage.removeItem(PENDING_KEY);
  return result.status;
}

console.log(await verifyFromPage(input));
console.log((await resumeOnLoad()) ?? "nothing to resume");
```

When Sourcify accepts the source and verifies it, it prints:

```text
verified on sourcify
nothing to resume
```

When the time budget runs out first, the handle stays in `localStorage`, and `resumeOnLoad`
finishes the job:

```text
still checking: the handle stays saved
verified
```

The handle holds no key and no URL, so it is safe to store, show or paste into a support request.
`checkStatus()` resolves the route from the handle's chain and the options you pass, never from the
handle; pass the same `route` and `fetch` the submit used. See [checkStatus()](../reference/check-status.md),
and step 5 of the [tutorial](../tutorials/deploy-and-verify-from-a-dapp.md#step-5-resume-after-a-page-reload)
for a resume that also handles `not-confirmed`.

A browser tab has no fixed limit on how long a call may run, but the user can close it. Keep the
default budget of 120 seconds (`timeoutMs`) or shorter, and rely on the saved handle for the rest.

## Etherscan from a browser

Never put an Etherscan key in browser code: Etherscan's API terms forbid exposing a key in
client-side applications. Run the [server handler](run-the-server-handler.md) on your server
instead. The page then passes `verify()` a `fetch` that sends each Etherscan request to the handler,
and the handler adds the key. The guide has that `fetch`, `handlerFetch`, for a Next.js route and
a Cloudflare Worker, and step 7 of the
[tutorial](../tutorials/deploy-and-verify-from-a-dapp.md#step-7-verify-on-etherscan-through-your-server)
uses it from a dapp.

A public dapp, or any use by a business, protocol, foundation or DAO, needs an Etherscan Advanced
plan or higher and its own key, and must show "Powered by Etherscan.io APIs" when it displays
Etherscan data. [Etherscan plans and attribution](../explanation/etherscan-plans-and-attribution.md)
explains the rule and its sources.

## Errors

The errors a page meets most often:

| Code                                                            | What to do in the page                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`not-confirmed`](../reference/errors/not-confirmed.md)         | Keep the handle and resume it with `checkStatus()` on a later load                 |
| [`network`](../reference/errors/network.md)                     | The explorer did not answer, or the browser blocked the request. Try again later   |
| [`missing-api-key`](../reference/errors/missing-api-key.md)     | The route needs a key and the page has none. Route Etherscan through the handler   |
| [`unsupported-chain`](../reference/errors/unsupported-chain.md) | The routing table has no row for the chain. See [Routing](../reference/routing.md) |
| [`in-progress`](../reference/errors/in-progress.md)             | Another submission of the contract is being checked. Try again in a minute         |

Every error has a `hint` to show the user and a `retryable` flag. [Errors](../reference/errors/index.md)
lists every code.

## Bundle size

`pnpm run size` in the repository bundles each entry point with esbuild for the browser, minified,
and gzips it. On 2026-11-04 it measured:

| Import                                              | Gzipped size |
| --------------------------------------------------- | ------------ |
| `verify`, with the routing table                    | 21,718 bytes |
| `checkStatus`, without the routing table            | 18,592 bytes |
| `createVerifyHandler` from `explorer-verify/server` | 12,395 bytes |

The server handler runs on your server, so its size does not reach the page.

In this version, `verify` and `checkStatus` carry every explorer client: Sourcify, Etherscan v2,
Routescan and Blockscout. A planned change,
[issue #136](https://github.com/aelmanaa/explorer-verify/issues/136), loads each client with a
dynamic `import()` only when a call is routed to it. A bundler then writes each client as its own
chunk and the page loads it on first use; a page that serves the package's own files loads the
client's module file the same way. Whether a CDN build keeps the clients apart is up to the CDN,
and is not tested. Until that change lands, the dynamic `import()` in the example above is what
keeps the library out of the first page load.

## Sources

- MDN, [`<script type="importmap">`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap):
  an import map maps bare names to URLs and must come before the modules that use it. Read on
  2026-11-04 (page modified 2026-10-12).
- MDN, [Import attributes](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import/with):
  `with { type: "json" }` needs `application/json`; Baseline since April 2025. Read on 2026-11-04
  (page modified 2026-09-11).
- esbuild, [Content types](https://esbuild.github.io/content-types/): the JSON loader is on by
  default for `.json` and accepts `with { type: 'json' }`. Read on 2026-11-04.
- Vite, [Features](https://vite.dev/guide/features): JSON imports and async chunks from dynamic
  imports. v8.3.4, read on 2026-11-04.
- esm.sh, [home page](https://esm.sh/): builds npm packages as ES modules and rewrites their
  imports. Read on 2026-11-04.
- Etherscan, [API terms](https://etherscan.io/apiterms): no keys in client-side applications. Read
  on 2026-11-04 (page updated 2026-10-01).
