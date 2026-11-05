# 0042: Every exported name is measured in real bundlers

Status: Accepted (2026-11-05). Extends the ceilings of
[decision 0014](0014-measured-bundle-ceilings.md) to every exported name. The model and the
ceilings of `size-budget.json` ([decision 0031](0031-clients-load-on-demand-and-chunks-measured-apart.md))
stay as they are.

Research: none (maintainer choice).

## Context

`size-budget.json` lists nine entries. It measures them with a model, `bundleApart` in
`scripts/bundle.ts`, that charges code the entry shares with a client chunk to the chunk. esbuild and
Rollup put that shared code in the initial load. On main at commit d82957d, measured with
`pnpm run size` (esbuild 0.28.2, Rollup 4.67.4, Node.js 24.21.0 zlib) on 2026-11-05, gzipped
initial load in bytes:

| Name                      | Model  | esbuild, splitting | esbuild, one file | Rollup |
| ------------------------- | ------ | ------------------ | ----------------- | ------ |
| `verify`                  | 14,862 | 20,047             | 29,003            | 18,225 |
| `checkStatus`             | 12,688 | 18,089             | 25,311            | 15,867 |
| `verifyEach`              | 16,480 | 21,699             | 30,629            | 19,817 |
| `linkProxy`               | 11,760 | 16,790             | 25,902            | 14,870 |
| `dryRun`                  | 13,437 | 18,632             | 26,204            | 16,708 |
| `formatHandle` (no entry) | n/a    | 4,778 (20 files)   | 205               | 127    |

Thirteen of the main entry's 18 value exports had no entry, among them `formatHandle`, `parseHandle`,
`ExplorerVerifyError`, `ERROR_CODES`, `dryRun` and `validateInput`. Under esbuild with splitting,
`formatHandle` loads 12,705 bytes minified and the build emits 20 files, because the main entry
reaches the dynamic `import()` of each client. No check measured it.

## Decision

- `pnpm run size` also runs `scripts/check-names.ts` against `name-budget.json`. The script lists
  the value exports of every code entry in each package's `exports` from the built package, so a
  new export is measured without editing a list.
- Each name is built three ways: esbuild with splitting, esbuild as one file, and Rollup with each
  chunk minified by esbuild, as Vite builds for production. Each build records the initial load,
  the entry file and the files it imports statically, minified and each gzipped on its own, and
  the number of files emitted.
- Each row holds the measured sizes and a ceiling per build, the gzipped size plus 20%, rounded up,
  as decision 0014 sets. An exported name with no row fails. A row for a name that is no longer
  exported fails.
- Light names: every name from `explorer-verify/handle`, `explorer-verify/errors` and
  `explorer-verify/backends` emits one file under esbuild splitting, and `formatHandle`,
  `ERROR_CODES` and `BACKEND_NAMES` stay under 1,024 bytes minified in every build. Those subpaths
  come with [#219](https://github.com/aelmanaa/explorer-verify/issues/219). Until a subpath is in
  `exports`, its rule prints a pending line and does not fail, and the report prints today's esbuild
  split size of the three names from the main entry.
- The report prints the model of `size-budget.json` beside the three builds for `verify`,
  `checkStatus`, `verifyEach`, `linkProxy` and `dryRun`. Those lines never fail.
- Rollup 4.67.4 becomes a root development dependency. VitePress already installs it through Vite,
  so the lockfile gains no package. The check resolves the package's own specifiers through its
  `exports`, loads JSON as a default export and treats a package with `"sideEffects": false` as
  free of side effects, as Vite does, without Vite's plugins.
- A package that runs only on Node, such as `@explorer-verify/hardhat`, is built with
  `platform: "node"`, and its dependencies and peer dependencies stay external: the row measures
  its own code.

## Alternatives considered

- Fail the light rule on the main entry today. Rejected: `formatHandle` from `explorer-verify`
  cannot meet it until #219 adds the subpaths, and a check that fails on main blocks every pull
  request. The rule binds when each subpath appears.
- Run Vite itself. Rejected: Vite is not a direct dependency, and a Vite build per name adds its
  plugin pipeline for no change in what Rollup and esbuild emit. Rollup with esbuild minification
  measured `verify` at 18,225 bytes gzipped, within 3% of the 18,744 that Vite 5.4.21 gave on
  commit 68867bc on 2026-11-05.
- Replace `size-budget.json`. Rejected for now: its chunk ceilings measure what loading one client
  adds, which no row of `name-budget.json` shows.

## Consequences

- A pull request that adds an export adds its row with
  `node scripts/check-names.ts name-budget.json --add-missing`, which never changes a row that
  exists.
- The check bundles 27 names three times. `pnpm run size`, build included, took 10 seconds on a
  development machine, and 31 seconds when that machine was under heavy load.
- One-file `verify` through a core entry with one client, which
  [#220](https://github.com/aelmanaa/explorer-verify/issues/220) proposes, is not checked yet. It
  becomes a row once that entry exists.
