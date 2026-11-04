# Testing

Audience: contributors writing or running tests.

## Run the tests

```bash
pnpm test                 # build, then unit tests
pnpm run coverage         # unit tests under c8; fails when any file is below 95%
pnpm run test:randomize   # unit tests in a random order; prints the seed
pnpm run test:browser     # build, then verify() and checkStatus() in headless Chromium
pnpm run test:browser:harness  # broken page scripts must fail the browser test
pnpm run size             # build, then the bundle size of each public entry
pnpm run test:mutation    # mutation testing of the result mapping and redaction (slow)
```

Tests use `node --test` with TypeScript run natively (Node 22.18 and later). `scripts/node-test.ts`
passes the right `--test-timeout` for the Node version.

## Coverage floor

c8 checks each file on its own (`"per-file": true` in `packages/explorer-verify/.c8rc.json`), so
every file under `src/` must reach 95% of lines, branches, functions and statements, and a
well-tested module cannot lift a weak one over the floor. The output names each file below it:

```text
ERROR: Coverage for branches (66.66%) does not meet threshold (95%) for src/probe.ts
```

`src/types.ts` and `src/backends/backend.ts` hold only types and are excluded: no test loads them at
run time, so c8 would report them at 0%.

## Layers

| Layer            | Where                                                                                                          | What it proves                                                                                                                                        | Status                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Unit             | `packages/*/test/unit/`, `scripts/test/`, `examples/test/`                                                     | Each module, with explorer responses recorded as fixtures and an injected `fetch`                                                                     | In place                                         |
| Browser smoke    | `scripts/browser-smoke.ts`, `packages/explorer-verify/test/browser/`, `scripts/test-browser/`                  | The core bundles and runs in a headless browser under real CORS (R-RUN-1), and gives the keccak-256 digests in `test/fixtures/keccak256-vectors.json` | In place                                         |
| Bundle size      | `scripts/check-size.ts`, `size-budget.json`                                                                    | Each public entry, bundled for the browser, stays at or below its ceiling (R-RUN-3)                                                                   | In place                                         |
| Integration      | `packages/cli/test/integration/` (CLI); `packages/explorer-verify/test/unit/server-handler*.test.ts` (handler) | The server handler and the CLI end to end against a local fake explorer. The CLI tests spawn the built bin with stdout piped and stdin closed         | CLI output contract in place (#98); handler done |
| Mutation         | `packages/explorer-verify/stryker.config.json`, `mutation-floors.json`, `.github/workflows/mutation.yml`       | The unit tests fail when the result mapping, the HTTP retry rules or the key redaction is changed (R-FLOW-4, R-FLOW-6, R-SEC-1)                       | In place                                         |
| Live             | planned (M2), maintainer only                                                                                  | Real verification on public testnets per backend, with dated results                                                                                  | Planned                                          |
| Docs check       | `scripts/check-agent-docs.ts`, in `pnpm run check`                                                             | `llms.txt`, page links and version lines (R-AX-1 to R-AX-3)                                                                                           | In place                                         |
| Docs examples    | `packages/explorer-verify/test/unit/user-docs.test.ts`                                                         | Every `ts` block under `docs/user/` compiles against the build and prints its documented output (R-AX-2)                                              | In place                                         |
| Link check       | lychee in CI: the `site` job, and `.github/workflows/links.yml` weekly                                         | Relative links and anchors in `docs/user/`, `llms.txt` and the built site; external links once a week                                                 | In place                                         |
| Agent evaluation | `test/agent-eval/`, maintainer only                                                                            | Agents complete a fixed task set without unsafe actions (R-AX-13)                                                                                     | Planned (#7)                                     |

## Agent readiness (R-AX)

Each requirement in [requirements.md](requirements.md#agent-readiness-r-ax) has a test that fails a
pull request which breaks it. The docs check covers R-AX-1 to R-AX-3; for the others, the issue in
the last column adds the test.

| Requirement | How it is tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| R-AX-1      | Docs check: `llms.txt` has an H1, a summary and H2 sections; every link is absolute; every page under `docs/user/` is listed and every listed file exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | In place                                                                                                  |
| R-AX-2      | Docs check: every user page has a version line, and regenerating the CLI reference gives no diff. `pkg:check` fails when the packed tarball lacks `docs/` or `llms.txt`. User-docs example tests: every `ts` block under `docs/user/` type-checks against the build and runs with recorded Sourcify answers, and prints the output block that follows it (see [User-docs examples](#user-docs-examples)). Site build: the API reference generator fails on an export or member without TSDoc, an unresolved `{@link}`, a type no entry point exports, or `{{` in a page, and CI runs it twice and fails on any difference ([API reference](tooling.md#api-reference))                                                                                                                                                                                                                                                                                                                                                                                                               | In place; the CLI reference check lands with the CLI reference                                            |
| R-AX-3      | Docs check: the agent page exists and every user page links `llms.txt` in its first 10 lines. CLI tests (`agent-page.test.ts`, integration and unit): the page's outward and safe lists name every function the packages export and every command the CLI lists, its `sh` examples print their output on the built bin, and the stderr handle line it quotes is the one the CLI prints. User-docs examples run its `ts` block                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | In place                                                                                                  |
| R-AX-4      | Skill example tests: each code block in the skill runs against the built package with a fake `fetch`. Each example must also print the output block that follows it, and each API name, field path, event name and exit code in the prose must match the build. `pkg:check` fails when the tarball lacks the skill                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `test/unit/skill.test.ts`, `scripts/check-packed-files.ts`                                                |
| R-AX-5      | Contract tests: every envelope produced in the suite validates against the published JSON Schema, compiled by ajv in strict mode. CLI harness: for every exit code, including 2 from a bad flag (`invalid-input`), 130 from a cancel (`cancelled`) and 6 from an injected internal exception (`internal-error`, no handle), stdout parses as exactly one envelope; `--json` after `--` or as another flag's value does not switch to JSON                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Contract tests in place (#5); CLI harness planned (#7)                                                    |
| R-AX-6      | CLI harness: each command runs with stdin closed under a timeout. With each stream piped or on a pseudo-terminal in turn, colour appears only on a terminal stream; spinners appear only with stderr on a terminal, `CI` unset, `--log-format text` and no `--quiet`; `NO_COLOR`, `TERM=dumb`, `CI` and `--color=auto\|always\|never` each change the output as the requirement states                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Planned (#7)                                                                                              |
| R-AX-7      | Contract tests: every result status and catalogue error code maps to exactly one exit code, including 6 for `unknown-state` (with a handle) and for `internal-error` (no handle, `retryable` false; the code lands with #7), and 3 for exactly `missing-api-key`, `api-key-rejected` and `quota-exceeded` (`api-keys.test.ts`, with the recorded Etherscan key answers). CLI harness: each outcome exits with its code, and an exception injected into the CLI gives `internal-error` and exit 6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Contract tests in place (#5); CLI harness planned (#7)                                                    |
| R-AX-8      | CLI harness: `--dry-run` sends no submit request to the fake explorer and succeeds without a key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | In place: core `dry-run.test.ts`, CLI `verify.test.ts` (unit and bin); the #7 harness adds more           |
| R-AX-9      | Unit tests (`api-keys.test.ts`, `verify.test.ts`): a dummy key in `apiKeys` goes only to its backend's table host, in the form body for Etherscan and the `apikey` header for Routescan, never in a URL, and never reaches the logger, `onEvent`, an error's `toJSON()` or a result. Contract tests and CLI harness: a dummy key passed through the environment, `--api-key-file` and `--api-key-stdin` never appears on stdout, on stderr or in JSON; no flag takes a key; `--api-key-stdin` with `--input-json -` exits 2; with stdin on a pseudo-terminal both flags exit 2 without waiting; a key piped with a trailing newline is used without it                                                                                                                                                                                                                                                                                                                                                                                                                              | Contract tests in place (#5); CLI harness planned (#7)                                                    |
| R-AX-10     | Unit tests (`error-pages.test.ts`): every code in `ERROR_CODES` has a page with its H1, `Cause:`, `Fix:`, its default hint, `Retryable:` and `Exit code:`, matching the catalogue; every page under `reference/errors/` other than the index is a code or a released code; every `docsUrl` ends in `reference/errors/<code>` with no fragment and maps to its page; every code in the committed released-codes list has a page, and a removed one says "Removed in X.Y.Z" with a version after its first and links its replacement. `pkg:check` fails when the tarball lacks a code's page; with `--release`, in the release workflow, it also fails when a code is not in the released-codes list or `docsUrl` still points at `blob/main`. Site build: each `docsUrl` maps to a file in the build output, with its `.md` copy. After the deploy: each code page and its `.md` copy return 200, or the promote stops; `check-release-workflows.ts` in `pnpm run check` fails when the job that moves `latest` does not need the docs job. CLI harness: a typo suggests one command | Unit tests, `pkg:check`, site build, deploy check and promote gate done (#82, #84, #87); CLI (#7) planned |
| R-AX-11     | CLI harness: `--help` for every command has an example and lists the environment variables and exit codes, and links the docs and `llms.txt`; `--version --json` parses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Planned (#7)                                                                                              |
| R-AX-12     | CLI harness: the same command run twice gives byte-identical stdout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Planned (#7)                                                                                              |
| R-AX-14     | CLI harness: stdout holds no progress line; under `--log-format json` every stderr line that starts with `{` parses, validates against the event schema and carries the envelope's `schemaVersion`; a field named like a reserved key appears under `fields`; the `verify.submitted` line carries the handle at `info` and `debug` and is absent at `error` and `off`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Planned (#7)                                                                                              |
| R-AX-15     | CLI harness: stdout of `--quiet`, the default and `--verbose` is byte-identical; each level shows exactly the event lines the table lists; `EXPLORER_VERIFY_LOG` sets the level and a flag overrides it; an invalid value gives one `warn` line naming the variable and not the value; `--quiet --verbose` exits 2; `-v` is rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Planned (#7)                                                                                              |
| R-AX-16     | CLI harness: `--input-json` from a file and from stdin gives the same result as the flags; each allowed flag is accepted with it and any other request flag exits 2; malformed JSON exits 2; unknown properties exit 2 with a count and no name or value. Contract tests: the shipped input, envelope and event schemas are valid JSON Schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | In place: CLI `verify.test.ts` (unit and bin); the #7 harness adds more                                   |
| R-AX-17     | Site build in pull request CI (`scripts/check-site.ts`): every link in the built `llms.txt` is a `.md` copy in the build, and every HTML page has a `.md` copy that `llms.txt` lists. Docs check: no `{{` in prose under `docs/user/`. After the deploy (`scripts/smoke-site.ts`): `/llms.txt` and every page it lists return 200                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | In place (#84)                                                                                            |
| R-AX-13     | Agent evaluation: at least two models run the task set; success, turns and unsafe actions attempted are recorded with the date in `docs/contributor/research/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Planned (#7)                                                                                              |

## Library logging and events (R-DX-5, R-DX-6)

Unit tests with an injected `fetch` and spies for `logger` and `onEvent`. The logger and event
guard (`src/observe.ts`), the redacting logger and the HTTP layer's log fields and `verify.retry`
events are tested in `observe.test.ts` and `redact.test.ts`. The stage events that `verify()` emits
are tested with it.

| Requirement | How it is tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| R-DX-5      | Type test: `console` satisfies `Logger`. Unit tests: a call without `logger` or `onEvent` writes nothing to a spied `console`; field values are flat and JSON-safe; a failure the call throws is not passed to `logger.error`; a dummy key never reaches the logger spy                                                                                                                                                                                                                                                                            | In place: guard and HTTP layer (#53), `verify()` (#17), `checkStatus()` (#18)          |
| R-DX-6      | Unit tests: a fixture run emits the events in stage order with the listed fields; `verify.submitted` carries the handle before an abort; `checkStatus` emits only `verify.routed`, `verify.poll`, `verify.retry` and `verify.result`; a call that throws emits no `verify.result`; an `onEvent` that throws is logged once at `warn` and does not change the outcome; a rejected promise from `onEvent` is caught; every event validates against the shipped event schema, whose `state` and `reason` are enums; a dummy key never reaches the spy | In place: guard, schema, `verify.retry` (#53), `verify()` (#17), `checkStatus()` (#18) |

## User-docs examples

`test/unit/user-docs.test.ts` in the core package tests every `ts` block under `docs/user/`
against the build, with the helpers of the skill test (R-AX-2, R-AX-4). It runs in `pnpm test`,
after the build, because the examples import `explorer-verify`, `@explorer-verify/foundry` and
`@explorer-verify/hardhat` by name, and each name resolves to the package's `dist/`.

1. It type-checks every block in one temporary project, with strict settings and the DOM library,
   so a browser example can use `localStorage`. The project also holds the verification files
   that the guide for package authors imports.
2. It runs every block with Node, with `fetch` replaced by the fake that replays recorded explorer
   answers (`test/helpers/skill-fetch.ts`). A fixture name is a Sourcify fixture, or
   `<backend>/<name>` for another backend's. A run must exit with its expected code, 0 by default,
   and print exactly the `text` block that follows the `ts` block, or nothing when none follows.

A block may use these names without defining them. The test declares them for the type-check, and
`test/helpers/docs-globals.ts` defines them for a run:

| Name                                    | Value in a run                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `input`                                 | A valid `VerifyInput` for the Greeter at the Sepolia address the Sourcify fixtures hold    |
| `apiKey`, `etherscanKey`, `explorerKey` | Dummy strings                                                                              |
| `localStorage`                          | An in-memory store                                                                         |
| `deployerAddress`                       | An address no one deploys from                                                             |
| `built`                                 | The `buildVerifyInput` result for a `Counter` that links the library `src/Tally.sol:Tally` |
| `request`                               | A status poll for the server handler, for a job the Etherscan fixtures hold                |

Two flags after `ts` in the info string change what the test does with a block:

| Flag          | The test                             | Use it for                                                       |
| ------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `ts no-run`   | Type-checks the block, never runs it | Code that compiles but cannot run offline, such as a live submit |
| `ts fragment` | Neither type-checks nor runs it      | Code that is not a module, such as a function signature          |

A flagged block needs its reason in an HTML comment on the nearest non-blank line before it, such
as `<!-- fragment: the signature only; the example below runs. -->`. The site does not show the
comment. A flagged block has no output block. The test fails on any other flag, on two flags, and
on a flag without its reason.

A block runs once, in a project with no build files and no recorded answers, unless `RUNS` in the
test lists it. An entry sets the files the run starts from (a Foundry or Hardhat project, a
package with build files, or the verification files a package ships, all made from the fixtures of
the three packages), the recorded answers
in order, the exit code, environment variables and, for a second run of the same block, the
output. Every run starts with `ETHERSCAN_API_KEY` and `ROUTESCAN_API_KEY` empty, so a key in the
test runner's environment never changes a run; an entry may set a dummy one. To add an example
that sends a request, add an entry with the answers it needs. The test names the page and line of
each failure.

`test/integration/ci-page.test.ts` in the CLI package runs the `sh` examples of the CI guide on the
built bin, and runs its `scripts/verify.sh` with `bash` and `jq` for exit codes 0, 2, 3 and 4, and
with a stand-in command whose hint holds `%`, CR and LF, which the script must escape. It skips the
script when either tool is missing.

## Link check

The `site` job of pull request CI runs [lychee](https://github.com/lycheeverse/lychee) with
`--offline --include-fragments` on `docs/user/` and the root `llms.txt`, then on the built site in
`site/dist/`. A relative link to a missing file, or to an anchor that the page lacks, fails the
job. `--offline` skips every external URL, so the check needs no network and gives the same result
on every run.

`.github/workflows/links.yml` checks the external links once a week, and on a manual dispatch. It
runs only in this repository, never on a fork or a pull request, and uses no secret beyond the
workflow's own `GITHUB_TOKEN`. When lychee finds a broken link, the workflow opens an issue titled
"Broken links in the docs", or adds a comment to the open one, so repeated failures give one open
issue. A run that finds no links, or cannot run lychee, also reaches the issue. `.lycheeignore`
lists the URLs both checks skip, each with its reason: Etherscan and npm answer 403 to automated
clients, the docs site is not deployed before the first release, and GitHub builds its heading
anchors in the browser.

## Browser smoke test

`pnpm run test:browser` builds the package, then runs `scripts/browser-smoke.ts`:

1. esbuild bundles `packages/explorer-verify/test/browser/entry.ts` for the browser (ESM, minified,
   `platform: "browser"`, code splitting on, so each backend client is a chunk of its own). The
   entry imports `verify` and `checkStatus` by package name, so the
   bundle holds the built `dist/`, as a dapp's would. The keccak-256 code is internal and not
   exported, so the bundle takes it from `src/internal/keccak.ts`. A Node built-in fails this step,
   also inside `try`/`catch` or a dynamic `import()` (R-RUN-1).
2. A replay server on `127.0.0.1` answers Sourcify's API from recorded fixtures, in order:
   - `verify()`: lookup, submit, a pending poll and an exact match;
   - `checkStatus()` on the handle string from `verify.submitted`: one poll;
   - `checkStatus()` on another recorded job's handle: one poll of that job.
     The page passes the server to the library as `route.apiUrl`. The server sends only the CORS
     headers Sourcify sends, as recorded in
     `test/fixtures/sourcify/2026-11-03-preflight-verify.json` and the other fixtures.
3. The bundle runs in Node, loaded from a new temporary folder each time. Then a second server on
   another port of `127.0.0.1` serves it to headless Chromium, so the requests to the replay
   server are cross-origin and Chromium applies its CORS checks, preflight included. The test observes requests without intercepting them,
   because a Playwright request route answers CORS preflights itself. Other paths on the page
   server return 404.
4. Each run must give the digests in `test/fixtures/keccak256-vectors.json`, then `verified` with
   `exact` from `verify()` and both `checkStatus()` calls. A fresh load in each runtime then
   resumes the first handle with `checkStatus()` alone, as after a page reload. In Chromium the
   test waits until the page has set its result. A module with a top-level `await` can start the
   scenario after the load event, and the checks must not run before it ends.
5. Every run routes to Sourcify, so each Chromium run must load the Sourcify client's chunk and
   no chunk of another client (decision 0031).

The test fails on any of these (R-SEC-2):

- a request out of the recorded order, or a recorded answer nobody asked for. The replay server
  answers an unexpected request at once with `400 {"customCode":"smoke_unexpected_request"}`;
- a request to any other host, or a WebSocket. Chromium resolves no host but `127.0.0.1`;
- a request header beyond the CORS-safelisted set and `content-type: application/json`, a `cookie`
  or `authorization` header, or a preflight that asks for another header. The page server sets a
  cookie, so a request that includes credentials carries it;
- a submit body without `compilerVersion`, `contractIdentifier` or `stdJsonInput`;
- an uncaught page error, a run with no result after 60 seconds, or a request sent after a run
  ended.

A passing run takes about 8 seconds with the build. Each call has a 10-second budget, so a broken
run ends in about 20 seconds.

`pnpm run test:browser:harness` checks the smoke test itself. It runs `scripts/browser-smoke.ts`
with each broken page script in `packages/explorer-verify/test/browser/broken/` (`--entry`), and
with `access-control-allow-origin` or `access-control-allow-headers` left out of the replay answers
(`--drop-response-header`). Each run must fail with its own message. One more run,
`test/browser/late-start.ts`, waits 1 second in a top-level `await`, past the load event, then
starts the scenario. It must pass. The harness needs a build first.

### Run it locally

Install the Chromium headless shell once, then run the test:

```bash
pnpm exec playwright install --only-shell chromium
pnpm run test:browser
pnpm run test:browser:harness
```

Playwright stores the browser in its cache folder (`~/.cache/ms-playwright` on Linux,
`~/Library/Caches/ms-playwright` on macOS), not in `node_modules`. On Linux, add `--with-deps` the
first time to install the system libraries; it uses `sudo`.

Playwright downloads no browser for some older systems, such as macOS 13: `playwright install`
stops with "Playwright does not support chromium on mac13". Pass a Chromium or Chrome binary you
already have:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
pnpm run test:browser --executable-path "$CHROME"
pnpm run test:browser:harness --executable-path "$CHROME"
```

`--executable-path` without a value stops with an error; it never falls back to the downloaded
browser.

## Bundle size

`pnpm run size` builds the package, then bundles each entry of `size-budget.json` at the
repository root with the same esbuild settings, gzips it at level 6 and prints one line
per entry. Each entry is measured without the clients it loads with a dynamic `import()`. Each
client is then measured on its own, without the modules the entry holds, and printed as a
`chunk` line ([decision 0031](decisions/0031-clients-load-on-demand-and-chunks-measured-apart.md)).
An entry with `oneFile`, `verify (one file)`, is measured as one file with every client
inlined, as esbuild without splitting ships it. The check fails when an entry also imports a
client statically, because no chunk is then split off. It exits 1 when an entry or a chunk is
above its `ceilingBytes`, and fails when an entry loads a chunk that `chunks` gives no ceiling:

```text
ok   verify: 13611 bytes (ceiling 16334)
OVER chunk routescan: 4100 bytes (ceiling 4032)
```

The entries are `verify`, `verify (one file)`, `checkStatus`, `buildVerifyInput`, the whole index
and `createVerifyHandler` ([decision 0014](decisions/0014-measured-bundle-ceilings.md)). To shrink a bundle, see what an
entry holds with esbuild's analyzer:

```bash
echo 'export { verify } from "explorer-verify";' > packages/explorer-verify/size-entry.js
pnpm exec esbuild packages/explorer-verify/size-entry.js --bundle --minify --format=esm \
  --platform=browser --target=es2023 --outfile=/dev/null --analyze
rm packages/explorer-verify/size-entry.js
```

A pull request that raises a ceiling records the new `measuredBytes` and says why.

## Mutation testing

Coverage shows which lines the tests run, not whether a test fails when a line is wrong. Mutation
testing checks that: StrykerJS changes the code one small step at a time (it flips a condition,
empties a block, replaces a string) and runs the unit tests against each change, called a mutant.
A mutant is killed when a test fails, and survives when every test passes. The score of a file is
the share of its mutants that the tests kill or that time out.

It covers the files where a surviving mutant means a false result or a leaked key. The Etherscan,
Routescan and Blockscout clients (`src/backends/etherscan.ts`, `routescan.ts`, `blockscout.ts`),
the server handler and the input builders are not mutated yet.

| File                       | What a surviving mutant can break                                  | Score | Killed only | Limit        |
| -------------------------- | ------------------------------------------------------------------ | ----- | ----------- | ------------ |
| `src/backends/sourcify.ts` | Sourcify answers mapped to results and errors (R-FLOW-4)           | 96.34 | 90.14       | 89           |
| `src/backends/common.ts`   | Submit, resubmit and handle rules shared by the clients (R-FLOW-4) | 91.33 | 91.33       | 90           |
| `src/flow/verify.ts`       | The flow engine: submit, poll, budget, recovery (R-FLOW-4)         | 91.83 | 89.64       | 88           |
| `src/flow/status.ts`       | `checkStatus()` (R-FLOW-4)                                         | 96.00 | 96.00       | 2 undetected |
| `src/http/fetch.ts`        | Retry, timeout and abort rules (R-FLOW-6)                          | 95.48 | 90.32       | 89           |
| `src/http/api-keys.ts`     | Which key goes to which host (R-SEC-1)                             | 95.64 | 94.63       | 93           |
| `src/routing/resolve.ts`   | Which backend and URL a chain gets, so where a key goes            | 96.03 | 93.55       | 92           |
| `src/errors.ts`            | The error catalogue and its redaction (R-SEC-1)                    | 98.99 | 98.99       | 97           |
| `src/observe.ts`           | The logger and event guard (R-DX-5, R-DX-6, R-SEC-1)               | 95.71 | 95.71       | 94           |
| `src/redact.ts`            | Key redaction (R-SEC-1)                                            | 88.76 | 78.28       | 77           |

"Score" is Stryker's score from the full run of 2026-11-04 on commit `ff437c9` (StrykerJS
10.0.0, Node 24.21.0, concurrency 4); "Killed only" counts timed-out mutants as not detected. Many of the survivors in
`redact.ts` only make it slower, such as an empty list of the words that must appear before a
pattern is tried; no test can kill them.

The check compares Stryker's score, which counts timeouts as detected, with the floor. Each floor
is set lower than that score: from the killed mutants alone, over the valid ones (killed, timed
out, survived, not covered), rounded down to the whole percent, minus 1. A mutant that times out on
one machine can survive on another, so a floor that counted timeouts would fail on a faster or
idler runner. A file with fewer than 50 mutants has `maxUndetected` instead, a maximum count of
survived and not-covered mutants, because one mutant moves its score by several points. It is set
to the survived, not-covered and timed-out mutants of the measuring run, plus 1. On an earlier base,
45 mutants of `errors.ts` timed out under heavy load, which would have put its floor 13 points
below its score; counting killed mutants only keeps such a run from failing the check.
[The research note](research/2026-11-03-mutation-testing.md) explains the tool choice and the
run times.

### Keep the floors current

- A pull request that lowers a file's score below its floor updates `measured` and `floor` (or
  `maxUndetected`) in `mutation-floors.json` and the table above, and says why.
- When scores rise, raise the floors by hand with the same rule; the check never raises them.
- When two open pull requests change the same mutated files, the one that merges second
  re-measures with a full run before it merges.
- After this setup first lands on `main`, dispatch one full run of the `Mutation` workflow on
  `main`. It seeds the cache that pull requests start from, and checks the floors on CI's 4-core
  runner.

### Run it locally

```bash
pnpm run test:mutation              # every mutant; about 4 hours with 4 processes
pnpm run test:mutation:incremental  # only mutated files and unit test files changed since the last run
```

Both commands build the package first. Stryker changes the mutated files in `src/` while it runs and puts them back
when it ends, so do not edit or commit them during a run
([tooling.md](tooling.md#mutation-testing) says how to recover from a killed run). Both commands
write `packages/explorer-verify/reports/mutation/mutation.html`
(open it in a browser to see each surviving mutant in the source),
`reports/mutation/mutation.json` and `reports/stryker-incremental.json`. Then
`scripts/check-mutation-score.ts` prints a table and exits 1 when a file fails:

```text
| File | Score | Floor | Killed | Timeout | Survived | No coverage | Result |
| --- | --: | --: | --: | --: | --: | --: | --- |
| src/backends/sourcify.ts | 96.34 | 89.00 | 320 | 22 | 13 | 0 | ok |
| src/flow/status.ts | 96.00 | max 2 undetected | 24 | 0 | 1 | 0 | ok |
```

A file fails when its score is below its floor (`BELOW`), when it has more undetected mutants than
`maxUndetected` (`TOO MANY`), when it is mutated and has no limit in
`packages/explorer-verify/mutation-floors.json` (`NO FLOOR`), or when it has a limit and is not in
the report (`NOT IN REPORT`).

The incremental command sees changes to the mutated files and to `test/unit/*.test.ts` only. It
does not see a change to any other file: `test/helpers/`, `test/fixtures/`, `schema/`, `docs/`,
the `src/` files the mutated code calls, `package.json`, the lockfile or a Stryker update. Only a
full run catches those: run `pnpm run test:mutation` locally after such a change, and the weekly
full run in CI catches it otherwise.

To mutate one file, or a range of lines, run Stryker from the package:

```bash
cd packages/explorer-verify
pnpm exec stryker run --force --mutate src/flow/status.ts
pnpm exec stryker run --force --mutate "src/backends/sourcify.ts:140-160"
```

A partial run rewrites the report with the other files' previous results, from
`reports/stryker-incremental.json`, or without them when that file does not exist, so the floor
check can then fail with `NOT IN REPORT`.

### In CI

The `Mutation` workflow (`.github/workflows/mutation.yml`) is not a required check. Both jobs have
a 300-minute limit.

- Weekly, on Monday, and on manual dispatch: `pnpm run test:mutation`. It writes the table to the
  job summary, uploads the report as an artifact for 30 days and, on `main`, saves
  `stryker-incremental.json` to the Actions cache.
- On a pull request that changes a mutated file, a file under `test/`, the Stryker config, the
  floors, the score scripts, `pnpm-workspace.yaml` or the workflow:
  `pnpm run test:mutation:incremental`, starting from the cached file of the latest full run on
  `main`. Without a cached file it runs every mutant. It has the limits of the incremental command
  above, so a pull request that changes only a helper or a fixture can pass here and fail the
  next weekly run.

### When a mutant survives

Read it in `mutation.html`. Most survivors are one of these:

- A missing test: the change alters behaviour that no test checks. Add the test, and raise the
  floor if the score allows it.
- An equivalent mutant: the change does not alter behaviour, for example an empty default
  `secrets` list replaced by a list holding a string that never occurs. No test can kill it.
- Text no test reads, such as a log message. Check the text in a test when it matters to a user.

## Deterministic tests

A test gives the same result on every run, on every machine and in any order.

- No network. Inject `fetch` and replay a recorded fixture.
- No real timers or sleeps. Use the `node:test` mock timers (`mock.timers.enable()`) and advance
  them with `mock.timers.tick()`.
- Drive a whole `verify()`, `checkStatus()` or `dryRun()` call on mock timers with
  `driveMockClock` from `test/helpers/mock-clock.ts` in each package. The first call in a process
  loads its explorer client with a dynamic `import()`, which takes real event-loop turns, and the
  time budget runs during the load (decision 0031). `driveMockClock` runs only the pending timers
  after each turn, so the clock stands still during the load, and it allows 100,000 turns. A loop
  that calls `mock.timers.tick()` on every turn spends the budget during the load, and a loop with
  a small turn limit can end before the load does. To wait for a step, such as the submit, use
  `turnUntil`, not a fixed number of turns.
- Write a file that a child process reads before the process starts, with `writeFiles` from
  `test/helpers/skill.ts`. It replaces the file whole, so no process reads it empty or half
  written.
- No randomness. Fix every value a test depends on: ids, salts, dates.
- No order dependence and no shared mutable state. Each test builds what it needs and cleans up in
  `afterEach`. A module-level value that tests change is a bug.
- A test that fails once is a bug to fix, not a flake to retry. Do not add retries.

CI runs the unit tests a second time in a random order (`pnpm run test:randomize`), so a test that
depends on order fails there. The command makes two runs, the package tests and then the script
tests, and each prints its own seed in its summary:

```text
ℹ Randomized test order seed: 3926293431
```

To rerun a failure, take the seed from the run that failed and use the matching command:

```bash
pnpm run build

# The package tests failed
cd packages/explorer-verify
node ../../scripts/node-test.ts unit --test-random-seed=<seed> "test/unit/**/*.test.ts"

# The script tests failed (from the repository root)
node scripts/node-test.ts unit --test-random-seed=<seed> "scripts/test/**/*.test.ts"
```

Node added `--test-randomize` and `--test-random-seed` in 24.16.0 and 26.1.0. On an older Node,
`scripts/node-test.ts` skips a random-order run with a note on stderr and exit code 0. With
`REQUIRE_RANDOM_ORDER=1`, as set in CI, it exits 1 instead, so the CI step cannot pass without
running the tests.

## Rules

- Never call a real explorer from unit tests. Inject `fetch` and replay a recorded response.
- Record fixtures from real responses under
  `packages/explorer-verify/test/fixtures/<backend>/<YYYY-MM-DD>-<endpoint>.json`, with the date and
  endpoint in the file name. Strip API keys from recorded URLs. Replay them through one fake `fetch`
  helper in `test/helpers/`.
- Every status string or error shape seen live gets a test (requirements R-QA-1).
- Name a test after the behaviour and cite the requirement when it pins one:
  `it("returns already-verified without submitting (R-FLOW-1)")`.
- Live tests read keys from the environment, run only on the maintainer's machine or an
  owner-approved workflow, and never print a key.
- Browser tests use Playwright and esbuild, both devDependencies. The core has no runtime
  dependencies (R-RUN-4).
