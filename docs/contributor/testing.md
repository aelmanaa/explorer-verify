# Testing

Audience: contributors writing or running tests.

## Run the tests

```bash
pnpm test                 # build, then unit tests
pnpm run coverage         # unit tests under c8; fails when any file is below 95%
pnpm run test:randomize   # unit tests in a random order; prints the seed
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

`src/types.ts` holds only types and is excluded.

## Layers

| Layer            | Where                                              | What it proves                                                                    | Status       |
| ---------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- | ------------ |
| Unit             | `packages/*/test/unit/`, `scripts/test/`           | Each module, with explorer responses recorded as fixtures and an injected `fetch` | In place     |
| Browser smoke    | planned (M1)                                       | The core bundles and runs in a headless browser (R-RUN-1)                         | Planned      |
| Integration      | planned (M3 handler, M4 CLI)                       | The server handler and the CLI end to end against a local fake explorer           | Planned      |
| Live             | planned (M2), maintainer only                      | Real verification on public testnets per backend, with dated results              | Planned      |
| Docs check       | `scripts/check-agent-docs.ts`, in `pnpm run check` | `llms.txt`, page links and version lines (R-AX-1 to R-AX-3)                       | In place     |
| Agent evaluation | `test/agent-eval/`, maintainer only                | Agents complete a fixed task set without unsafe actions (R-AX-13)                 | Planned (#7) |

## Agent readiness (R-AX)

Each requirement in [requirements.md](requirements.md#agent-readiness-r-ax) has a test that fails a
pull request which breaks it. The docs check covers R-AX-1 to R-AX-3; for the others, the issue in
the last column adds the test.

| Requirement | How it is tested                                                                                                                                                                                                                                                                                                                                                                                          | Status                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| R-AX-1      | Docs check: `llms.txt` has an H1, a summary and H2 sections; every link is absolute; every page under `docs/user/` is listed and every listed file exists                                                                                                                                                                                                                                                 | In place                                                |
| R-AX-2      | Docs check: every user page has a version line, and regenerating the API and CLI references gives no diff. `pkg:check` fails when the packed tarball lacks `docs/` or `llms.txt`                                                                                                                                                                                                                          | In place; the reference check lands with the references |
| R-AX-3      | Docs check: the agent page exists and every user page links `llms.txt` in its first 10 lines                                                                                                                                                                                                                                                                                                              | In place                                                |
| R-AX-4      | Skill example tests: each code block in the skill runs against the built package with a fake `fetch`. `pkg:check` fails when the tarball lacks the skill                                                                                                                                                                                                                                                  | Planned (#6)                                            |
| R-AX-5      | Contract tests: every envelope produced in the suite validates against the published JSON Schema. CLI harness: for every exit code, including 2 from a bad flag (`invalid-input`), 130 from a cancel (`cancelled`) and 6 from an injected internal exception (`internal-error`, no handle), stdout parses as exactly one envelope; `--json` after `--` or as another flag's value does not switch to JSON | Contract tests in place (#5); CLI harness planned (#7)  |
| R-AX-6      | CLI harness: each command runs with stdin closed under a timeout. With each stream piped or on a pseudo-terminal in turn, colour appears only on a terminal stream; spinners appear only with stderr on a terminal, `CI` unset, `--log-format text` and no `--quiet`; `NO_COLOR`, `TERM=dumb`, `CI` and `--color=auto\|always\|never` each change the output as the requirement states                    | Planned (#7)                                            |
| R-AX-7      | Contract tests: every result status and catalogue error code maps to exactly one exit code, including 6 for `unknown-state` (with a handle) and for `internal-error` (no handle, `retryable` false). CLI harness: each outcome exits with its code, and an exception injected into the CLI gives `internal-error` and exit 6                                                                              | Contract tests in place (#5); CLI harness planned (#7)  |
| R-AX-8      | CLI harness: `--dry-run` sends no submit request to the fake explorer and succeeds without a key                                                                                                                                                                                                                                                                                                          | Planned (#7)                                            |
| R-AX-9      | Contract tests and CLI harness: a dummy key passed through the environment, `--api-key-file` and `--api-key-stdin` never appears on stdout, on stderr or in JSON; no flag takes a key; `--api-key-stdin` with `--input-json -` exits 2; with stdin on a pseudo-terminal both flags exit 2 without waiting; a key piped with a trailing newline is used without it                                         | Contract tests in place (#5); CLI harness planned (#7)  |
| R-AX-10     | Contract tests: every catalogue error has a hint and a `docsUrl` that resolves to a heading in the errors page. CLI harness: a typo suggests one command                                                                                                                                                                                                                                                  | Contract tests in place (#43); CLI harness planned (#7) |
| R-AX-11     | CLI harness: `--help` for every command has an example and lists the environment variables and exit codes, and links the docs and `llms.txt`; `--version --json` parses                                                                                                                                                                                                                                   | Planned (#7)                                            |
| R-AX-12     | CLI harness: the same command run twice gives byte-identical stdout                                                                                                                                                                                                                                                                                                                                       | Planned (#7)                                            |
| R-AX-14     | CLI harness: stdout holds no progress line; under `--log-format json` every stderr line that starts with `{` parses, validates against the event schema and carries the envelope's `schemaVersion`; a field named like a reserved key appears under `fields`; the `verify.submitted` line carries the handle at `info` and `debug` and is absent at `error` and `off`                                     | Planned (#7)                                            |
| R-AX-15     | CLI harness: stdout of `--quiet`, the default and `--verbose` is byte-identical; each level shows exactly the event lines the table lists; `EXPLORER_VERIFY_LOG` sets the level and a flag overrides it; an invalid value gives one `warn` line naming the variable and not the value; `--quiet --verbose` exits 2; `-v` is rejected                                                                      | Planned (#7)                                            |
| R-AX-16     | CLI harness: `--input-json` from a file and from stdin gives the same result as the flags; each allowed flag is accepted with it and any other request flag exits 2; malformed JSON exits 2; unknown properties exit 2 with a count and no name or value. Contract tests: the shipped input, envelope and event schemas are valid JSON Schema                                                             | Planned (#7)                                            |
| R-AX-13     | Agent evaluation: at least two models run the task set; success, turns and unsafe actions attempted are recorded with the date in `docs/contributor/research/`                                                                                                                                                                                                                                            | Planned (#7)                                            |

## Library logging and events (R-DX-5, R-DX-6)

Unit tests with an injected `fetch` and spies for `logger` and `onEvent`.

| Requirement | How it is tested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Status        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| R-DX-5      | Type test: `console` satisfies `Logger`. Unit tests: a call without `logger` or `onEvent` writes nothing to a spied `console`; field values are flat and JSON-safe; a failure the call throws is not passed to `logger.error`; a dummy key never reaches the logger spy                                                                                                                                                                                                                                                           | Planned (#17) |
| R-DX-6      | Unit tests: a fixture run emits the events in stage order with the listed fields; `verify.submitted` carries the handle before an abort; `checkStatus` emits only `verify.poll`, `verify.retry` and `verify.result`; a call that throws emits no `verify.result`; an `onEvent` that throws is logged once at `warn` and does not change the outcome; a rejected promise from `onEvent` is caught; every event validates against the shipped event schema, whose `state` and `reason` are enums; a dummy key never reaches the spy | Planned (#17) |

## Deterministic tests

A test gives the same result on every run, on every machine and in any order.

- No network. Inject `fetch` and replay a recorded fixture.
- No real timers or sleeps. Use the `node:test` mock timers (`mock.timers.enable()`) and advance
  them with `mock.timers.tick()`.
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
- The browser smoke test's tools (headless browser, bundler) are chosen in its M1 issue, as
  devDependencies only.
