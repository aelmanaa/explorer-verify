---
"@explorer-verify/cli": patch
"explorer-verify": patch
---

`verify` now submits only where the command line says: `--backend <name>`, or `--backend auto`
for the routing table's pick. With `--input-json`, `route.backend` does the same, `"auto"`
included. Without a target, `verify` exits 2 with `invalid-input` before any request, and the hint
lists the backends the chain lists, says what `auto` would pick and why, and suggests `--dry-run`.
Add `--backend auto` to a script to keep the old behaviour.

- `--api-url` needs `--backend` naming the backend that serves that API, in a dry run too.
- `--allow-sourcify-fallback` alone is not a target. `auto` with another `--backend`, or with
  `--api-key-file` or `--api-key-stdin`, exits 2.
- With `--backend auto`, and in a dry run without `--backend`, the `verify.routed` line shows at
  the default level with how the backend was chosen and which backends were skipped.
- `--dry-run` and `status` need no target. The dry-run summary says how the backend was chosen.

In the library, `verify()` behaves as before. The `verify.routed` event gains `routedBy` (`caller`,
`table`, `fallback` or `api-url`) and `skipped`, and `DryRunResult` gains `routedBy`. The event
and envelope schemas describe both.

[#212](https://github.com/aelmanaa/explorer-verify/issues/212)
