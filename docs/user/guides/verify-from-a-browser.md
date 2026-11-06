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
own, an explorer client's file only when a call is routed to it, and loads the routing table as a
JSON module. A JSON module needs the file served as
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
when you pass `route.backend` on the chains whose row lists an instance
([Blockscout rows](../reference/routing.md#blockscout-rows)), and with `route.apiUrl` elsewhere.
Blockscout's hosted API, the backend `blockscout-hosted`, cannot be used from a browser: it sends
no CORS headers, and the server handler does not forward Blockscout. Use `blockscout`, an instance,
which needs no key.
Routescan comes last in the rows that list it, so pass `route: { backend: "routescan" }` to use it
there, and add `route.apiUrl` on other chains
([Routing](../reference/routing.md#routescan-entries)). The module below loads the
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
    if (error instanceof ExplorerVerifyError && error.code === "not-confirmed") {
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
handle; pass the same `route`, `fetch` and `handlerUrl` the submit used. See [checkStatus()](../reference/check-status.md),
and step 5 of the [tutorial](../tutorials/deploy-and-verify-from-a-dapp.md#step-5-resume-after-a-page-reload)
for a resume that also handles `not-confirmed`.
A Sourcify handle from `verifyEach()`, on a chain where `handlerUrl` makes Etherscan the choice,
resumes only with `route: { backend: "sourcify" }`.

A browser tab has no fixed limit on how long a call may run, but the user can close it. Keep the
default budget of 120 seconds (`timeoutMs`) or shorter, and rely on the saved handle for the rest.

## Etherscan from a browser

Never put an Etherscan key in browser code: Etherscan's API terms forbid exposing a key in
client-side applications. Run the [server handler](run-the-server-handler.md) on your server
instead, at `/api/verify` on the page's origin or on a host of its own. The page then passes the
handler's URL as `handlerUrl`:

<!-- no-run: it posts to /api/verify on the page's own origin, which a test run does not serve. -->

```ts no-run
import { verify } from "explorer-verify";

// Your server runs createVerifyHandler at /api/verify and holds the key.
const result = await verify(input, { handlerUrl: "/api/verify" });
console.log(`${result.status} on ${result.backend}`);
```

Each Etherscan request goes to the handler with no key, and the handler adds it. With no
`route.backend`, the routing table chooses as it does with an Etherscan key: a chain whose row
lists Etherscan first goes to the handler. An injected `fetch` alone does not do this:
without `handlerUrl`, a call routed to Etherscan with no key throws `missing-api-key` before any
request. [API keys](../reference/api-keys.md#a-server-adds-the-key) lists the rules, the guide
shows the handler as a Next.js route and a Cloudflare Worker, and step 7 of the
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
| [`missing-api-key`](../reference/errors/missing-api-key.md)     | The route needs a key and the page has none. Set `handlerUrl` to your handler      |
| [`unsupported-chain`](../reference/errors/unsupported-chain.md) | The routing table has no row for the chain. See [Routing](../reference/routing.md) |
| [`in-progress`](../reference/errors/in-progress.md)             | Another submission of the contract is being checked. Try again in a minute         |

Every error has a `hint` to show the user and a `retryable` flag. [Errors](../reference/errors/index.md)
lists every code.

## Bundle size

`verify()` and `checkStatus()` hold the routing, the input checks and the polling, but no explorer
client. Each client (Sourcify, Etherscan v2, Etherscan-compatible, Routescan and Blockscout) is a
module of its own. A call loads only the client of the backend its route resolves to, with a
dynamic `import()`, and keeps it for later calls
([client chunks](../reference/routing.md#client-chunks)). A page that verifies on Sourcify
downloads the entry and the Sourcify client, and never the other four. The first call on a backend
waits for its client to load, and that wait counts against `timeoutMs`.

What reaches the page depends on your bundler:

- Vite, Rollup and webpack write each client as a chunk of its own by default. The page fetches a
  client's chunk on the first call routed to it.
- esbuild does the same with `splitting: true` and `format: "esm"`. Without splitting, every client
  stays in the one output file, and the page downloads all five with the entry. To ship one client
  in one file, import `verify` from `explorer-verify/core` and pass that client
  ([ship only the clients your tool uses](wrap-explorer-verify-in-your-tool.md#ship-only-the-clients-your-tool-uses)).

The `import("explorer-verify")` in the example above still matters: it keeps the entry itself out
of the first page load. The client chunks keep the clients the page never calls out of every load.

The routing table's rows are a chunk of their own as well. A call loads them only when its route
needs them. A page that always passes `route.apiUrl` never downloads them, unless the route is
`etherscan-v2` at `https://api.etherscan.io/v2/api`, `blockscout` at an `https` URL whose path is
`/api`, or `etherscan-compatible` at an `https` URL: those load the table to read what the row says
about that URL, such as its explorer page
([table chunk](../reference/routing.md#table-chunk)).

### A page that only reads a handle or an error

A page that stores or checks a handle, or maps an error code, without verifying, imports from the
small entries: `explorer-verify/handle`, `explorer-verify/errors` and `explorer-verify/backends`.
They never reach the verification code. Under esbuild with `splitting: true`, the same names from
`explorer-verify` bring the default entry's shared chunk and every client chunk into the build.
`scripts/check-names.ts` measured, with esbuild 0.28.2 and Rollup 4.67.4, gzip from the zlib of
Node 24.21.0, on 2026-11-06:

| Import                                       | esbuild, splitting              | Rollup             |
| -------------------------------------------- | ------------------------------- | ------------------ |
| `formatHandle` from `explorer-verify`        | 13,884 bytes minified, 21 files | 114 bytes minified |
| `formatHandle` from `explorer-verify/handle` | 114 bytes minified, 1 file      | 114 bytes minified |
| `ERROR_CODES` from `explorer-verify`         | 14,382 bytes minified, 21 files | 525 bytes minified |
| `ERROR_CODES` from `explorer-verify/errors`  | 523 bytes minified, 1 file      | 525 bytes minified |

### Measured in the repository

`pnpm run size` bundles each entry point from the built package with esbuild 0.28.2 for the
browser, minified, and gzips it with the zlib of Node 24.21.0. It measures each entry without its
clients, and each client on its own. On 2026-11-04, on main at commit 4919790 with constructor
argument derivation added (#64), it measured:

| Import or chunk                                                       | Gzipped size |
| --------------------------------------------------------------------- | ------------ |
| `verify`, with the routing table                                      | 15,322 bytes |
| `checkStatus`, without the routing table                              | 12,074 bytes |
| Sourcify client                                                       | 2,884 bytes  |
| Etherscan v2 client                                                   | 3,513 bytes  |
| [Etherscan-compatible](../reference/etherscan-compatible.md) client   | 3,496 bytes  |
| Routescan client, with the Etherscan v2 request code it uses          | 3,591 bytes  |
| Blockscout client                                                     | 2,945 bytes  |
| Constructor argument derivation, loaded only when a call derives them | 1,960 bytes  |
| `verify` as one file with every client, without the routing table     | 24,001 bytes |
| `createVerifyHandler` from `explorer-verify/server`                   | 12,474 bytes |

A page that verifies on Sourcify ships `verify` with the routing table plus the Sourcify client:
18,206 bytes by this count. A call that derives constructor arguments also loads the derivation
code. The count is a model: each part is gzipped as one file, without the cost a real split adds
per file. The server handler runs on your server, so its size does not reach the page.

On 2026-11-05 the routing table grew from 94 to 288 chains, one for every chain Sourcify supports
([#166](https://github.com/aelmanaa/explorer-verify/issues/166)). At main 60f089c with that
change, `verify` with the routing table measured 16,577 bytes, 1,084 more than without it. The
Blockscout entries of [#169](https://github.com/aelmanaa/explorer-verify/issues/169) added 1,059
bytes to the rows and 1,341 bytes to `verify` with the table, which measured 18,208 bytes at main
c2142eb with that change.

On 2026-11-05 the rows moved to a chunk of their own
([#192](https://github.com/aelmanaa/explorer-verify/issues/192)). At main 0ee4ea4 with that change,
`verify` measured 14,861 bytes and the `table` chunk 3,042. A page that verifies on Sourcify with
`route.apiUrl` ships 17,728 bytes, and one that lets the table choose the route ships 20,770, against
21,292 before for both.

### Measured with Vite and esbuild

[Decision 0031](../../contributor/decisions/0031-clients-load-on-demand-and-chunks-measured-apart.md)
built `export { verify } from "explorer-verify"` with an empty routing table, at main ff437c9 on
2026-11-04, before the Etherscan-compatible client was added, and gzipped each output file on its
own:

| Build                       | Entry             | Sourcify client | Page that verifies on Sourcify |
| --------------------------- | ----------------- | --------------- | ------------------------------ |
| Vite 5.4.21 (Rollup 4.67.4) | 17,056            | 3,635           | 20,691                         |
| esbuild 0.28.2, splitting   | 18,046 (3 files)  | 3,610           | 21,656                         |
| esbuild 0.28.2, one file    | 21,663 (one file) | in the entry    | 21,663                         |

With Vite, the entry is about 4 KB smaller than the same build with the clients imported
statically (21,106 bytes), until the first call. With esbuild and splitting, the entry is about
3.6 KB smaller than the one file. Either way, a client added in a later version adds a chunk that
only its own calls load, and leaves the entry as it is.

### Not tested

- webpack. Its behaviour above comes from its documentation.
- Loading the client chunks from a CDN. Whether a CDN build such as esm.sh keeps each client in a
  module of its own is up to the CDN. When you serve the package's own files, the dynamic `import()`
  makes the browser fetch `backends/<name>.js` on the first call routed to that backend, but no test
  loads those files in a browser.

The browser smoke test bundles the library with esbuild, splitting on, and runs it in headless
Chromium: a call routed to Sourcify loads the Sourcify chunk and no other client's chunk.

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
- esbuild, [Splitting](https://esbuild.github.io/api/#splitting): code reached through `import()`
  goes to a separate file when `splitting` is on, with ESM output only. Read on 2026-11-04.
- Rollup, [Code splitting](https://rollupjs.org/tutorial/#code-splitting): a dynamic import creates
  a separate chunk loaded on demand. Read on 2026-11-04.
- webpack, [Dynamic imports](https://webpack.js.org/guides/code-splitting/#dynamic-imports): `import()`
  splits a module into a bundle of its own. Read on 2026-11-04.
- esm.sh, [home page](https://esm.sh/): builds npm packages as ES modules and rewrites their
  imports. Read on 2026-11-04.
- Etherscan, [API terms](https://etherscan.io/apiterms): no keys in client-side applications. Read
  on 2026-11-04 (page updated 2026-10-01).
