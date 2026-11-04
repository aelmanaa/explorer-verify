# How bundlers and runtimes handle a client loaded with `import()`

Date: 2026-11-04. Issue: [#136](https://github.com/aelmanaa/explorer-verify/issues/136).

Question: if each backend client sits behind a dynamic `import()` with a literal path, does each
main bundler put it in its own chunk, what does a build that does not split do, and what does each
client weigh on its own?

## Bundler documentation, read on 2026-11-04

| Tool                | What its docs say                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| esbuild             | With `splitting` on, "code referenced through an asynchronous `import()` expression will be split off into a separate file". Splitting "only works with the `esm` output format". Without it, "an `import()` expression becomes `Promise.resolve().then(() => require())`": the code stays in the one file. Import paths are bundled when they are a string literal. |
| Rollup              | "Rollup will use the dynamic import to create a separate chunk that is only loaded on demand." `output.inlineDynamicImports` inlines them instead, for a single bundle, and only with a single input.                                                                                                                                                                |
| Vite                | Production builds split code at dynamic imports, and Vite "automatically rewrites code-split dynamic import calls with a preload step".                                                                                                                                                                                                                              |
| webpack             | `import()` is the recommended way to split code dynamically; its guide shows a dynamically imported module emitted as a bundle of its own.                                                                                                                                                                                                                           |
| Cloudflare Wrangler | By default a lazily imported file is bundled into the Worker's entry point. With `find_additional_modules` and matching `rules`, it ships as a separate module, loaded when it is imported.                                                                                                                                                                          |
| TypeScript          | `rewriteRelativeImportExtensions` rewrites `.ts` in relative import paths to `.js` in the output. The docs show static imports only.                                                                                                                                                                                                                                 |

## Checked locally on 2026-11-04

Each build below takes `export { verify } from "explorer-verify"` from the built package at main
ff437c9 with #136, with an empty routing table, and gzips each output file at level 6 on its own.

- TypeScript 7.0.2 (`tsc -b`, the package build) rewrites the four literal paths, such as
  `import("../backends/sourcify.ts")`, to `.js` in `dist/src/flow/verify.js`.
- esbuild 0.28.2 with `splitting: true`, `format: "esm"`, `platform: "browser"`, minified:
  - The entry loads three files: `entry.js` and two shared chunks, 18,046 bytes in all.
  - Each client is its own chunk. With the chunks it adds, Sourcify is 3,610 bytes, Etherscan v2
    3,669, Routescan 3,860 and Blockscout 3,221.
  - Without splitting, one file: 21,663 bytes. Before the clients were loaded with `import()`, at
    main ff83bab, it was 20,567. Most of the 1,096 bytes are the wrappers esbuild adds to start
    each lazily loaded module; the rest bounds the load by the signal and the time budget.
- Vite 5.4.21, which builds with Rollup 4.67.4 and minifies with esbuild, a dependency of the docs
  site, run with `modulePreload: false` outside the repository's scripts:
  - One entry chunk holds every module the entry imports: 17,056 bytes.
  - Each client is a dynamic chunk, and the code only the clients share (`backends/common.js`) is
    one shared chunk of 1,610 bytes. Sourcify adds 2,025 + 1,610 = 3,635 bytes, Etherscan v2
    1,941 + 1,610 = 3,551, Blockscout 1,640 + 1,610 = 3,250, and Routescan 360 + 1,941 + 1,610 =
    3,911.
  - A page that verifies on Sourcify loads 20,691 bytes.
  - The same build with the four clients imported statically, in a copy of the built package, is
    one file of 21,106 bytes.
  - Unlike esbuild, Rollup does not move code that the entry holds into chunks shared with the
    clients.
- The browser smoke test bundles with esbuild splitting and runs the bundle in Node 24.21.0 and in
  headless Chromium. A call routed to Sourcify loads only the Sourcify client's chunk.
- Not run: webpack, Deno, Bun and edge runtimes. Their behaviour above comes from their docs; a
  dynamic `import()` of a relative path is standard ECMAScript.

## Each entry measured apart from its clients

`scripts/bundle.ts` `bundleApart` (decision 0031): the entry is one esbuild file in which each
dynamic `import()` stays an import, and each client is bundled alone, without the modules the
entry already holds. Same esbuild, zlib and empty routing table as above. This is a model: it
leaves out the per-file gzip cost and the exports a real split adds, so it is smaller than any
build above.

| Measured                        | Bytes  |
| ------------------------------- | ------ |
| `verify` without its clients    | 13,611 |
| `verify` with the routing table | 14,693 |
| `checkStatus`                   | 11,730 |
| `index`                         | 21,776 |
| Sourcify client                 | 2,885  |
| Etherscan v2 client             | 3,277  |
| Routescan client                | 3,360  |
| Blockscout client               | 2,933  |

The Routescan client imports the Etherscan v2 client's request code, so its size includes that
code. Each client has the same size whichever entry loads it.

## What it means

With Vite, a page that verifies on Sourcify ships about 400 bytes less than with every client
imported statically, and its entry is about 4 KB smaller until the first call. With esbuild, the
page ships about 1 KB more than before, split or not. The lasting gain is that a new client no
longer grows any entry: it adds a chunk that only its own calls load.

## Sources

- esbuild, API, splitting and bundle: https://esbuild.github.io/api/#splitting (read 2026-11-04)
- Rollup, tutorial, code splitting: https://rollupjs.org/tutorial/#code-splitting (read 2026-11-04)
- Rollup, `output.inlineDynamicImports`:
  https://rollupjs.org/configuration-options/#output-inlinedynamicimports (read 2026-11-04)
- Vite, features, async chunk loading optimization:
  https://vite.dev/guide/features.html#async-chunk-loading-optimization (read 2026-11-04)
- webpack, code splitting guide, dynamic imports:
  https://webpack.js.org/guides/code-splitting/#dynamic-imports (read 2026-11-04)
- Cloudflare Workers, Wrangler bundling: https://developers.cloudflare.com/workers/wrangler/bundling/
  (read 2026-11-04)
- TypeScript, `rewriteRelativeImportExtensions`:
  https://www.typescriptlang.org/tsconfig/#rewriteRelativeImportExtensions (read 2026-11-04)
- TypeScript 5.7 release notes, path rewriting for relative paths:
  https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-7.html (read 2026-11-04)
- Local measurements: esbuild 0.28.2, Vite 5.4.21 with Rollup 4.67.4, TypeScript 7.0.2, Node
  24.21.0 zlib, main at ff437c9 plus #136 and, for the one-file size before, ff83bab, 2026-11-04.
