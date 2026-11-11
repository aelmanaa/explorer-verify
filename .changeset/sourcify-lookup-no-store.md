---
"explorer-verify": patch
---

Through the platform's `fetch`, the Sourcify lookup now goes with `cache: "no-store"`, so a browser's HTTP cache no longer adds up to an hour on top of Sourcify's own cache. An injected `fetch` gets no `cache` field: it handles caching itself. A runtime whose `Request` refuses or drops the field, such as Cloudflare Workers before compatibility date 2024-11-11, sends the lookup without it. Sourcify's shared cache still serves a lookup for up to an hour, and no request field reaches it. The Sourcify reference page, the `dryRun()` docs and `DryRunResult.lookup` now say that a lookup grade can be up to an hour old, and that a job's answer wins over it. After a 409 that follows a lookup naming another contract, `verify()` logs at `warn` that the kept `storedContract` may be out of date.

[#356](https://github.com/aelmanaa/explorer-verify/issues/356)
