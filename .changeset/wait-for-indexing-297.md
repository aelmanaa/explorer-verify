---
"explorer-verify": minor
"@explorer-verify/cli": minor
---

Breaking: when Etherscan, Routescan or an Etherscan-compatible explorer still finds no contract code
at the address, `verify()` now throws the new `not-indexed` error instead of `timeout` or
`unexpected-response`. The CLI and the JSON envelope exit 4 for this case, where they exited 5.
`not-indexed` is retryable, carries no handle, and has `details.backend`, `details.submits` and
`details.elapsedMs`. Its hint says to check the chain ID and the address, then try again in a
minute.

`verify()` and `verifyEach()` also take `indexWaitMs`: how long to send the submit again while the
explorer finds no contract code, as it does right after a deployment. The wait counts from the
first submit, never cuts a wait short and stays within `timeoutMs`. Without it, `verify()` sends at
most 10 submits, as before.

```ts
await verify(input, { indexWaitMs: 120_000, timeoutMs: 300_000 });
```

What should I do? Where you matched `timeout` or `unexpected-response` for this case, match
`not-indexed`. In a script that reads exit codes, treat exit 4 with no handle as "run verify again
later". Right after a deployment, pass `indexWaitMs` to wait longer.

[#297](https://github.com/aelmanaa/explorer-verify/issues/297)
