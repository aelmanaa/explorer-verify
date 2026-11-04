# 0031: Clients load on demand, and each client chunk has its own ceiling

Status: Accepted (2026-11-04). Amends how [decision 0014](0014-measured-bundle-ceilings.md)
measures an entry, and resets the `verify`, `verify with table`, `checkStatus` and `index`
ceilings of [decision 0030](0030-raise-ceilings-for-the-blockscout-client.md) and
[decision 0024](0024-compact-routing-table.md).

Research: [clients loaded with `import()`](../research/2026-11-04-lazy-client-chunks.md).

## Context

`verify()`, `checkStatus()` and `dryRun()` imported all four clients: Sourcify, Etherscan v2,
Routescan and Blockscout. Every client grew every entry, and a page that only verifies on Sourcify
still downloaded the other three. Decision 0030 raised three ceilings for the Blockscout client as a
stopgap until issue [#136](https://github.com/aelmanaa/explorer-verify/issues/136).

## Decision

### Loading

- `DEFAULT_DEPENDENCIES` holds a loader per backend, a function that runs a dynamic `import()` with
  a literal path, such as `import("../backends/sourcify.ts")`. The flow engine resolves the route,
  starts the time budget, then loads only that route's client, then runs as before. A test can
  still pass a client object in place of a loader.
- The load counts against `timeoutMs`: a load that does not end in time throws `timeout`. An abort
  of the caller's signal during the load rejects with `signal.reason` (R-FLOW-6).
- The load's deadline runs on `AbortSignal.timeout`, not `setTimeout`. A test or an app that fakes
  `setTimeout` and `Date` and runs every timer at once would otherwise end a load that is about to
  settle. In CI on Node 24.0.0, a test that ran every fake timer at once hit the deadline before
  the first dynamic import settled. Node's MockTimers does not drive `AbortSignal.timeout`.
- Its timer does not keep a Node process alive. No `setTimeout` runs beside it, not even one that
  only keeps the process alive: with fake timers, running it would move the fake clock to the
  deadline and spend the budget of every request after the load. A real dynamic import holds its
  own handles while it loads. The load itself is awaited directly: no step waits on a timer or a
  macrotask once the import has settled.
- A first dynamic import takes real event-loop turns: 17 on Node 24.0.0 and 1 on 22.18.0, 24.21.0
  and 26.0.0, measured locally on 2026-11-04 for the Sourcify client. A test that runs fake timers
  for a fixed number of turns must allow for them; two such loops were raised to 3,000 turns.
- Each loaded client is kept, by loader, for the life of the page or process. A later call takes
  it at once, with no wait and no timer. A load that failed is not kept, so the next call tries
  again.
- A loader that fails, such as a chunk the page cannot fetch, rejects the call with the loader's
  error, unchanged, before any request to an explorer.
- Nothing in the public API changes. The core stays runtime-neutral: a dynamic `import()` of a
  relative path is standard ECMAScript.
- Bundlers that split code put each client in its own chunk: Rollup, Vite and webpack do it by
  default; esbuild does it with `splitting` and ESM output. esbuild without splitting, and
  Wrangler by default, keep every client in the one file.

### Measuring

- `pnpm run size` measures each entry with its dynamic imports left out: the entry is one file in
  which each `import()` stays an import.
- Each module an entry loads with `import()` is measured on its own: that module and its imports,
  without the modules the entry already holds. It is what loading it adds to a page. `size-budget.json`
  lists these under `chunks`, one per client, with a ceiling set by decision 0014's rule. A client
  that several entries load counts at its largest size.
- An entry that loads a module with no `chunks` ceiling fails the check, so a new client cannot
  ship unmeasured. A ceiling for a chunk that no entry loads fails too. An entry that imports a
  client statically as well as with `import()` fails, because no chunk is split off.
- One more entry, `verify (one file)`, measures `verify` as one file with every client inlined, as
  esbuild without splitting and Wrangler ship it. Its ceiling bounds that form.
- A page that verifies on one backend ships an entry plus that backend's chunk. `verify with table`
  plus the largest chunk bounds it.
- The browser smoke test bundles with esbuild splitting on. In Chromium, a run routed to Sourcify
  must load the Sourcify chunk and no other client's chunk.

### Ceilings

The measured size plus 20%, rounded up, by decision 0014's rule. Measured with esbuild 0.28.2 and
Node 24.21.0 zlib on 2026-11-04. "Before" is main at commit ff83bab, measured as one file with
every client; "After" is main at ff437c9 with #136, measured without the clients. Main moved from
ff83bab to ff437c9 with a docs change that does not change these sizes.

| Entry               | Before (ff83bab) | After  | Old ceiling | New ceiling |
| ------------------- | ---------------- | ------ | ----------- | ----------- |
| `verify`            | 20,567           | 13,611 | 24,681      | 16,334      |
| `verify (one file)` | 20,567           | 21,663 | none        | 25,996      |
| `verify with table` | 21,718           | 14,693 | 26,062      | 17,632      |
| `checkStatus`       | 18,592           | 11,730 | 22,311      | 14,076      |
| `index`             | 28,803           | 21,776 | 28,979      | 26,132      |

| Chunk        | Measured | Ceiling |
| ------------ | -------- | ------- |
| `sourcify`   | 2,885    | 3,462   |
| `etherscan`  | 3,277    | 3,933   |
| `routescan`  | 3,360    | 4,032   |
| `blockscout` | 2,933    | 3,520   |

The `routescan` chunk includes the Etherscan v2 request code it imports. `buildVerifyInput`
(11,870), `createVerifyHandler` (12,395), `resolveInputFromBytecode` (21,124) and the
`routing table` (933) do not load a client and keep their ceilings.

### What real bundlers ship

The measured form is a model. The research note has the builds; for `verify`, empty routing
table, gzip per file:

| Build                                 | Entry             | Plus the Sourcify client | Page on Sourcify |
| ------------------------------------- | ----------------- | ------------------------ | ---------------- |
| Measured form                         | 13,611            | 2,885                    | 16,496           |
| Vite 5.4.21 (Rollup 4.67.4)           | 17,056            | 3,635                    | 20,691           |
| Vite, clients imported statically     | 21,106 (one file) | none                     | 21,106           |
| esbuild with splitting                | 18,046 (3 files)  | 3,610                    | 21,656           |
| esbuild without splitting             | 21,663 (one file) | none                     | 21,663           |
| esbuild, one file, before this change | 20,567            | none                     | 20,567           |

With Vite, a page that verifies on Sourcify ships about 400 bytes less than with the clients
imported statically, and its entry is 4 KB smaller until the first call. With esbuild, the page
ships about 1 KB more than before, split or not. The real benefit is that a new client no longer
grows any entry: it adds a chunk that only its own calls load.

## Alternatives considered

- Measure esbuild's split output as it is. Rejected: esbuild moves code that the entry and the
  clients share into hashed shared chunks, so an entry spans three files whose split depends on
  esbuild's rules. Rollup keeps the entry's modules in one chunk. The measured form is closer to
  that, and stays the same when shared code moves between files.
- Keep one bundle per entry. Rejected: each new client would grow every entry, which is what #136
  asks to stop.
- One subpath export per client, such as `explorer-verify/sourcify`. Rejected: it changes the
  public API, and callers would have to know which backend a chain routes to.
- Bundler comments such as `webpackChunkName`. Rejected: they are specific to one bundler and are
  not needed for the split.

## Consequences

- esbuild users who do not turn on `splitting` get one file 1,096 bytes larger than before for
  `verify`: esbuild wraps each lazily loaded module to start it on first use, and the load is
  bounded by the signal and the budget. `verify (one file)` bounds that form.
- A new client adds a `chunks` line and its own ceiling, and leaves the entries as they are.
- R-RUN-3 now names the chunks.
