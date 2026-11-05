---
"@explorer-verify/cli": patch
---

`verify` and `status` take `--allow-sourcify-fallback`, which sets `allowSourcifyFallback: true`.
A chain with no row in the routing table then goes to the public Sourcify API, and the result links
the Sourcify contract page. Without the flag such a chain exits 2 with `unsupported-chain`, and the
hint now names the flag. The flag works with `--dry-run`, `--input-json` and `--backend sourcify`.
It exits 2 with `--api-url`, with a `route.apiUrl` in the request, with a `--backend` other than
`sourcify` and with a repeated `--backend`, because it would change nothing there.

[#167](https://github.com/aelmanaa/explorer-verify/issues/167)
