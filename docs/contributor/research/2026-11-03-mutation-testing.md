# 2026-11-03: Mutation testing tool

Audience: contributors who change the mutation testing setup. Sources read and commands run on
2026-11-03, and one more full run on 2026-11-04. Commands ran on macOS (8 logical cores) with Node 24.21.0, npm 11.19.0, pnpm 12.16.1
and gh 2.92.0. Each claim names its source; links are listed under [Sources](#sources). Lines
marked "Inference" are conclusions drawn from the sources, not facts stated by them.

Question: which tool can mutate the TypeScript in `packages/explorer-verify/src` and judge each
mutant with the existing `node --test` unit tests, run as TypeScript with no build step, fast enough
for a weekly CI job and an incremental pull request job?

## Answer summary

- StrykerJS is the mutation testing tool for JavaScript and TypeScript. An npm search for "mutation
  testing" on 2026-11-03 returned Stryker's own packages, a Bun runner plugin for Stryker and a
  tool for Salesforce Apex; no other tool for Node.
- Stryker has no runner built for `node:test`. Its tap runner runs any test file that prints TAP,
  and its docs name the Node test runner as one. A dedicated `node:test` runner is proposed in
  stryker-js #6020, open on 2026-11-03.
- With the tap runner, Node's type stripping runs the instrumented `.ts` copies directly. No build
  step and no TypeScript loader were needed.
- Incremental mode works with the tap runner, at the granularity of a test file.
- A full run of seven source files (2,175 mutants) took 69 to 77 minutes on the machine above. An
  incremental run took 1 minute 24 seconds with no change, and 11 minutes after a change to one
  test file. Scores moved by up to 1.8 points between two full runs, because mutants moved between
  timeout and survived. A third run, with longer timeouts and nine files (2,891 mutants), took 8.5
  hours on the same machine under heavy load from other jobs. The fifth, which set the floors,
  took 3 hours 43 minutes with 4 processes (3,112 mutants, ten files).
- Choice: `@stryker-mutator/core` and `@stryker-mutator/tap-runner` 10.0.0, Apache-2.0.

## 1. Candidates

| Candidate                   | `node --test`                                       | TypeScript without a build                    | Coverage analysis                       | Incremental                                      |
| --------------------------- | --------------------------------------------------- | --------------------------------------------- | --------------------------------------- | ------------------------------------------------ |
| Stryker, tap runner         | Yes: runs each test file with `--test-reporter=tap` | Yes, measured below                           | Per test file                           | Yes; a changed test file counts as all its tests |
| Stryker, command runner     | Yes: runs any command, judged by its exit code      | Yes: the command is `node --test`             | None: every mutant runs the whole suite | Mutants only; test changes are not detected      |
| Stryker, `node:test` runner | Proposed in #6020, not released                     | Reported working with type stripping in #6020 | Per test                                | Not released                                     |

- The tap runner "enables running any test files that produce TAP output", including "the
  build-in node test runner" (tap runner docs). Its default `nodeArgs` since 9.0 are
  `--test-reporter=tap -r {{hookFile}} {{testFile}}`. Each test file runs in its own process, and
  "coverage is measured per test file" (tap runner docs).
- The command runner "runs a configurable bash/cmd command and bases the result on the exit code";
  with it "Stryker cannot do any optimizations and just runs all tests for all mutants"
  (configuration docs).
- stryker-js #5421 (opened 2025-07-04) asks for a native `node:test` runner. stryker-js #6020
  (opened 2026-06-03) proposes one. In #6020, one tester compared it with the tap runner on a
  TypeScript project that runs `node:test` with type stripping. A maintainer's comment of
  2026-07-04 says the tap runner "was the recommended way of running Stryker with the
  node-runner". Both were open on 2026-11-03.
- Inference: the tap runner is the supported path today. If #6020 ships, per-test coverage could
  shorten runs; the switch is a config change.

## 2. TypeScript without a build

- Stryker's tap runner docs say it does not compile TypeScript, and suggest a loader or a build.
  This repository needs neither: Node 22.18 and later strip types by default, and the code uses
  only erasable syntax (`erasableSyntaxOnly` in `tsconfig.base.json`).
- Measured: Stryker 10.0.0 instrumented the seven files, and `node --test-reporter=tap` ran the
  instrumented copies on Node 24.21.0. The dry run passed with 35 test files.
- Two adjustments were needed, both measured on the same run:
  - Tests read files outside the package by relative path: `../../../../docs/` and, since
    2026-11-04, `../../../hardhat/test/fixtures/` (another package). Stryker's sandbox, a copy of
    the package under its temp folder, cannot satisfy both paths. Stryker's `inPlace` option
    instruments the files where they are, keeps "a copy of the originals in the temp directory"
    (configuration docs) and puts them back at the end. A dry run with `inPlace` passed on
    2026-11-04 with 47 test files and left `src/` unchanged.
  - One test in `verify.test.ts` reads the source text of `src/flow/verify.ts`. The instrumented
    copy holds every mutant, so the test failed the dry run. It is skipped when the file it reads
    contains `stryMutAct_`, the name of the call Stryker wraps each mutant in.
- No type checker runs. Stryker's checkers are optional and empty by default (configuration docs).

## 3. Incremental mode

- `--incremental` stores results in `reports/stryker-incremental.json` and reuses them. A killed
  mutant is reused when its killing test is unchanged; a surviving one when no new or changed test
  covers it. The dry run still runs (incremental docs).
- With the tap runner, tests are reported per file without locations, so a changed test file
  counts as all of its tests changed (incremental docs).
- Stryker "will not detect any changes you've made in files other than mutated files and test
  files" (incremental docs). Here that means any file other than the mutated files and
  `test/unit/*.test.ts`: `test/helpers/`, `test/fixtures/`, `schema/`, `docs/`, the `src/` files
  the mutated code calls, `package.json`, the lockfile and a Stryker update. Changes to
  dependencies are not detected either (incremental docs). Inference: only a full run catches a
  change to those files, so the weekly full run is the backstop for pull requests.
- `--force` reruns all mutants and still writes the file (incremental docs).
- A GitHub Actions cache saved on the default branch can be restored by a pull request
  (GitHub cache docs), so a pull request can start from the last full run on `main`.

## 4. Runtime on this repository

Measured on 2026-11-03 on the machine above, with concurrency 7 (the default for 8 cores). Run 1
was `stryker run --incremental` with no incremental file; other commands ran on the same machine
during it. Run 2 was `pnpm run test:mutation`, with nothing else running.

| Run                                                             | Mutants run      | Time        |
| --------------------------------------------------------------- | ---------------- | ----------- |
| Dry run (every test file once, with coverage), part of each run | none             | 1 min 25 s  |
| Full, run 1                                                     | 2,175            | 76 min 45 s |
| Full, run 2                                                     | 2,175            | 68 min 56 s |
| Incremental, nothing changed                                    | 0 (2,175 reused) | 1 min 24 s  |
| Incremental, one line added to `test/unit/status.test.ts`       | 186              | 10 min 52 s |

Scores, run 1 / run 2:

| File                       | Mutants | Killed    | Timeout | Survived | Score         |
| -------------------------- | ------- | --------- | ------- | -------- | ------------- |
| `src/backends/sourcify.ts` | 461     | 408 / 408 | 1 / 1   | 52 / 52  | 88.72 / 88.72 |
| `src/flow/verify.ts`       | 443     | 374 / 374 | 11 / 3  | 58 / 66  | 86.91 / 85.10 |
| `src/flow/status.ts`       | 25      | 24 / 24   | 0 / 0   | 1 / 1    | 96.00 / 96.00 |
| `src/http/fetch.ts`        | 579     | 519 / 525 | 20 / 9  | 40 / 45  | 93.09 / 92.23 |
| `src/errors.ts`            | 330     | 326 / 326 | 2 / 1   | 2 / 3    | 99.39 / 99.09 |
| `src/observe.ts`           | 70      | 63 / 67   | 6 / 1   | 1 / 2    | 98.57 / 97.14 |
| `src/redact.ts`            | 267     | 187 / 170 | 78 / 95 | 2 / 2    | 99.25 / 99.25 |

- Most mutants whose status changed between the runs moved between killed and timeout, which both
  count as detected (78 mutants). Seventeen moved from timeout in run 1 to survived in run 2,
  three from survived to timeout, and one from killed to survived. Source: the two
  `mutation.json` reports, compared mutant by mutant by id.
- Inference: a mutant that slows a test file past Stryker's timeout counts as detected on a loaded
  machine and as survived on an idle one, so a floor needs a margin below the measured score.
- Run 1 used about 1.5 cores on average (`time`: 6,145 s user over 4,610 s wall). Every test file
  that reaches a mutant runs until one fails, so a surviving mutant runs all of them.

Inference: GitHub's standard Linux runner has 4 cores (GitHub runner docs), about half the workers
used here, so a full CI run should take about twice as long.

### Run 3: longer timeouts and nine files (2026-11-04)

Runs 1 and 2 used Stryker's default timeouts (`timeoutFactor` 1.5, `timeoutMS` 5000; configuration
docs). Run 3 used `timeoutFactor` 3 and `timeoutMS` 15000, on a tree with two more mutated files
(`src/http/api-keys.ts`, `src/routing/resolve.ts`) and changes to `errors.ts`, `verify.ts`,
`status.ts` and `sourcify.ts` from other merged work. It was `pnpm run test:mutation` on the same
machine while other jobs held its load average above 100 (`uptime`: 135 at 5%, 257 at 14%).

- 2,891 mutants; the dry run took 2 min 19 s; the full run took 513 min 40 s, at 34% of one
  core on average (`time`: 9,321 s user and 1,174 s system over 30,828 s wall).
- Scores (killed, timeout, survived; Stryker's score; killed over valid):

| File                       | Mutants | Killed | Timeout | Survived | Score | Killed only |
| -------------------------- | ------- | ------ | ------- | -------- | ----- | ----------- |
| `src/backends/sourcify.ts` | 461     | 400    | 11      | 50       | 89.15 | 86.77       |
| `src/flow/verify.ts`       | 496     | 427    | 2       | 67       | 86.49 | 86.09       |
| `src/flow/status.ts`       | 25      | 24     | 0       | 1        | 96.00 | 96.00       |
| `src/http/fetch.ts`        | 579     | 527    | 1       | 51       | 91.19 | 91.02       |
| `src/http/api-keys.ts`     | 294     | 281    | 0       | 13       | 95.58 | 95.58       |
| `src/routing/resolve.ts`   | 355     | 329    | 4       | 22       | 93.80 | 92.68       |
| `src/errors.ts`            | 344     | 296    | 45      | 3        | 99.13 | 86.05       |
| `src/observe.ts`           | 70      | 67     | 0       | 3        | 95.71 | 95.71       |
| `src/redact.ts`            | 267     | 227    | 6       | 34       | 87.27 | 85.02       |

- `redact.ts` had 78 and 95 timeouts in runs 1 and 2, and 6 in run 3; 34 of its mutants
  survived, against 2. With the longer limit, most of them ran every test file to the end and
  passed. Many change only the prefilter that skips a pattern when its words are absent (for
  example `needs: ["key"]` emptied), so they make redaction slower without changing its output.
- Inference: with the default limits, a slower but correct mutant counted as detected. With the
  longer limits, more of them survive, which is their real status. A floor computed from killed
  mutants alone does not depend on how many mutants time out.

### Run 4: commit `6d2bfac` (2026-11-04)

Run 4 ran on commit `6d2bfac`, which adds tests for survivors of
the earlier runs, with Stryker in place (`inPlace`, section 2) and `concurrency` 4. Command:
`pnpm run test:mutation`, with the machine's load average between 46 and 97 (`uptime`).

- 2,939 mutants; the dry run took 2 min 4 s over 50 test files; the full run took 193 min 11 s.

| File                       | Mutants | Killed | Timeout | Survived | Score | Killed only |
| -------------------------- | ------- | ------ | ------- | -------- | ----- | ----------- |
| `src/backends/sourcify.ts` | 457     | 426    | 0       | 31       | 93.22 | 93.22       |
| `src/flow/verify.ts`       | 496     | 448    | 3       | 45       | 90.93 | 90.32       |
| `src/flow/status.ts`       | 25      | 24     | 0       | 1        | 96.00 | 96.00       |
| `src/http/fetch.ts`        | 603     | 558    | 6       | 39       | 93.53 | 92.54       |
| `src/http/api-keys.ts`     | 294     | 280    | 1       | 13       | 95.58 | 95.24       |
| `src/routing/resolve.ts`   | 375     | 351    | 4       | 20       | 94.67 | 93.60       |
| `src/errors.ts`            | 351     | 347    | 0       | 4        | 98.86 | 98.86       |
| `src/observe.ts`           | 70      | 67     | 0       | 3        | 95.71 | 95.71       |
| `src/redact.ts`            | 267     | 225    | 4       | 38       | 85.77 | 84.27       |

- `errors.ts` had 45 timeouts in run 3 and none in run 4, on a tree whose `errors.ts` changed
  between the two. Inference: the load on the machine still moves mutants between timeout and
  killed, which is why the floors count killed mutants only.

### Run 5: the measured floors (2026-11-04)

Run 5 set `mutation-floors.json`. It ran on commit `ff437c9`, after the Routescan and Blockscout
clients moved shared client code from `sourcify.ts` into `src/backends/common.ts`, which run 5
mutates as well. Same settings as run 4. The commands now build the package first, because
`blackbox-34-resolve-bytecode.test.ts` imports the built `explorer-verify/resolve` and failed the
dry run without it. Command: `pnpm run test:mutation`.

- 3,112 mutants; the dry run took 51 s over 61 test files; the full run took 223 min 6 s.

| File                       | Mutants | Killed | Timeout | Survived | No coverage | Score | Killed only |
| -------------------------- | ------- | ------ | ------- | -------- | ----------- | ----- | ----------- |
| `src/backends/sourcify.ts` | 355     | 320    | 22      | 13       | 0           | 96.34 | 90.14       |
| `src/backends/common.ts`   | 173     | 158    | 0       | 14       | 1           | 91.33 | 91.33       |
| `src/flow/verify.ts`       | 502     | 450    | 11      | 41       | 0           | 91.83 | 89.64       |
| `src/flow/status.ts`       | 25      | 24     | 0       | 1        | 0           | 96.00 | 96.00       |
| `src/http/fetch.ts`        | 620     | 560    | 32      | 28       | 0           | 95.48 | 90.32       |
| `src/http/api-keys.ts`     | 298     | 282    | 3       | 13       | 0           | 95.64 | 94.63       |
| `src/routing/resolve.ts`   | 403     | 377    | 10      | 16       | 0           | 96.03 | 93.55       |
| `src/errors.ts`            | 398     | 394    | 0       | 4        | 0           | 98.99 | 98.99       |
| `src/observe.ts`           | 70      | 67     | 0       | 3        | 0           | 95.71 | 95.71       |
| `src/redact.ts`            | 267     | 209    | 28      | 30       | 0           | 88.76 | 78.28       |

- `redact.ts` had 4 timeouts in run 4 and 28 in run 5, with the same source in both. The floors,
  from killed mutants only, absorb that shift; Stryker's score moves with it.

## 5. Maintenance and licence

- `@stryker-mutator/core` and `@stryker-mutator/tap-runner`: Apache-2.0 (npm registry). Releases:
  9.6.0 on 2026-02-27, 9.6.1 on 2026-04-10, 10.0.0 on 2026-08-14, 10.1.0 and 10.1.1 on 2026-10-23
  (GitHub releases). Version 10.0.0 requires Node 22.0.0 or later (npm registry).
- The `stryker-mutator/stryker-js` repository: Apache-2.0, not archived, last push 2026-10-30
  (GitHub API).
- 10.0.0 is chosen because 10.1.x was less than two weeks old on 2026-11-03. Every package the two
  add to the lockfile was published on or before 2026-10-20, checked with `npm view <name>@<version>
  time` for each.

## 6. Advisories in the added packages

`pnpm audit` (pnpm 12.16.1, 2026-11-03) reported moderate advisories in packages the two Stryker
packages add:

- `qs` 6.15.1, pinned exactly by `typed-rest-client` 2.3.1 under `@stryker-mutator/core`:
  GHSA-q8mj-m7cp-5q26, GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g and GHSA-6pq8-jhm2-2vcw, all fixed
  in 6.16.1 (published 2026-10-14). An override in `pnpm-workspace.yaml`
  (`typed-rest-client>qs: 6.16.1`) applies it; `pnpm dedupe --check` stays clean.
- `minimatch` below 11.0.1 (GHSA-g3hv-75wg-m249) and `glob` 9.0.0 to 14.0.1 (GHSA-3g3m-2fjr-6pw4).
  `@stryker-mutator/core` 10.0.0 asks for `minimatch` ~10.2.4 and the tap runner for `glob`
  ~13.0.0 (npm registry), and the fixes are in the next majors. The repository already has both
  advisories through `c8` and `eslint-plugin-jsdoc`. Accepted: the packages are development tools
  that read the repository's own files, and nothing they match comes from outside it.

## Sources

Read on 2026-11-03:

- Stryker: [tap runner](https://stryker-mutator.io/docs/stryker-js/tap-runner/),
  [incremental mode](https://stryker-mutator.io/docs/stryker-js/incremental/),
  [configuration](https://stryker-mutator.io/docs/stryker-js/configuration/),
  [StrykerJS 7 announcement](https://stryker-mutator.io/blog/announcing-stryker-js-7/).
- stryker-js issues: [#5421](https://github.com/stryker-mutator/stryker-js/issues/5421),
  [#6020](https://github.com/stryker-mutator/stryker-js/issues/6020).
- [stryker-js releases](https://github.com/stryker-mutator/stryker-js/releases).
- npm registry: [@stryker-mutator/core](https://www.npmjs.com/package/@stryker-mutator/core),
  [@stryker-mutator/tap-runner](https://www.npmjs.com/package/@stryker-mutator/tap-runner).
- Node.js: [TypeScript type stripping](https://nodejs.org/api/typescript.html).
- GitHub:
  [cache access across branches](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache),
  [standard runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories).

Commands run on 2026-11-03: `npm view` and `npm search` (npm 11.19.0) for versions, dates,
licences and engines; `gh api repos/stryker-mutator/stryker-js` and `gh issue view` (gh 2.92.0);
`pnpm run test:mutation` and `pnpm run test:mutation:incremental` (pnpm 12.16.1, Node 24.21.0).
