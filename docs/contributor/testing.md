# Testing

Audience: contributors writing or running tests.

## Run the tests

```bash
pnpm test            # build, then unit tests
pnpm run coverage    # unit tests under c8; fails below 95%
```

Tests use `node --test` with TypeScript run natively (Node 22.18 and later). `scripts/node-test.ts`
passes the right `--test-timeout` for the Node version.

## Layers

| Layer         | Where                         | What it proves                                                                    | Status   |
| ------------- | ----------------------------- | --------------------------------------------------------------------------------- | -------- |
| Unit          | `packages/*/test/unit/`       | Each module, with explorer responses recorded as fixtures and an injected `fetch` | In place |
| Browser smoke | planned (M1)                  | The core bundles and runs in a headless browser (R-RUN-1)                         | Planned  |
| Integration   | planned (M3 handler, M4 CLI)  | The server handler and the CLI end to end against a local fake explorer           | Planned  |
| Live          | planned (M2), maintainer only | Real verification on public testnets per backend, with dated results              | Planned  |

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
