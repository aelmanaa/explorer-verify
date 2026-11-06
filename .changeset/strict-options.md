---
"explorer-verify": minor
"@explorer-verify/hardhat": minor
"@explorer-verify/foundry": minor
---

Breaking: an options key that a function does not read now throws `invalid-input` before any request, where it was ignored before. The issue names the key and, when one matches it ignoring case or by prefix, the option it may mean: `verify(input, { timeout: 5 })` gives `timeout: is not a known option; did you mean timeoutMs?`. The error never repeats the key's value. The rule covers the options of `verify()`, `dryRun()`, `checkStatus()`, `linkProxy()`, `verifyEach()`, `buildVerifyInput()`, `buildVerifyInputFromBytecode()`, `toEnvelope()`, `createVerifyHandler()`, `routesFor()`, `findHardhatBuild()`, `findFoundryBuild()`, `buildVerifyInputFromHardhat()` and `buildVerifyInputFromFoundry()`, and the keys of `route` and of each `backends` entry.

Each flow function has its own options type: `VerifyOptions`, `DryRunOptions`, `CheckStatusOptions` and `LinkProxyOptions`, all built on the new `CallOptions`. In an object literal, TypeScript now refuses `pollIntervalMs` for `dryRun()` and `rpcUrl` for `checkStatus()` and `linkProxy()`. At run time those four functions still accept every key of `VerifyOptions`, so one options object built for `verify()` works with each of them. Every optional input field now accepts `undefined`, which counts as absent, so code built with `exactOptionalPropertyTypes` can pass `rpcUrl: process.env.RPC_URL` without a conditional spread.

[#216](https://github.com/aelmanaa/explorer-verify/issues/216)
