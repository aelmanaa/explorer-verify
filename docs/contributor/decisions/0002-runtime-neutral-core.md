# 0002: The core runs in any JavaScript runtime

Status: Accepted (2026-11-02)

## Context

Users verify from a browser, from their own backend, from serverless or edge functions, and from
scripts. Etherscan, Sourcify and Blockscout all send `access-control-allow-origin: *` (checked
2026-11-02), so a browser can call them directly. See
[the explorer API research](../research/2026-11-02-explorer-apis.md#browser-reachability-live-2026-11-02).

## Decision

The `explorer-verify` package uses only web-platform globals and never imports a Node built-in.
`fetch` is injectable. Node-only code (CLI, build helpers that read files) stays out of the core
entry point, in add-on packages or Node-only subpath exports (the split was decided in
[0008](0008-package-split-and-bundle-budget.md)).

## Consequences

- Enforced twice: oxlint `import/no-nodejs-modules` on `packages/*/src`, and
  `tsconfig.build.json` builds with `types: []` and the DOM lib, so Node APIs do not typecheck.
- Tests still run on Node; a browser smoke test is planned in M1.
- No `process.env`: keys and URLs come in through options.
