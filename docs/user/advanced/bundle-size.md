# Bundle size

Version: explorer-verify 0.4.0

Agents: [llms.txt](../../../llms.txt) lists every page of these docs.

Audience: developers who ship `verify()` in a web page and want to know what it adds to the
bundle. The [browser guide](../guides/verify-from-a-browser.md) covers the setup.

## What a page downloads

`verify()` and `checkStatus()` hold the routing, the input checks and the polling, but no explorer
client. Each client is a module of its own:

- Sourcify;
- Etherscan v2;
- Etherscan-compatible;
- Routescan;
- Blockscout.

A call loads only the client of the backend its route resolves to, with a dynamic `import()`, and
keeps it for later calls ([client chunks](../reference/routing.md#client-chunks)). A page that
verifies on Sourcify downloads the entry and the Sourcify client, and never the other four.

> [!NOTE]
> The first call on a backend waits for its client to load, and that wait counts against
> `timeoutMs`.

## What your bundler does with the clients

| Bundler                    | Client chunks                                                    |
| -------------------------- | ---------------------------------------------------------------- |
| Vite, Rollup, webpack      | One chunk per client by default, fetched on the first call to it |
| esbuild, `splitting: true` | One chunk per client, with `format: "esm"`                       |
| esbuild, no splitting      | Every client in the one output file, downloaded with the entry   |

To ship one client in one file, import `verify` from `explorer-verify/core` and pass that client
([ship only the clients your tool uses](../guides/wrap-explorer-verify-in-your-tool.md#ship-only-the-clients-your-tool-uses)).

A dynamic `import("explorer-verify")` in your page still matters. It keeps the entry itself out of
the first page load, and the client chunks keep the clients the page never calls out of every load.

## The routing table chunk

The routing table's rows are a chunk of their own. A call loads them only when its route needs
them. A page that always passes `route.apiUrl` never downloads them, except for these routes, which
load the table to read what the row says about the URL, such as its explorer page:

- `etherscan-v2` at `https://api.etherscan.io/v2/api`;
- `blockscout` at an `https` URL whose path is `/api`;
- `etherscan-compatible` at an `https` URL.

See [table chunk](../reference/routing.md#table-chunk).

## A page that only reads a handle or an error

A page that stores or checks a handle, or maps an error code, without verifying, imports from the
small entries. They never reach the verification code:

- `explorer-verify/handle`;
- `explorer-verify/errors`;
- `explorer-verify/backends`.

Under esbuild with `splitting: true`, the same names imported from `explorer-verify` bring the
default entry's shared chunk and every client chunk into the build. `scripts/check-names.ts`
measured, with esbuild 0.28.2 and Rollup 4.67.4, gzip from the zlib of Node 24.21.0, on 2026-11-06:

| Import                                       | esbuild, splitting              | Rollup             |
| -------------------------------------------- | ------------------------------- | ------------------ |
| `formatHandle` from `explorer-verify`        | 13,884 bytes minified, 21 files | 114 bytes minified |
| `formatHandle` from `explorer-verify/handle` | 114 bytes minified, 1 file      | 114 bytes minified |
| `ERROR_CODES` from `explorer-verify`         | 14,382 bytes minified, 21 files | 525 bytes minified |
| `ERROR_CODES` from `explorer-verify/errors`  | 523 bytes minified, 1 file      | 525 bytes minified |

## Measured in the repository

`pnpm run size` bundles each entry point from the built package with esbuild 0.28.2 for the
browser, minified, and gzips it with the zlib of Node 24.21.0. It measures each entry without its
clients, and each client on its own. On 2026-11-04, at commit 4919790, it measured:

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
code. The server handler runs on your server, so its size does not reach the page.

> [!NOTE]
> The count is a model: each part is gzipped as one file, without the cost a real split adds per
> file.

## Changes since that measurement

| Date       | Change                                                                                                  | Commit  | `verify` with the table |
| ---------- | ------------------------------------------------------------------------------------------------------- | ------- | ----------------------- |
| 2026-11-05 | The table grew from 94 to 288 chains ([#166](https://github.com/aelmanaa/explorer-verify/issues/166))   | 60f089c | 16,577 bytes (+1,084)   |
| 2026-11-05 | Blockscout entries ([#169](https://github.com/aelmanaa/explorer-verify/issues/169))                     | c2142eb | 18,208 bytes (+1,341)   |
| 2026-11-05 | The rows moved to a chunk of their own ([#192](https://github.com/aelmanaa/explorer-verify/issues/192)) | 0ee4ea4 | 14,861 bytes            |

The Blockscout entries added 1,059 bytes to the rows. After the rows moved, the `table` chunk
measured 3,042 bytes. A page that verifies on Sourcify with `route.apiUrl` then shipped 17,728
bytes, and one that lets the table choose the route 20,770, against 21,292 before for both.

## Measured with Vite and esbuild

[Decision 0031](../../contributor/decisions/0031-clients-load-on-demand-and-chunks-measured-apart.md)
built `export { verify } from "explorer-verify"` with an empty routing table, at main ff437c9 on
2026-11-04, before the Etherscan-compatible client was added. It gzipped each output file on its
own (bytes):

| Build                       | Entry             | Sourcify client | Page that verifies on Sourcify |
| --------------------------- | ----------------- | --------------- | ------------------------------ |
| Vite 5.4.21 (Rollup 4.67.4) | 17,056            | 3,635           | 20,691                         |
| esbuild 0.28.2, splitting   | 18,046 (3 files)  | 3,610           | 21,656                         |
| esbuild 0.28.2, one file    | 21,663 (one file) | in the entry    | 21,663                         |

With Vite, the entry is about 4 KB smaller than the same build with the clients imported
statically (21,106 bytes), until the first call. With esbuild and splitting, the entry is about
3.6 KB smaller than the one file. A client added in a later version adds a chunk that only its own
calls load, and leaves the entry as it is.

## What is tested

The browser smoke test bundles the library with esbuild, splitting on, and runs it in headless
Chromium. A call routed to Sourcify loads the Sourcify chunk and no other client's chunk.

Not tested:

- webpack. Its behaviour above comes from its documentation.
- Loading the client chunks from a CDN. A check by hand of the esm.sh build of 0.1.0 found each
  client in a module of its own: a dry run on Sourcify fetched `backends/sourcify.mjs` and no other
  client. Another CDN may differ, and no test repeats the check.
- Serving the package's own files. The browser fetches `backends/<name>.js` on the first call
  routed to that backend, but no test loads those files.

## Sources

- esbuild, [Splitting](https://esbuild.github.io/api/#splitting): code reached through `import()`
  goes to a separate file when `splitting` is on, with ESM output only. Read on 2026-11-04.
- Rollup, [Code splitting](https://rollupjs.org/tutorial/#code-splitting): a dynamic import creates
  a separate chunk loaded on demand. Read on 2026-11-04.
- Vite, [Features](https://vite.dev/guide/features): async chunks from dynamic imports. v8.3.4,
  read on 2026-11-04.
- esm.sh, [`explorer-verify@0.1.0`](https://esm.sh/explorer-verify@0.1.0): one module per source
  file; a `dryRun()` on Sourcify in headless Chromium fetched only the Sourcify client. Checked on
  2026-11-10.
- webpack, [Dynamic imports](https://webpack.js.org/guides/code-splitting/#dynamic-imports):
  `import()` splits a module into a bundle of its own. Read on 2026-11-04.
