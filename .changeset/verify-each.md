---
"explorer-verify": patch
"@explorer-verify/cli": patch
---

The core package exports `verifyEach()`, which verifies a contract on several backends in one call
and returns one outcome per backend, with the `BackendEntry`, `BackendOutcome`,
`VerifyEachOptions` and `VerifyEachResult` types. `backends` lists backend names or route
overrides, or is `"all"` for every backend the routing table lists for the chain that can run with
the keys given. The backends run in parallel with one time budget and the caller's signal, and
each gets only its own key. One backend's error, a client module that fails to load included, is
that backend's outcome and holds the `ExplorerVerifyError`; it never discards the others. A
`not-confirmed` outcome keeps the handle that resumes that backend with `checkStatus()`.

`toEnvelope()` and `exitCodeOf()` accept the result. The envelope schema adds its form. The exit
code is 0 only when every backend verified, and otherwise the first of 6, 4, 3, 2, 5, 1 and 130
that any outcome has; read `result.outcomes` for every backend.

The CLI's `verify` now takes `--backend` more than once and then runs `verifyEach()`, printing one
envelope with an outcome per backend. `--api-url`, `--api-key-file`, `--api-key-stdin` and
`--dry-run` exit 2 with a repeated `--backend`. `status` still takes one `--backend`. A cancelled
run on several backends lists every job still running in `error.handles`, so none is lost.

[#95](https://github.com/aelmanaa/explorer-verify/issues/95)
