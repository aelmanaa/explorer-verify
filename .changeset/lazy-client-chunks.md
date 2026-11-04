---
"explorer-verify": patch
---

`verify()`, `checkStatus()` and `dryRun()` load each explorer client with a dynamic `import()`, only when a call is routed to it. Vite, Rollup and webpack put each client in a chunk of its own, and esbuild does the same with `--splitting`. A new client therefore no longer grows the code a page loads before its first call. Measured on `verify` with Vite 5.4.21, the entry is 17,056 bytes gzipped and a call routed to Sourcify adds 3,635, against 21,106 for one file with every client. With esbuild the page is about 1 KB larger than before, with or without `--splitting`. The load counts against `timeoutMs` and stops when the signal aborts. A client that fails to load rejects the call with the loader's error. The API and the results do not change. Issue: https://github.com/aelmanaa/explorer-verify/issues/136
