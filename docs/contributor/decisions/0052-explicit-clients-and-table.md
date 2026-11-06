# 0052: `explorer-verify/core` takes the clients and the routing table from its caller

Status: Accepted (2026-11-06). Amends where [decision 0031](0031-clients-load-on-demand-and-chunks-measured-apart.md)
keeps the client loaders and where [decision 0040](0040-routing-table-loads-on-demand.md) keeps
the table loader, adds the core rows that [decision 0042](0042-every-exported-name-measured-in-real-bundlers.md)
left for later, amends the R-RUN-3 criterion of issue #220, and resets the `checkStatus` ceiling
of [decision 0014](0014-measured-bundle-ceilings.md).

Research: none (maintainer choice).

## Context

Issue [#220](https://github.com/aelmanaa/explorer-verify/issues/220). The client chunks of decision
0031 and the table chunk of decision 0040 exist only when the bundler splits code. esbuild without
`splitting`, Wrangler by default, CommonJS output and a wrapper SDK that bundles its dependencies
inline every dynamic `import()`. Measured with esbuild 0.28.2, minified, gzip from the zlib of
Node.js 24.21.0, on 2026-11-06 at main f7c12bf, `verify` from `explorer-verify` as one file is
111,704 bytes minified, 32,551 gzipped: all five clients, the routing table, the constructor
argument derivation and the `handlerUrl` code, whatever the caller uses. A wrapper that bundles
the library freezes that form for its own users. The public API had no way to pass only the
clients a caller uses: `DEFAULT_DEPENDENCIES` and `runVerify()` are internal.

## Decision

### Entries

- `explorer-verify/core` exports `verify`, `dryRun`, `checkStatus`, `verifyEach` and `linkProxy`,
  one for each flow function of `explorer-verify`; a test checks the two lists match. Each takes
  the options of the same function in `explorer-verify`, plus `clients`, required, and `table`,
  optional. It runs the same engine and gives the same result for the same explorer answers; a
  test replays recorded answers through both entries and compares results, errors and requests.
- `explorer-verify/clients/<name>` for `sourcify`, `etherscan-v2`, `etherscan-compatible`,
  `routescan` and `blockscout` export client factories, in the style of viem's `http()`:
  `sourcify()`, `etherscanV2()`, `etherscanCompatible()`, `routescan()`, `blockscout()` and
  `blockscoutHosted()` for the four verification functions, and `sourcifyProxyLink()`,
  `etherscanV2ProxyLink()`, `etherscanCompatibleProxyLink()` and `blockscoutProxyLink()` for
  `linkProxy`. A factory leaves room for options per client later without a breaking change.
  Routescan has no proxy-link client, as it has no proxy-link code.
- `clients` is typed as `ClientList<C>`, a non-empty tuple, `readonly [C, ...C[]]`, which the core
  exports for a list built in code, so `clients: []` fails to
  compile.
- `explorer-verify/table` exports `routingTable`, which imports the rows statically.
- `explorer-verify` keeps its lazy loaders and its behaviour. It refuses `clients` and `table` as
  unknown keys (decision 0047), with a hint that names `explorer-verify/core`.

### No dynamic `import()` behind the core

- The engine modules (`flow/verify.ts`, `flow/status.ts`, `flow/dry-run.ts`, `flow/verify-each.ts`,
  `flow/link-proxy.ts`, `routing/resolve.ts`) hold no dynamic `import()` and no fallback loader.
- The default entry's loaders and its five public functions move to `flow/defaults.ts`;
  `loadRoutingTable`, `routingTableDate` and `routesFor` move to `routing/load-table.ts`. These two
  are the only modules with a dynamic `import()`, and no module of the core, the clients or the
  table imports them. A unit test walks the imports from those entries and fails on any
  `import(` it reaches.
- `DEFAULT_DEPENDENCIES` holds no derivation loader. `verify()` and `verifyEach()` use
  `VERIFY_DEPENDENCIES`, which adds it, so a one-file `checkStatus()` or `dryRun()` does not inline
  the derivation code it never runs.
- Each top-level call that builds a backend client, a proxy linker or the table object carries a
  `/* @__PURE__ */` annotation, so a bundler drops what the caller does not import. The client
  factories are function declarations, which bundlers drop when unused. A test fails on any
  top-level call in the client modules and the table module without the annotation.

### What a client holds

- A client is a new frozen object with `kind` and `backend` (or `backends`). What it holds is kept
  in a `WeakMap` inside the package, by object: the backend's code, and, for a client that sends
  constructor arguments, the derivation; `etherscanV2()` and `etherscanV2ProxyLink()` also hold the
  `handlerUrl` code, which serves only Etherscan v2 requests. A caller who passes only `sourcify()`
  bundles neither.
- An object built by hand holds nothing and throws `invalid-input` naming its entry. A frozen
  object of a client's shape is named as a client of another copy of the package, with the fix:
  install explorer-verify once, as a peer dependency of the wrapper. A client of the other kind is
  named as such. The guide tells a wrapper to build its clients itself rather than take them from
  its callers.
- A frozen `routingTable` of another copy is named the same way.
- The default and core entries both say "must be a plain object" for options that are not one;
  the core's hint for `linkProxy` names a proxy-link client.
- The `WeakMap` stays for 0.x. When R-EXT-2 designs third-party clients, a `Symbol.for` brand
  with an ABI number, as `ExplorerVerifyError` carries one (decision 0044), is the planned path:
  it lets a client of one copy work with another copy of the same ABI.
- The routing table chooses only among the backends of `clients`, as the engine already preferred
  backends with a client.

### Without a table

- A route with `route.apiUrl` reads no row, even where `readsTable()` says the default entry would:
  it goes where the caller says, and gets no explorer page from a row.
- A route that names a backend with one public host for every chain, `sourcify`, `etherscan-v2`
  or `blockscout-hosted`, goes to that host with no `apiUrl`. The host is the library's
  configuration, as `blockscout-hosted` already was (decision 0041), not the caller's. Sourcify's
  page needs no row; Etherscan's page host comes from a row, so such a result has no page.
- `checkStatus()` without a table and without `route` takes the handle's backend as
  `route.backend` when that backend has one public host, as a caller who set it would.
- Every other route throws `invalid-input` naming `table`. Routescan's API path names the chain's
  network, and Blockscout's and a standalone explorer's hosts vary per chain, so they need the
  table or `route.apiUrl`.
- A standalone Etherscan-compatible row says whether its explorer needs a key. Without the table,
  that early `missing-api-key` check does not apply, and the explorer refuses a keyless request
  itself. The core's `table` doc says so.
- So a call through the core reaches only hosts from the passed table, the library's fixed hosts
  or the caller's route (R-SEC-2). In `verifyEach()` with a list, an entry that needs the table
  makes the call throw, instead of giving that entry an outcome.

### What the core reads, and its errors

- The core takes the property descriptors of the options and hands the engine a copy without
  `clients` and `table`, so no getter of another key runs before the engine lists the keys
  (decision 0047). It checks unknown keys itself, so they are named in the same error as its own
  issues. It reads `clients` by index, so a hole in a sparse array is an entry that is not a client.
- Each error comes before any request. The engine takes them through a `missing` dependency whose
  text sits in `core/options.ts`, so the default entry does not bundle it:

  | What the call left out                                                        | Error                                                                 |
  | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
  | `clients`, an empty list, or an entry not from the package                    | `invalid-input` naming `clients` or `clients[i]`, with unknown keys   |
  | A `table` that is not `routingTable`                                          | `invalid-input` naming `table`                                        |
  | A client for `route.backend`                                                  | `invalid-input` on `route.backend`; the hint names the factory to add |
  | A client for any backend the chain's row lists                                | `unsupported-chain`, naming every backend the row lists               |
  | A client for the backend a handle names, in `checkStatus`                     | `invalid-input` naming `clients`, before the route resolves           |
  | `table`, for a route that needs it                                            | `invalid-input` naming `table`                                        |
  | `etherscanV2()`, or `etherscanV2ProxyLink()` in `linkProxy`, for `handlerUrl` | `invalid-input` naming `handlerUrl`                                   |
  | The proxy-link client of the route's backend                                  | `invalid-input` naming `clients`                                      |

### Measuring

- `size-budget.json` gains six entries, each one file with the named clients and no table:
  `verify` with Sourcify (ceiling 26,224) and with Etherscan v2 (31,083), and `linkProxy` with each
  proxy-link client: Sourcify (23,219), Etherscan v2 (24,364), Etherscan-compatible (22,562) and
  Blockscout (24,629). Each ceiling is the measured size plus 20%, by decision 0014's rule.
- `checkStatus` measures 14,171 bytes, above its ceiling of 14,076: the default entry's hint for
  `clients` and `table`, the fixed hosts and the `missing` dependency are in its path. Its ceiling
  is reset by decision 0014's rule, to 17,006.
- `name-budget.json` gains a row for each of the 16 new names, by decision 0042's rule.
- The browser smoke test loads a fourth page that verifies through the core with the Sourcify
  client. In Chromium it must load no chunk at all.

### The R-RUN-3 criterion

The issue set "below 62 KB minified" for `verify` from the core with the Sourcify client and no
table, from an estimate at commit 68867bc, when `verify` as one file was 101,719 bytes. Main has
grown by 9,985 bytes since, in code the core shares: strict options (decision 0047), `handlerUrl`
(decision 0046) and its refusals (decision 0048). The error class keeps its hint catalogue on
purpose: `error.hint` is part of agent readiness (R-AX), and it stays filled through both entries.
The criterion is therefore amended to the measured size plus decision 0014's margin: 65,572 bytes
minified and 21,853 gzipped, so at most 78,687 minified and 26,224 gzipped, the gzipped bound
checked in CI.

The modules of that bundle, minified bytes, as esbuild's metafile gives them:

| Module                   | Bytes  | Module                    | Bytes  |
| ------------------------ | ------ | ------------------------- | ------ |
| `flow/verify.js`         | 12,215 | `core/options.js`         | 3,304  |
| `http/fetch.js`          | 8,237  | `http/api-keys.js`        | 2,975  |
| `input/validate.js`      | 7,618  | `backends/common.js`      | 2,086  |
| `routing/resolve.js`     | 6,924  | `observe.js`              | 1,571  |
| `errors.js`              | 6,305  | `flow/format-handle.js`   | 476    |
| `backends/sourcify.js`   | 4,737  | `internal/known-keys.js`  | 460    |
| `redact.js`              | 3,589  | `internal/read-fields.js` | 352    |
| `error-hints.js`         | 3,574  | `core/parts.js`           | 349    |
| six more, each under 300 | 763    | Total, with 37 of esbuild | 65,572 |

### Sizes

esbuild 0.28.2, minified, gzip from the zlib of Node.js 24.21.0, 2026-11-06. "main" is f7c12bf;
"#220" is that commit with this change. One file, as esbuild without splitting ships it:

| Bundle                                               | main minified | main gzipped | #220 minified | #220 gzipped |
| ---------------------------------------------------- | ------------- | ------------ | ------------- | ------------ |
| `verify` from `explorer-verify`                      | 111,704       | 32,551       | 112,520       | 32,666       |
| `checkStatus` from `explorer-verify`                 | 100,837       | 28,870       | 101,533       | 29,038       |
| `dryRun` from `explorer-verify`                      | 102,957       | 29,759       | 103,653       | 29,917       |
| `verifyEach` from `explorer-verify`                  | 117,365       | 34,187       | 118,310       | 34,366       |
| `linkProxy` from `explorer-verify`                   | 103,545       | 29,381       | 100,396       | 28,596       |
| `verify` from the core, `sourcify()`, no table       | none          | none         | 65,572        | 21,853       |
| `verify` from the core, `sourcify()`, `routingTable` | none          | none         | 91,533        | 25,033       |
| `verify` from the core, `etherscanV2()`, no table    | none          | none         | 77,968        | 25,902       |
| `verify` from the core, `blockscout()`, no table     | none          | none         | 71,364        | 23,845       |
| `verify` from the core, every client, `routingTable` | none          | none         | 114,307       | 31,763       |
| `dryRun` from the core, `sourcify()`, no table       | none          | none         | 61,132        | 20,634       |
| `linkProxy` from the core, `sourcifyProxyLink()`     | none          | none         | 58,220        | 19,349       |

A caller who verifies on Sourcify ships 46,132 bytes less minified (42%), 10,698 less gzipped
(33%), than with `verify` from `explorer-verify` as one file. `linkProxy` from the default entry
shrinks by 3,149 bytes: the `/* @__PURE__ */` annotations let the bundler drop the Etherscan and
Blockscout clients that the modules the proxy-link code imports define, and `linkProxy` never
calls.

The model of `pnpm run size`, gzipped, for the default entry:

| Entry               | main   | #220   | Change |
| ------------------- | ------ | ------ | ------ |
| `verify`            | 16,158 | 16,310 | +152   |
| `verify (one file)` | 28,594 | 28,775 | +181   |
| `checkStatus`       | 14,011 | 14,171 | +160   |
| `verifyEach`        | 17,808 | 18,012 | +204   |
| `linkProxy`         | 12,990 | 13,176 | +186   |
| `index`             | 29,331 | 29,767 | +436   |

The default entry grows by the engine's checks for a part the caller left out, the fixed hosts
without a table, the hint for `clients` and `table`, and the second dependency object
`VERIFY_DEPENDENCIES`; `index` also by the `routesFor` wrapper.

## Alternatives considered

- Let the default entry take `clients`. Rejected: its modules would still hold the dynamic
  `import()`s, which a one-file bundler inlines whatever the call passes.
- Export each backend's internal client object as the public client. Rejected: the `Backend`
  interface would become public API before the extension point of R-EXT-2 is designed, and an
  object that only looks like a client would reach the engine.
- Client objects instead of factories. Rejected: a factory takes options later without a break.
- Move the hint catalogue out of the error class to meet 62 KB. Rejected: hints are part of agent
  readiness, and an error without its hint would differ between the two entries.
- Import the derivation and the `handlerUrl` code in the core itself. Rejected: every caller would
  ship about 8,500 bytes minified it may never run; Sourcify sends no constructor arguments, and
  `handlerUrl` serves only Etherscan v2.
- Require `table` for every route the default entry would read it for. Rejected: a caller of
  Sourcify or Etherscan would ship 25,858 bytes of rows to reach a host the library knows.
- `clients` as a record by backend name. Rejected: a list reads as what the caller imports, and a
  proxy-link client serves two backends.

## Consequences

- Seven new subpath exports are public API before 0.1.0. R-EXT-2, third-party clients, stays open.
- A new backend adds a client module under `src/clients/`, a subpath export, a loader in
  `flow/defaults.ts` and its name rows.
- The engine's tests that relied on the old fallbacks get them from `test/helpers/defaults.ts`.
- `core/options.ts`, `core/parts.ts`, `flow/defaults.ts`, `routing/load-table.ts` and the client
  modules join the mutated files.
