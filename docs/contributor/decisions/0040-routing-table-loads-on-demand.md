# 0040: The routing table loads on demand, and its chunk has its own ceiling

Status: Accepted (2026-11-05). Amends how [decision 0023](0023-routing-table-size-measured-apart.md)
measures the table, removes the `routing table` and `verify with table` entries of decisions
[0024](0024-compact-routing-table.md) and [0038](0038-blockscout-rows.md), and applies the loading
rules of [decision 0031](0031-clients-load-on-demand-and-chunks-measured-apart.md) to the table.
Composes with the standalone entries of [decision 0039](0039-standalone-hosts-in-the-routing-table.md).

Research: [clients loaded with `import()`](../research/2026-11-04-lazy-client-chunks.md). The sizes
below were measured with `pnpm run size` (esbuild 0.28.2, Node.js 24.21.0 zlib) on 2026-11-05.

## Context

`routing/resolve.ts` imported `routing/table.json` statically, so every bundle that resolves a
route shipped the rows. With the Sourcify, Routescan and Blockscout rows (decisions 0036 to 0038),
`verify with table` measured 18,425 bytes on main at commit 0ee4ea4, of which the rows were about
3,800. A caller who always passes `route.apiUrl`, such as a page that sends its requests to a
proxy on its own server, downloaded rows it never read. Decision 0024 named the next step: load the table
apart. Decision 0038 deferred it to
[#192](https://github.com/aelmanaa/explorer-verify/issues/192).

## Decision

### Loading

- The rows move to `routing/table.ts`, which nothing in the package imports statically.
  `loadRoutingTable()` in `routing/resolve.ts` loads it with a dynamic `import()` of a literal
  path. A bundler that splits code puts the rows in a chunk of their own.
- `resolveRoute()` splits in two steps. `checkRoute()` checks the chain id and the route override
  and reads no table. `routeFrom()` builds the route from the checked override and a loaded table.
  The flow engine checks the override, starts the time budget, loads the table only when the route
  needs it, then resolves the route and loads the client.
- The table loads through `bounded()`, as a client does: the load counts against `timeoutMs`, an
  abort rejects with `signal.reason`, a load that does not end in time throws `timeout`, and a
  loaded table is kept by loader for the life of the page or process. A load that failed is not
  kept. The `timeout` names `route.backend`, or `sourcify` when no backend is named, as
  `unsupported-chain` does for a chain without a row.
- A table that fails to load rejects `verify()`, `dryRun()`, `checkStatus()` and `linkProxy()`
  with the loader's error, unchanged, as a client does. In `verifyEach()` with a list of entries,
  each entry that needs the table gets an outcome, as for a client: `network` with the load's
  error as its cause, or `timeout` naming that entry's backend; the other entries run. With
  `backends: "all"`, the call reads the row before it has any entry, so it throws the loader's
  error.
- `FlowDependencies.table` and `LinkDependencies.table` take a table or a loader. The tests pass
  tables.

### Which calls load the table

`readsTable()` in `routing/resolve.ts` decides, from the checked override:

| Route                                                                                   | Loads the table |
| --------------------------------------------------------------------------------------- | --------------- |
| No `route.apiUrl`, `route.backend` or not                                               | Yes             |
| `etherscan-v2` with `apiUrl` `https://api.etherscan.io/v2/api`                          | Yes             |
| `blockscout` with an `https` `apiUrl` whose path is `/api`                              | Yes             |
| `etherscan-compatible` with an `https` `apiUrl`                                         | Yes             |
| Any other `route.apiUrl`: Sourcify, Routescan, a proxy for Etherscan v2, a local server | No              |

A route with `route.apiUrl` reads the table only for what the row says about its own API URL: the
result carries the row's page when `apiUrl` is the row's own API URL for the backend (R-FLOW-3,
#122), and a standalone entry with `needsKey` keeps the route's `needsKey`, so a call without
`route.apiKey` still throws `missing-api-key` before any request (decision 0039). The backends whose
row decides this are Etherscan v2, whose page host the row names; Blockscout, whose instance the
row names; and `etherscan-compatible`, whose API host and path, page and `needsKey` a schema 3 row
names. A Sourcify page needs no row, a Routescan entry has no page, and no row lists an `http`
URL. So every other route with `route.apiUrl` gives the same result with or without the table, and
does not load it.

The other paths of decision 0039 have no `route.apiUrl`, so they load the table as any such route
does, and need it: a `route.apiKey` for `etherscan-compatible` without `apiUrl` binds to the row's
standalone host, or throws `invalid-input` when the row's explorer takes no key; the choice of a
backend skips a standalone entry with `needsKey` when no key is set; `verifyEach()` with
`backends: "all"` leaves such an entry out; and `linkProxy()` refuses a standalone entry the table
chose. The `invalid-input` for a refused `route.apiKey` now comes after the table loads; in
`verifyEach()` it is still thrown, with the fields named after the entry. A unit test checks this for
every entry of the shipped table, so a backend whose page comes from a row cannot be added without
`readsTable()` saying so.

`checkStatus()` resolves its route from its options, as `verify()` does: a handle never names a
host, so a handle with `route.apiUrl` in the options loads the table on the same terms.

For a route with `route.apiUrl`, `tableHost` no longer comes from the row. A key from `apiKeys`
never goes to such a route, so `tableHost` only names, in the `missing-api-key` message, where a
key from `apiKeys` would go. It is now the backend's one API host, `sourcify.dev`,
`api.etherscan.io` or `api.routescan.io`, also on a chain the table does not list, and `undefined`
for Blockscout and `etherscan-compatible`, which take no key from `apiKeys`. Before, a route at a
standalone row's own API had that host as `tableHost`; only the hint text changes.

### `routingTableDate()`

`routingTableDate()` loads the table, so it returns `Promise<string>`. Keeping it synchronous
would need a static import of the rows from the package index. The index would then import the
table both statically and with `import()`, and no bundler would split it off. The CLI awaits it
for `--version --json`. The package has not been published, so no released caller breaks.

### Measuring

- The `table` chunk is measured as the clients are: `routing/table.ts` and the rows, at its
  largest size over the entries, with its own ceiling under `chunks`.
- `verify`, `checkStatus`, `verifyEach`, `linkProxy` and `index` drop `withoutTable`: the rows are
  no longer in any entry, so the flag only emptied the chunk. `verify (one file)` keeps it: it
  inlines every dynamic import, the table included, and measures the code.
- The `routing table` and `verify with table` entries are removed. The `table` chunk measures the
  rows, and `verify` plus the `table` chunk bounds a page that verifies without a route.
- The browser smoke test loads a third page that verifies without a route. In Chromium it must
  load the `table` chunk and the Sourcify chunk; the runs with `route.apiUrl` must load neither the
  `table` chunk nor any other client's.

### Sizes

"Before" is main at commit 0ee4ea4, with the schema 3 table of decision 0039; "After" is that commit with this change. Bytes, minified and
gzipped. Before, the code entries were measured with an empty table, and a real bundle of each
added the rows.

| Entry or chunk        | Before | After  | Ceiling before | Ceiling after |
| --------------------- | ------ | ------ | -------------- | ------------- |
| `verify`              | 14,603 | 14,861 | 16,334         | 16,334        |
| `verify with table`   | 18,425 | none   | 21,850         | none          |
| `verify (one file)`   | 24,723 | 25,054 | 25,996         | 25,996        |
| `checkStatus`         | 12,407 | 12,688 | 14,076         | 14,076        |
| `verifyEach`          | 15,946 | 16,480 | 18,316         | 18,316        |
| `linkProxy`           | 11,507 | 11,760 | 13,512         | 13,512        |
| `index`               | 26,460 | 27,073 | 31,510         | 31,510        |
| `routing table`       | 3,013  | none   | 3,566          | none          |
| chunk `table`         | none   | 3,042  | none           | 3,651         |
| `createVerifyHandler` | 13,038 | 13,037 | 14,429         | 14,429        |

The loading code adds 258 bytes to `verify` and 534 to `verifyEach`. A page that verifies with
`route.apiUrl` on Sourcify ships `verify` plus the Sourcify chunk, 17,728 bytes, against 21,292
before. A page that verifies without a route also loads the `table` chunk, 20,770 bytes, against
21,292 before.

The `table` chunk's ceiling is its measured size plus 20%, rounded up, by decision 0014's rule.
The code ceilings stay: each entry is still under the ceiling it had, and none dropped below the
size its ceiling was set from. The page budget for `verify` with the table falls from 21,850 to
19,985 bytes, the `verify` ceiling plus the `table` ceiling.

## Alternatives considered

- A second entry point without the table, such as `explorer-verify/lite`. Rejected: callers would
  have to choose an import by how they route, and two entries would share most of their code. The
  dynamic import gives the same saving to every caller who passes a route.
- Load the table for every route with `route.apiUrl`, or for none. Rejected: for every route, a
  call to a proxy or a local server would still download the rows; for none, a route to the row's
  own Etherscan or Blockscout URL would lose its explorer page, which the tests of #122 rely on.
- A separate subpath export, such as `explorer-verify/routing-table`, that imports the rows
  statically and keeps a synchronous `routingTableDate()`. Rejected: it is one more public entry
  to maintain, document and measure, and nothing is published yet, so making
  `routingTableDate()` async breaks no released caller.
- Keep `routingTableDate()` synchronous through a second, generated module that holds only the
  date. Rejected: the date would have two sources, and the package is not published yet.
- Load the table at module start, before any call. Rejected: a page that never verifies without a
  route would still download it.

## Consequences

- A call with a route that `readsTable()` rejects loads no table code, in a browser, on a backend
  and in the server handler. The handler never resolves a route and never loaded the table.
- A new backend whose explorer page comes from a row adds its case to `readsTable()`; the unit
  test over the shipped table fails until it does.
- `routingTableDate()` returns a promise.
- R-RUN-3 names the `table` chunk.
